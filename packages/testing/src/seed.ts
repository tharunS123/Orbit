/**
 * Development seed. Creates two demo accounts through the Supabase Auth admin API and fills
 * them with realistic content using the same server mutators the apps use — so seeded data goes
 * through validation, RLS, triggers and activity logging exactly like real edits.
 *
 *   pnpm db:seed            (local stack only; refuses non-local URLs unless --force)
 *
 * Re-running is safe: existing demo accounts are reused and content is only created once.
 */
import { parseTaskInput, positionsBetween, TEMPLATES, todayIn } from '@orbit/core';
import { asService, createDb, type Sql } from '@orbit/database';
import { jsonToYUpdate, markdownToContent } from '@orbit/editor/schema';
import { uuidv7 } from '@orbit/shared';
import { runMutation, type PushDeps } from '@orbit/sync/server';

const DEMO_PASSWORD = 'orbit-demo-2026';
const USERS = [
  { email: 'maya@orbit.test', name: 'Maya Chen', timezone: 'Europe/Lisbon' },
  { email: 'sam@orbit.test', name: 'Sam Okafor', timezone: 'America/New_York' },
];

function env(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is not set. Run "pnpm setup" first.`);
  return v;
}

async function ensureUser(u: (typeof USERS)[number]): Promise<string> {
  const url = env('SUPABASE_URL');
  const key = env('SUPABASE_SERVICE_ROLE_KEY');
  const headers = { apikey: key, authorization: `Bearer ${key}`, 'content-type': 'application/json' };
  const res = await fetch(`${url}/auth/v1/admin/users`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ email: u.email, password: DEMO_PASSWORD, email_confirm: true, user_metadata: { display_name: u.name } }),
  });
  if (res.ok) return ((await res.json()) as { id: string }).id;
  const list = await fetch(`${url}/auth/v1/admin/users?per_page=1000`, { headers });
  const found = ((await list.json()) as { users: { id: string; email: string }[] }).users.find((x) => x.email === u.email);
  if (!found) throw new Error(`Could not create ${u.email}: ${res.status} ${await res.text()}`);
  return found.id;
}

async function main() {
  const dbUrl = env('DATABASE_URL');
  const local = /@(127\.0\.0\.1|localhost|host\.docker\.internal)[:/]/.test(dbUrl);
  if (!local && !process.argv.includes('--force')) throw new Error('Refusing to seed a non-local database. Pass --force if you really mean it.');

  const sql: Sql = createDb(dbUrl, { max: 2 });
  const deps: PushDeps = { sql };
  try {
    const [mayaId, samId] = await Promise.all(USERS.map(ensureUser)) as [string, string];
    await asService(sql, async (tx) => {
      for (const [i, id] of [mayaId, samId].entries()) {
        await tx`update profiles set timezone = ${USERS[i]!.timezone}, onboarded_at = coalesce(onboarded_at, now()),
                                    usage_type = coalesce(usage_type, 'team') where id = ${id}`;
      }
    });

    const [done] = await asService(sql, (tx) => tx`select 1 from worker_state where key = 'seed.demo'`);
    if (done) {
      console.log('Demo content already present — nothing to do.');
      return;
    }
    // Clear leftovers of an interrupted run (demo accounts only).
    await asService(sql, async (tx) => {
      const ids = [mayaId, samId];
      await tx`delete from tasks where created_by = any(${ids}::uuid[])`;
      await tx`delete from lists where created_by = any(${ids}::uuid[])`;
      await tx`delete from labels where workspace_id in (select id from workspaces where owner_id = any(${ids}::uuid[]))`;
      await tx`delete from workspaces where owner_id = any(${ids}::uuid[]) and kind = 'team'`;
    });

    const mutate = (userId: string, name: Parameters<typeof runMutation>[2], args: unknown) => runMutation(deps, userId, name, args);
    const [personal] = await asService(sql, (tx) => tx<{ id: string }[]>`select id from workspaces where owner_id = ${mayaId} and kind = 'personal'`);

    // Team workspace shared by both demo users (membership added directly, as an accepted invite would).
    const teamId = uuidv7();
    await mutate(mayaId, 'workspace.create', { id: teamId, memberId: uuidv7(), name: 'Northwind Studio', icon: '🧭' });
    await asService(sql, (tx) => tx`insert into workspace_members (workspace_id, user_id, role) values (${teamId}, ${samId}, 'member') on conflict do nothing`);

    const labels: Record<string, string> = {};
    for (const [name, color] of [['design', 'violet'], ['launch', 'orange'], ['bug', 'red']] as const) {
      labels[name] = uuidv7();
      await mutate(mayaId, 'label.create', { id: labels[name], workspaceId: teamId, name, color });
    }

    const today = todayIn(USERS[0]!.timezone);
    const listPositions = positionsBetween(null, null, 4);
    const plans: { workspaceId: string; title: string; emoji: string; visibility: 'private' | 'workspace'; markdown: string }[] = [
      { workspaceId: personal!.id, ...pick('weekly-planning'), visibility: 'private' },
      { workspaceId: personal!.id, ...pick('trip-planning'), visibility: 'private' },
      {
        workspaceId: teamId,
        title: 'Website relaunch',
        emoji: '🚀',
        visibility: 'workspace',
        markdown: [
          '# Website relaunch',
          'Ship the new marketing site before the October campaign.',
          '## Design',
          '- [x] Moodboard and references #design',
          '- [ ] Final homepage mockups Fri #design',
          '  - [ ] Hero illustration',
          '  - [ ] Pricing table',
          '## Build',
          '- [ ] Set up preview deployments',
          '- [ ] Contact form sends to the shared inbox #bug',
          '- [ ] Launch checklist review next Tuesday #launch',
        ].join('\n'),
      },
      { workspaceId: teamId, ...pick('meeting-agenda'), visibility: 'workspace' },
    ];

    for (const [i, plan] of plans.entries()) {
      const listId = uuidv7();
      await mutate(mayaId, 'list.create', { id: listId, workspaceId: plan.workspaceId, title: plan.title, emoji: plan.emoji, visibility: plan.visibility, position: listPositions[i] });
      const creates: Record<string, unknown>[] = [];
      const content = markdownToContent(plan.markdown.replace(/^# .*\n/, ''), (title, opts) => {
        const parsed = parseTaskInput(title, { timeZone: USERS[0]!.timezone, labels: Object.entries(labels).map(([name, id]) => ({ id, name })) });
        const id = uuidv7();
        creates.push({
          id,
          workspaceId: plan.workspaceId,
          listId: opts.parentId ? null : listId,
          parentTaskId: opts.parentId,
          title: parsed.title || title,
          dueDate: parsed.dueDate,
          dueTime: parsed.dueTime,
          dueTz: parsed.dueTime ? USERS[0]!.timezone : null,
          recurrence: parsed.recurrence,
          labelIds: parsed.labelIds,
          completed: opts.completed,
          assigneeId: plan.workspaceId === teamId && creates.length % 3 === 1 ? samId : null,
        });
        return id;
      });
      const positions = positionsBetween(null, null, creates.length);
      for (const [j, c] of creates.entries()) await mutate(mayaId, 'task.create', { ...c, position: positions[j] });
      await asService(sql, (tx) => tx`
        insert into documents (name, workspace_id, list_id, state, size_bytes)
        values (${`list:${listId}`}, ${plan.workspaceId}, ${listId}, ${Buffer.from(jsonToYUpdate(content))}, 0)
        on conflict (name) do nothing`);
    }

    // A few Inbox items with natural-language dates.
    for (const text of ['Renew passport next month', 'Call the landlord tomorrow at 10am', 'Water the plants every Sunday']) {
      const parsed = parseTaskInput(text, { timeZone: USERS[0]!.timezone });
      await mutate(mayaId, 'task.create', {
        id: uuidv7(),
        workspaceId: personal!.id,
        title: parsed.title,
        dueDate: parsed.dueDate,
        dueTime: parsed.dueTime,
        dueTz: parsed.dueTime ? USERS[0]!.timezone : null,
        recurrence: parsed.recurrence,
        position: positionsBetween(null, null, 1)[0],
        inInbox: true,
        inboxPosition: positionsBetween(null, null, 1)[0],
      });
    }

    await asService(sql, (tx) => tx`insert into worker_state (key, value) values ('seed.demo', ${tx.json({ at: new Date().toISOString() })}) on conflict (key) do nothing`);
    console.log(`Seeded demo content (today is ${today} in ${USERS[0]!.timezone}).`);
    for (const u of USERS) console.log(`  ${u.email} / ${DEMO_PASSWORD}`);
  } finally {
    await sql.end({ timeout: 2 });
  }
}

function pick(id: string) {
  const t = TEMPLATES.find((x) => x.id === id);
  if (!t) throw new Error(`Unknown template ${id}`);
  return { title: t.title, emoji: t.emoji, markdown: t.markdown };
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
