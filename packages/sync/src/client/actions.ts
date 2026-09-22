import { AppError, LABEL_COLORS, uuidv7, type LabelColor, type List, type Recurrence, type Reminder, type Task, type TaskSource } from '@orbit/shared';
import { parseTaskInput, planMove, positionAtEnd, positionAtStart, positionBetween, sortByPosition, todayIn, type ParsedTask } from '@orbit/core';
import type { TaskPatch } from '../mutators';
import { selectAssignable, selectLabels } from './selectors';
import type { SyncClient } from './sync-client';

/**
 * High-level user actions. They generate ids and ordering keys, run natural-language parsing,
 * batch mutations, and return an `undo` closure so the UI can offer Undo for everything.
 */

export interface ActionContext {
  userId: string;
  timeZone: string;
  now?: () => Date;
}

export interface ActionResult {
  undo?: () => void;
  label?: string;
}

export interface CreateTaskInput {
  workspaceId: string;
  /** Raw text; parsed for dates/recurrence/#labels/@people unless `parse` is false. */
  text: string;
  parse?: boolean;
  listId?: string | null;
  parentTaskId?: string | null;
  inInbox?: boolean;
  /** Insert after this sibling; default: end. */
  afterId?: string | null;
  atStart?: boolean;
  dueDate?: string | null;
  dueTime?: string | null;
  recurrence?: Recurrence | null;
  reminders?: Reminder[];
  labelIds?: string[];
  assigneeId?: string | null;
  source?: TaskSource | null;
  id?: string;
}

const nextColor = (i: number): LabelColor => LABEL_COLORS[(i * 5 + 3) % LABEL_COLORS.length]!;

export class Actions {
  constructor(
    private readonly client: SyncClient,
    private readonly ctx: ActionContext,
  ) {}

  private get store() {
    return this.client.store;
  }

  private now() {
    return this.ctx.now?.() ?? new Date();
  }

  today() {
    return todayIn(this.ctx.timeZone, this.now());
  }

  private siblings(listId: string | null, parentTaskId: string | null, workspaceId: string): Task[] {
    return this.store
      .all('tasks')
      .filter((t) => !t.deletedAt && t.workspaceId === workspaceId && (parentTaskId ? t.parentTaskId === parentTaskId : t.parentTaskId === null && t.listId === listId));
  }

  /** Parse without creating — for live previews under the input. */
  preview(text: string, workspaceId: string, listId: string | null = null): ParsedTask {
    return parseTaskInput(text, {
      timeZone: this.ctx.timeZone,
      now: this.now(),
      labels: selectLabels(this.store, workspaceId).map((l) => ({ id: l.id, name: l.name })),
      members: selectAssignable(this.store, workspaceId, listId).map((p) => ({ userId: p.id, displayName: p.displayName, email: p.email })),
    });
  }

  createTask(input: CreateTaskInput): { id: string } & ActionResult {
    const id = input.id ?? uuidv7();
    const listId = input.parentTaskId ? null : (input.listId ?? null);
    const parsed = input.parse === false ? null : this.preview(input.text, input.workspaceId, listId);
    const title = parsed ? parsed.title || input.text.trim() : input.text.trim();

    const labelIds = new Set(input.labelIds ?? []);
    for (const l of parsed?.labelIds ?? []) labelIds.add(l);
    const existing = selectLabels(this.store, input.workspaceId).length;
    parsed?.newLabelNames.forEach((name, i) => {
      const labelId = uuidv7();
      this.client.mutate('label.create', { id: labelId, workspaceId: input.workspaceId, name, color: nextColor(existing + i) });
      labelIds.add(labelId);
    });

    const sibs = sortByPosition(this.siblings(listId, input.parentTaskId ?? null, input.workspaceId));
    let position: string;
    if (input.atStart) position = positionAtStart(sibs);
    else if (input.afterId) {
      const idx = sibs.findIndex((s) => s.id === input.afterId);
      position = positionBetween(sibs[idx]?.position ?? null, sibs[idx + 1]?.position ?? null);
    } else position = positionAtEnd(sibs);

    const dueDate = input.dueDate !== undefined ? input.dueDate : (parsed?.dueDate ?? null);
    this.client.mutate('task.create', {
      id,
      workspaceId: input.workspaceId,
      listId,
      parentTaskId: input.parentTaskId ?? null,
      title,
      position,
      inInbox: input.inInbox ?? (!listId && !input.parentTaskId),
      dueDate,
      dueTime: input.dueTime !== undefined ? input.dueTime : (parsed?.dueTime ?? null),
      dueTz: dueDate ? this.ctx.timeZone : null,
      recurrence: input.recurrence !== undefined ? input.recurrence : (parsed?.recurrence ?? null),
      reminders: input.reminders ?? [],
      labelIds: [...labelIds],
      assigneeId: input.assigneeId !== undefined ? input.assigneeId : (parsed?.assigneeId ?? null),
      source: input.source ?? null,
    });
    return { id, label: 'Task created', undo: () => this.client.mutate('task.delete', { ids: [id] }) };
  }

