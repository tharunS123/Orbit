import type { Hono } from 'hono';
import { z } from 'zod';
import { AppError, PRODUCT } from '@orbit/shared';
import { PLANS, planLimits, type PlanId } from '@orbit/core';
import { asService, asUser } from '@orbit/database';
import { pullRequestSchema, pushRequestSchema } from '@orbit/sync';
import { handlePull, handlePush, handleReconcile } from '@orbit/sync/server';
import type { ApiEnv } from '../context';
import { body, rateLimit, query } from '../middleware';

/** Sync, bootstrap, activity, stats, sessions and devices. */
export function coreRoutes(app: Hono<ApiEnv>, authed: Hono<ApiEnv>) {
  app.get('/health', async (c) => {
    const deps = c.get('deps');
    await asService(deps.sql, (tx) => tx`select 1`);
    return c.json({ ok: true, product: PRODUCT.name, time: new Date().toISOString() });
  });


  // ───────────── sync ─────────────
  authed.post('/sync/push', rateLimit('push', 240, 60), async (c) => {
    const deps = c.get('deps');
    const req = await body(c, pushRequestSchema);
    const res = await handlePush({ sql: deps.sql, queue: deps.queue, log: (level, msg, data) => c.get('log')[level](data ?? {}, msg) }, c.get('user').userId, req);
    return c.json(res);
  });

  authed.post('/sync/pull', rateLimit('pull', 600, 60), async (c) => {
    const deps = c.get('deps');
    const req = await body(c, pullRequestSchema);
    const res = await handlePull(deps.sql, c.get('user').userId, req);
    await asUser(deps.sql, { userId: c.get('user').userId }, (tx) => tx`
      insert into sync_devices (id, user_id, last_pull_at) values (${req.clientId}, ${c.get('user').userId}, now())
      on conflict (id) do update set last_pull_at = now()`).catch(() => undefined);
    return c.json(res);
  });

  authed.get('/sync/reconcile', rateLimit('reconcile', 30, 3600), async (c) => {
    return c.json(await handleReconcile(c.get('deps').sql, c.get('user').userId));
  });

  // ───────────── bootstrap ─────────────
  authed.get('/me', async (c) => {
    const deps = c.get('deps');
    const user = c.get('user');
    const data = await asUser(deps.sql, { userId: user.userId }, async (tx) => {
      const [plan] = await tx<{ plan: PlanId }[]>`select app.user_plan(${user.userId}) as plan`;
      const [ent] = await tx<{ source: string; validUntil: string | null }[]>`select source, valid_until from entitlements where user_id = ${user.userId}`;
      const [storage] = await tx<{ bytes: number }[]>`select app.storage_bytes(${user.userId}) as bytes`;
      const [lists] = await tx<{ count: number }[]>`select app.active_list_count(${user.userId}) as count`;
      const [usage] = await tx<{ talk: number; meetings: number }[]>`
        select
          (select count(*)::int from ai_usage_events where user_id = ${user.userId} and feature = 'talk' and metric = 'requests' and created_at >= date_trunc('month', now())) as talk,
          (select count(*)::int from meeting_sessions where created_by = ${user.userId} and created_at >= date_trunc('month', now()) and deleted_at is null) as meetings`;
      return { plan: plan?.plan ?? 'free', ent, storage: storage?.bytes ?? 0, lists: lists?.count ?? 0, usage };
    });
    const limits = planLimits(data.plan);
    return c.json({
      userId: user.userId,
      email: user.email,
      plan: data.plan,
      planName: PLANS[data.plan].name,
      planSource: data.ent?.source ?? 'default',
      planValidUntil: data.ent?.validUntil ?? null,
      limits: { ...limits, features: [...limits.features] },
      usage: { storageBytes: data.storage, activeLists: data.lists, talkThisMonth: data.usage?.talk ?? 0, meetingsThisMonth: data.usage?.meetings ?? 0 },
      capabilities: deps.capabilities,
      flags: deps.flags,
      collabUrl: deps.env.COLLAB_URL,
      mcpUrl: deps.env.MCP_PUBLIC_URL,
      vapidPublicKey: deps.env.VAPID_PUBLIC_KEY ?? null,
      inboundEmailDomain: deps.env.INBOUND_EMAIL_DOMAIN,
    });
  });

  // ───────────── activity & stats ─────────────
  authed.get('/tasks/:id/activity', async (c) => {
    const id = z.uuid().parse(c.req.param('id'));
    const rows = await asUser(c.get('deps').sql, { userId: c.get('user').userId }, (tx) => tx`
      select id, type, actor_id, data, created_at from activity_events where task_id = ${id}
      order by created_at desc limit 200`);
    return c.json({ events: rows });
  });

  authed.get('/lists/:id/activity', async (c) => {
    const id = z.uuid().parse(c.req.param('id'));
    const rows = await asUser(c.get('deps').sql, { userId: c.get('user').userId }, (tx) => tx`
      select id, type, actor_id, task_id, data, created_at from activity_events where list_id = ${id}
      order by created_at desc limit 200`);
    return c.json({ events: rows });
  });

  authed.get('/me/heatmap', async (c) => {
    const q = query(c, z.object({ days: z.coerce.number().int().min(7).max(400).default(90), tz: z.string().max(64).default('UTC') }));
    const rows = await asUser(c.get('deps').sql, { userId: c.get('user').userId }, (tx) => tx<{ day: string; count: number }[]>`
      select to_char((completed_at at time zone app.valid_timezone(${q.tz}))::date, 'YYYY-MM-DD') as day, count(*)::int as count
        from task_completions
       where user_id = ${c.get('user').userId} and undone_at is null
         and completed_at >= now() - make_interval(days => ${q.days})
       group by 1 order by 1`);
    const total = rows.reduce((s, r) => s + r.count, 0);
    const best = rows.reduce((m, r) => (r.count > m.count ? r : m), { day: '', count: 0 });
    // Current streak: consecutive days ending today/yesterday with ≥1 completion.
    const days = new Set(rows.map((r) => r.day));
    let streak = 0;
    const cursor = new Date();
    const fmt = (d: Date) => new Intl.DateTimeFormat('en-CA', { timeZone: q.tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
    if (!days.has(fmt(cursor))) cursor.setUTCDate(cursor.getUTCDate() - 1);
    while (days.has(fmt(cursor))) {
      streak++;
      cursor.setUTCDate(cursor.getUTCDate() - 1);
    }
    return c.json({ days: rows, total, bestDay: best.count ? best : null, currentStreak: streak, activeDays: rows.length });
  });

  // ───────────── sessions & devices ─────────────
  authed.get('/account/sessions', async (c) => {
    const user = c.get('user');
    const rows = await asService(c.get('deps').sql, (tx) => tx`
      select id, created_at, updated_at, user_agent, ip::text as ip, aal from auth.sessions where user_id = ${user.userId}
      order by updated_at desc nulls last limit 50`).catch(() => [] as unknown[]);
    return c.json({ sessions: (rows as { id: string }[]).map((s) => ({ ...s, current: s.id === user.sessionId })) });
  });

  authed.delete('/account/sessions/:id', async (c) => {
    const user = c.get('user');
    const id = z.uuid().parse(c.req.param('id'));
    const deleted = await asService(c.get('deps').sql, async (tx) => {
      const rows = await tx`delete from auth.sessions where id = ${id} and user_id = ${user.userId} returning id`;
      await tx`insert into audit_log (user_id, action, target) values (${user.userId}, 'session.revoke', ${id})`;
      return rows.length;
    });
    if (!deleted) throw new AppError('not_found', 'Session not found.');
    return c.json({ ok: true });
  });

  authed.post('/devices/push-token', async (c) => {
    const user = c.get('user');
    const input = await body(
      c,
      z.object({
        deviceId: z.uuid(),
        platform: z.enum(['web', 'ios', 'android', 'macos', 'windows', 'linux']),
        name: z.string().max(120).default(''),
        appVersion: z.string().max(40).optional(),
        channel: z.enum(['webpush', 'apns', 'fcm']),
        token: z.string().min(10).max(4096),
        endpoint: z.string().url().max(2048).optional(),
        keys: z.object({ p256dh: z.string().max(200), auth: z.string().max(100) }).optional(),
      }),
    );
    if (input.channel === 'webpush' && (!input.endpoint || !input.keys)) throw new AppError('validation', 'Web push subscriptions need an endpoint and keys.');
    await asService(c.get('deps').sql, async (tx) => {
      await tx`insert into devices (id, user_id, platform, name, app_version, last_seen_at) values (${input.deviceId}, ${user.userId}, ${input.platform}, ${input.name}, ${input.appVersion ?? null}, now())
               on conflict (id) do update set last_seen_at = now(), name = excluded.name, app_version = excluded.app_version, revoked_at = null
               where devices.user_id = ${user.userId}`;
      await tx`insert into push_tokens (user_id, device_id, channel, token, endpoint, keys)
               values (${user.userId}, ${input.deviceId}, ${input.channel}, ${input.token}, ${input.endpoint ?? null}, ${input.keys ? tx.json(input.keys) : null})
               on conflict (channel, token) do update set user_id = excluded.user_id, device_id = excluded.device_id, failed_at = null, updated_at = now()`;
    });
    return c.json({ ok: true });
  });

  authed.get('/devices', async (c) => {
    const rows = await asUser(c.get('deps').sql, { userId: c.get('user').userId }, (tx) => tx`
      select id, platform, name, app_version, last_seen_at, created_at, revoked_at from devices order by last_seen_at desc`);
    return c.json({ devices: rows });
  });

  authed.delete('/devices/:id', async (c) => {
    const id = z.uuid().parse(c.req.param('id'));
    const user = c.get('user');
    await asService(c.get('deps').sql, async (tx) => {
      await tx`update devices set revoked_at = now() where id = ${id} and user_id = ${user.userId}`;
      await tx`delete from push_tokens where device_id = ${id} and user_id = ${user.userId}`;
    });
    return c.json({ ok: true });
  });

}
