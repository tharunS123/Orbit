import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { uuidv7, type Task } from '@orbit/shared';
import { positionBetween } from '@orbit/core';
import { asService, asUser, type Sql } from '@orbit/database';
import { createTestDatabase, createTestUser, type TestDatabase, type TestUser } from '@orbit/database/testing';
import { Actions } from './client/actions';
import { isInInbox } from './client/selectors';
import { MemoryPersistence } from './client/persistence';
import { handlePull, runMutation } from './server';
import { createDevice } from './test-helpers';

let db: TestDatabase;
let sql: Sql;
let alice: TestUser;
let bob: TestUser;
let teamId: string;

const deps = () => ({ sql });
const today = '2026-09-22';

beforeAll(async () => {
  db = await createTestDatabase();
  sql = db.sql;
  alice = await createTestUser(sql, 'Alice');
  bob = await createTestUser(sql, 'Bob');
  teamId = uuidv7();
  await runMutation(deps(), alice.id, 'workspace.create', { id: teamId, memberId: uuidv7(), name: 'Acme' });
  await asUser(sql, { userId: alice.id }, (tx) => tx`insert into workspace_members (workspace_id, user_id, role) values (${teamId}, ${bob.id}, 'member')`);
}, 120_000);

afterAll(async () => db?.close());

const task = async (u: TestUser, id: string) =>
  (await asUser(sql, { userId: u.id }, (tx) => tx<Task[]>`select * from tasks where id = ${id}`))[0];

