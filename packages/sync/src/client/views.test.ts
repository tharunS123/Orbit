import { describe, expect, it } from 'vitest';
import { AppError, uuidv7 } from '@orbit/shared';
import { EntityStore } from './store';
import { MemoryPersistence } from './persistence';
import { SyncClient } from './sync-client';
import { Actions } from './actions';
import { isInInbox, selectInbox, selectListTasks, selectSidebar, selectToday, selectTrash, selectUpcoming, searchLocal, subtaskProgress } from './selectors';

const userId = uuidv7();
const other = uuidv7();
const ws = uuidv7();
const timeZone = 'America/New_York';
// Tuesday 2026-09-22, 12:00 in New York
let now = new Date('2026-09-22T16:00:00Z');

async function setup() {
  const store = new EntityStore(userId);
  const client = new SyncClient({
    store,
    persistence: new MemoryPersistence(),
    transport: {
      push: async () => {
        throw new AppError('network', 'offline');
      },
      pull: async () => {
        throw new AppError('network', 'offline');
      },
    },
    userId,
    now: () => now,
  });
  await client.hydrate();
  // Seed base state as if pulled from the server.
  const meta = { createdAt: now.toISOString(), updatedAt: now.toISOString(), deletedAt: null };
  store.applyServerChanges({
    workspaces: [{ id: ws, name: 'Personal', kind: 'personal', ownerId: userId, icon: null, ...meta }],
    workspaceMembers: [{ id: uuidv7(), workspaceId: ws, userId, role: 'owner', ...meta }],
    profiles: [
      { id: userId, email: 'me@x.com', displayName: 'Me', avatarPath: null, timezone: timeZone, locale: 'en', usageType: null, onboardedAt: null, settings: {} as never, ...meta },
    ],
  } as never);
  const actions = new Actions(client, { userId, timeZone, now: () => now });
  const ctx = { userId, timeZone, now, workspaceId: null };
  return { store, client, actions, ctx };
}

