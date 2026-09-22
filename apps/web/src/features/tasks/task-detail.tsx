'use client';

import * as React from 'react';
import Link from 'next/link';
import {
  ArrowRightLeft,
  Bell,
  CalendarDays,
  ChevronRight,
  ExternalLink,
  Inbox,
  Link2,
  Maximize2,
  MoreHorizontal,
  Repeat,
  SkipForward,
  Tag,
  Trash2,
  UserRound,
  X,
} from 'lucide-react';
import type { Task } from '@orbit/shared';
import { routes } from '@orbit/shared';
import { describeRecurrence, dueBucket } from '@orbit/core';
import { dueLabel } from '@/lib/format';
import { isInInbox, listPath, selectChildren, taskPath } from '@orbit/sync/client';
import {
  Avatar,
  Button,
  EmptyState,
  LabelChip,
  Menu,
  MenuContent,
  MenuItem,
  MenuSeparator,
  MenuTrigger,
  Switch,
  TaskCheckbox,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  Tooltip,
  cn,
} from '@orbit/ui';
import { useSignedImage } from '@/lib/images';
import { useStoreQuery, useSync } from '@/lib/sync';
import { useUndo } from '@/lib/undo';
import { DocumentEditor } from '@/features/editor/document-editor';
import { AttachmentsSection } from '@/features/files/attachments';
import { useTaskCommands } from './commands';
import { ActivityLog, Comments } from './comments';
import { AssigneePicker, DatePicker, LabelPicker, ListPicker, RecurrencePicker, ReminderPicker, describeReminder } from './pickers';
import { QuickAddRow } from './task-list';

function PropertyRow({ icon: Icon, label, children }: { icon: React.ComponentType<{ className?: string }>; label: string; children: React.ReactNode }) {
  return (
    <div className="flex min-h-9 items-center gap-3">
      <span className="flex w-28 shrink-0 items-center gap-2 text-[13px] text-fg-subtle">
        <Icon className="size-4" aria-hidden /> {label}
      </span>
      <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1.5">{children}</div>
    </div>
  );
}

const valueButton = 'h-7 rounded-md px-2 text-[13px] hover:bg-bg-hover text-left';

function Assignee({ task }: { task: Task }) {
  const cmd = useTaskCommands();
  const profile = useStoreQuery(['profiles'], (s) => (task.assigneeId ? s.get('profiles', task.assigneeId) : undefined), [task.assigneeId]);
  const src = useSignedImage(profile?.avatarPath);
  return (
    <AssigneePicker workspaceId={task.workspaceId} listId={task.listId} value={task.assigneeId} onChange={(u) => cmd.assign([task.id], u)}>
      <button type="button" className={cn(valueButton, 'flex items-center gap-2')}>
        {profile ? (
          <>
            <Avatar name={profile.displayName} src={src} seed={profile.id} size={20} /> {profile.displayName}
          </>
        ) : (
          <span className="text-fg-subtle">Unassigned</span>
        )}
      </button>
    </AssigneePicker>
  );
}

function TitleEditor({ task }: { task: Task }) {
  const { actions } = useSync();
  const [draft, setDraft] = React.useState(task.title);
  const ref = React.useRef<HTMLTextAreaElement>(null);
  React.useEffect(() => {
    if (document.activeElement !== ref.current) setDraft(task.title);
  }, [task.title]);
  React.useLayoutEffect(() => {
    const el = ref.current;
    if (el) {
      el.style.height = '0px';
      el.style.height = `${el.scrollHeight}px`;
    }
  }, [draft]);
  const commit = () => {
    const t = draft.replace(/\s+/g, ' ').trim();
    if (t !== task.title) actions.updateTask(task.id, { title: t });
  };
  return (
    <textarea
      ref={ref}
      value={draft}
      rows={1}
      aria-label="Task title"
      placeholder="Task name"
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          (e.target as HTMLTextAreaElement).blur();
        }
      }}
      className={cn('w-full resize-none overflow-hidden bg-transparent text-xl leading-snug font-semibold tracking-tight outline-none placeholder:text-fg-subtle', task.completedAt && 'text-fg-muted line-through')}
    />
  );
}

