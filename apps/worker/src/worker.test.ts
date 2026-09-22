import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { asService, type Sql } from '@orbit/database';
import { createTestDatabase, createTestUser, type TestDatabase, type TestUser } from '@orbit/database/testing';
import { createLogger, createMemoryStorage } from '@orbit/api';
import type { EmailMessage, PushPayload } from '@orbit/notifications';
import type { WorkerDeps } from './deps';
import { deleteAccount } from './jobs/account';
import { copyAttachments } from './jobs/attachments';
import { applyMeetingRetention, runMaintenance } from './jobs/maintenance';
import { EMAIL_DELAY_MS, deliverEmail, deliverPush, sweepNotifications } from './jobs/notifications';
import { purgeTrash } from './jobs/purge';
import { scanReminders } from './jobs/reminders';

let db: TestDatabase;
let sql: Sql;
let alice: TestUser;
let bob: TestUser;

const emails: EmailMessage[] = [];
const pushes: { userId: string; payload: PushPayload }[] = [];
const jobs: { name: string; data: Record<string, unknown>; opts?: { singletonKey?: string; startAfter?: Date } }[] = [];
const storage = createMemoryStorage();
let clock = new Date('2026-10-05T08:00:00.000Z');
let pushConfigured = true;

function deps(): WorkerDeps {
  return {
    sql,
    logger: createLogger('fatal', 'test'),
    storage,
    mailer: { kind: 'memory', send: async (m) => void emails.push(m) },
    push: {
      get configured() {
        return pushConfigured;
      },
      send: async (userId, payload) => {
        pushes.push({ userId, payload });
        return 1;
      },
    },
    enqueue: async (name, data, opts) => void jobs.push({ name, data, opts }),
    appUrl: 'https://app.test',
    now: () => clock,
  };
}

const svc = <T>(fn: Parameters<typeof asService<T>>[1]) => asService(sql, fn);

async function makeTask(u: TestUser, fields: { title?: string; dueDate?: string; dueTime?: string; dueTz?: string; reminders?: unknown[]; listId?: string; workspaceId?: string; assigneeId?: string }) {
  const [row] = await svc((tx) => tx<{ id: string }[]>`
    insert into tasks (workspace_id, list_id, created_by, assignee_id, title, position, due_date, due_time, due_tz, reminders)
    values (${fields.workspaceId ?? u.personalWorkspaceId}, ${fields.listId ?? null}, ${u.id}, ${fields.assigneeId ?? null}, ${fields.title ?? 'Task'}, 'a0',
            ${fields.dueDate ?? null}, ${fields.dueTime ?? null}, ${fields.dueTz ?? null}, ${tx.json((fields.reminders ?? []) as never)})
    returning id`);
  return row!.id;
}

const rid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

beforeAll(async () => {
  db = await createTestDatabase();
  sql = db.sql;
  alice = await createTestUser(sql, 'Alice');
  bob = await createTestUser(sql, 'Bob');
});
afterAll(async () => {
  await db.close();
});
beforeEach(() => {
  emails.length = 0;
  pushes.length = 0;
  jobs.length = 0;
  pushConfigured = true;
});