  updateTask(id: string, patch: TaskPatch): ActionResult {
    const before = this.store.get('tasks', id);
    if (!before) throw new AppError('not_found', 'Task not found.');
    const next: TaskPatch = { ...patch };
    if ((patch.dueDate !== undefined || patch.dueTime !== undefined) && patch.dueTz === undefined) next.dueTz = this.ctx.timeZone;
    this.client.mutate('task.update', { id, patch: next });
    const revert: TaskPatch = {};
    for (const key of Object.keys(next) as (keyof TaskPatch)[]) (revert as Record<string, unknown>)[key] = before[key as keyof Task] ?? null;
    return { undo: () => this.client.mutate('task.update', { id, patch: revert }) };
  }

  setCompleted(ids: string[], completed: boolean): ActionResult {
    const before = ids.map((id) => this.store.get('tasks', id)).filter((t): t is Task => Boolean(t));
    if (!before.length) return {};
    this.client.mutate('task.setCompleted', { ids: before.map((t) => t.id), completed, today: this.today() });
    return {
      label: completed ? (before.length > 1 ? `${before.length} tasks completed` : 'Completed') : 'Reopened',
      undo: () => {
        const recurring = before.filter((t) => t.recurrence && completed && !t.completedAt);
        const plain = before.filter((t) => !recurring.includes(t) && Boolean(t.completedAt) !== completed);
        if (plain.length) this.client.mutate('task.setCompleted', { ids: plain.map((t) => t.id), completed: !completed, today: this.today() });
        for (const t of recurring) {
          this.client.mutate('task.update', { id: t.id, patch: { dueDate: t.dueDate, dueTime: t.dueTime, dueTz: t.dueTz, occurrenceCount: t.occurrenceCount } });
          if (t.completedAt === null) this.client.mutate('task.setCompleted', { ids: [t.id], completed: false, today: this.today() });
        }
      },
    };
  }

  toggle(id: string): ActionResult {
    const t = this.store.get('tasks', id);
    return t ? this.setCompleted([id], !t.completedAt) : {};
  }

  skipOccurrence(id: string): ActionResult {
    const t = this.store.get('tasks', id);
    if (!t) return {};
    this.client.mutate('task.skipOccurrence', { id, today: this.today() });
    return { label: 'Skipped', undo: () => this.client.mutate('task.update', { id, patch: { dueDate: t.dueDate } }) };
  }

  setDue(ids: string[], dueDate: string | null, dueTime: string | null = null): ActionResult {
    const before = ids.map((id) => this.store.get('tasks', id)).filter((t): t is Task => Boolean(t));
    this.client.mutate('task.setDue', { ids, dueDate, dueTime, dueTz: dueDate ? this.ctx.timeZone : null });
    return {
      label: dueDate ? 'Scheduled' : 'Date removed',
      undo: () => {
        for (const t of before) this.client.mutate('task.update', { id: t.id, patch: { dueDate: t.dueDate, dueTime: t.dueTime, dueTz: t.dueTz } });
      },
    };
  }

  assign(ids: string[], assigneeId: string | null): ActionResult {
    const before = ids.map((id) => this.store.get('tasks', id)).filter((t): t is Task => Boolean(t));
    this.client.mutate('task.assign', { ids, assigneeId });
    return {
      label: assigneeId ? 'Assigned' : 'Unassigned',
      undo: () => {
        for (const t of before) this.client.mutate('task.update', { id: t.id, patch: { assigneeId: t.assigneeId } });
      },
    };
  }

  setLabels(ids: string[], add: string[], remove: string[] = []): ActionResult {
    this.client.mutate('task.setLabels', { ids, add, remove });
    return { undo: () => this.client.mutate('task.setLabels', { ids, add: remove, remove: add }) };
  }

  deleteTasks(ids: string[]): ActionResult {
    this.client.mutate('task.delete', { ids });
    return { label: ids.length > 1 ? `${ids.length} tasks deleted` : 'Task deleted', undo: () => this.client.mutate('task.restore', { ids }) };
  }

  setInbox(ids: string[], inInbox: boolean): ActionResult {
    const positions: Record<string, string> = {};
    if (inInbox) {
      let pos: string | null = null;
      for (const id of ids) {
        pos = positionBetween(null, pos ?? null);
        positions[id] = pos;
      }
    }
    this.client.mutate('task.setInbox', { ids, inInbox, positions: inInbox ? positions : undefined });
    return { label: inInbox ? 'Added to Inbox' : 'Removed from Inbox', undo: () => this.client.mutate('task.setInbox', { ids, inInbox: !inInbox }) };
  }