describe('actions + selectors', () => {
  it('quick add parses natural language and lands in Inbox', async () => {
    const { store, actions, ctx } = await setup();
    const { id } = actions.createTask({ workspaceId: ws, text: 'Pay rent every month #home' });
    const t = store.get('tasks', id)!;
    expect(t.title).toBe('Pay rent');
    expect(t.recurrence).toMatchObject({ freq: 'monthly', byMonthDay: [22] });
    expect(t.labelIds).toHaveLength(1);
    expect(store.get('labels', t.labelIds[0]!)?.name).toBe('home');
    expect(selectInbox(store, ctx).open.map((x) => x.id)).toEqual([id]);
    expect(selectToday(store, ctx).today.map((x) => x.id)).toEqual([id]);
  });

  it('Today sections: overdue, today, later today, completed today', async () => {
    const { store, actions, ctx } = await setup();
    const overdue = actions.createTask({ workspaceId: ws, text: 'Old thing', dueDate: '2026-09-20' }).id;
    const passed = actions.createTask({ workspaceId: ws, text: 'Morning call', dueDate: '2026-09-22', dueTime: '09:00' }).id;
    const allDay = actions.createTask({ workspaceId: ws, text: 'Write report', dueDate: '2026-09-22' }).id;
    const later = actions.createTask({ workspaceId: ws, text: 'Evening run', dueDate: '2026-09-22', dueTime: '18:00' }).id;
    const done = actions.createTask({ workspaceId: ws, text: 'Done already', dueDate: '2026-09-22' }).id;
    actions.setCompleted([done], true);
    const assignedToOther = actions.createTask({ workspaceId: ws, text: 'Not mine', dueDate: '2026-09-22', assigneeId: other }).id;
    const v = selectToday(store, ctx);
    expect(v.overdue.map((t) => t.id)).toEqual([overdue, passed]);
    expect(v.today.map((t) => t.id)).toEqual([allDay]);
    expect(v.laterToday.map((t) => t.id)).toEqual([later]);
    expect(v.completedToday.map((t) => t.id)).toEqual([done]);
    expect([...v.overdue, ...v.today, ...v.laterToday].some((t) => t.id === assignedToOther)).toBe(false);
  });

  it('completing a recurring task advances it and undo restores it exactly', async () => {
    const { store, actions } = await setup();
    const id = actions.createTask({ workspaceId: ws, text: 'Water plants every Monday and Thursday' }).id;
    expect(store.get('tasks', id)?.dueDate).toBe('2026-09-24');
    const { undo } = actions.setCompleted([id], true);
    expect(store.get('tasks', id)).toMatchObject({ dueDate: '2026-09-28', completedAt: null, occurrenceCount: 1 });
    undo!();
    expect(store.get('tasks', id)).toMatchObject({ dueDate: '2026-09-24', completedAt: null, occurrenceCount: 0 });
  });

  it('upcoming groups by viewer-local date and lists overdue separately', async () => {
    const { store, actions, ctx } = await setup();
    actions.createTask({ workspaceId: ws, text: 'Late', dueDate: '2026-09-01' });
    const tomorrow = actions.createTask({ workspaceId: ws, text: 'Tomorrow thing tomorrow' }).id;
    // 09:00 in Tokyo on the 24th = 20:00 on the 23rd in New York.
    const tokyo = actions.createTask({ workspaceId: ws, text: 'Tokyo call' }).id;
    actions.updateTask(tokyo, { dueDate: '2026-09-24', dueTime: '09:00', dueTz: 'Asia/Tokyo' });
    const v = selectUpcoming(store, ctx, { start: '2026-09-22', days: 7 });
    expect(v.overdue).toHaveLength(1);
    expect(v.days[1]!.tasks.map((t) => t.id)).toEqual([tomorrow, tokyo]);
  });

  it('lists: subtasks, progress, reorder, move, delete → trash → restore', async () => {
    const { store, actions, ctx } = await setup();
    const { id: listId } = actions.createList({ workspaceId: ws, title: 'Launch' });
    expect(selectSidebar(store, userId, ws)[0]!.items.map((i) => i.list.id)).toEqual([listId]);
    const a = actions.createTask({ workspaceId: ws, listId, text: 'A', parse: false }).id;
    const b = actions.createTask({ workspaceId: ws, listId, text: 'B', parse: false }).id;
    const c = actions.createTask({ workspaceId: ws, listId, text: 'C', parse: false }).id;
    const sub1 = actions.createTask({ workspaceId: ws, parentTaskId: a, text: 'a1', parse: false }).id;
    actions.createTask({ workspaceId: ws, parentTaskId: a, text: 'a2', parse: false });
    actions.setCompleted([sub1], true);
    expect(subtaskProgress(store, a)).toEqual({ done: 1, total: 2 });
    expect(store.get('tasks', sub1)?.listId).toBe(listId);

    actions.reorder(selectListTasks(store, listId), [c], 0);
    expect(selectListTasks(store, listId).map((t) => t.title)).toEqual(['C', 'A', 'B']);

    actions.moveTasks([b], { listId: null });
    expect(selectListTasks(store, listId).map((t) => t.title)).toEqual(['C', 'A']);
    expect(isInInbox(store, store.get('tasks', b)!, userId)).toBe(true);

    const { undo } = actions.deleteTasks([a]);
    expect(store.get('tasks', sub1)?.deletedAt).not.toBeNull();
    expect(selectTrash(store, ctx).tasks.map((t) => t.id)).toEqual([a]);
    undo!();
    expect(store.get('tasks', sub1)?.deletedAt).toBeNull();
  });

  it('duplicates a task subtree with fresh ids and reset completion', async () => {
    const { store, actions } = await setup();
    const { id: listId } = actions.createList({ workspaceId: ws, title: 'Dup' });
    const a = actions.createTask({ workspaceId: ws, listId, text: 'Parent', parse: false }).id;
    const child = actions.createTask({ workspaceId: ws, parentTaskId: a, text: 'Child', parse: false }).id;
    actions.setCompleted([child], true);
    const { id: copy } = actions.duplicateTask(a);
    const kids = store.childrenOf(copy);
    expect(kids.map((k) => [k.title, k.completedAt])).toEqual([['Child', null]]);
    expect(selectListTasks(store, listId).map((t) => t.id)).toEqual([a, copy]);
  });

  it('local search ranks prefix matches and skips deleted', async () => {
    const { store, actions } = await setup();
    actions.createTask({ workspaceId: ws, text: 'Budget review', parse: false });
    const del = actions.createTask({ workspaceId: ws, text: 'Budget draft', parse: false }).id;
    actions.deleteTasks([del]);
    actions.createList({ workspaceId: ws, title: 'Family budget' });
    const hits = searchLocal(store, 'budget');
    expect(hits.map((h) => h.title)).toEqual(['Budget review', 'Family budget']);
    now = new Date('2026-09-22T16:00:00Z');
  });
});