export function TaskDetail({ taskId, onClose, onOpenTask, mode = 'panel' }: { taskId: string; onClose?: () => void; onOpenTask: (id: string) => void; mode?: 'panel' | 'page' }) {
  const { store, userId, timeZone, actions } = useSync();
  const { run } = useUndo();
  const cmd = useTaskCommands();
  const task = useStoreQuery(['tasks'], (s) => s.get('tasks', taskId), [taskId]);
  const crumbs = useStoreQuery(['tasks', 'lists'], (s) => {
    const t = s.get('tasks', taskId);
    return { lists: t?.listId ? listPath(s, t.listId) : [], parents: taskPath(s, taskId).slice(0, -1) };
  }, [taskId]);
  const children = useStoreQuery(['tasks'], (s) => selectChildren(s, taskId), [taskId]);
  const labels = useStoreQuery(['labels'], (s) => (task ? task.labelIds.map((id) => s.get('labels', id)).filter((l) => l && !l.deletedAt) : []), [task?.labelIds.join()]);
  const inbox = useStoreQuery(['taskUserStates', 'tasks'], (s) => (task ? isInInbox(s, task, userId) : false), [task?.id, userId]);
  const [tab, setTab] = React.useState('comments');

  if (!task) {
    return (
      <div className="flex h-full flex-col">
        <div className="flex justify-end p-2">
          {onClose ? (
            <Button variant="ghost" size="icon-sm" aria-label="Close" onClick={onClose}>
              <X />
            </Button>
          ) : null}
        </div>
        <EmptyState title="Task not found" description="It may have been deleted, or you no longer have access to it." />
      </div>
    );
  }

  const bucket = dueBucket(task, timeZone);
  const done = Boolean(task.completedAt);

  return (
    <div className="flex h-full min-h-0 flex-col bg-surface">
      <header className="flex h-12 shrink-0 items-center gap-1 border-b border-border px-3">
        <nav aria-label="Breadcrumb" className="flex min-w-0 flex-1 items-center gap-1 text-[13px] text-fg-muted">
          {crumbs.lists.length ? (
            crumbs.lists.map((l, i) => (
              <React.Fragment key={l.id}>
                {i > 0 ? <ChevronRight className="size-3 shrink-0 text-fg-subtle" aria-hidden /> : null}
                <Link href={routes.list(l.id)} className="truncate hover:text-fg">
                  {l.emoji ? `${l.emoji} ` : ''}
                  {l.title || 'Untitled list'}
                </Link>
              </React.Fragment>
            ))
          ) : (
            <Link href={routes.inbox()} className="flex items-center gap-1 hover:text-fg">
              <Inbox className="size-3.5" /> Inbox
            </Link>
          )}
          {crumbs.parents.map((p) => (
            <React.Fragment key={p.id}>
              <ChevronRight className="size-3 shrink-0 text-fg-subtle" aria-hidden />
              <button type="button" className="truncate hover:text-fg" onClick={() => onOpenTask(p.id)}>
                {p.title || 'Untitled task'}
              </button>
            </React.Fragment>
          ))}
        </nav>
        {task.recurrence && !done ? (
          <Tooltip content="Skip this occurrence">
            <Button variant="ghost" size="icon-sm" aria-label="Skip this occurrence" onClick={() => cmd.skip(task.id)}>
              <SkipForward />
            </Button>
          </Tooltip>
        ) : null}
        <Menu>
          <MenuTrigger asChild>
            <Button variant="ghost" size="icon-sm" aria-label="More actions">
              <MoreHorizontal />
            </Button>
          </MenuTrigger>
          <MenuContent align="end">
            <MenuItem onSelect={() => cmd.duplicate([task.id])}>Duplicate</MenuItem>
            <MenuItem onSelect={() => cmd.copyMarkdown([task.id])}>Copy as Markdown</MenuItem>
            <MenuItem onSelect={() => cmd.copyLink(task.id)}>
              <Link2 /> Copy link
            </MenuItem>
            <MenuSeparator />
            <MenuItem
              danger
              onSelect={() => {
                cmd.remove([task.id]);
                onClose?.();
              }}
            >
              <Trash2 /> Delete task
            </MenuItem>
          </MenuContent>
        </Menu>
        {mode === 'panel' ? (
          <>
            <Tooltip content="Open full page">
              <Button asChild variant="ghost" size="icon-sm" aria-label="Open full page">
                <Link href={routes.task(task.id)}>
                  <Maximize2 />
                </Link>
              </Button>
            </Tooltip>
            <Tooltip content="Close" shortcut="escape">
              <Button variant="ghost" size="icon-sm" aria-label="Close task" onClick={onClose}>
                <X />
              </Button>
            </Tooltip>
          </>
        ) : null}
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className={cn('mx-auto flex flex-col gap-5 px-5 pt-5 pb-24', mode === 'page' ? 'max-w-3xl' : 'max-w-2xl')}>
          <div className="flex items-start gap-3">
            <span className="mt-1.5">
              <TaskCheckbox checked={done} label={done ? 'Reopen task' : 'Complete task'} onCheckedChange={() => cmd.toggle([task.id])} />
            </span>
            <TitleEditor task={task} />
          </div>

          <div className="flex flex-col">
            <PropertyRow icon={CalendarDays} label="Due">
              <DatePicker value={{ dueDate: task.dueDate, dueTime: task.dueTime }} onChange={(v) => cmd.setDue([task.id], v.dueDate, v.dueTime)}>
                <button type="button" className={cn(valueButton, bucket === 'overdue' && 'text-danger', bucket === 'today' && 'text-accent', !task.dueDate && 'text-fg-subtle')}>
                  {task.dueDate ? dueLabel(task, timeZone) : 'No date'}
                </button>
              </DatePicker>
            </PropertyRow>
            <PropertyRow icon={Repeat} label="Repeat">
              <RecurrencePicker value={task.recurrence} dueDate={task.dueDate} onChange={(r, start) => run(null, () => actions.updateTask(task.id, { recurrence: r, ...(r && !task.dueDate ? { dueDate: start ?? null } : {}) }), { toast: false })}>
                <button type="button" className={cn(valueButton, !task.recurrence && 'text-fg-subtle')}>
                  {task.recurrence ? describeRecurrence(task.recurrence) : 'Doesn’t repeat'}
                </button>
              </RecurrencePicker>
            </PropertyRow>
            <PropertyRow icon={Bell} label="Reminders">
              <ReminderPicker reminders={task.reminders} hasDue={Boolean(task.dueDate)} hasTime={Boolean(task.dueTime)} onChange={(r) => actions.updateTask(task.id, { reminders: r })}>
                <button type="button" className={cn(valueButton, !task.reminders.length && 'text-fg-subtle')}>
                  {task.reminders.length ? task.reminders.map((r) => describeReminder(r, Boolean(task.dueTime))).join(', ') : 'None'}
                </button>
              </ReminderPicker>
            </PropertyRow>
            <PropertyRow icon={UserRound} label="Assignee">
              <Assignee task={task} />
            </PropertyRow>
            <PropertyRow icon={Tag} label="Labels">
              {labels.map((l) => (
                <LabelChip key={l!.id} name={l!.name} color={l!.color} onRemove={() => cmd.toggleLabel([task.id], l!.id, false)} />
              ))}
              <LabelPicker workspaceId={task.workspaceId} value={task.labelIds} onToggle={(id, on) => cmd.toggleLabel([task.id], id, on)}>
                <button type="button" className={cn(valueButton, 'text-fg-subtle')}>
                  {labels.length ? '+' : 'Add label'}
                </button>
              </LabelPicker>
            </PropertyRow>
            {!task.parentTaskId ? (
              <PropertyRow icon={ArrowRightLeft} label="List">
                <ListPicker workspaceId={task.workspaceId} currentListId={task.listId} onPick={(l) => cmd.move([task.id], l)}>
                  <button type="button" className={valueButton}>
                    {task.listId ? (store.get('lists', task.listId)?.title || 'Untitled list') : 'Inbox'}
                  </button>
                </ListPicker>
                {task.listId ? (
                  <label className="ml-auto flex items-center gap-2 text-xs text-fg-muted">
                    Show in Inbox
                    <Switch checked={inbox} onCheckedChange={(on) => cmd.setInbox([task.id], on)} aria-label="Show in Inbox" />
                  </label>
                ) : null}
              </PropertyRow>
            ) : null}
            {task.source?.url ? (
              <PropertyRow icon={ExternalLink} label="Source">
                <a href={task.source.url} target="_blank" rel="noopener noreferrer" className={cn(valueButton, 'inline-flex items-center gap-1 text-accent hover:underline')}>
                  {task.source.provider.replace('_', ' ')}
                  {task.source.sender ? ` · ${task.source.sender}` : ''}
                  <ExternalLink className="size-3" />
                </a>
              </PropertyRow>
            ) : null}
          </div>
          {task.source?.summary ? <p className="rounded-lg bg-surface-sunken p-3 text-[13px] leading-relaxed text-fg-muted">{task.source.summary}</p> : null}

          {/* Notes and subtasks live together in the task's own document; subtasks created
              anywhere else are appended to it automatically. */}
          <section aria-label="Notes and subtasks">
            <h3 className="mb-1 text-[13px] font-semibold text-fg-muted">
              Notes & subtasks {children.length ? <span className="font-normal text-fg-subtle">· {children.filter((c) => c.completedAt).length}/{children.length} done</span> : null}
            </h3>
            <DocumentEditor docName={`task:${task.id}`} workspaceId={task.workspaceId} context={{ kind: 'task', taskId: task.id, listId: task.listId }} placeholder="Add notes, or type [] for a subtask. / for more blocks" onOpenTask={onOpenTask} minimal />
            <QuickAddRow workspaceId={task.workspaceId} parentTaskId={task.id} placeholder="Add a subtask" className="mt-1" />
          </section>

          <AttachmentsSection target={{ workspaceId: task.workspaceId, taskId: task.id }} />

          <Tabs value={tab} onValueChange={setTab}>
            <TabsList>
              <TabsTrigger value="comments">Comments</TabsTrigger>
              <TabsTrigger value="activity">Activity</TabsTrigger>
            </TabsList>
            <TabsContent value="comments" className="pt-2">
              <Comments taskId={task.id} workspaceId={task.workspaceId} listId={task.listId} />
            </TabsContent>
            <TabsContent value="activity" className="pt-1">
              <ActivityLog taskId={task.id} />
            </TabsContent>
          </Tabs>
        </div>
      </div>
    </div>
  );
}
