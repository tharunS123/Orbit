import type { Label, List, Notification, Profile, Section, SectionItem, Task, TaskMessage, Workspace, WorkspaceMember, WorkspaceRole } from '@orbit/shared';
import { addDays, civilDateOf, comparePositioned, dueBucket, todayIn, zonedToUtc, type CivilDate } from '@orbit/core';
import type { EntityStore } from './store';

/**
 * Pure view queries over the local store. Views read only from here so every platform shows the
 * same thing, and the logic is unit-testable without a UI.
 */

export interface ViewContext {
  userId: string;
  timeZone: string;
  now: Date;
  /** Restrict to one workspace; null = all workspaces. */
  workspaceId: string | null;
}

const alive = <T extends { deletedAt: string | null }>(x: T | undefined | null): x is T => Boolean(x && !x.deletedAt);

export function myMemberships(store: EntityStore, userId: string): WorkspaceMember[] {
  return store.all('workspaceMembers').filter((m) => m.userId === userId && !m.deletedAt);
}

export interface WorkspaceWithRole extends Workspace {
  role: WorkspaceRole;
}

export function selectWorkspaces(store: EntityStore, userId: string): WorkspaceWithRole[] {
  const out: WorkspaceWithRole[] = [];
  for (const m of myMemberships(store, userId)) {
    const ws = store.get('workspaces', m.workspaceId);
    if (alive(ws)) out.push({ ...ws, role: m.role });
  }
  return out.sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === 'personal' ? -1 : 1));
}

export function roleIn(store: EntityStore, userId: string, workspaceId: string): WorkspaceRole | null {
  return myMemberships(store, userId).find((m) => m.workspaceId === workspaceId)?.role ?? null;
}

export interface MemberWithProfile {
  member: WorkspaceMember;
  profile: Profile | undefined;
}

export function selectMembers(store: EntityStore, workspaceId: string): MemberWithProfile[] {
  return store
    .all('workspaceMembers')
    .filter((m) => m.workspaceId === workspaceId && !m.deletedAt)
    .map((member) => ({ member, profile: store.get('profiles', member.userId) }))
    .sort((a, b) => (a.profile?.displayName ?? '').localeCompare(b.profile?.displayName ?? ''));
}

/** People who can be assigned a task in a list (workspace members with list access). */
export function selectAssignable(store: EntityStore, workspaceId: string, listId: string | null): Profile[] {
  const members = selectMembers(store, workspaceId);
  if (!listId) return members.map((m) => m.profile).filter((p): p is Profile => Boolean(p));
  const list = store.get('lists', listId);
  if (!list) return [];
  const listMembers = new Set(store.all('listMembers').filter((m) => m.listId === listId && !m.deletedAt).map((m) => m.userId));
  return members
    .filter(({ member }) => member.userId === list.createdBy || listMembers.has(member.userId) || (list.visibility === 'workspace' && member.role !== 'guest'))
    .map((m) => m.profile)
    .filter((p): p is Profile => Boolean(p));
}

export function selectLabels(store: EntityStore, workspaceId: string | null): Label[] {
  return store
    .all('labels')
    .filter((l) => !l.deletedAt && (!workspaceId || l.workspaceId === workspaceId))
    .sort((a, b) => a.name.localeCompare(b.name));
}

function inScope(ctx: ViewContext, t: { workspaceId: string }) {
  return !ctx.workspaceId || t.workspaceId === ctx.workspaceId;
}

/** A task is visible in views if it and its list are alive (not deleted/archived). */
export function isTaskLive(store: EntityStore, t: Task): boolean {
  if (t.deletedAt) return false;
  if (t.listId) {
    const list = store.get('lists', t.listId);
    if (!list || list.deletedAt || list.archivedAt) return false;
  }
  return true;
}

export function isRelevantToMe(t: Task, userId: string): boolean {
  return t.assigneeId === userId || (t.assigneeId === null && t.createdBy === userId);
}

// ───────────── Inbox ─────────────
export interface InboxView {
  open: Task[];
  completedToday: Task[];
}

export function isInInbox(store: EntityStore, t: Task, userId: string): boolean {
  const state = store.userState(t.id);
  if (state && !state.deletedAt) {
    if (state.inInbox) return true;
    // Explicitly processed out of the inbox — but list-less tasks have nowhere else to live.
    return t.listId === null && t.parentTaskId === null && t.createdBy === userId;
  }
  if (t.parentTaskId) return false;
  if (t.listId === null && t.createdBy === userId) return true;
  // Assigned to me by someone else and not yet triaged.
  return t.assigneeId === userId && t.createdBy !== userId;
}