describe('server mutators', () => {
  it('creates tasks in lists and inbox, with labels filtered to the workspace', async () => {
    const listId = uuidv7();
    await runMutation(deps(), alice.id, 'list.create', { id: listId, workspaceId: teamId, title: 'Launch', position: 'a0', visibility: 'workspace' });
    const labelId = uuidv7();
    await runMutation(deps(), alice.id, 'label.create', { id: labelId, workspaceId: teamId, name: 'urgent', color: 'red' });
    const foreignLabel = uuidv7();
    await runMutation(deps(), alice.id, 'label.create', { id: foreignLabel, workspaceId: alice.personalWorkspaceId, name: 'home', color: 'blue' });
    const t1 = uuidv7();
    await runMutation(deps(), alice.id, 'task.create', {
      id: t1, workspaceId: teamId, listId, title: 'Ship', position: 'a0', labelIds: [labelId, foreignLabel], dueDate: '2026-09-30', dueTime: '09:00', dueTz: 'Europe/Paris',
    });
    const row = await task(alice, t1);
    expect(row).toMatchObject({ title: 'Ship', listId, labelIds: [labelId], dueDate: '2026-09-30', dueAt: '2026-09-30T07:00:00.000Z' });

    const inbox = uuidv7();
    await runMutation(deps(), alice.id, 'task.create', { id: inbox, workspaceId: teamId, title: 'Call bank', position: 'a0', inInbox: true });
    const [state] = await asUser(sql, { userId: alice.id }, (tx) => tx`select in_inbox from task_user_states where task_id = ${inbox}`);
    expect(state!.inInbox).toBe(true);
  });

  it('rejects edits to lists the user cannot edit and invalid assignment', async () => {
    const listId = uuidv7();
    await runMutation(deps(), alice.id, 'list.create', { id: listId, workspaceId: teamId, title: 'Private', position: 'a1' });
    await expect(runMutation(deps(), bob.id, 'task.create', { id: uuidv7(), workspaceId: teamId, listId, title: 'x', position: 'a0' })).rejects.toMatchObject({ code: 'not_found' });
    const t = uuidv7();
    await runMutation(deps(), alice.id, 'task.create', { id: t, workspaceId: teamId, listId, title: 'mine', position: 'a0' });
    await expect(runMutation(deps(), alice.id, 'task.update', { id: t, patch: { assigneeId: bob.id } })).rejects.toMatchObject({ code: 'validation' });
    await runMutation(deps(), alice.id, 'list.share', { listId, userId: bob.id, role: 'editor', memberId: uuidv7() });
    await runMutation(deps(), alice.id, 'task.update', { id: t, patch: { assigneeId: bob.id } });
    const notes = await asUser(sql, { userId: bob.id }, (tx) => tx`select type from notifications order by created_at`);
    expect(notes.map((n) => n.type)).toEqual(expect.arrayContaining(['list_shared', 'task_assigned']));
  });

  it('advances recurring tasks on completion, resets subtasks, records history', async () => {
    const id = uuidv7();
    await runMutation(deps(), alice.id, 'task.create', {
      id, workspaceId: alice.personalWorkspaceId, title: 'Workout', position: 'a0', dueDate: '2026-09-21',
      recurrence: { freq: 'weekly', interval: 1, byWeekday: ['MO', 'TH'], anchor: 'schedule' },
    });
    const sub = uuidv7();
    await runMutation(deps(), alice.id, 'task.create', { id: sub, workspaceId: alice.personalWorkspaceId, parentTaskId: id, title: 'Stretch', position: 'a0' });
    await runMutation(deps(), alice.id, 'task.setCompleted', { ids: [sub], completed: true, today });
    await runMutation(deps(), alice.id, 'task.setCompleted', { ids: [id], completed: true, today });
    const row = await task(alice, id);
    expect(row).toMatchObject({ dueDate: '2026-09-24', completedAt: null, occurrenceCount: 1 });
    expect((await task(alice, sub))!.completedAt).toBeNull();
    const hist = await asUser(sql, { userId: alice.id }, (tx) => tx`select occurrence_date from task_completions where task_id = ${id}`);
    expect(hist.map((h) => h.occurrenceDate)).toEqual(['2026-09-21']);
    await runMutation(deps(), alice.id, 'task.skipOccurrence', { id, today });
    expect((await task(alice, id))!.dueDate).toBe('2026-09-28');
  });

  it('merges concurrent label edits atomically and deletes/restores subtrees', async () => {
    const id = uuidv7();
    await runMutation(deps(), alice.id, 'task.create', { id, workspaceId: teamId, title: 'Labels', position: 'a0' });
    const [l1, l2] = [uuidv7(), uuidv7()];
    await runMutation(deps(), alice.id, 'label.create', { id: l1, workspaceId: teamId, name: 'one', color: 'red' });
    await runMutation(deps(), alice.id, 'label.create', { id: l2, workspaceId: teamId, name: 'two', color: 'blue' });
    await Promise.all([
      runMutation(deps(), alice.id, 'task.setLabels', { ids: [id], add: [l1] }),
      runMutation(deps(), alice.id, 'task.setLabels', { ids: [id], add: [l2] }),
    ]);
    expect((await task(alice, id))!.labelIds.sort()).toEqual([l1, l2].sort());

    const child = uuidv7();
    await runMutation(deps(), alice.id, 'task.create', { id: child, workspaceId: teamId, parentTaskId: id, title: 'child', position: 'a0' });
    await runMutation(deps(), alice.id, 'task.delete', { ids: [id] });
    expect((await task(alice, child))!.deletedAt).not.toBeNull();
    await expect(runMutation(deps(), alice.id, 'task.update', { id, patch: { title: 'zombie' } })).rejects.toMatchObject({ code: 'deleted' });
    await runMutation(deps(), alice.id, 'task.restore', { ids: [id] });
    expect((await task(alice, child))!.deletedAt).toBeNull();
  });

  it('enforces the free plan list quota server-side', async () => {
    const u = await createTestUser(sql, 'Quota');
    for (let i = 0; i < 20; i++) await runMutation(deps(), u.id, 'list.create', { id: uuidv7(), workspaceId: u.personalWorkspaceId, title: `L${i}`, position: `a${i}` });
    await expect(runMutation(deps(), u.id, 'list.create', { id: uuidv7(), workspaceId: u.personalWorkspaceId, title: 'one too many', position: 'b0' })).rejects.toMatchObject({ code: 'quota_exceeded' });
    await asService(sql, (tx) => tx`insert into entitlements (user_id, plan, source) values (${u.id}, 'plus', 'test')`);
    await runMutation(deps(), u.id, 'list.create', { id: uuidv7(), workspaceId: u.personalWorkspaceId, title: 'now allowed', position: 'b0' });
  });

  it('duplicates a list with remapped tasks and reset completion', async () => {
    const src = uuidv7();
    await runMutation(deps(), alice.id, 'list.create', { id: src, workspaceId: alice.personalWorkspaceId, title: 'Template', position: 'c0' });
    const t1 = uuidv7();
    const t2 = uuidv7();
    await runMutation(deps(), alice.id, 'task.create', { id: t1, workspaceId: alice.personalWorkspaceId, listId: src, title: 'Parent', position: 'a0', dueDate: '2026-10-01', completed: true });
    await runMutation(deps(), alice.id, 'task.create', { id: t2, workspaceId: alice.personalWorkspaceId, parentTaskId: t1, title: 'Child', position: 'a0' });
    const newId = uuidv7();
    const map = { [t1]: uuidv7(), [t2]: uuidv7() };
    await runMutation(deps(), alice.id, 'list.duplicate', { id: src, newId, title: 'Copy', position: 'c1', taskIdMap: map, clearDates: true });
    const copies = await asUser(sql, { userId: alice.id }, (tx) => tx<Task[]>`select * from tasks where list_id = ${newId} order by parent_task_id nulls first`);
    expect(copies.map((c) => [c.id, c.title, c.completedAt, c.dueDate, c.parentTaskId])).toEqual([
      [map[t1], 'Parent', null, null, null],
      [map[t2], 'Child', null, null, map[t1]],
    ]);
  });

  it('notifies mentioned users only if they can see the task', async () => {
    const listId = uuidv7();
    await runMutation(deps(), alice.id, 'list.create', { id: listId, workspaceId: teamId, title: 'Secret', position: 'd0' });
    const t = uuidv7();
    await runMutation(deps(), alice.id, 'task.create', { id: t, workspaceId: teamId, listId, title: 'hidden', position: 'a0' });
    await runMutation(deps(), alice.id, 'message.create', { id: uuidv7(), taskId: t, body: 'hey @bob', mentions: [bob.id] });
    const n = await asUser(sql, { userId: bob.id }, (tx) => tx`select 1 from notifications where task_id = ${t}`);
    expect(n.length).toBe(0);
  });

  it('transfers ownership through the dedicated path only', async () => {
    const ws = uuidv7();
    await runMutation(deps(), alice.id, 'workspace.create', { id: ws, memberId: uuidv7(), name: 'Transfer' });
    await asUser(sql, { userId: alice.id }, (tx) => tx`insert into workspace_members (workspace_id, user_id, role) values (${ws}, ${bob.id}, 'member')`);
    await expect(runMutation(deps(), bob.id, 'workspace.transfer', { workspaceId: ws, toUserId: bob.id })).rejects.toMatchObject({ code: 'forbidden' });
    await runMutation(deps(), alice.id, 'workspace.transfer', { workspaceId: ws, toUserId: bob.id });
    const rows = await asService(sql, (tx) => tx`select user_id, role from workspace_members where workspace_id = ${ws} order by role`);
    expect(rows.map((r) => [r.userId, r.role])).toEqual([[alice.id, 'admin'], [bob.id, 'owner']]);
  });
});