describe('reminders', () => {
  it('delivers each reminder exactly once, with email fallback when no device is registered', async () => {
    clock = new Date('2026-10-05T07:59:00.000Z');
    await scanReminders(deps()); // establishes the cursor
    const taskId = await makeTask(alice, {
      title: 'Submit report',
      dueDate: '2026-10-05',
      dueTime: '10:15',
      dueTz: 'Europe/Berlin', // 08:15Z
      reminders: [{ id: rid(1), kind: 'relative', offsetMinutes: 15 }, { id: rid(2), kind: 'relative', offsetMinutes: 0 }],
    });

    clock = new Date('2026-10-05T08:00:30.000Z');
    const first = await scanReminders(deps());
    expect(first.sent).toBe(1); // 08:00Z (15 minutes before)
    expect(emails).toHaveLength(1);
    expect(emails[0]!.subject).toBe('Reminder: Submit report');
    expect(emails[0]!.text).toContain(`https://app.test/task?id=${taskId}`);
    expect(jobs).toEqual([expect.objectContaining({ name: 'notification.deliver', data: { userId: alice.id } })]);

    const [n] = await svc((tx) => tx<{ type: string; data: { title: string } }[]>`select type, data from notifications where user_id = ${alice.id} and task_id = ${taskId}`);
    expect(n).toMatchObject({ type: 'task_due', data: { title: 'Submit report' } });

    // Re-scanning the same window (e.g. overlapping replicas after a cursor reset) sends nothing.
    await svc((tx) => tx`delete from worker_state`);
    clock = new Date('2026-10-05T08:01:00.000Z');
    expect((await scanReminders(deps())).sent).toBe(0);

    // Completing the task cancels the remaining reminder implicitly.
    await svc((tx) => tx`update tasks set completed_at = now() where id = ${taskId}`);
    clock = new Date('2026-10-05T08:16:00.000Z');
    expect((await scanReminders(deps())).sent).toBe(0);
  });

  it('does not email when the recipient can receive push, and honours the reminders switch', async () => {
    clock = new Date('2026-10-06T07:00:00.000Z');
    await scanReminders(deps());
    await svc((tx) => tx`insert into push_tokens (user_id, channel, token) values (${bob.id}, 'fcm', 'bob-token')`);
    await makeTask(bob, { title: 'All-day thing', dueDate: '2026-10-06', reminders: [{ id: rid(3), kind: 'relative', offsetMinutes: 0 }] });
    // Bob's zone is UTC with the default 09:00 reminder time.
    clock = new Date('2026-10-06T09:00:10.000Z');
    expect((await scanReminders(deps())).sent).toBe(1);
    expect(emails).toHaveLength(0);
    expect(jobs.map((j) => j.data.userId)).toEqual([bob.id]);

    await svc((tx) => tx`update profiles set settings = ${tx.json({ notifications: { reminders: false } })} where id = ${bob.id}`);
    await makeTask(bob, { title: 'Muted', reminders: [{ id: rid(4), kind: 'absolute', at: '2026-10-06T09:05:00.000Z' }] });
    jobs.length = 0;
    clock = new Date('2026-10-06T09:05:30.000Z');
    expect((await scanReminders(deps())).sent).toBe(1);
    expect(jobs).toHaveLength(0);
    const muted = await svc((tx) => tx`select 1 from notifications n join tasks t on t.id = n.task_id where t.title = 'Muted'`);
    expect(muted).toHaveLength(0);
    await svc((tx) => tx`update profiles set settings = '{}'::jsonb where id = ${bob.id}`);
  });
});

describe('notification delivery', () => {
  it('pushes once, respects preferences, then emails what stays unread', async () => {
    clock = new Date();
    await svc((tx) => tx`update notifications set pushed_at = now(), emailed_at = now() where user_id = ${alice.id}`);
    const taskId = await makeTask(alice, { title: 'Design review' });
    await svc((tx) => tx`
      insert into notifications (user_id, workspace_id, type, actor_id, task_id, data, created_at)
      values (${alice.id}, ${alice.personalWorkspaceId}, 'mention', ${bob.id}, ${taskId}, ${tx.json({ title: 'Design review' })}, ${clock}),
             (${alice.id}, ${alice.personalWorkspaceId}, 'comment', ${bob.id}, ${taskId}, ${tx.json({ title: 'Design review' })}, ${clock})`);
    await svc((tx) => tx`update profiles set settings = ${tx.json({ notifications: { comments: false } })} where id = ${alice.id}`);

    expect(await deliverPush(deps(), alice.id)).toEqual({ pushed: 1 });
    expect(pushes[0]!.payload).toMatchObject({ title: 'Bob mentioned you on “Design review”', path: `/task?id=${taskId}` });
    expect(jobs).toEqual([expect.objectContaining({ data: { userId: alice.id, phase: 'email' }, opts: expect.objectContaining({ singletonKey: `email:${alice.id}` }) })]);
    // Idempotent: nothing left to push.
    expect(await deliverPush(deps(), alice.id)).toEqual({ pushed: 0 });

    // Too early for email.
    expect(await deliverEmail(deps(), alice.id)).toEqual({ emailed: 0 });
    clock = new Date(clock.getTime() + EMAIL_DELAY_MS);
    expect(await deliverEmail(deps(), alice.id)).toEqual({ emailed: 1 }); // comment muted by prefs
    expect(emails[0]!.subject).toBe('Bob mentioned you on “Design review”');
    expect(await deliverEmail(deps(), alice.id)).toEqual({ emailed: 0 });
    // Nothing of Alice's left for the sweeper to email.
    clock = new Date(clock.getTime() + 10 * 60_000);
    jobs.length = 0;
    await sweepNotifications(deps());
    expect(jobs.filter((j) => j.data.userId === alice.id && j.data.phase === 'email')).toHaveLength(0);
    await svc((tx) => tx`update profiles set settings = '{}'::jsonb where id = ${alice.id}`);
  });

  it('sends a digest for several unread notifications and skips read ones', async () => {
    clock = new Date();
    const past = new Date(clock.getTime() - EMAIL_DELAY_MS - 60_000);
    const t = await makeTask(bob, { title: 'Launch' });
    await svc((tx) => tx`
      insert into notifications (user_id, workspace_id, type, actor_id, task_id, data, created_at, pushed_at, read_at)
      values (${bob.id}, ${bob.personalWorkspaceId}, 'task_assigned', ${alice.id}, ${t}, ${tx.json({ title: 'Launch' })}, ${past}, ${past}, null),
             (${bob.id}, ${bob.personalWorkspaceId}, 'mention', ${alice.id}, ${t}, ${tx.json({ title: 'Launch' })}, ${past}, ${past}, null),
             (${bob.id}, ${bob.personalWorkspaceId}, 'comment', ${alice.id}, ${t}, ${tx.json({ title: 'Launch' })}, ${past}, ${past}, ${past})`);
    expect(await deliverEmail(deps(), bob.id)).toEqual({ emailed: 2 });
    expect(emails[0]!.subject).toContain('2 unread updates');
    expect(emails[0]!.html).toContain('Alice assigned you');
  });
});