export function selectInbox(store: EntityStore, ctx: ViewContext): InboxView {
  const today = todayIn(ctx.timeZone, ctx.now);
  const open: Task[] = [];
  const completedToday: Task[] = [];
  for (const t of store.all('tasks')) {
    if (!inScope(ctx, t) || !isTaskLive(store, t) || !isInInbox(store, t, ctx.userId)) continue;
    if (t.completedAt) {
      if (civilDateOf(new Date(t.completedAt), ctx.timeZone) === today) completedToday.push(t);
    } else open.push(t);
  }
  const pos = (t: Task) => store.userState(t.id)?.inboxPosition ?? t.position;
  open.sort((a, b) => (pos(a) < pos(b) ? -1 : pos(a) > pos(b) ? 1 : a.id < b.id ? -1 : 1));
  completedToday.sort((a, b) => (b.completedAt ?? '').localeCompare(a.completedAt ?? ''));
  return { open, completedToday };
}

// ───────────── Today ─────────────
export interface TodayView {
  overdue: Task[];
  today: Task[];
  laterToday: Task[];
  completedToday: Task[];
}

export function selectToday(store: EntityStore, ctx: ViewContext): TodayView {
  const view: TodayView = { overdue: [], today: [], laterToday: [], completedToday: [] };
  const todayStr = todayIn(ctx.timeZone, ctx.now);
  for (const t of store.all('tasks')) {
    if (!inScope(ctx, t) || !isTaskLive(store, t) || !isRelevantToMe(t, ctx.userId)) continue;
    if (t.completedAt) {
      if (civilDateOf(new Date(t.completedAt), ctx.timeZone) === todayStr && t.dueDate) view.completedToday.push(t);
      continue;
    }
    // Recurring tasks advance on completion; a completed occurrence isn't "completed today".
    const bucket = dueBucket(t, ctx.timeZone, ctx.now);
    if (bucket === 'overdue') view.overdue.push(t);
    else if (bucket === 'today') (t.dueTime ? view.laterToday : view.today).push(t);
  }
  const todayPos = (t: Task) => store.userState(t.id)?.todayPosition ?? null;
  const byTodayOrder = (a: Task, b: Task) => {
    const pa = todayPos(a);
    const pb = todayPos(b);
    if (pa && pb && pa !== pb) return pa < pb ? -1 : 1;
    if (pa && !pb) return -1;
    if (!pa && pb) return 1;
    return comparePositioned(a, b);
  };
  const byTime = (a: Task, b: Task) => (a.dueAt ?? '').localeCompare(b.dueAt ?? '') || byTodayOrder(a, b);
  view.overdue.sort((a, b) => (a.dueDate ?? '').localeCompare(b.dueDate ?? '') || byTime(a, b));
  view.today.sort(byTodayOrder);
  view.laterToday.sort(byTime);
  view.completedToday.sort((a, b) => (b.completedAt ?? '').localeCompare(a.completedAt ?? ''));
  return view;
}

// ───────────── Upcoming ─────────────
export interface UpcomingDay {
  date: CivilDate;
  tasks: Task[];
}
export interface UpcomingView {
  overdue: Task[];
  days: UpcomingDay[];
  unscheduled: Task[];
}

/** Local civil date a task falls on for the viewer (timed tasks convert zones). */
export function taskViewDate(t: Task, timeZone: string): CivilDate | null {
  if (!t.dueDate) return null;
  if (!t.dueTime) return t.dueDate;
  return civilDateOf(zonedToUtc(t.dueDate, t.dueTime, t.dueTz ?? timeZone), timeZone);
}