  /** Move tasks into a list (or Inbox when listId is null) or under a parent task. */
  moveTasks(ids: string[], target: { listId: string | null; parentTaskId?: string | null; index?: number }): ActionResult {
    const tasks = ids.map((id) => this.store.get('tasks', id)).filter((t): t is Task => Boolean(t));
    if (!tasks.length) return {};
    const parent = target.parentTaskId ? this.store.get('tasks', target.parentTaskId) : null;
    const workspaceId = parent?.workspaceId ?? (target.listId ? this.store.get('lists', target.listId)?.workspaceId : tasks[0]!.workspaceId) ?? tasks[0]!.workspaceId;
    const sibs = this.siblings(parent ? null : target.listId, parent?.id ?? null, workspaceId).filter((t) => !ids.includes(t.id));
    const updates = planMove([...sibs, ...tasks.map((t) => ({ id: t.id, position: 'zzzz' }))], ids, target.index ?? sibs.length);
    const positions = Object.fromEntries(updates.filter((u) => ids.includes(u.id)).map((u) => [u.id, u.position]));
    const neighbourUpdates = updates.filter((u) => !ids.includes(u.id));
    if (neighbourUpdates.length) this.client.mutate('task.reorder', { updates: neighbourUpdates });
    this.client.mutate('task.move', { ids, listId: parent ? null : target.listId, parentTaskId: target.parentTaskId ?? null, positions });
    return {
      label: 'Moved',
      undo: () => {
        for (const t of tasks) this.client.mutate('task.move', { ids: [t.id], listId: t.listId, parentTaskId: t.parentTaskId, positions: { [t.id]: t.position } });
      },
    };
  }

  /** Reorder among siblings (drag & drop or keyboard). */
  reorder(siblings: Task[], ids: string[], toIndex: number): ActionResult {
    const before = siblings.filter((s) => ids.includes(s.id)).map((s) => ({ id: s.id, position: s.position }));
    const updates = planMove(siblings, ids, toIndex);
    if (!updates.length) return {};
    this.client.mutate('task.reorder', { updates });
    return { undo: () => this.client.mutate('task.reorder', { updates: before }) };
  }

  reorderToday(ordered: Task[], ids: string[], toIndex: number): ActionResult {
    const keyed = ordered.map((t, i) => ({ id: t.id, position: this.store.userState(t.id)?.todayPosition ?? `a${String(i).padStart(4, '0')}` }));
    const updates = planMove(keyed, ids, toIndex);
    this.client.mutate('task.setTodayOrder', { updates });
    return {};
  }

  reorderInbox(ordered: Task[], ids: string[], toIndex: number): ActionResult {
    const keyed = ordered.map((t) => ({ id: t.id, position: this.store.userState(t.id)?.inboxPosition ?? t.position }));
    const updates = planMove(keyed, ids, toIndex);
    this.client.mutate('task.setInbox', { ids: updates.map((u) => u.id), inInbox: true, positions: Object.fromEntries(updates.map((u) => [u.id, u.position])) });
    return {};
  }

  duplicateTask(id: string, opts: { clearDates?: boolean; clearAssignees?: boolean } = {}): { id: string } & ActionResult {
    const t = this.store.get('tasks', id);
    if (!t) throw new AppError('not_found', 'Task not found.');
    const idMap: Record<string, string> = {};
    const walk = (taskId: string) => {
      idMap[taskId] = uuidv7();
      for (const c of this.store.childrenOf(taskId)) if (!c.deletedAt) walk(c.id);
    };
    walk(id);
    const sibs = sortByPosition(this.siblings(t.listId, t.parentTaskId, t.workspaceId));
    const idx = sibs.findIndex((s) => s.id === id);
    const position = positionBetween(t.position, sibs[idx + 1]?.position ?? null);
    this.client.mutate('task.duplicate', { idMap, rootId: id, position, resetCompletion: true, clearDates: opts.clearDates ?? false, clearAssignees: opts.clearAssignees ?? false });
    const newId = idMap[id]!;
    return { id: newId, label: 'Duplicated', undo: () => this.client.mutate('task.delete', { ids: [newId] }) };
  }