describe('trash purge', () => {
  it('permanently deletes old trash with files, keeping recent and restored items', async () => {
    clock = new Date();
    const old = new Date(clock.getTime() - 31 * 86_400_000);
    const recent = new Date(clock.getTime() - 5 * 86_400_000);
    const [oldList, keepList] = await svc(async (tx) => {
      const a = await tx<{ id: string }[]>`insert into lists (workspace_id, created_by, title, deleted_at) values (${alice.personalWorkspaceId}, ${alice.id}, 'Old', ${old}) returning id`;
      const b = await tx<{ id: string }[]>`insert into lists (workspace_id, created_by, title, deleted_at) values (${alice.personalWorkspaceId}, ${alice.id}, 'Recent', ${recent}) returning id`;
      return [a[0]!.id, b[0]!.id];
    });
    const inOld = await makeTask(alice, { title: 'in old list', listId: oldList });
    const oldTask = await makeTask(alice, { title: 'old trashed task' });
    await svc((tx) => tx`update tasks set deleted_at = ${old} where id = ${oldTask}`);
    const path = `attachments/${alice.personalWorkspaceId}/x/file.pdf`;
    await storage.upload(path, new Uint8Array([1, 2, 3]), 'application/pdf');
    await svc((tx) => tx`insert into attachments (workspace_id, task_id, uploaded_by, name, mime_type, size_bytes, storage_path, status)
                         values (${alice.personalWorkspaceId}, ${inOld}, ${alice.id}, 'file.pdf', 'application/pdf', 3, ${path}, 'ready')`);

    const res = await purgeTrash(deps());
    expect(res).toMatchObject({ lists: 1, tasks: 1 });
    expect(storage.objects.has(path)).toBe(false);
    const left = await svc((tx) => tx<{ id: string }[]>`select id from tasks where id = any(${[inOld, oldTask]}::uuid[]) union all select id from lists where id = ${oldList}`);
    expect(left).toHaveLength(0);
    const kept = await svc((tx) => tx`select 1 from lists where id = ${keepList}`);
    expect(kept).toHaveLength(1);
  });
});

describe('attachments copy', () => {
  it('copies ready files into a duplicated list, idempotently', async () => {
    const [src, dst] = await svc(async (tx) => {
      const a = await tx<{ id: string }[]>`insert into lists (workspace_id, created_by, title) values (${alice.personalWorkspaceId}, ${alice.id}, 'Src') returning id`;
      const b = await tx<{ id: string }[]>`insert into lists (workspace_id, created_by, title) values (${alice.personalWorkspaceId}, ${alice.id}, 'Dst') returning id`;
      return [a[0]!.id, b[0]!.id];
    });
    const t1 = await makeTask(alice, { listId: src });
    const t2 = await makeTask(alice, { listId: dst });
    const path = `attachments/${alice.personalWorkspaceId}/src/photo.png`;
    await storage.upload(path, new Uint8Array([9]), 'image/png');
    await svc((tx) => tx`insert into attachments (workspace_id, task_id, uploaded_by, name, mime_type, size_bytes, storage_path, status)
                         values (${alice.personalWorkspaceId}, ${t1}, ${alice.id}, 'photo.png', 'image/png', 1, ${path}, 'ready')`);
    const job = { userId: alice.id, taskIdMap: { [t1]: t2 }, listIdMap: { [src]: dst } };
    expect(await copyAttachments(deps(), job)).toEqual({ copied: 1 });
    expect(await copyAttachments(deps(), job)).toEqual({ copied: 0 });
    // Bob cannot copy Alice's private files.
    expect(await copyAttachments(deps(), { ...job, userId: bob.id })).toEqual({ copied: 0 });
    const copies = await svc((tx) => tx<{ storagePath: string }[]>`select storage_path from attachments where task_id = ${t2}`);
    expect(copies).toHaveLength(1);
    expect(storage.objects.has(copies[0]!.storagePath)).toBe(true);
  });
});

