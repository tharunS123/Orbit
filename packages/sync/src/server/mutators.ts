import {
  AppError,
  profileSettingsSchema,
  type Recurrence,
  type Task,
} from '@orbit/shared';
import {
  advanceRecurrence,
  isValidTimeZone,
  normalizeRecurrence,
  planLimits,
  withinLimit,
  type PlanId,
} from '@orbit/core';
import type { Tx } from '@orbit/database';
import { deterministicId } from '../client/apply';
import type { MutatorArgs, MutatorName } from '../mutators';
import { copyDocument } from './documents';

/**
 * Authoritative mutator implementations. Every statement runs inside `asUser` (RLS enforced);
 * the explicit checks here exist to return precise errors, enforce plan limits and rules RLS
 * cannot express, and to record activity/notifications.
 */

export interface ServerCtx {
  tx: Tx;
  userId: string;
  now: Date;
  plan(): Promise<PlanId>;
  /** Enqueue a background job in the same transaction (committed atomically). */
  enqueue(name: string, data: Record<string, unknown>, opts?: { singletonKey?: string; startAfter?: Date }): Promise<void>;
}

type TaskRow = Task;

/** JSON parameter that stays SQL NULL for null/undefined (tx.json(null) would store JSON null). */
const j = (tx: Tx, value: unknown) => (value == null ? null : tx.json(value as never));

async function loadTask(ctx: ServerCtx, id: string, opts: { allowDeleted?: boolean } = {}): Promise<TaskRow> {
  const [row] = await ctx.tx<TaskRow[]>`select * from tasks where id = ${id}`;
  if (!row) throw new AppError('not_found', 'That task no longer exists or you lost access to it.', { id });
  if (row.deletedAt && !opts.allowDeleted) throw new AppError('deleted', 'This task was deleted.', { id });
  return row;
}

async function loadList(ctx: ServerCtx, id: string) {
  const [row] = await ctx.tx<{ id: string; workspaceId: string; parentListId: string | null; deletedAt: string | null; title: string; visibility: string; createdBy: string }[]>`
    select id, workspace_id, parent_list_id, deleted_at, title, visibility, created_by from lists where id = ${id}`;
  if (!row) throw new AppError('not_found', 'That list no longer exists or you lost access to it.', { id });
  if (row.deletedAt) throw new AppError('deleted', 'That list was deleted.', { id });
  return row;
}

async function requireListEditable(ctx: ServerCtx, listId: string) {
  const list = await loadList(ctx, listId);
  const [lvl] = await ctx.tx<{ level: number }[]>`select app.list_level(${listId}) as level`;
  if ((lvl?.level ?? 0) < 2) throw new AppError('forbidden', 'You can view this list but not edit it.');
  return list;
}

function validateTz(tz: string | null | undefined) {
  if (tz && !isValidTimeZone(tz)) throw new AppError('validation', `Unknown time zone "${tz}".`);
}

async function activity(ctx: ServerCtx, ev: { workspaceId: string; taskId?: string | null; listId?: string | null; type: string; data?: Record<string, unknown> }) {
  await ctx.tx`insert into activity_events (workspace_id, task_id, list_id, actor_id, type, data)
               values (${ev.workspaceId}, ${ev.taskId ?? null}, ${ev.listId ?? null}, ${ctx.userId}, ${ev.type}, ${j(ctx.tx, (ev.data ?? {}))})`;
}

async function notify(
  ctx: ServerCtx,
  n: { userId: string; workspaceId: string | null; type: string; taskId?: string | null; listId?: string | null; data?: Record<string, unknown>; dedupeKey?: string },
) {
  if (n.userId === ctx.userId) return;
  const [res] = await ctx.tx<{ created: boolean }[]>`
    select app.notify(${n.userId}, ${n.workspaceId}, ${n.type}, ${n.taskId ?? null}, ${n.listId ?? null},
                      ${j(ctx.tx, n.data ?? {})}, ${n.dedupeKey ?? null}) as created`;
  if (!res?.created) return;
  await ctx.enqueue('notification.deliver', { userId: n.userId, type: n.type, taskId: n.taskId ?? null, listId: n.listId ?? null }, {
    singletonKey: `push:${n.userId}`,
  });
}

async function assertAssignable(ctx: ServerCtx, task: { workspaceId: string; listId: string | null }, assigneeId: string) {
  const [row] = await ctx.tx<{ member: boolean; level: number }[]>`
    select app.is_workspace_member(${task.workspaceId}, ${assigneeId}) as member,
           case when ${task.listId}::uuid is null then 3 else app.user_list_level(${assigneeId}, ${task.listId}) end as level`;
  if (!row?.member) throw new AppError('validation', 'That person is not a member of this workspace.');
  if (row.level < 1) throw new AppError('validation', 'That person does not have access to this list. Share it with them first.');
}

async function filterLabels(ctx: ServerCtx, workspaceId: string, ids: string[]): Promise<string[]> {
  if (!ids.length) return [];
  const rows = await ctx.tx<{ id: string }[]>`select id from labels where workspace_id = ${workspaceId} and id = any(${ids}::uuid[]) and deleted_at is null`;
  return rows.map((r) => r.id);
}

async function setUserState(ctx: ServerCtx, task: { id: string; workspaceId: string }, patch: { inInbox?: boolean; inboxPosition?: string | null; todayPosition?: string | null }) {
  const id = deterministicId(ctx.userId, task.id);
  await ctx.tx`
    insert into task_user_states (id, user_id, task_id, workspace_id, in_inbox, inbox_position, today_position)
    values (${id}, ${ctx.userId}, ${task.id}, ${task.workspaceId}, ${patch.inInbox ?? false}, ${patch.inboxPosition ?? null}, ${patch.todayPosition ?? null})
    on conflict (user_id, task_id) do update set
      in_inbox = case when ${patch.inInbox === undefined} then task_user_states.in_inbox else excluded.in_inbox end,
      inbox_position = case when ${patch.inboxPosition === undefined} then task_user_states.inbox_position else excluded.inbox_position end,
      today_position = case when ${patch.todayPosition === undefined} then task_user_states.today_position else excluded.today_position end,
      deleted_at = null`;
}