  // ───────────── lists ─────────────
  createList(input: { workspaceId: string; title?: string; emoji?: string | null; parentListId?: string | null; star?: boolean; sectionId?: string | null; visibility?: List['visibility'] }): { id: string } & ActionResult {
    const id = uuidv7();
    const siblings = this.store.all('lists').filter((l) => l.workspaceId === input.workspaceId && (l.parentListId ?? null) === (input.parentListId ?? null) && !l.deletedAt);
    const star = input.star !== false && !input.parentListId;
    const starItems = this.store.all('sectionItems').filter((i) => i.userId === this.ctx.userId && i.workspaceId === input.workspaceId && !i.deletedAt && (i.sectionId ?? null) === (input.sectionId ?? null));
    this.client.mutate('list.create', {
      id,
      workspaceId: input.workspaceId,
      parentListId: input.parentListId ?? null,
      title: input.title ?? '',
      emoji: input.emoji ?? null,
      visibility: input.visibility ?? 'private',
      position: positionAtEnd(siblings),
      star: star ? { itemId: uuidv7(), sectionId: input.sectionId ?? null, position: positionAtEnd(starItems) } : undefined,
    });
    return { id, label: 'List created', undo: () => this.client.mutate('list.delete', { id }) };
  }

  duplicateList(id: string, opts: { title?: string; clearDates?: boolean; clearAssignees?: boolean; copyAttachments?: boolean } = {}): { id: string } & ActionResult {
    const src = this.store.get('lists', id);
    if (!src) throw new AppError('not_found', 'List not found.');
    const listIdMap: Record<string, string> = {};
    const collectLists = (parentId: string) => {
      for (const l of this.store.all('lists')) {
        if (l.parentListId === parentId && !l.deletedAt && !listIdMap[l.id]) {
          listIdMap[l.id] = uuidv7();
          collectLists(l.id);
        }
      }
    };
    collectLists(id);
    const allLists = new Set([id, ...Object.keys(listIdMap)]);
    const taskIdMap: Record<string, string> = {};
    for (const t of this.store.all('tasks')) if (t.listId && allLists.has(t.listId) && !t.deletedAt) taskIdMap[t.id] = uuidv7();
    const newId = uuidv7();
    const siblings = this.store.all('lists').filter((l) => l.workspaceId === src.workspaceId && l.parentListId === src.parentListId && !l.deletedAt);
    const sorted = sortByPosition(siblings);
    const idx = sorted.findIndex((l) => l.id === id);
    this.client.mutate('list.duplicate', {
      id,
      newId,
      title: opts.title ?? `${src.title || 'Untitled list'} (copy)`,
      position: positionBetween(src.position, sorted[idx + 1]?.position ?? null),
      taskIdMap,
      listIdMap,
      clearDates: opts.clearDates ?? false,
      clearAssignees: opts.clearAssignees ?? true,
      copyAttachments: opts.copyAttachments ?? false,
    });
    return { id: newId, label: 'List duplicated', undo: () => this.client.mutate('list.delete', { id: newId }) };
  }

  deleteList(id: string): ActionResult {
    this.client.mutate('list.delete', { id });
    return { label: 'List deleted', undo: () => this.client.mutate('list.restore', { id }) };
  }

  archiveList(id: string, archived: boolean): ActionResult {
    this.client.mutate('list.archive', { id, archived });
    return { label: archived ? 'List archived' : 'List restored', undo: () => this.client.mutate('list.archive', { id, archived: !archived }) };
  }

  star(listId: string, sectionId: string | null = null): ActionResult {
    const list = this.store.get('lists', listId);
    if (!list) return {};
    const items = this.store.all('sectionItems').filter((i) => i.userId === this.ctx.userId && i.workspaceId === list.workspaceId && !i.deletedAt && (i.sectionId ?? null) === sectionId);
    this.client.mutate('list.star', { id: uuidv7(), listId, workspaceId: list.workspaceId, sectionId, position: positionAtEnd(items.map((i) => ({ id: i.id, position: i.position }))) });
    return { undo: () => this.client.mutate('list.unstar', { listId }) };
  }

  unstar(listId: string): ActionResult {
    const item = this.store.all('sectionItems').find((i) => i.listId === listId && i.userId === this.ctx.userId && !i.deletedAt);
    this.client.mutate('list.unstar', { listId });
    return item ? { undo: () => this.star(listId, item.sectionId) } : {};
  }

  createSection(workspaceId: string, name: string): { id: string } {
    const id = uuidv7();
    const sections = this.store.all('sections').filter((s) => s.userId === this.ctx.userId && s.workspaceId === workspaceId && !s.deletedAt);
    this.client.mutate('section.create', { id, workspaceId, name, position: positionAtEnd(sections) });
    return { id };
  }

  createLabel(workspaceId: string, name: string, color?: LabelColor): { id: string } {
    const id = uuidv7();
    const count = selectLabels(this.store, workspaceId).length;
    this.client.mutate('label.create', { id, workspaceId, name, color: color ?? nextColor(count) });
    return { id };
  }
}