describe('account deletion', () => {
  it('deletes private data, anonymises the profile and keeps shared contributions', async () => {
    const carol = await createTestUser(sql, 'Carol');
    const dave = await createTestUser(sql, 'Dave');
    const team = await svc(async (tx) => {
      const [ws] = await tx<{ id: string }[]>`insert into workspaces (name, kind, owner_id) values ('Team', 'team', ${dave.id}) returning id`;
      await tx`insert into workspace_members (workspace_id, user_id, role) values (${ws!.id}, ${dave.id}, 'owner'), (${ws!.id}, ${carol.id}, 'member') on conflict do nothing`;
      return ws!.id;
    });
    const privateTask = await makeTask(carol, { title: 'private' });
    const sharedTask = await makeTask(carol, { title: 'shared', workspaceId: team, assigneeId: carol.id });
    await svc((tx) => tx`insert into push_tokens (user_id, channel, token) values (${carol.id}, 'apns', 'carol-token')`);
    await svc((tx) => tx`insert into account_deletions (user_id) values (${carol.id})`);

    expect(await deleteAccount(deps(), carol.id)).toEqual({ status: 'deleted' });
    const state = await svc(async (tx) => ({
      profile: (await tx<{ displayName: string; email: string | null }[]>`select display_name, email from profiles where id = ${carol.id}`)[0],
      authUser: await tx`select 1 from auth.users where id = ${carol.id}`,
      personal: await tx`select 1 from workspaces where id = ${carol.personalWorkspaceId}`,
      privateTask: await tx`select 1 from tasks where id = ${privateTask}`,
      shared: (await tx<{ assigneeId: string | null }[]>`select assignee_id from tasks where id = ${sharedTask}`)[0],
      membership: (await tx<{ deletedAt: Date | null }[]>`select deleted_at from workspace_members where user_id = ${carol.id} and workspace_id = ${team}`)[0],
      tokens: await tx`select 1 from push_tokens where user_id = ${carol.id}`,
      request: (await tx<{ completedAt: Date | null }[]>`select completed_at from account_deletions where user_id = ${carol.id}`)[0],
    }));
    expect(state.profile).toEqual({ displayName: 'Deleted user', email: null });
    expect(state.authUser).toHaveLength(0);
    expect(state.personal).toHaveLength(0);
    expect(state.privateTask).toHaveLength(0);
    expect(state.shared).toEqual({ assigneeId: null });
    expect(state.membership?.deletedAt).not.toBeNull();
    expect(state.tokens).toHaveLength(0);
    expect(state.request?.completedAt).not.toBeNull();
    expect(emails.at(-1)!.subject).toMatch(/account was deleted/);
    // Retry is a no-op.
    expect(await deleteAccount(deps(), carol.id)).toEqual({ status: 'skipped' });
  });

  it('refuses while the user still owns a shared workspace', async () => {
    const erin = await createTestUser(sql, 'Erin');
    await svc(async (tx) => {
      const [ws] = await tx<{ id: string }[]>`insert into workspaces (name, kind, owner_id) values ('Erin Co', 'team', ${erin.id}) returning id`;
      await tx`insert into workspace_members (workspace_id, user_id, role) values (${ws!.id}, ${erin.id}, 'owner'), (${ws!.id}, ${bob.id}, 'member') on conflict do nothing`;
      await tx`insert into account_deletions (user_id) values (${erin.id})`;
    });
    await expect(deleteAccount(deps(), erin.id)).rejects.toThrow(/Erin Co/);
    const [req] = await svc((tx) => tx<{ error: string | null }[]>`select error from account_deletions where user_id = ${erin.id}`);
    expect(req!.error).toMatch(/Erin Co/);
  });
});

describe('maintenance', () => {
  it('prunes bookkeeping and removes expired meeting audio', async () => {
    clock = new Date();
    const [m] = await svc((tx) => tx<{ id: string }[]>`
      insert into meeting_sessions (workspace_id, created_by, title, status, audio_path, retention_until)
      values (${bob.personalWorkspaceId}, ${bob.id}, 'Standup', 'ready', 'meetings/a.webm', ${new Date(clock.getTime() - 1000)}) returning id`);
    await storage.upload('meetings/a.webm', new Uint8Array([1]), 'audio/webm');
    await svc((tx) => tx`insert into meeting_audio_chunks (meeting_id, seq, storage_path, start_ms, duration_ms, size_bytes) values (${m!.id}, 0, 'meetings/a-0.webm', 0, 1000, 1)`);
    await storage.upload('meetings/a-0.webm', new Uint8Array([1]), 'audio/webm');

    expect(await applyMeetingRetention(deps())).toEqual({ meetings: 1 });
    expect(storage.objects.has('meetings/a.webm')).toBe(false);
    expect(storage.objects.has('meetings/a-0.webm')).toBe(false);
    expect(await applyMeetingRetention(deps())).toEqual({ meetings: 0 });

    const counts = await runMaintenance(deps());
    expect(counts).toHaveProperty('syncMutations');
  });
});