describe('pull', () => {
  it('returns full state, then only changes; paginates; isolates users', async () => {
    const u = await createTestUser(sql, 'Puller');
    const listId = uuidv7();
    await runMutation(deps(), u.id, 'list.create', { id: listId, workspaceId: u.personalWorkspaceId, title: 'P', position: 'a0' });
    let pos: string | null = null;
    for (let i = 0; i < 25; i++) {
      pos = positionBetween(pos, null);
      await runMutation(deps(), u.id, 'task.create', { id: uuidv7(), workspaceId: u.personalWorkspaceId, listId, title: `t${i}`, position: pos });
    }
    const clientId = uuidv7();
    let res = await handlePull(sql, u.id, { clientId, cursor: '0', limit: 10 });
    let total = res.changes.tasks?.length ?? 0;
    let pages = 1;
    while (res.page) {
      res = await handlePull(sql, u.id, { clientId, cursor: '0', page: res.page, limit: 10 });
      total += res.changes.tasks?.length ?? 0;
      pages++;
    }
    expect(total).toBe(25);
    expect(pages).toBeGreaterThan(2);
    expect(res.cursor).toMatch(/^\d+$/);

    const cursor = res.cursor!;
    const empty = await handlePull(sql, u.id, { clientId, cursor });
    expect(empty.changes.tasks ?? []).toHaveLength(0);

    const newTask = uuidv7();
    await runMutation(deps(), u.id, 'task.create', { id: newTask, workspaceId: u.personalWorkspaceId, listId, title: 'late', position: 'z0' });
    const delta = await handlePull(sql, u.id, { clientId, cursor });
    expect(delta.changes.tasks?.map((t) => t.id)).toEqual([newTask]);

    const other = await handlePull(sql, alice.id, { clientId: uuidv7(), cursor: '0' });
    expect((other.changes.tasks ?? []).some((t) => t.listId === listId)).toBe(false);
  });
});