async function subtreeIds(ctx: ServerCtx, rootId: string): Promise<string[]> {
  const rows = await ctx.tx<{ id: string }[]>`
    with recursive sub as (
      select id from tasks where parent_task_id = ${rootId}
      union all
      select t.id from tasks t join sub on t.parent_task_id = sub.id
    ) select id from sub`;
  return rows.map((r) => r.id);
}

async function completeTask(ctx: ServerCtx, task: TaskRow, completed: boolean, today: string) {
  if (!completed) {
    if (!task.completedAt) return;
    await ctx.tx`update tasks set completed_at = null, completed_by = null where id = ${task.id}`;
    await ctx.tx`update task_completions set undone_at = now()
                 where id = (select id from task_completions where task_id = ${task.id} and user_id = ${ctx.userId} and undone_at is null
                              order by completed_at desc limit 1)`;
    await activity(ctx, { workspaceId: task.workspaceId, taskId: task.id, listId: task.listId, type: 'reopened' });
    return;
  }
  if (task.completedAt) return;
  await ctx.tx`insert into task_completions (task_id, workspace_id, user_id, occurrence_date)
               values (${task.id}, ${task.workspaceId}, ${ctx.userId}, ${task.dueDate})`;
  if (task.recurrence && task.dueDate) {
    const { nextDueDate, occurrenceCount } = advanceRecurrence(task.recurrence, task.dueDate, today, task.occurrenceCount, today);
    if (nextDueDate) {
      await ctx.tx`update tasks set due_date = ${nextDueDate}, occurrence_count = ${occurrenceCount}, completed_at = null, completed_by = null
                   where id = ${task.id}`;
      const subs = await subtreeIds(ctx, task.id);
      if (subs.length) await ctx.tx`update tasks set completed_at = null, completed_by = null where id = any(${subs}::uuid[]) and completed_at is not null`;
      await activity(ctx, { workspaceId: task.workspaceId, taskId: task.id, listId: task.listId, type: 'completed_occurrence', data: { occurrence: task.dueDate, next: nextDueDate } });
      return;
    }
    await ctx.tx`update tasks set occurrence_count = ${occurrenceCount}, completed_at = now(), completed_by = ${ctx.userId} where id = ${task.id}`;
  } else {
    await ctx.tx`update tasks set completed_at = now(), completed_by = ${ctx.userId} where id = ${task.id}`;
  }
  await activity(ctx, { workspaceId: task.workspaceId, taskId: task.id, listId: task.listId, type: 'completed' });
  for (const uid of new Set([task.createdBy, task.assigneeId].filter((u): u is string => Boolean(u)))) {
    await notify(ctx, { userId: uid, workspaceId: task.workspaceId, type: 'task_updated', taskId: task.id, listId: task.listId, data: { event: 'completed', title: task.title }, dedupeKey: `completed:${task.id}` });
  }
}

async function checkListQuota(ctx: ServerCtx, parentListId: string | null) {
  const limits = planLimits(await ctx.plan());
  const [row] = await ctx.tx<{ count: number }[]>`select app.active_list_count(${ctx.userId}) as count`;
  if (!withinLimit(limits.maxLists, row?.count ?? 0)) {
    throw new AppError('quota_exceeded', `Your plan includes ${limits.maxLists} active lists. Archive a list or upgrade to add more.`, { limit: limits.maxLists, feature: 'lists' });
  }
  if (parentListId && limits.maxNestingDepth !== null) {
    const [d] = await ctx.tx<{ depth: number }[]>`
      with recursive up as (
        select id, parent_list_id, 1 as depth from lists where id = ${parentListId}
        union all select l.id, l.parent_list_id, up.depth + 1 from lists l join up on l.id = up.parent_list_id where up.depth < 60
      ) select max(depth)::int as depth from up`;
    // depth = number of ancestors the new list will have = its nesting level.
    if ((d?.depth ?? 0) > limits.maxNestingDepth) {
      throw new AppError('plan_required', 'Deeper nesting of lists is available on Plus.', { feature: 'nested_lists_unlimited' });
    }
  }
}

function normalizeRule(rule: Recurrence | null | undefined, dueDate: string | null): Recurrence | null {
  if (!rule) return null;
  return dueDate ? normalizeRecurrence(rule, dueDate) : rule;
}

type Impl = { [N in MutatorName]: (ctx: ServerCtx, args: MutatorArgs<N>) => Promise<void> };