export function selectUpcoming(
  store: EntityStore,
  ctx: ViewContext,
  range: { start: CivilDate; days: number },
  opts: { includeUnscheduled?: boolean; onlyMine?: boolean } = {},
): UpcomingView {
  const end = addDays(range.start, range.days - 1);
  const today = todayIn(ctx.timeZone, ctx.now);
  const byDate = new Map<CivilDate, Task[]>();
  const overdue: Task[] = [];
  const unscheduled: Task[] = [];
  for (const t of store.all('tasks')) {
    if (!inScope(ctx, t) || !isTaskLive(store, t) || t.completedAt) continue;
    if (opts.onlyMine !== false && !isRelevantToMe(t, ctx.userId)) continue;
    const date = taskViewDate(t, ctx.timeZone);
    if (!date) {
      if (opts.includeUnscheduled && !t.parentTaskId) unscheduled.push(t);
      continue;
    }
    if (date < today) {
      if (range.start <= today) overdue.push(t);
      continue;
    }
    if (date < range.start || date > end) continue;
    const arr = byDate.get(date) ?? [];
    arr.push(t);
    byDate.set(date, arr);
  }
  const days: UpcomingDay[] = [];
  for (let i = 0; i < range.days; i++) {
    const date = addDays(range.start, i);
    // All-day tasks first, then timed tasks by their actual instant (correct across zones).
    const tasks = (byDate.get(date) ?? []).sort((a, b) => (a.dueAt ?? '').localeCompare(b.dueAt ?? '') || comparePositioned(a, b));
    days.push({ date, tasks });
  }
  overdue.sort((a, b) => (a.dueDate ?? '').localeCompare(b.dueDate ?? ''));
  unscheduled.sort(comparePositioned);
  return { overdue, days, unscheduled };
}

// ───────────── Lists & sidebar ─────────────
export function selectListTasks(store: EntityStore, listId: string, opts: { showCompleted?: boolean } = {}): Task[] {
  return store
    .all('tasks')
    .filter((t) => t.listId === listId && t.parentTaskId === null && !t.deletedAt && (opts.showCompleted !== false || !t.completedAt))
    .sort(comparePositioned);
}

export function selectChildren(store: EntityStore, taskId: string, opts: { showCompleted?: boolean } = {}): Task[] {
  return store
    .childrenOf(taskId)
    .filter((t) => !t.deletedAt && (opts.showCompleted !== false || !t.completedAt))
    .sort(comparePositioned);
}

export function subtaskProgress(store: EntityStore, taskId: string): { done: number; total: number } {
  const kids = store.childrenOf(taskId).filter((t) => !t.deletedAt);
  return { done: kids.filter((k) => k.completedAt).length, total: kids.length };
}

export interface ListNode {
  list: List;
  children: ListNode[];
  openCount: number;
}

export function selectListTree(store: EntityStore, workspaceId: string, opts: { archived?: boolean } = {}): ListNode[] {
  const lists = store.all('lists').filter((l) => l.workspaceId === workspaceId && !l.deletedAt && Boolean(l.archivedAt) === Boolean(opts.archived));
  const counts = new Map<string, number>();
  for (const t of store.all('tasks')) {
    if (t.listId && !t.completedAt && !t.deletedAt && !t.parentTaskId) counts.set(t.listId, (counts.get(t.listId) ?? 0) + 1);
  }
  const ids = new Set(lists.map((l) => l.id));
  const byParent = new Map<string | null, List[]>();
  for (const l of lists) {
    const key = l.parentListId && ids.has(l.parentListId) ? l.parentListId : null;
    const arr = byParent.get(key) ?? [];
    arr.push(l);
    byParent.set(key, arr);
  }
  const build = (parent: string | null, depth: number): ListNode[] =>
    depth > 20
      ? []
      : (byParent.get(parent) ?? []).sort(comparePositioned).map((list) => ({ list, children: build(list.id, depth + 1), openCount: counts.get(list.id) ?? 0 }));
  return build(null, 0);
}

export interface SidebarSection {
  section: Section | null;
  items: { item: SectionItem; list: List }[];
}

/** Starred lists grouped by the user's sections (null section = "Starred"). */
export function selectSidebar(store: EntityStore, userId: string, workspaceId: string): SidebarSection[] {
  const sections = store.all('sections').filter((s) => s.userId === userId && s.workspaceId === workspaceId && !s.deletedAt).sort(comparePositioned);
  const items = store.all('sectionItems').filter((i) => i.userId === userId && i.workspaceId === workspaceId && !i.deletedAt);
  const withList = items
    .map((item) => ({ item, list: store.get('lists', item.listId) }))
    .filter((x): x is { item: SectionItem; list: List } => alive(x.list) && !x.list.archivedAt)
    .sort((a, b) => comparePositioned(a.item, b.item));
  const valid = new Set(sections.map((s) => s.id));
  return [
    { section: null, items: withList.filter((x) => !x.item.sectionId || !valid.has(x.item.sectionId)) },
    ...sections.map((section) => ({ section, items: withList.filter((x) => x.item.sectionId === section.id) })),
  ];
}

