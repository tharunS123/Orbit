import {
  AppError,
  profileSettingsSchema,
  type EntityMap,
  type List,
  type SyncTableName,
  type Task,
  type TaskUserState,
} from '@orbit/shared';
import { advanceRecurrence, normalizeRecurrence, zonedToUtc } from '@orbit/core';
import type { MutatorArgs, MutatorName } from '../mutators';

/**
 * Optimistic client implementations. They mirror server/mutators.ts closely enough that the UI
 * shows the final result instantly; the server's version wins on the next pull (rebase).
 * They must be deterministic given (store state, args, ctx) because pending mutations are
 * replayed on top of fresh server state.
 */

export interface ClientTx {
  readonly userId: string;
  /** ISO timestamp captured when the mutation was created (stable across replays). */
  readonly now: string;
  get<T extends SyncTableName>(table: T, id: string): EntityMap[T] | undefined;
  all<T extends SyncTableName>(table: T): Iterable<EntityMap[T]>;
  put<T extends SyncTableName>(table: T, row: EntityMap[T]): void;
  patch<T extends SyncTableName>(table: T, id: string, patch: Partial<EntityMap[T]>): void;
  childrenOf(taskId: string): Task[];
  userState(taskId: string): TaskUserState | undefined;
}

const meta = (now: string) => ({ createdAt: now, updatedAt: now, deletedAt: null });

function computeDueAt(dueDate: string | null, dueTime: string | null, dueTz: string | null): string | null {
  if (!dueDate || !dueTime) return null;
  try {
    return zonedToUtc(dueDate, dueTime, dueTz || 'UTC').toISOString();
  } catch {
    return null;
  }
}

function requireTask(tx: ClientTx, id: string): Task {
  const task = tx.get('tasks', id);
  if (!task) throw new AppError('not_found', 'Task not found.');
  if (task.deletedAt) throw new AppError('deleted', 'This task was deleted.');
  return task;
}

function descendants(tx: ClientTx, id: string): Task[] {
  const out: Task[] = [];
  const stack = [id];
  const seen = new Set<string>();
  while (stack.length) {
    const cur = stack.pop()!;
    if (seen.has(cur)) continue;
    seen.add(cur);
    for (const c of tx.childrenOf(cur)) {
      out.push(c);
      stack.push(c.id);
    }
  }
  return out;
}

function setUserState(tx: ClientTx, task: Task, patch: Partial<TaskUserState>) {
  const existing = tx.userState(task.id);
  if (existing) {
    tx.patch('taskUserStates', existing.id, { ...patch, deletedAt: null });
  } else {
    tx.put('taskUserStates', {
      id: deterministicId(tx.userId, task.id),
      userId: tx.userId,
      taskId: task.id,
      workspaceId: task.workspaceId,
      inInbox: false,
      inboxPosition: null,
      todayPosition: null,
      ...meta(tx.now),
      ...patch,
    });
  }
}

