import { beforeEach, describe, expect, it } from 'vitest';
import { uuidv7 } from '@orbit/shared';
import { Actions, EntityStore, MemoryPersistence, SyncClient, isInInbox } from '@orbit/sync/client';
import { buildCreateInput, captureDueLabel, effectiveMetadata, SubmitGuard } from './capture-core';

/**
 * Capture runs through the same `Actions.preview` / `createTask` path as every other surface —
 * these tests use the real local store and mutators (no network).
 */
const userId = uuidv7();
const workspaceId = uuidv7();
const now = () => new Date('2026-09-22T15:00:00Z'); // Tuesday
const timeZone = 'America/New_York';

let client: SyncClient;
let actions: Actions;
let workLabel: string;

beforeEach(async () => {
  const store = new EntityStore(userId);
  const persistence = new MemoryPersistence();
  const t = new Date('2026-01-01T00:00:00Z').toISOString();
  await persistence.apply({
    puts: [
      { table: 'profiles', row: { id: userId, displayName: 'Me', email: 'me@example.test', avatarPath: null, timezone: timeZone, settings: {}, onboardedAt: t, createdAt: t, updatedAt: t } as never },
      { table: 'workspaces', row: { id: workspaceId, name: 'Personal', kind: 'personal', ownerId: userId, createdAt: t, updatedAt: t, deletedAt: null } as never },
      { table: 'workspaceMembers', row: { id: uuidv7(), workspaceId, userId, role: 'owner', createdAt: t, updatedAt: t } as never },
    ],
    meta: { schemaVersion: 3, userId, clientId: uuidv7() },
  });
  client = new SyncClient({ store, persistence, transport: { push: async () => { throw new Error('offline'); }, pull: async () => { throw new Error('offline'); } }, userId });
  await client.hydrate();
  actions = new Actions(client, { userId, timeZone, now });
  workLabel = actions.createLabel(workspaceId, 'work').id;
});

describe('quick-capture parsing (shared parser)', () => {
  it('previews dates, times and labels before saving', () => {
    const parsed = actions.preview('Submit CS project tomorrow at 7pm #school', workspaceId);
    const meta = effectiveMetadata(parsed, {}, null);
    expect(meta).toMatchObject({ dueDate: '2026-09-23', dueTime: '19:00', listId: null, newLabelNames: ['school'] });
    expect(parsed.title).toBe('Submit CS project');
    expect(captureDueLabel(meta.dueDate!, meta.dueTime, timeZone, now(), true)).toBe('Tomorrow, Sep 23 · 7pm');
  });

  it('resolves existing labels and weekday dates ("next Friday")', () => {
    const parsed = actions.preview('Call Sarah next Friday #work', workspaceId);
    const meta = effectiveMetadata(parsed, {}, null);
    expect(meta.labelIds).toEqual([workLabel]);
    expect(meta.dueDate).not.toBeNull();
    const label = captureDueLabel(meta.dueDate!, null, timeZone, now(), true);
    expect(label).toMatch(/^Friday, (Sep|Oct) \d+$/);
  });

  it('understands recurrence', () => {
    const meta = effectiveMetadata(actions.preview('Pay rent every month #home', workspaceId), {}, null);
    expect(meta.recurrence).not.toBeNull();
  });

  it('saves exactly what the preview showed, into the Inbox by default', () => {
    const id = uuidv7();
    actions.createTask(buildCreateInput({ id, workspaceId, text: 'Submit CS project tomorrow at 7pm #school', overrides: {}, defaultListId: null }));
    const task = client.store.get('tasks', id)!;
    expect(task).toMatchObject({ title: 'Submit CS project', dueDate: '2026-09-23', dueTime: '19:00', dueTz: timeZone, listId: null });
    expect(client.store.get('labels', task.labelIds[0]!)?.name).toBe('school');
    expect(isInInbox(client.store, task, userId)).toBe(true);
    // Offline: queued in the outbox, nothing lost.
    expect(client.store.pendingMutations().map((m) => m.name)).toContain('task.create');
  });

  it('explicit choices override the text', () => {
    const listId = actions.createList({ workspaceId, title: 'School' }).id;
    const overrides = { listId, due: { dueDate: '2026-10-01', dueTime: null }, labelIds: [workLabel] };
    const meta = effectiveMetadata(actions.preview('Essay tomorrow 5pm', workspaceId), overrides, null);
    expect(meta).toMatchObject({ listId, dueDate: '2026-10-01', dueTime: null, labelIds: [workLabel] });
    const id = uuidv7();
    actions.createTask(buildCreateInput({ id, workspaceId, text: 'Essay tomorrow 5pm', overrides, defaultListId: null }));
    const task = client.store.get('tasks', id)!;
    expect(task).toMatchObject({ title: 'Essay', listId, dueDate: '2026-10-01', dueTime: null, labelIds: [workLabel] });
    expect(isInInbox(client.store, task, userId)).toBe(false);
  });

  it('clearing the date in the picker drops the time too', () => {
    expect(effectiveMetadata(actions.preview('Gym tomorrow 7am', workspaceId), { due: { dueDate: null, dueTime: '07:00' } }, null)).toMatchObject({ dueDate: null, dueTime: null });
  });
});

describe('duplicate-save prevention', () => {
  it('lets a draft save once, however often Enter is pressed', () => {
    const guard = new SubmitGuard();
    const id = guard.id;
    expect(guard.begin()).toBe(true);
    expect(guard.begin()).toBe(false);
    expect(guard.begin()).toBe(false);
    expect(guard.id).toBe(id);
    const next = guard.next();
    expect(next).not.toBe(id);
    expect(guard.begin()).toBe(true);
  });

  it('allows retrying a failed save with the same task id', () => {
    const guard = new SubmitGuard();
    const id = guard.id;
    guard.begin();
    guard.fail();
    expect(guard.begin()).toBe(true);
    expect(guard.id).toBe(id);
  });

  it('a repeated create for the same draft id cannot add a second task', () => {
    const guard = new SubmitGuard();
    const save = () => (guard.begin() ? actions.createTask(buildCreateInput({ id: guard.id, workspaceId, text: 'Buy groceries tomorrow', overrides: {}, defaultListId: null })) : null);
    save();
    save();
    save();
    expect(client.store.all('tasks').filter((t) => t.title === 'Buy groceries')).toHaveLength(1);
  });
});

describe('due chip labels', () => {
  const tz = 'UTC';
  const at = new Date('2026-09-22T12:00:00Z');
  it('shows relative day and the real date', () => {
    expect(captureDueLabel('2026-09-22', null, tz, at, false)).toBe('Today, Sep 22');
    expect(captureDueLabel('2026-09-23', '16:00', tz, at, true)).toBe('Tomorrow, Sep 23 · 4pm');
    expect(captureDueLabel('2026-09-23', '16:00', tz, at, false)).toBe('Tomorrow, Sep 23 · 16:00');
    expect(captureDueLabel('2026-10-02', null, tz, at, false)).toBe('Friday, Oct 2');
    expect(captureDueLabel('2026-11-20', null, tz, at, false)).toBe('Nov 20');
    expect(captureDueLabel('2027-01-05', null, tz, at, false)).toBe('Jan 5, 2027');
  });
});