export function isStarred(store: EntityStore, userId: string, listId: string): boolean {
  return store.all('sectionItems').some((i) => i.userId === userId && i.listId === listId && !i.deletedAt);
}

/** Breadcrumb from the root list down to `listId`. */
export function listPath(store: EntityStore, listId: string): List[] {
  const out: List[] = [];
  let cur = store.get('lists', listId);
  const seen = new Set<string>();
  while (cur && !seen.has(cur.id)) {
    seen.add(cur.id);
    out.unshift(cur);
    cur = cur.parentListId ? store.get('lists', cur.parentListId) : undefined;
  }
  return out;
}

export function taskPath(store: EntityStore, taskId: string): Task[] {
  const out: Task[] = [];
  let cur = store.get('tasks', taskId);
  const seen = new Set<string>();
  while (cur && !seen.has(cur.id)) {
    seen.add(cur.id);
    out.unshift(cur);
    cur = cur.parentTaskId ? store.get('tasks', cur.parentTaskId) : undefined;
  }
  return out;
}

// ───────────── Updates ─────────────
export function selectNotifications(store: EntityStore, userId: string): { items: Notification[]; unread: number } {
  const items = store
    .all('notifications')
    .filter((n) => n.userId === userId && !n.deletedAt)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return { items, unread: items.filter((n) => !n.readAt).length };
}

export function selectPendingInvitations(store: EntityStore, email: string | null) {
  if (!email) return [];
  const now = new Date().toISOString();
  return store
    .all('workspaceInvitations')
    .filter((i) => i.status === 'pending' && i.email.toLowerCase() === email.toLowerCase() && i.expiresAt > now && !i.deletedAt);
}

export function selectMessages(store: EntityStore, taskId: string): TaskMessage[] {
  return store
    .all('taskMessages')
    .filter((m) => m.taskId === taskId)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

// ───────────── Trash ─────────────
export function selectTrash(store: EntityStore, ctx: ViewContext): { tasks: Task[]; lists: List[] } {
  const cutoff = new Date(ctx.now.getTime() - 30 * 86400_000).toISOString();
  const tasks = store
    .all('tasks')
    .filter((t) => t.deletedAt && t.deletedAt > cutoff && inScope(ctx, t))
    // Only show roots of deleted subtrees.
    .filter((t) => !t.parentTaskId || !store.get('tasks', t.parentTaskId)?.deletedAt)
    .sort((a, b) => (b.deletedAt ?? '').localeCompare(a.deletedAt ?? ''));
  const lists = store
    .all('lists')
    .filter((l) => l.deletedAt && l.deletedAt > cutoff && inScope(ctx, l))
    .filter((l) => !l.parentListId || !store.get('lists', l.parentListId)?.deletedAt)
    .sort((a, b) => (b.deletedAt ?? '').localeCompare(a.deletedAt ?? ''));
  return { tasks, lists };
}

// ───────────── Local search (offline command palette) ─────────────
export interface LocalHit {
  kind: 'task' | 'list';
  id: string;
  title: string;
  score: number;
}

export function searchLocal(store: EntityStore, q: string, limit = 12): LocalHit[] {
  const needle = q.trim().toLowerCase();
  if (!needle) return [];
  const words = needle.split(/\s+/);
  const score = (text: string) => {
    const hay = text.toLowerCase();
    if (!words.every((w) => hay.includes(w))) return 0;
    return (hay.startsWith(needle) ? 3 : 0) + (hay.includes(needle) ? 2 : 1) - hay.length / 1000;
  };
  const hits: LocalHit[] = [];
  for (const l of store.all('lists')) {
    if (l.deletedAt) continue;
    const s = score(l.title);
    if (s > 0) hits.push({ kind: 'list', id: l.id, title: l.title || 'Untitled list', score: s + 0.5 });
  }
  for (const t of store.all('tasks')) {
    if (t.deletedAt) continue;
    const s = score(t.title);
    if (s > 0) hits.push({ kind: 'task', id: t.id, title: t.title, score: s - (t.completedAt ? 1 : 0) });
  }
  return hits.sort((a, b) => b.score - a.score).slice(0, limit);
}
