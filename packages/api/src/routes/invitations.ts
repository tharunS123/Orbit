import { Hono } from 'hono';
import { z } from 'zod';
import { AppError, shareLinks } from '@orbit/shared';
import { planLimits, type PlanId } from '@orbit/core';
import { issueSecret, sha256 } from '@orbit/auth';
import { asService, asUser } from '@orbit/database';
import { emailTemplates } from '@orbit/notifications';
import type { ApiEnv } from '../context';
import { clientIp } from '../context';
import { body, rateLimit, requireAuth } from '../middleware';

/**
 * Invitation lifecycle: create (email) → preview → accept/decline → revoke/resend.
 * Tokens are random, shown once in the email link, and stored only as SHA-256 hashes.
 */
export function invitationRoutes(app: Hono<ApiEnv>, authed: Hono<ApiEnv>) {
  // Public preview for the invitation landing page (no auth; minimal, non-sensitive fields).
  app.get('/invitations/preview', rateLimit('invite-preview', 60, 60, (c) => clientIp(c)), async (c) => {
    const token = z.string().min(20).max(200).parse(c.req.query('token'));
    const [row] = await asService(c.get('deps').sql, (tx) => tx<{ workspace: string; inviter: string; listTitle: string | null; role: string; status: string; expiresAt: string; email: string }[]>`
      select w.name as workspace, p.display_name as inviter, l.title as list_title, i.role, i.status, i.expires_at, i.email
        from workspace_invitations i
        join workspaces w on w.id = i.workspace_id
        join profiles p on p.id = i.invited_by
        left join lists l on l.id = i.list_id
       where i.token_hash = ${sha256(token)}`);
    if (!row) throw new AppError('not_found', 'This invitation link is invalid.');
    const [local, domain] = row.email.split('@');
    return c.json({
      workspace: row.workspace,
      inviter: row.inviter,
      listTitle: row.listTitle,
      role: row.role,
      status: row.expiresAt < new Date().toISOString() && row.status === 'pending' ? 'expired' : row.status,
      // Masked so a forwarded link doesn't reveal the full address.
      emailHint: `${local!.slice(0, 2)}•••@${domain}`,
    });
  });


  authed.post('/invitations', rateLimit('invite', 60, 3600), async (c) => {
    const deps = c.get('deps');
    const user = c.get('user');
    const input = await body(
      c,
      z.object({
        workspaceId: z.uuid(),
        listId: z.uuid().nullable().default(null),
        emails: z.array(z.email().max(254)).min(1).max(50),
        role: z.enum(['admin', 'member', 'guest']).default('member'),
      }),
    );
    const results = await asUser(deps.sql, { userId: user.userId }, async (tx) => {
      const [ws] = await tx<{ name: string; kind: string; ownerId: string }[]>`select name, kind, owner_id from workspaces where id = ${input.workspaceId} and deleted_at is null`;
      if (!ws) throw new AppError('not_found', 'Workspace not found.');
      if (ws.kind === 'personal' && !input.listId) throw new AppError('validation', 'Invite people to a team workspace, or share a specific list.');
      const role = ws.kind === 'personal' ? 'guest' : input.listId && input.role !== 'admin' ? input.role : input.role;
      let listTitle: string | null = null;
      if (input.listId) {
        const [l] = await tx<{ title: string }[]>`select title from lists where id = ${input.listId} and workspace_id = ${input.workspaceId} and deleted_at is null`;
        if (!l) throw new AppError('not_found', 'List not found.');
        listTitle = l.title || 'Untitled list';
      }
      const [plan] = await tx<{ plan: PlanId }[]>`select app.user_plan(${ws.ownerId}) as plan`;
      const limits = planLimits(plan?.plan ?? 'free');
      const [counts] = await tx<{ members: number; pending: number }[]>`
        select (select count(*)::int from workspace_members where workspace_id = ${input.workspaceId} and deleted_at is null) as members,
               (select count(*)::int from workspace_invitations where workspace_id = ${input.workspaceId} and status = 'pending' and expires_at > now()) as pending`;
      if ((counts?.members ?? 0) + (counts?.pending ?? 0) + input.emails.length > limits.maxWorkspaceMembers) {
        throw new AppError('quota_exceeded', `This workspace's plan allows ${limits.maxWorkspaceMembers} people. Upgrade to invite more.`, { feature: 'members' });
      }
      const [inviter] = await tx<{ displayName: string }[]>`select display_name from profiles where id = ${user.userId}`;
      const out: { email: string; status: 'invited' | 'already_member' | 'already_invited'; token?: string }[] = [];
      for (const raw of input.emails) {
        const email = raw.toLowerCase();
        const member = await tx`select 1 from workspace_members m join profiles p on p.id = m.user_id
                                where m.workspace_id = ${input.workspaceId} and lower(p.email) = ${email} and m.deleted_at is null`;
        if (member.length && !input.listId) {
          out.push({ email, status: 'already_member' });
          continue;
        }
        const existing = await tx`select 1 from workspace_invitations where workspace_id = ${input.workspaceId} and lower(email) = ${email}
                                  and coalesce(list_id, '00000000-0000-0000-0000-000000000000') = coalesce(${input.listId}::uuid, '00000000-0000-0000-0000-000000000000')
                                  and status = 'pending' and expires_at > now()`;
        if (existing.length) {
          out.push({ email, status: 'already_invited' });
          continue;
        }
        // Expired pending rows would block the unique index — mark them expired first.
        await tx`update workspace_invitations set status = 'expired' where workspace_id = ${input.workspaceId} and lower(email) = ${email} and status = 'pending' and expires_at <= now()`;
        const secret = issueSecret('', 32);
        await tx`insert into workspace_invitations (workspace_id, list_id, email, role, token_hash, invited_by)
                 values (${input.workspaceId}, ${input.listId}, ${email}, ${role}, ${secret.hash}, ${user.userId})`;
        out.push({ email, status: 'invited', token: secret.token });
      }
      return { out, ws, listTitle, inviter: inviter?.displayName ?? 'A teammate', role };
    });

    for (const r of results.out) {
      if (r.status !== 'invited' || !r.token) continue;
      const url = shareLinks.invite(deps.env.APP_URL, r.token);
      const tpl = emailTemplates.invitation({ inviter: results.inviter, workspace: results.ws.name, listTitle: results.listTitle, url, role: results.role });
      await deps.mailer.send({ to: r.email, ...tpl, idempotencyKey: `invite:${sha256(r.token)}` }).catch((error) => {
        c.get('log').error({ err: String(error) }, 'invitation email failed');
      });
    }
    return c.json({ results: results.out.map(({ token: _t, ...r }) => r) });
  });

  authed.post('/invitations/accept', rateLimit('invite-accept', 20, 60), async (c) => {
    const { token } = await body(c, z.object({ token: z.string().min(20).max(200) }));
    const [res] = await asUser(c.get('deps').sql, { userId: c.get('user').userId }, (tx) =>
      tx<{ workspaceId: string; listId: string | null; role: string }[]>`select * from app.accept_invitation(${sha256(token)})`);
    return c.json(res);
  });

  authed.post('/invitations/:id/accept', async (c) => {
    // Accept from in-app (the invitee sees pending invitations via sync). Token isn't needed:
    // we look up by id and require the email match inside the database function.
    const id = z.uuid().parse(c.req.param('id'));
    const [hash] = await asUser(c.get('deps').sql, { userId: c.get('user').userId }, (tx) =>
      tx<{ tokenHash: string }[]>`select i.token_hash from workspace_invitations i where i.id = ${id} and i.status = 'pending' and lower(i.email) = app.my_email()`);
    if (!hash) throw new AppError('not_found', 'Invitation not found.');
    const [res] = await asUser(c.get('deps').sql, { userId: c.get('user').userId }, (tx) =>
      tx<{ workspaceId: string; listId: string | null; role: string }[]>`select * from app.accept_invitation(${hash.tokenHash})`);
    return c.json(res);
  });

  authed.post('/invitations/:id/decline', async (c) => {
    const id = z.uuid().parse(c.req.param('id'));
    await asUser(c.get('deps').sql, { userId: c.get('user').userId }, (tx) => tx`select app.decline_invitation(${id})`);
    return c.json({ ok: true });
  });

  authed.post('/invitations/:id/revoke', async (c) => {
    const id = z.uuid().parse(c.req.param('id'));
    const rows = await asUser(c.get('deps').sql, { userId: c.get('user').userId }, (tx) =>
      tx`update workspace_invitations set status = 'revoked' where id = ${id} and status = 'pending' returning id`);
    if (!rows.length) throw new AppError('not_found', 'Invitation not found or already handled.');
    return c.json({ ok: true });
  });

  authed.post('/invitations/:id/resend', rateLimit('invite-resend', 20, 3600), async (c) => {
    const deps = c.get('deps');
    const id = z.uuid().parse(c.req.param('id'));
    const secret = issueSecret('', 32);
    const [row] = await asUser(deps.sql, { userId: c.get('user').userId }, (tx) => tx<{ email: string; workspace: string; listTitle: string | null; role: string; inviter: string }[]>`
      with upd as (
        update workspace_invitations set token_hash = ${secret.hash}, expires_at = now() + interval '14 days'
         where id = ${id} and status = 'pending' returning email, workspace_id, list_id, role, invited_by
      ) select upd.email, w.name as workspace, l.title as list_title, upd.role, p.display_name as inviter
          from upd join workspaces w on w.id = upd.workspace_id join profiles p on p.id = upd.invited_by
          left join lists l on l.id = upd.list_id`);
    if (!row) throw new AppError('not_found', 'Invitation not found or already handled.');
    const tpl = emailTemplates.invitation({ inviter: row.inviter, workspace: row.workspace, listTitle: row.listTitle, url: shareLinks.invite(deps.env.APP_URL, secret.token), role: row.role });
    await deps.mailer.send({ to: row.email, ...tpl, idempotencyKey: `invite:${secret.hash}` });
    return c.json({ ok: true });
  });

}