describe('sync client end-to-end', () => {
  it('offline edits survive restart and sync on reconnect; concurrent field edits merge', async () => {
    const persistence = new MemoryPersistence();
    const clientId = uuidv7();
    let phone = await createDevice(sql, alice.id, persistence, clientId);
    const laptop = await createDevice(sql, alice.id);
    await phone.client.sync();
    await laptop.client.sync();

    const listId = uuidv7();
    phone.client.mutate('list.create', { id: listId, workspaceId: alice.personalWorkspaceId, title: 'Groceries', position: 'm0' });
    const milk = uuidv7();
    phone.client.mutate('task.create', { id: milk, workspaceId: alice.personalWorkspaceId, listId, title: 'Milk', position: 'a0' });
    await phone.client.sync();
    await laptop.client.sync();
    expect(laptop.store.get('tasks', milk)?.title).toBe('Milk');

    // Phone goes offline and edits the title; laptop edits the due date meanwhile.
    phone.transport.online = false;
    phone.client.mutate('task.update', { id: milk, patch: { title: 'Oat milk' } });
    const eggs = uuidv7();
    phone.client.mutate('task.create', { id: eggs, workspaceId: alice.personalWorkspaceId, listId, title: 'Eggs', position: 'a1' });
    await phone.client.sync();
    expect(phone.client.getStatus().state).toBe('offline');
    expect(phone.store.get('tasks', milk)?.title).toBe('Oat milk');
    laptop.client.mutate('task.update', { id: milk, patch: { dueDate: '2026-09-25' } });
    await laptop.client.sync();

    // "Restart" the phone app while still offline: state comes back from persistence.
    await phone.client.flush();
    phone = await createDevice(sql, alice.id, persistence, clientId);
    expect(phone.store.get('tasks', milk)?.title).toBe('Oat milk');
    expect(phone.store.get('tasks', eggs)?.title).toBe('Eggs');
    expect(phone.store.pendingMutations()).toHaveLength(2);

    phone.transport.online = true;
    await phone.client.sync();
    expect(phone.store.pendingMutations()).toHaveLength(0);
    const merged = phone.store.get('tasks', milk)!;
    expect(merged.title).toBe('Oat milk');
    expect(merged.dueDate).toBe('2026-09-25');
    await laptop.client.sync();
    expect(laptop.store.get('tasks', milk)).toMatchObject({ title: 'Oat milk', dueDate: '2026-09-25' });
    expect(laptop.store.get('tasks', eggs)?.title).toBe('Eggs');
  });

  it('a satellite window (desktop Quick Capture) shares the outbox: offline captures appear in the main window and sync once', async () => {
    // Both windows use the same local database (IndexedDB on desktop).
    const shared = new MemoryPersistence();
    const main = await createDevice(sql, alice.id, shared);
    await main.client.sync();
    await main.client.flush();
    // The satellite hydrates from the shared cache and never starts its own sync loop.
    const capture = await createDevice(sql, alice.id, shared);
    expect(capture.store.get('workspaces', alice.personalWorkspaceId)).toBeTruthy();
    const now = () => new Date('2026-09-22T15:00:00Z');
    const captureActions = new Actions(capture.client, { userId: alice.id, timeZone: 'UTC', now });

    main.transport.online = false;
    const { id } = captureActions.createTask({ workspaceId: alice.personalWorkspaceId, text: 'Submit CS project tomorrow at 7pm #school', inInbox: true });
    await capture.client.flush();
    expect(capture.transport.pushes).toBe(0);

    // The main window adopts it immediately — no network involved.
    expect(await main.client.adoptPending()).toBe(2); // label.create + task.create
    expect(main.store.get('tasks', id)).toMatchObject({ title: 'Submit CS project', dueDate: '2026-09-23', dueTime: '19:00', listId: null });
    expect(isInInbox(main.store, main.store.get('tasks', id)!, alice.id)).toBe(true);
    const labelId = main.store.get('tasks', id)!.labelIds[0]!;
    expect(main.store.get('labels', labelId)?.name).toBe('school');
    expect(await main.client.adoptPending()).toBe(0);

    await main.client.sync();
    expect(main.client.getStatus().state).toBe('offline');
    expect(main.store.pendingMutations()).toHaveLength(2);

    main.transport.online = true;
    await main.client.sync();
    await main.client.flush();
    expect(main.store.pendingMutations()).toHaveLength(0);
    expect(await shared.loadPending()).toHaveLength(0);
    expect(await main.client.adoptPending()).toBe(0);
    const rows = await asUser(sql, { userId: alice.id }, (tx) => tx<{ n: number }[]>`select count(*)::int as n from tasks where id = ${id}`);
    expect(rows[0]!.n).toBe(1);
    expect(await task(alice, id)).toMatchObject({ title: 'Submit CS project', listId: null });

    // Online capture pushed by both windows (a race) is still applied once.
    const second = captureActions.createTask({ workspaceId: alice.personalWorkspaceId, text: 'Buy groceries tomorrow', inInbox: true });
    await capture.client.flush();
    await main.client.adoptPending();
    capture.client.start();
    await Promise.all([capture.client.sync(), main.client.sync()]);
    capture.client.stop();
    await main.client.sync();
    const again = await asUser(sql, { userId: alice.id }, (tx) => tx<{ n: number }[]>`select count(*)::int as n from tasks where id = ${second.id}`);
    expect(again[0]!.n).toBe(1);
    expect(main.issues).toEqual([]);
    expect(capture.issues).toEqual([]);
    expect(main.store.get('tasks', second.id)).toMatchObject({ title: 'Buy groceries', dueDate: '2026-09-23', dueTime: null });

    // The satellite refreshes from the cache the main window keeps current.
    await main.client.flush();
    await capture.client.reload();
    expect(capture.store.get('tasks', id)?.title).toBe('Submit CS project');
  });

  it('is idempotent when a push is retried', async () => {
    const dev = await createDevice(sql, alice.id);
    await dev.client.sync();
    const id = uuidv7();
    const m = dev.client.mutate('task.create', { id, workspaceId: alice.personalWorkspaceId, title: 'Once', position: 'a0', inInbox: true });
    await dev.client.sync();
    // Simulate a lost response: push the same mutation again.
    const res = await dev.transport.push({ clientId: dev.client.clientId, mutations: [m] });
    expect(res.results[0]!.status).toBe('applied');
    const rows = await asUser(sql, { userId: alice.id }, (tx) => tx`select count(*)::int as n from tasks where id = ${id}`);
    expect(rows[0]!.n).toBe(1);
  });

  it('surfaces rejected mutations as issues and reverts to server truth', async () => {
    const dev = await createDevice(sql, bob.id);
    await dev.client.sync();
    const privateList = uuidv7();
    await runMutation(deps(), alice.id, 'list.create', { id: privateList, workspaceId: teamId, title: 'Alice only', position: 'x0' });
    // Bob tries to add into a list he can't see (e.g. stale id from a link).
    const t = uuidv7();
    dev.client.mutate('task.create', { id: t, workspaceId: teamId, listId: privateList, title: 'sneaky', position: 'a0' });
    expect(dev.store.get('tasks', t)).toBeDefined();
    await dev.client.sync();
    expect(dev.issues).toEqual(['task.create:not_found']);
    expect(dev.store.get('tasks', t)).toBeUndefined();
  });

  it('receives shared lists (backfill) and purges them when unshared', async () => {
    const bobDev = await createDevice(sql, bob.id);
    await bobDev.client.sync();
    const listId = uuidv7();
    await runMutation(deps(), alice.id, 'list.create', { id: listId, workspaceId: teamId, title: 'Soon shared', position: 'y0' });
    const t = uuidv7();
    await runMutation(deps(), alice.id, 'task.create', { id: t, workspaceId: teamId, listId, title: 'old task', position: 'a0' });
    await bobDev.client.sync();
    expect(bobDev.store.get('tasks', t)).toBeUndefined();

    await runMutation(deps(), alice.id, 'list.share', { listId, userId: bob.id, role: 'editor', memberId: uuidv7() });
    await bobDev.client.sync();
    expect(bobDev.store.get('lists', listId)?.title).toBe('Soon shared');
    expect(bobDev.store.get('tasks', t)?.title).toBe('old task'); // backfilled despite old change_xid

    await runMutation(deps(), alice.id, 'list.unshare', { listId, userId: bob.id });
    await bobDev.client.sync();
    expect(bobDev.store.get('lists', listId)).toBeUndefined();
    expect(bobDev.store.get('tasks', t)).toBeUndefined();
  });

  it('rebuilds a corrupted cache while keeping unsynced work', async () => {
    const persistence = new MemoryPersistence();
    const dev = await createDevice(sql, alice.id, persistence);
    await dev.client.sync();
    dev.transport.online = false;
    const id = uuidv7();
    dev.client.mutate('task.create', { id, workspaceId: alice.personalWorkspaceId, title: 'Unsynced', position: 'a0' });
    await dev.client.flush();
    persistence.load = async () => {
      throw new Error('corrupt');
    };
    const restarted = await createDevice(sql, alice.id, persistence);
    expect(restarted.store.get('tasks', id)?.title).toBe('Unsynced');
    restarted.transport.online = true;
    await restarted.client.sync();
    expect((await task(alice, id))?.title).toBe('Unsynced');
  });
});