export const serverMutators: Impl = {
  async 'task.create'(ctx, a) {
    let workspaceId = a.workspaceId;
    let listId = a.listId;
    if (a.parentTaskId) {
      const parent = await loadTask(ctx, a.parentTaskId);
      workspaceId = parent.workspaceId;
      listId = parent.listId;
      if (listId) await requireListEditable(ctx, listId);
    } else if (listId) {
      const list = await requireListEditable(ctx, listId);
      if (list.workspaceId !== workspaceId) throw new AppError('validation', 'List belongs to another workspace.');
    }
    validateTz(a.dueTz);
    const dueDate = a.dueDate ?? null;
    const labelIds = await filterLabels(ctx, workspaceId, a.labelIds);
    if (a.assigneeId) await assertAssignable(ctx, { workspaceId, listId }, a.assigneeId);
    const exists = await ctx.tx`select 1 from tasks where id = ${a.id}`;
    if (exists.length) return; // replay of an already-created task (e.g. duplicate submit)
    await ctx.tx`
      insert into tasks (id, workspace_id, list_id, parent_task_id, created_by, assignee_id, title, position,
                         completed_at, completed_by, due_date, due_time, due_tz, reminders, recurrence, label_ids, source)
      values (${a.id}, ${workspaceId}, ${listId}, ${a.parentTaskId}, ${ctx.userId}, ${a.assigneeId}, ${a.title}, ${a.position},
              ${a.completed ? ctx.now : null}, ${a.completed ? ctx.userId : null}, ${dueDate}, ${dueDate ? (a.dueTime ?? null) : null},
              ${a.dueTz ?? null}, ${j(ctx.tx, a.reminders)}, ${j(ctx.tx, normalizeRule(a.recurrence, dueDate))},
              ${labelIds}::uuid[], ${j(ctx.tx, a.source)})`;
    if (a.inInbox) await setUserState(ctx, { id: a.id, workspaceId }, { inInbox: true, inboxPosition: a.inboxPosition ?? a.position });
    await activity(ctx, { workspaceId, taskId: a.id, listId, type: 'created', data: a.source ? { source: a.source.provider } : {} });
    if (a.assigneeId) {
      await notify(ctx, { userId: a.assigneeId, workspaceId, type: 'task_assigned', taskId: a.id, listId, data: { title: a.title } });
    }
  },

  async 'task.update'(ctx, a) {
    const task = await loadTask(ctx, a.id);
    const p = a.patch;
    validateTz(p.dueTz);
    if (p.assigneeId) await assertAssignable(ctx, task, p.assigneeId);
    const dueDate = p.dueDate !== undefined ? p.dueDate : task.dueDate;
    const set: Record<string, unknown> = {};
    if (p.title !== undefined) set.title = p.title;
    if (p.dueDate !== undefined) set.due_date = p.dueDate;
    if (p.dueDate === null) set.due_time = null;
    else if (p.dueTime !== undefined) set.due_time = dueDate ? p.dueTime : null;
    if (p.dueTz !== undefined) set.due_tz = p.dueTz;
    if (p.reminders !== undefined) set.reminders = j(ctx.tx, p.reminders);
    if (p.recurrence !== undefined) set.recurrence = j(ctx.tx, normalizeRule(p.recurrence, dueDate ?? null));
    if (p.assigneeId !== undefined) set.assignee_id = p.assigneeId;
    if (p.occurrenceCount !== undefined) set.occurrence_count = p.occurrenceCount;
    if (!Object.keys(set).length) return;
    await ctx.tx`update tasks set ${ctx.tx(set as never)} where id = ${a.id}`;

    if (p.title !== undefined && p.title !== task.title)
      await activity(ctx, { workspaceId: task.workspaceId, taskId: task.id, listId: task.listId, type: 'title_changed', data: { from: task.title, to: p.title } });
    if ((p.dueDate !== undefined && p.dueDate !== task.dueDate) || (p.dueTime !== undefined && p.dueTime !== task.dueTime))
      await activity(ctx, { workspaceId: task.workspaceId, taskId: task.id, listId: task.listId, type: 'due_changed', data: { from: task.dueDate, to: dueDate, time: p.dueTime ?? task.dueTime } });
    if (p.recurrence !== undefined)
      await activity(ctx, { workspaceId: task.workspaceId, taskId: task.id, listId: task.listId, type: 'recurrence_changed', data: { to: p.recurrence } });
    if (p.reminders !== undefined)
      await activity(ctx, { workspaceId: task.workspaceId, taskId: task.id, listId: task.listId, type: 'reminders_changed', data: { count: p.reminders.length } });
    if (p.assigneeId !== undefined && p.assigneeId !== task.assigneeId) {
      await activity(ctx, { workspaceId: task.workspaceId, taskId: task.id, listId: task.listId, type: 'assignee_changed', data: { from: task.assigneeId, to: p.assigneeId } });
      if (p.assigneeId)
        await notify(ctx, { userId: p.assigneeId, workspaceId: task.workspaceId, type: 'task_assigned', taskId: task.id, listId: task.listId, data: { title: p.title ?? task.title } });
    }
  },

  async 'task.setCompleted'(ctx, a) {
    for (const id of a.ids) {
      const task = await loadTask(ctx, id);
      await completeTask(ctx, task, a.completed, a.today);
    }
  },

  async 'task.skipOccurrence'(ctx, a) {
    const task = await loadTask(ctx, a.id);
    if (!task.recurrence || !task.dueDate) throw new AppError('validation', 'Only repeating tasks can skip an occurrence.');
    const { nextDueDate } = advanceRecurrence(task.recurrence, task.dueDate, a.today, task.occurrenceCount);
    if (!nextDueDate) throw new AppError('validation', 'This is the last occurrence.');
    await ctx.tx`update tasks set due_date = ${nextDueDate} where id = ${task.id}`;
    await activity(ctx, { workspaceId: task.workspaceId, taskId: task.id, listId: task.listId, type: 'occurrence_skipped', data: { skipped: task.dueDate, next: nextDueDate } });
  },

  async 'task.move'(ctx, a) {
    let targetWorkspace: string | null = null;
    let targetList = a.listId;
    if (a.parentTaskId) {
      const parent = await loadTask(ctx, a.parentTaskId);
      targetWorkspace = parent.workspaceId;
      targetList = parent.listId;
      if (a.ids.includes(parent.id)) throw new AppError('validation', 'A task cannot be moved into itself.');
    } else if (a.listId) {
      targetWorkspace = (await requireListEditable(ctx, a.listId)).workspaceId;
    }
    if (targetList) await requireListEditable(ctx, targetList);
    for (const id of a.ids) {
      const task = await loadTask(ctx, id);
      if (targetWorkspace && task.workspaceId !== targetWorkspace)
        throw new AppError('validation', 'Moving tasks between workspaces is not supported yet. Duplicate instead.');
      await ctx.tx`update tasks set list_id = ${a.parentTaskId ? task.listId : a.listId}, parent_task_id = ${a.parentTaskId},
                   position = ${a.positions[id] ?? task.position} where id = ${id}`;
      if (!a.listId && !a.parentTaskId) await setUserState(ctx, task, { inInbox: true });
      if (task.listId !== targetList || task.parentTaskId !== a.parentTaskId)
        await activity(ctx, { workspaceId: task.workspaceId, taskId: id, listId: targetList, type: 'moved', data: { fromList: task.listId, toList: targetList, fromParent: task.parentTaskId, toParent: a.parentTaskId } });
    }
  },

  async 'task.reorder'(ctx, a) {
    for (const u of a.updates) {
      const res = await ctx.tx`update tasks set position = ${u.position} where id = ${u.id} and deleted_at is null returning id`;
      if (!res.length) await loadTask(ctx, u.id); // throws the precise error
    }
  },

  async 'task.setLabels'(ctx, a) {
    const tasks = await ctx.tx<{ id: string; workspaceId: string }[]>`select id, workspace_id from tasks where id = any(${a.ids}::uuid[]) and deleted_at is null`;
    if (!tasks.length) throw new AppError('not_found', 'Those tasks no longer exist.');
    for (const t of tasks) {
      const add = await filterLabels(ctx, t.workspaceId, a.add);
      await ctx.tx`
        update tasks set label_ids = coalesce((
          select array_agg(distinct l) from unnest(label_ids || ${add}::uuid[]) as l where not (l = any(${a.remove}::uuid[]))
        ), '{}') where id = ${t.id}`;
      await activity(ctx, { workspaceId: t.workspaceId, taskId: t.id, type: 'labels_changed', data: { added: add, removed: a.remove } });
    }
  },

  async 'task.setDue'(ctx, a) {
    for (const id of a.ids) await serverMutators['task.update'](ctx, { id, patch: { dueDate: a.dueDate, dueTime: a.dueTime, dueTz: a.dueTz } });
  },

  async 'task.assign'(ctx, a) {
    for (const id of a.ids) await serverMutators['task.update'](ctx, { id, patch: { assigneeId: a.assigneeId } });
  },

  async 'task.delete'(ctx, a) {
    for (const id of a.ids) {
      const task = await loadTask(ctx, id, { allowDeleted: true });
      if (task.deletedAt) continue;
      const subs = await subtreeIds(ctx, id);
      await ctx.tx`update tasks set deleted_at = ${ctx.now} where id = any(${[id, ...subs]}::uuid[]) and deleted_at is null`;
      await activity(ctx, { workspaceId: task.workspaceId, taskId: id, listId: task.listId, type: 'deleted' });
    }
  },

  async 'task.restore'(ctx, a) {
    for (const id of a.ids) {
      const task = await loadTask(ctx, id, { allowDeleted: true });
      if (!task.deletedAt) continue;
      if (task.listId) await loadList(ctx, task.listId);
      const subs = await subtreeIds(ctx, id);
      await ctx.tx`update tasks set deleted_at = null where id = ${id}`;
      if (subs.length) await ctx.tx`update tasks set deleted_at = null where id = any(${subs}::uuid[]) and deleted_at = ${task.deletedAt}`;
      await activity(ctx, { workspaceId: task.workspaceId, taskId: id, listId: task.listId, type: 'restored' });
    }
  },

  async 'task.setInbox'(ctx, a) {
    for (const id of a.ids) {
      const task = await loadTask(ctx, id);
      await setUserState(ctx, task, { inInbox: a.inInbox, ...(a.positions?.[id] ? { inboxPosition: a.positions[id] } : {}) });
    }
  },

  async 'task.setTodayOrder'(ctx, a) {
    for (const u of a.updates) {
      const task = await loadTask(ctx, u.id);
      await setUserState(ctx, task, { todayPosition: u.position });
    }
  },

  async 'task.duplicate'(ctx, a) {
    const source = await loadTask(ctx, a.rootId);
    if (source.listId) await requireListEditable(ctx, source.listId);
    const subtree = new Set([a.rootId, ...(await subtreeIds(ctx, a.rootId))]);
    for (const oldId of Object.keys(a.idMap)) if (!subtree.has(oldId)) throw new AppError('validation', 'Duplicate map includes unrelated tasks.');
    const rows = await ctx.tx<TaskRow[]>`select * from tasks where id = any(${[...subtree]}::uuid[]) and deleted_at is null order by created_at`;
    const byId = new Map(rows.map((r) => [r.id, r]));
    // Insert parents before children.
    const ordered: TaskRow[] = [];
    const visit = (t: TaskRow) => {
      if (ordered.includes(t)) return;
      if (t.id !== a.rootId && t.parentTaskId && byId.get(t.parentTaskId)) visit(byId.get(t.parentTaskId)!);
      ordered.push(t);
    };
    rows.forEach(visit);
    for (const t of ordered) {
      const newId = a.idMap[t.id];
      if (!newId) continue;
      const isRoot = t.id === a.rootId;
      const parent = isRoot ? t.parentTaskId : (a.idMap[t.parentTaskId!] ?? null);
      await ctx.tx`
        insert into tasks (id, workspace_id, list_id, parent_task_id, created_by, assignee_id, title, position, completed_at, completed_by,
                           due_date, due_time, due_tz, reminders, recurrence, label_ids)
        values (${newId}, ${t.workspaceId}, ${t.listId}, ${parent}, ${ctx.userId}, ${a.clearAssignees ? null : t.assigneeId}, ${t.title},
                ${isRoot ? a.position : t.position},
                ${a.resetCompletion ? null : t.completedAt}, ${a.resetCompletion ? null : t.completedBy},
                ${a.clearDates ? null : t.dueDate}, ${a.clearDates ? null : t.dueTime}, ${t.dueTz}, ${j(ctx.tx, t.reminders)},
                ${j(ctx.tx, (a.clearDates ? null : t.recurrence))}, ${t.labelIds}::uuid[])
        on conflict (id) do nothing`;
      await copyDocument(ctx.tx, `task:${t.id}`, `task:${newId}`, { taskId: newId, workspaceId: t.workspaceId }, a.idMap);
    }
    await activity(ctx, { workspaceId: source.workspaceId, taskId: a.idMap[a.rootId]!, listId: source.listId, type: 'duplicated', data: { from: source.id } });
  },

  async 'list.create'(ctx, a) {
    const [role] = await ctx.tx<{ role: string | null }[]>`select app.workspace_role(${a.workspaceId}) as role`;
    if (!role?.role) throw new AppError('forbidden', 'You are not a member of this workspace.');
    if (role.role === 'guest') throw new AppError('forbidden', 'Guests cannot create lists.');
    if (a.parentListId) {
      const parent = await requireListEditable(ctx, a.parentListId);
      if (parent.workspaceId !== a.workspaceId) throw new AppError('validation', 'Parent list is in another workspace.');
    }
    const exists = await ctx.tx`select 1 from lists where id = ${a.id}`;
    if (exists.length) return;
    await checkListQuota(ctx, a.parentListId);
    await ctx.tx`
      insert into lists (id, workspace_id, parent_list_id, created_by, title, emoji, visibility, position)
      values (${a.id}, ${a.workspaceId}, ${a.parentListId}, ${ctx.userId}, ${a.title}, ${a.emoji}, ${a.visibility}, ${a.position})`;
    if (a.star) {
      await ctx.tx`
        insert into section_items (id, user_id, workspace_id, section_id, list_id, position)
        values (${a.star.itemId}, ${ctx.userId}, ${a.workspaceId}, ${a.star.sectionId}, ${a.id}, ${a.star.position})
        on conflict (user_id, list_id) do update set section_id = excluded.section_id, position = excluded.position, deleted_at = null`;
    }
    await activity(ctx, { workspaceId: a.workspaceId, listId: a.id, type: 'list_created' });
  },

  async 'list.update'(ctx, a) {
    const list = await requireListEditable(ctx, a.id);
    const p = a.patch;
    const set: Record<string, unknown> = {};
    if (p.title !== undefined) set.title = p.title;
    if (p.emoji !== undefined) set.emoji = p.emoji;
    if (p.description !== undefined) set.description = p.description;
    if (p.coverPath !== undefined) set.cover_path = p.coverPath;
    if (p.visibility !== undefined) set.visibility = p.visibility;
    if (p.position !== undefined) set.position = p.position;
    if (p.parentListId !== undefined) {
      if (p.parentListId) {
        const parent = await requireListEditable(ctx, p.parentListId);
        if (parent.workspaceId !== list.workspaceId) throw new AppError('validation', 'Parent list is in another workspace.');
        const limits = planLimits(await ctx.plan());
        if (limits.maxNestingDepth !== null && parent.parentListId)
          throw new AppError('plan_required', 'Deeper nesting of lists is available on Plus.', { feature: 'nested_lists_unlimited' });
      }
      set.parent_list_id = p.parentListId;
    }
    if (!Object.keys(set).length) return;
    await ctx.tx`update lists set ${ctx.tx(set as never)} where id = ${a.id}`;
    if (p.visibility !== undefined && p.visibility !== list.visibility)
      await activity(ctx, { workspaceId: list.workspaceId, listId: list.id, type: 'visibility_changed', data: { from: list.visibility, to: p.visibility } });
  },

  async 'list.archive'(ctx, a) {
    const list = await loadList(ctx, a.id);
    if (!a.archived) await checkListQuota(ctx, null);
    await ctx.tx`update lists set archived_at = ${a.archived ? ctx.now : null} where id = ${a.id}`;
    await activity(ctx, { workspaceId: list.workspaceId, listId: list.id, type: a.archived ? 'list_archived' : 'list_unarchived' });
  },

  async 'list.delete'(ctx, a) {
    const [list] = await ctx.tx<{ workspaceId: string; deletedAt: string | null }[]>`select workspace_id, deleted_at from lists where id = ${a.id}`;
    if (!list) throw new AppError('not_found', 'List not found.');
    if (list.deletedAt) return;
    await ctx.tx`
      with recursive sub as (
        select id from lists where id = ${a.id}
        union all select l.id from lists l join sub on l.parent_list_id = sub.id
      ) update lists set deleted_at = ${ctx.now} where id in (select id from sub) and deleted_at is null`;
    await activity(ctx, { workspaceId: list.workspaceId, listId: a.id, type: 'list_deleted' });
  },

  async 'list.restore'(ctx, a) {
    const [list] = await ctx.tx<{ workspaceId: string; deletedAt: string | null }[]>`select workspace_id, deleted_at from lists where id = ${a.id}`;
    if (!list?.deletedAt) return;
    await checkListQuota(ctx, null);
    await ctx.tx`
      with recursive sub as (
        select id from lists where id = ${a.id}
        union all select l.id from lists l join sub on l.parent_list_id = sub.id
      ) update lists set deleted_at = null where id in (select id from sub) and deleted_at = ${list.deletedAt}`;
    await activity(ctx, { workspaceId: list.workspaceId, listId: a.id, type: 'list_restored' });
  },

  async 'list.duplicate'(ctx, a) {
    const src = await loadList(ctx, a.id);
    await checkListQuota(ctx, src.parentListId);
    const [full] = await ctx.tx<{ emoji: string | null; description: string | null; coverPath: string | null; parentListId: string | null }[]>`
      select emoji, description, cover_path, parent_list_id from lists where id = ${a.id}`;
    await ctx.tx`insert into lists (id, workspace_id, parent_list_id, created_by, title, emoji, description, cover_path, visibility, position)
                 values (${a.newId}, ${src.workspaceId}, ${full!.parentListId}, ${ctx.userId}, ${a.title}, ${full!.emoji}, ${full!.description},
                         ${full!.coverPath}, 'private', ${a.position})`;
    // Sublists (parents first).
    const subs = await ctx.tx<{ id: string; parentListId: string; title: string; emoji: string | null; position: string; depth: number }[]>`
      with recursive sub as (
        select id, parent_list_id, title, emoji, position, 1 as depth from lists where parent_list_id = ${a.id} and deleted_at is null
        union all select l.id, l.parent_list_id, l.title, l.emoji, l.position, sub.depth + 1 from lists l join sub on l.parent_list_id = sub.id where l.deleted_at is null
      ) select * from sub order by depth`;
    const listMap: Record<string, string> = { [a.id]: a.newId, ...a.listIdMap };
    for (const s of subs) {
      const newId = a.listIdMap[s.id];
      if (!newId) continue;
      await ctx.tx`insert into lists (id, workspace_id, parent_list_id, created_by, title, emoji, visibility, position)
                   values (${newId}, ${src.workspaceId}, ${listMap[s.parentListId] ?? a.newId}, ${ctx.userId}, ${s.title}, ${s.emoji}, 'private', ${s.position})`;
    }
    const allLists = Object.keys(listMap);
    const tasks = await ctx.tx<TaskRow[]>`
      select * from tasks where list_id = any(${allLists}::uuid[]) and deleted_at is null
      order by (parent_task_id is not null), created_at`;
    const byId = new Map(tasks.map((t) => [t.id, t]));
    const inserted = new Set<string>();
    const insertTask = async (t: TaskRow): Promise<void> => {
      if (inserted.has(t.id)) return;
      const newId = a.taskIdMap[t.id];
      if (!newId) return;
      if (t.parentTaskId && byId.has(t.parentTaskId)) await insertTask(byId.get(t.parentTaskId)!);
      inserted.add(t.id);
      const newParent = t.parentTaskId ? (a.taskIdMap[t.parentTaskId] ?? null) : null;
      if (t.parentTaskId && !newParent) return; // parent not copied → skip orphan
      await ctx.tx`
        insert into tasks (id, workspace_id, list_id, parent_task_id, created_by, assignee_id, title, position,
                           due_date, due_time, due_tz, reminders, recurrence, label_ids)
        values (${newId}, ${t.workspaceId}, ${newParent ? null : (listMap[t.listId!] ?? a.newId)}, ${newParent}, ${ctx.userId},
                ${a.clearAssignees ? null : t.assigneeId}, ${t.title}, ${t.position},
                ${a.clearDates ? null : t.dueDate}, ${a.clearDates ? null : t.dueTime}, ${t.dueTz},
                ${j(ctx.tx, (a.clearDates ? [] : t.reminders))}, ${j(ctx.tx, (a.clearDates ? null : t.recurrence))},
                ${t.labelIds}::uuid[])`;
      await copyDocument(ctx.tx, `task:${t.id}`, `task:${newId}`, { taskId: newId, workspaceId: t.workspaceId }, a.taskIdMap, listMap);
    };
    for (const t of tasks) await insertTask(t);
    for (const [oldList, newList] of Object.entries(listMap)) {
      await copyDocument(ctx.tx, `list:${oldList}`, `list:${newList}`, { listId: newList, workspaceId: src.workspaceId }, a.taskIdMap, listMap);
    }
    if (a.copyAttachments) {
      await ctx.enqueue('attachments.copy', { userId: ctx.userId, taskIdMap: a.taskIdMap, listIdMap: listMap });
    }
    await activity(ctx, { workspaceId: src.workspaceId, listId: a.newId, type: 'list_duplicated', data: { from: a.id } });
  },

  async 'list.share'(ctx, a) {
    const list = await loadList(ctx, a.listId);
    const [can] = await ctx.tx<{ ok: boolean }[]>`select app.can_share_list(${a.listId}) as ok`;
    if (!can?.ok) throw new AppError('forbidden', 'You cannot share this list.');
    const [member] = await ctx.tx<{ ok: boolean }[]>`select app.is_workspace_member(${list.workspaceId}, ${a.userId}) as ok`;
    if (!member?.ok) throw new AppError('validation', 'Invite this person to the workspace first.');
    const limits = planLimits(await ctx.plan());
    const [count] = await ctx.tx<{ n: number }[]>`select count(*)::int as n from list_members where list_id = ${a.listId} and deleted_at is null`;
    if (!withinLimit(limits.maxCollaboratorsPerList, count?.n ?? 0))
      throw new AppError('quota_exceeded', `Your plan allows ${limits.maxCollaboratorsPerList} collaborators per list.`, { feature: 'collaborators' });
    await ctx.tx`
      insert into list_members (id, list_id, workspace_id, user_id, role, added_by)
      values (${a.memberId}, ${a.listId}, ${list.workspaceId}, ${a.userId}, ${a.role}, ${ctx.userId})
      on conflict (list_id, user_id) do update set role = excluded.role, deleted_at = null, added_by = excluded.added_by`;
    if (list.visibility === 'private') await ctx.tx`update lists set visibility = 'shared' where id = ${a.listId}`;
    await activity(ctx, { workspaceId: list.workspaceId, listId: list.id, type: 'list_shared', data: { userId: a.userId, role: a.role } });
    await notify(ctx, { userId: a.userId, workspaceId: list.workspaceId, type: 'list_shared', listId: list.id, data: { title: list.title } });
  },

  async 'list.unshare'(ctx, a) {
    const list = await loadList(ctx, a.listId);
    const res = await ctx.tx`update list_members set deleted_at = ${ctx.now} where list_id = ${a.listId} and user_id = ${a.userId} and deleted_at is null returning id`;
    if (!res.length) return;
    await activity(ctx, { workspaceId: list.workspaceId, listId: list.id, type: 'list_unshared', data: { userId: a.userId } });
  },

  async 'section.create'(ctx, a) {
    await ctx.tx`insert into sections (id, user_id, workspace_id, name, position) values (${a.id}, ${ctx.userId}, ${a.workspaceId}, ${a.name}, ${a.position})
                 on conflict (id) do nothing`;
  },
  async 'section.update'(ctx, a) {
    const set: Record<string, unknown> = {};
    if (a.name !== undefined) set.name = a.name;
    if (a.position !== undefined) set.position = a.position;
    if (a.collapsed !== undefined) set.collapsed = a.collapsed;
    if (!Object.keys(set).length) return;
    const res = await ctx.tx`update sections set ${ctx.tx(set as never)} where id = ${a.id} returning id`;
    if (!res.length) throw new AppError('not_found', 'Section not found.');
  },
  async 'section.delete'(ctx, a) {
    await ctx.tx`update section_items set section_id = null where section_id = ${a.id}`;
    await ctx.tx`update sections set deleted_at = ${ctx.now} where id = ${a.id}`;
  },
  async 'list.star'(ctx, a) {
    await loadList(ctx, a.listId);
    await ctx.tx`
      insert into section_items (id, user_id, workspace_id, section_id, list_id, position)
      values (${a.id}, ${ctx.userId}, ${a.workspaceId}, ${a.sectionId}, ${a.listId}, ${a.position})
      on conflict (user_id, list_id) do update set section_id = excluded.section_id, position = excluded.position, deleted_at = null`;
  },
  async 'list.unstar'(ctx, a) {
    await ctx.tx`update section_items set deleted_at = ${ctx.now} where list_id = ${a.listId} and user_id = ${ctx.userId}`;
  },
  async 'sectionItem.move'(ctx, a) {
    if (a.sectionId) {
      const s = await ctx.tx`select 1 from sections where id = ${a.sectionId} and deleted_at is null`;
      if (!s.length) throw new AppError('not_found', 'Section not found.');
    }
    await ctx.tx`update section_items set section_id = ${a.sectionId}, position = ${a.position} where list_id = ${a.listId} and user_id = ${ctx.userId}`;
  },

  async 'label.create'(ctx, a) {
    const dup = await ctx.tx`select 1 from labels where workspace_id = ${a.workspaceId} and lower(name) = lower(${a.name}) and deleted_at is null and id <> ${a.id}`;
    if (dup.length) throw new AppError('conflict', `A label named "${a.name}" already exists.`);
    await ctx.tx`insert into labels (id, workspace_id, name, color, created_by) values (${a.id}, ${a.workspaceId}, ${a.name}, ${a.color}, ${ctx.userId})
                 on conflict (id) do nothing`;
  },
  async 'label.update'(ctx, a) {
    const set: Record<string, unknown> = {};
    if (a.name !== undefined) set.name = a.name;
    if (a.color !== undefined) set.color = a.color;
    if (!Object.keys(set).length) return;
    const res = await ctx.tx`update labels set ${ctx.tx(set as never)} where id = ${a.id} and deleted_at is null returning id`;
    if (!res.length) throw new AppError('not_found', 'Label not found.');
  },
  async 'label.delete'(ctx, a) {
    const res = await ctx.tx`update labels set deleted_at = ${ctx.now} where id = ${a.id} and deleted_at is null returning workspace_id`;
    if (!res.length) return;
    await ctx.tx`update tasks set label_ids = array_remove(label_ids, ${a.id}::uuid) where ${a.id}::uuid = any(label_ids)`;
  },

  async 'message.create'(ctx, a) {
    const task = await loadTask(ctx, a.taskId);
    const exists = await ctx.tx`select 1 from task_messages where id = ${a.id}`;
    if (exists.length) return;
    await ctx.tx`
      insert into task_messages (id, workspace_id, task_id, author_id, parent_message_id, kind, body, attachment_id, mentions)
      values (${a.id}, ${task.workspaceId}, ${a.taskId}, ${ctx.userId}, ${a.parentMessageId}, ${a.kind}, ${a.body}, ${a.attachmentId}, ${a.mentions}::uuid[])`;
    await activity(ctx, { workspaceId: task.workspaceId, taskId: task.id, listId: task.listId, type: 'commented', data: { messageId: a.id } });
    const mentioned = new Set<string>();
    for (const uid of a.mentions) {
      const [ok] = await ctx.tx<{ ok: boolean }[]>`select app.user_can_access_task(${uid}, ${task.id}) as ok`;
      if (ok?.ok) {
        mentioned.add(uid);
        await notify(ctx, { userId: uid, workspaceId: task.workspaceId, type: 'mention', taskId: task.id, listId: task.listId, data: { messageId: a.id, title: task.title } });
      }
    }
    const participants = await ctx.tx<{ userId: string }[]>`
      select distinct author_id as user_id from task_messages where task_id = ${task.id} and deleted_at is null
      union select ${task.createdBy}::uuid union select ${task.assigneeId}::uuid`;
    for (const p of participants) {
      if (!p.userId || mentioned.has(p.userId)) continue;
      await notify(ctx, { userId: p.userId, workspaceId: task.workspaceId, type: 'comment', taskId: task.id, listId: task.listId, data: { messageId: a.id, title: task.title }, dedupeKey: `comment:${task.id}` });
    }
  },
  async 'message.edit'(ctx, a) {
    if (a.attachmentId) {
      // Link an uploaded voice note; the attachment must belong to this message.
      const res = await ctx.tx`update task_messages m set attachment_id = ${a.attachmentId}
                               where m.id = ${a.id} and m.deleted_at is null
                                 and exists (select 1 from attachments a where a.id = ${a.attachmentId} and a.message_id = m.id)
                               returning m.id`;
      if (!res.length) throw new AppError('not_found', 'Message or attachment not found.');
      return;
    }
    const res = await ctx.tx`update task_messages set body = ${a.body}, mentions = ${a.mentions}::uuid[], edited_at = now()
                             where id = ${a.id} and deleted_at is null returning id`;
    if (!res.length) throw new AppError('not_found', 'Message not found.');
  },
  async 'message.delete'(ctx, a) {
    await ctx.tx`update task_messages set deleted_at = ${ctx.now}, body = '' where id = ${a.id} and deleted_at is null`;
  },
  async 'reaction.toggle'(ctx, a) {
    const [msg] = await ctx.tx<{ workspaceId: string; taskId: string }[]>`select workspace_id, task_id from task_messages where id = ${a.messageId} and deleted_at is null`;
    if (!msg) throw new AppError('not_found', 'Message not found.');
    await ctx.tx`
      insert into message_reactions (id, workspace_id, message_id, task_id, user_id, emoji, deleted_at)
      values (${a.id}, ${msg.workspaceId}, ${a.messageId}, ${msg.taskId}, ${ctx.userId}, ${a.emoji}, ${a.on ? null : ctx.now})
      on conflict (message_id, user_id, emoji) do update set deleted_at = excluded.deleted_at`;
  },

  async 'notification.markRead'(ctx, a) {
    if (a.all) {
      await ctx.tx`update notifications set read_at = ${a.read ? ctx.now : null} where user_id = ${ctx.userId} and (read_at is null) = ${a.read}`;
    } else if (a.ids?.length) {
      await ctx.tx`update notifications set read_at = ${a.read ? ctx.now : null} where id = any(${a.ids}::uuid[]) and user_id = ${ctx.userId}`;
    }
  },

  async 'attachment.rename'(ctx, a) {
    const res = await ctx.tx`update attachments set name = ${a.name} where id = ${a.id} and deleted_at is null returning id`;
    if (!res.length) throw new AppError('not_found', 'File not found.');
  },
  async 'attachment.delete'(ctx, a) {
    const rows = await ctx.tx<{ id: string; workspaceId: string; taskId: string | null; listId: string | null; name: string }[]>`
      update attachments set deleted_at = ${ctx.now} where id = any(${a.ids}::uuid[]) and deleted_at is null
      returning id, workspace_id, task_id, list_id, name`;
    for (const r of rows) {
      await activity(ctx, { workspaceId: r.workspaceId, taskId: r.taskId, listId: r.listId, type: 'attachment_removed', data: { name: r.name } });
    }
    if (rows.length) await ctx.enqueue('attachments.purge', { ids: rows.map((r) => r.id) }, { startAfter: new Date(Date.now() + 30 * 86400_000) });
  },

  async 'profile.update'(ctx, a) {
    validateTz(a.timezone);
    const set: Record<string, unknown> = {};
    if (a.displayName !== undefined) set.display_name = a.displayName;
    if (a.avatarPath !== undefined) {
      if (a.avatarPath && !a.avatarPath.startsWith(`avatars/${ctx.userId}/`)) throw new AppError('validation', 'Invalid avatar.');
      set.avatar_path = a.avatarPath;
    }
    if (a.timezone !== undefined) set.timezone = a.timezone;
    if (a.locale !== undefined) set.locale = a.locale;
    if (a.usageType !== undefined) set.usage_type = a.usageType;
    if (Object.keys(set).length) await ctx.tx`update profiles set ${ctx.tx(set as never)} where id = ${ctx.userId}`;
    if (a.onboarded) await ctx.tx`update profiles set onboarded_at = coalesce(onboarded_at, now()) where id = ${ctx.userId}`;
    if (a.settings) {
      const patch = profileSettingsSchema.partial().parse(a.settings);
      await ctx.tx`update profiles set settings = app.jsonb_deep_merge(settings, ${j(ctx.tx, patch)}) where id = ${ctx.userId}`;
    }
  },

  async 'workspace.create'(ctx, a) {
    const exists = await ctx.tx`select 1 from workspaces where id = ${a.id}`;
    if (exists.length) return;
    await ctx.tx`insert into workspaces (id, name, kind, owner_id, icon) values (${a.id}, ${a.name}, 'team', ${ctx.userId}, ${a.icon})`;
    await ctx.tx`insert into workspace_members (id, workspace_id, user_id, role) values (${a.memberId}, ${a.id}, ${ctx.userId}, 'owner')`;
  },
  async 'workspace.update'(ctx, a) {
    const set: Record<string, unknown> = {};
    if (a.name !== undefined) set.name = a.name;
    if (a.icon !== undefined) set.icon = a.icon;
    if (!Object.keys(set).length) return;
    const res = await ctx.tx`update workspaces set ${ctx.tx(set as never)} where id = ${a.id} returning id`;
    if (!res.length) throw new AppError('forbidden', 'Only owners and admins can rename a workspace.');
  },
  async 'workspace.delete'(ctx, a) {
    const res = await ctx.tx`update workspaces set deleted_at = ${ctx.now} where id = ${a.id} and deleted_at is null returning id`;
    if (!res.length) throw new AppError('forbidden', 'Only the owner can delete this workspace.');
  },
  async 'member.setRole'(ctx, a) {
    const res = await ctx.tx`update workspace_members set role = ${a.role} where workspace_id = ${a.workspaceId} and user_id = ${a.userId} and deleted_at is null returning id`;
    if (!res.length) throw new AppError('forbidden', 'You cannot change this member’s role.');
  },
  async 'member.remove'(ctx, a) {
    const res = await ctx.tx`update workspace_members set deleted_at = ${ctx.now} where workspace_id = ${a.workspaceId} and user_id = ${a.userId} and deleted_at is null returning id`;
    if (!res.length) throw new AppError('forbidden', 'You cannot remove this member.');
    await ctx.tx`update list_members set deleted_at = ${ctx.now} where workspace_id = ${a.workspaceId} and user_id = ${a.userId} and deleted_at is null`;
  },
  async 'workspace.leave'(ctx, a) {
    const res = await ctx.tx`update workspace_members set deleted_at = ${ctx.now} where workspace_id = ${a.workspaceId} and user_id = ${ctx.userId} and deleted_at is null returning id`;
    if (!res.length) throw new AppError('not_found', 'You are not a member of this workspace.');
  },
  async 'workspace.transfer'(ctx, a) {
    await ctx.tx`select app.transfer_workspace(${a.workspaceId}, ${a.toUserId})`;
  },
};