/** Stable id for per-user rows so replays and the server converge on the same row id. */
export function deterministicId(a: string, b: string): string {
  // FNV-1a over both ids → 128 bits formatted as a v8-style uuid (version nibble 8).
  let h1 = 0x811c9dc5, h2 = 0x01000193, h3 = 0x9e3779b9, h4 = 0x85ebca6b;
  const s = `${a}:${b}`;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 16777619) >>> 0;
    h2 = Math.imul(h2 ^ c, 2246822507) >>> 0;
    h3 = Math.imul(h3 ^ c, 3266489909) >>> 0;
    h4 = Math.imul(h4 ^ c, 668265263) >>> 0;
  }
  const hex = [h1, h2, h3, h4].map((h) => h.toString(16).padStart(8, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-8${hex.slice(13, 16)}-${((parseInt(hex[16]!, 16) & 0x3) | 0x8).toString(16)}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

function applyTaskCompletion(tx: ClientTx, task: Task, completed: boolean, today: string) {
  if (!completed) {
    tx.patch('tasks', task.id, { completedAt: null, completedBy: null });
    return;
  }
  if (task.completedAt) return;
  if (task.recurrence && task.dueDate) {
    const { nextDueDate, occurrenceCount } = advanceRecurrence(task.recurrence, task.dueDate, today, task.occurrenceCount, today);
    if (nextDueDate) {
      tx.patch('tasks', task.id, {
        dueDate: nextDueDate,
        dueAt: computeDueAt(nextDueDate, task.dueTime, task.dueTz),
        occurrenceCount,
        completedAt: null,
        completedBy: null,
      });
      for (const child of descendants(tx, task.id)) {
        if (child.completedAt) tx.patch('tasks', child.id, { completedAt: null, completedBy: null });
      }
      return;
    }
    tx.patch('tasks', task.id, { occurrenceCount, completedAt: tx.now, completedBy: tx.userId });
    return;
  }
  tx.patch('tasks', task.id, { completedAt: tx.now, completedBy: tx.userId });
}

type Appliers = { [N in MutatorName]: (tx: ClientTx, args: MutatorArgs<N>) => void };

export const clientMutators: Appliers = {
  'task.create'(tx, a) {
    const parent = a.parentTaskId ? requireTask(tx, a.parentTaskId) : null;
    const dueDate = a.dueDate ?? null;
    const dueTime = dueDate ? (a.dueTime ?? null) : null;
    const dueTz = a.dueTz ?? null;
    const recurrence = a.recurrence && dueDate ? normalizeRecurrence(a.recurrence, dueDate) : a.recurrence;
    const task: Task = {
      id: a.id,
      workspaceId: parent?.workspaceId ?? a.workspaceId,
      listId: parent ? parent.listId : a.listId,
      parentTaskId: a.parentTaskId,
      rootTaskId: parent ? (parent.rootTaskId ?? parent.id) : null,
      createdBy: tx.userId,
      assigneeId: a.assigneeId,
      title: a.title,
      position: a.position,
      completedAt: a.completed ? tx.now : null,
      completedBy: a.completed ? tx.userId : null,
      dueDate,
      dueTime,
      dueTz,
      dueAt: computeDueAt(dueDate, dueTime, dueTz),
      reminders: a.reminders,
      recurrence: recurrence ?? null,
      occurrenceCount: 0,
      labelIds: a.labelIds,
      source: a.source,
      hasDetails: false,
      detailsPreview: null,
      childCount: 0,
      childCompletedCount: 0,
      ...meta(tx.now),
    };
    tx.put('tasks', task);
    if (a.inInbox) setUserState(tx, task, { inInbox: true, inboxPosition: a.inboxPosition ?? a.position });
  },

  'task.update'(tx, a) {
    const task = requireTask(tx, a.id);
    const p = a.patch;
    const next: Partial<Task> = {};
    if (p.title !== undefined) next.title = p.title;
    if (p.assigneeId !== undefined) next.assigneeId = p.assigneeId;
    if (p.reminders !== undefined) next.reminders = p.reminders;
    if (p.dueDate !== undefined || p.dueTime !== undefined || p.dueTz !== undefined) {
      const dueDate = p.dueDate !== undefined ? p.dueDate : task.dueDate;
      const dueTime = dueDate ? (p.dueTime !== undefined ? p.dueTime : task.dueTime) : null;
      const dueTz = p.dueTz !== undefined ? p.dueTz : task.dueTz;
      Object.assign(next, { dueDate, dueTime, dueTz, dueAt: computeDueAt(dueDate ?? null, dueTime ?? null, dueTz ?? null) });
    }
    if (p.recurrence !== undefined) {
      const date = next.dueDate !== undefined ? next.dueDate : task.dueDate;
      next.recurrence = p.recurrence && date ? normalizeRecurrence(p.recurrence, date) : p.recurrence;
    }
    tx.patch('tasks', task.id, next);
  },

  'task.setCompleted'(tx, a) {
    for (const id of a.ids) {
      const task = tx.get('tasks', id);
      if (task && !task.deletedAt) applyTaskCompletion(tx, task, a.completed, a.today);
    }
  },

  'task.skipOccurrence'(tx, a) {
    const task = requireTask(tx, a.id);
    if (!task.recurrence || !task.dueDate) return;
    const { nextDueDate } = advanceRecurrence(task.recurrence, task.dueDate, a.today, task.occurrenceCount);
    if (nextDueDate) tx.patch('tasks', task.id, { dueDate: nextDueDate, dueAt: computeDueAt(nextDueDate, task.dueTime, task.dueTz) });
  },

  'task.move'(tx, a) {
    const parent = a.parentTaskId ? requireTask(tx, a.parentTaskId) : null;
    for (const id of a.ids) {
      const task = tx.get('tasks', id);
      if (!task || task.deletedAt) continue;
      const listId = parent ? parent.listId : a.listId;
      tx.patch('tasks', id, {
        listId,
        parentTaskId: a.parentTaskId,
        rootTaskId: parent ? (parent.rootTaskId ?? parent.id) : null,
        position: a.positions[id] ?? task.position,
      });
      for (const d of descendants(tx, id)) tx.patch('tasks', d.id, { listId, rootTaskId: parent ? (parent.rootTaskId ?? parent.id) : id });
      if (!listId && !a.parentTaskId) setUserState(tx, task, { inInbox: true });
    }
  },

  'task.reorder'(tx, a) {
    for (const u of a.updates) if (tx.get('tasks', u.id)) tx.patch('tasks', u.id, { position: u.position });
  },

  'task.setLabels'(tx, a) {
    for (const id of a.ids) {
      const task = tx.get('tasks', id);
      if (!task || task.deletedAt) continue;
      const set = new Set(task.labelIds);
      a.add.forEach((l) => set.add(l));
      a.remove.forEach((l) => set.delete(l));
      tx.patch('tasks', id, { labelIds: [...set] });
    }
  },

  'task.setDue'(tx, a) {
    for (const id of a.ids) {
      if (tx.get('tasks', id)) clientMutators['task.update'](tx, { id, patch: { dueDate: a.dueDate, dueTime: a.dueTime, dueTz: a.dueTz } });
    }
  },

  'task.assign'(tx, a) {
    for (const id of a.ids) if (tx.get('tasks', id)) tx.patch('tasks', id, { assigneeId: a.assigneeId });
  },

  'task.delete'(tx, a) {
    for (const id of a.ids) {
      const task = tx.get('tasks', id);
      if (!task || task.deletedAt) continue;
      tx.patch('tasks', id, { deletedAt: tx.now });
      for (const d of descendants(tx, id)) if (!d.deletedAt) tx.patch('tasks', d.id, { deletedAt: tx.now });
    }
  },

  'task.restore'(tx, a) {
    for (const id of a.ids) {
      const task = tx.get('tasks', id);
      if (!task?.deletedAt) continue;
      const stamp = task.deletedAt;
      tx.patch('tasks', id, { deletedAt: null });
      for (const d of descendants(tx, id)) if (d.deletedAt === stamp) tx.patch('tasks', d.id, { deletedAt: null });
    }
  },

  'task.setInbox'(tx, a) {
    for (const id of a.ids) {
      const task = tx.get('tasks', id);
      if (!task) continue;
      setUserState(tx, task, { inInbox: a.inInbox, inboxPosition: a.positions?.[id] ?? tx.userState(id)?.inboxPosition ?? task.position });
    }
  },

  'task.setTodayOrder'(tx, a) {
    for (const u of a.updates) {
      const task = tx.get('tasks', u.id);
      if (task) setUserState(tx, task, { todayPosition: u.position });
    }
  },

  'task.duplicate'(tx, a) {
    const source = requireTask(tx, a.rootId);
    const copyOne = (orig: Task, parentNewId: string | null, pos: string, root: string | null) => {
      const newId = a.idMap[orig.id];
      if (!newId) return;
      tx.put('tasks', {
        ...orig,
        id: newId,
        parentTaskId: parentNewId,
        rootTaskId: root,
        title: orig.id === source.id && !parentNewId ? `${orig.title}` : orig.title,
        position: pos,
        createdBy: tx.userId,
        completedAt: a.resetCompletion ? null : orig.completedAt,
        completedBy: a.resetCompletion ? null : orig.completedBy,
        dueDate: a.clearDates ? null : orig.dueDate,
        dueTime: a.clearDates ? null : orig.dueTime,
        dueAt: a.clearDates ? null : orig.dueAt,
        recurrence: a.clearDates ? null : orig.recurrence,
        assigneeId: a.clearAssignees ? null : orig.assigneeId,
        occurrenceCount: 0,
        source: null,
        ...meta(tx.now),
      });
      for (const child of tx.childrenOf(orig.id)) {
        if (!child.deletedAt) copyOne(child, newId, child.position, root ?? newId);
      }
    };
    copyOne(source, source.parentTaskId, a.position, source.rootTaskId);
  },

  'list.create'(tx, a) {
    const list: List = {
      id: a.id,
      workspaceId: a.workspaceId,
      parentListId: a.parentListId,
      createdBy: tx.userId,
      title: a.title,
      emoji: a.emoji,
      coverPath: null,
      description: null,
      visibility: a.visibility,
      position: a.position,
      archivedAt: null,
      ...meta(tx.now),
    };
    tx.put('lists', list);
    if (a.star) {
      tx.put('sectionItems', {
        id: a.star.itemId,
        userId: tx.userId,
        workspaceId: a.workspaceId,
        sectionId: a.star.sectionId,
        listId: a.id,
        position: a.star.position,
        ...meta(tx.now),
      });
    }
  },

  'list.update'(tx, a) {
    const list = tx.get('lists', a.id);
    if (!list || list.deletedAt) throw new AppError('not_found', 'List not found.');
    tx.patch('lists', a.id, a.patch as Partial<List>);
  },

  'list.archive'(tx, a) {
    if (tx.get('lists', a.id)) tx.patch('lists', a.id, { archivedAt: a.archived ? tx.now : null });
  },

  'list.delete'(tx, a) {
    if (tx.get('lists', a.id)) tx.patch('lists', a.id, { deletedAt: tx.now });
  },

  'list.restore'(tx, a) {
    if (tx.get('lists', a.id)) tx.patch('lists', a.id, { deletedAt: null });
  },

  'list.duplicate'(tx, a) {
    const src = tx.get('lists', a.id);
    if (!src) throw new AppError('not_found', 'List not found.');
    tx.put('lists', { ...src, id: a.newId, title: a.title, position: a.position, createdBy: tx.userId, visibility: 'private', archivedAt: null, ...meta(tx.now) });
    for (const [oldId, newListId] of Object.entries(a.listIdMap)) {
      const sub = tx.get('lists', oldId);
      if (sub) {
        const parent = sub.parentListId ? (a.listIdMap[sub.parentListId] ?? (sub.parentListId === a.id ? a.newId : null)) : null;
        tx.put('lists', { ...sub, id: newListId, parentListId: parent, createdBy: tx.userId, visibility: 'private', ...meta(tx.now) });
      }
    }
    for (const [oldId, newId] of Object.entries(a.taskIdMap)) {
      const t = tx.get('tasks', oldId);
      if (!t || t.deletedAt) continue;
      const listId = t.listId === a.id ? a.newId : t.listId ? (a.listIdMap[t.listId] ?? null) : null;
      tx.put('tasks', {
        ...t,
        id: newId,
        listId,
        parentTaskId: t.parentTaskId ? (a.taskIdMap[t.parentTaskId] ?? null) : null,
        rootTaskId: t.rootTaskId ? (a.taskIdMap[t.rootTaskId] ?? null) : null,
        createdBy: tx.userId,
        completedAt: null,
        completedBy: null,
        dueDate: a.clearDates ? null : t.dueDate,
        dueTime: a.clearDates ? null : t.dueTime,
        dueAt: a.clearDates ? null : t.dueAt,
        recurrence: a.clearDates ? null : t.recurrence,
        assigneeId: a.clearAssignees ? null : t.assigneeId,
        occurrenceCount: 0,
        source: null,
        ...meta(tx.now),
      });
    }
  },

  'list.share'(tx, a) {
    const list = tx.get('lists', a.listId);
    if (!list) throw new AppError('not_found', 'List not found.');
    tx.put('listMembers', {
      id: a.memberId,
      listId: a.listId,
      workspaceId: list.workspaceId,
      userId: a.userId,
      role: a.role,
      addedBy: tx.userId,
      ...meta(tx.now),
    });
    if (list.visibility === 'private') tx.patch('lists', a.listId, { visibility: 'shared' });
  },

  'list.unshare'(tx, a) {
    for (const m of tx.all('listMembers')) {
      if (m.listId === a.listId && m.userId === a.userId && !m.deletedAt) tx.patch('listMembers', m.id, { deletedAt: tx.now });
    }
  },

  'section.create'(tx, a) {
    tx.put('sections', { id: a.id, userId: tx.userId, workspaceId: a.workspaceId, name: a.name, position: a.position, collapsed: false, ...meta(tx.now) });
  },
  'section.update'(tx, a) {
    const { id, ...rest } = a;
    const patch = Object.fromEntries(Object.entries(rest).filter(([, v]) => v !== undefined));
    if (tx.get('sections', id)) tx.patch('sections', id, patch);
  },
  'section.delete'(tx, a) {
    if (!tx.get('sections', a.id)) return;
    tx.patch('sections', a.id, { deletedAt: tx.now });
    for (const item of tx.all('sectionItems')) if (item.sectionId === a.id) tx.patch('sectionItems', item.id, { sectionId: null });
  },
  'list.star'(tx, a) {
    const existing = [...tx.all('sectionItems')].find((i) => i.listId === a.listId && i.userId === tx.userId);
    if (existing) tx.patch('sectionItems', existing.id, { sectionId: a.sectionId, position: a.position, deletedAt: null });
    else tx.put('sectionItems', { id: a.id, userId: tx.userId, workspaceId: a.workspaceId, sectionId: a.sectionId, listId: a.listId, position: a.position, ...meta(tx.now) });
  },
  'list.unstar'(tx, a) {
    for (const i of tx.all('sectionItems')) if (i.listId === a.listId && !i.deletedAt) tx.patch('sectionItems', i.id, { deletedAt: tx.now });
  },
  'sectionItem.move'(tx, a) {
    for (const i of tx.all('sectionItems')) if (i.listId === a.listId && !i.deletedAt) tx.patch('sectionItems', i.id, { sectionId: a.sectionId, position: a.position });
  },

  'label.create'(tx, a) {
    tx.put('labels', { id: a.id, workspaceId: a.workspaceId, name: a.name, color: a.color, createdBy: tx.userId, ...meta(tx.now) });
  },
  'label.update'(tx, a) {
    const patch: Partial<EntityMap['labels']> = {};
    if (a.name !== undefined) patch.name = a.name;
    if (a.color !== undefined) patch.color = a.color;
    if (tx.get('labels', a.id)) tx.patch('labels', a.id, patch);
  },
  'label.delete'(tx, a) {
    if (!tx.get('labels', a.id)) return;
    tx.patch('labels', a.id, { deletedAt: tx.now });
    for (const t of tx.all('tasks')) if (t.labelIds.includes(a.id)) tx.patch('tasks', t.id, { labelIds: t.labelIds.filter((l) => l !== a.id) });
  },

  'message.create'(tx, a) {
    const task = requireTask(tx, a.taskId);
    tx.put('taskMessages', {
      id: a.id,
      workspaceId: task.workspaceId,
      taskId: a.taskId,
      authorId: tx.userId,
      parentMessageId: a.parentMessageId,
      kind: a.kind,
      body: a.body,
      attachmentId: a.attachmentId,
      mentions: a.mentions,
      editedAt: null,
      ...meta(tx.now),
    });
  },
  'message.edit'(tx, a) {
    if (tx.get('taskMessages', a.id)) tx.patch('taskMessages', a.id, { body: a.body, mentions: a.mentions, editedAt: tx.now });
  },
  'message.delete'(tx, a) {
    if (tx.get('taskMessages', a.id)) tx.patch('taskMessages', a.id, { deletedAt: tx.now, body: '' });
  },
  'reaction.toggle'(tx, a) {
    const msg = tx.get('taskMessages', a.messageId);
    if (!msg) return;
    const existing = [...tx.all('messageReactions')].find((r) => r.messageId === a.messageId && r.userId === tx.userId && r.emoji === a.emoji);
    if (existing) tx.patch('messageReactions', existing.id, { deletedAt: a.on ? null : tx.now });
    else if (a.on)
      tx.put('messageReactions', { id: a.id, workspaceId: msg.workspaceId, messageId: a.messageId, taskId: msg.taskId, userId: tx.userId, emoji: a.emoji, ...meta(tx.now) });
  },

  'notification.markRead'(tx, a) {
    const target = a.all ? null : new Set(a.ids ?? []);
    for (const n of tx.all('notifications')) {
      if (n.userId !== tx.userId) continue;
      if (target && !target.has(n.id)) continue;
      if (a.read && !n.readAt) tx.patch('notifications', n.id, { readAt: tx.now });
      if (!a.read && n.readAt) tx.patch('notifications', n.id, { readAt: null });
    }
  },

  'attachment.rename'(tx, a) {
    if (tx.get('attachments', a.id)) tx.patch('attachments', a.id, { name: a.name });
  },
  'attachment.delete'(tx, a) {
    for (const id of a.ids) if (tx.get('attachments', id)) tx.patch('attachments', id, { deletedAt: tx.now });
  },

  'profile.update'(tx, a) {
    const profile = tx.get('profiles', tx.userId);
    if (!profile) return;
    const patch: Partial<EntityMap['profiles']> = {};
    if (a.displayName !== undefined) patch.displayName = a.displayName;
    if (a.avatarPath !== undefined) patch.avatarPath = a.avatarPath;
    if (a.timezone !== undefined) patch.timezone = a.timezone;
    if (a.locale !== undefined) patch.locale = a.locale;
    if (a.usageType !== undefined) patch.usageType = a.usageType;
    if (a.onboarded) patch.onboardedAt = profile.onboardedAt ?? tx.now;
    if (a.settings) patch.settings = mergeSettings(profile.settings, a.settings);
    tx.patch('profiles', tx.userId, patch);
  },

  'workspace.create'(tx, a) {
    tx.put('workspaces', { id: a.id, name: a.name, kind: 'team', ownerId: tx.userId, icon: a.icon, ...meta(tx.now) });
    tx.put('workspaceMembers', { id: a.memberId, workspaceId: a.id, userId: tx.userId, role: 'owner', ...meta(tx.now) });
  },
  'workspace.update'(tx, a) {
    const patch: Partial<EntityMap['workspaces']> = {};
    if (a.name !== undefined) patch.name = a.name;
    if (a.icon !== undefined) patch.icon = a.icon;
    if (tx.get('workspaces', a.id)) tx.patch('workspaces', a.id, patch);
  },
  'workspace.delete'(tx, a) {
    if (tx.get('workspaces', a.id)) tx.patch('workspaces', a.id, { deletedAt: tx.now });
  },
  'member.setRole'(tx, a) {
    for (const m of tx.all('workspaceMembers'))
      if (m.workspaceId === a.workspaceId && m.userId === a.userId && !m.deletedAt) tx.patch('workspaceMembers', m.id, { role: a.role });
  },
  'member.remove'(tx, a) {
    for (const m of tx.all('workspaceMembers'))
      if (m.workspaceId === a.workspaceId && m.userId === a.userId && !m.deletedAt) tx.patch('workspaceMembers', m.id, { deletedAt: tx.now });
  },
  'workspace.leave'(tx, a) {
    for (const m of tx.all('workspaceMembers'))
      if (m.workspaceId === a.workspaceId && m.userId === tx.userId && !m.deletedAt) tx.patch('workspaceMembers', m.id, { deletedAt: tx.now });
  },
  'workspace.transfer'(tx, a) {
    for (const m of tx.all('workspaceMembers')) {
      if (m.workspaceId !== a.workspaceId || m.deletedAt) continue;
      if (m.userId === a.toUserId) tx.patch('workspaceMembers', m.id, { role: 'owner' });
      else if (m.userId === tx.userId) tx.patch('workspaceMembers', m.id, { role: 'admin' });
    }
    if (tx.get('workspaces', a.workspaceId)) tx.patch('workspaces', a.workspaceId, { ownerId: a.toUserId });
  },
};

export function mergeSettings(
  current: EntityMap['profiles']['settings'],
  patch: Partial<EntityMap['profiles']['settings']>,
): EntityMap['profiles']['settings'] {
  return profileSettingsSchema.parse({
    ...current,
    ...patch,
    notifications: { ...current.notifications, ...(patch.notifications ?? {}) },
    ai: { ...current.ai, ...(patch.ai ?? {}) },
  });
}
