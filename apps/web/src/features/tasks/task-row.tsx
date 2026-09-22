'use client';

import * as React from 'react';
import {
  AlignLeft,
  ArrowRightLeft,
  Bell,
  CalendarDays,
  ChevronRight,
  Copy,
  CopyPlus,
  FileText,
  GripVertical,
  Inbox,
  Link2,
  MessageSquare,
  MoreHorizontal,
  Paperclip,
  Repeat,
  Share2,
  SkipForward,
  Sofa,
  Sun,
  Sunrise,
  Tag,
  Trash2,
  UserRound,
  X,
} from 'lucide-react';
import type { Task } from '@orbit/shared';
import { dueBucket } from '@orbit/core';
import { dueLabel } from '@/lib/format';
import { isInInbox, subtaskProgress } from '@orbit/sync/client';
import {
  Avatar,
  Button,
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger,
  LabelChip,
  Menu,
  MenuContent,
  MenuItem,
  MenuSeparator,
  MenuSub,
  MenuSubContent,
  MenuSubTrigger,
  MenuTrigger,
  ProgressRing,
  TaskCheckbox,
  Tooltip,
  cn,
} from '@orbit/ui';
import { SHORTCUTS } from '@/lib/hotkeys';
import { useSignedImage } from '@/lib/images';
import { useStoreQuery, useSync } from '@/lib/sync';
import { useTaskCommands, type PickerKind } from './commands';
import { AssigneePicker, DatePicker, LabelPicker, ListPicker, RecurrencePicker, ReminderPicker } from './pickers';
import { useLongPress, useOptionalSelection } from './selection';

export interface TaskRowProps {
  task: Task;
  depth?: number;
  /** Show the list name chip (views outside a list). */
  showList?: boolean;
  showWorkspace?: boolean;
  expanded?: boolean;
  onToggleExpand?: () => void;
  hasChildren?: boolean;
  onOpen: (id: string) => void;
  dragHandleProps?: React.HTMLAttributes<HTMLButtonElement>;
  isDragging?: boolean;
  /** Called on Enter while editing the title — e.g. create the next sibling. */
  onEnterNext?: (id: string) => void;
  autoEdit?: boolean;
  className?: string;
}

function DueChip({ task, timeZone }: { task: Task; timeZone: string }) {
  if (!task.dueDate) return null;
  const bucket = dueBucket(task, timeZone);
  const label = dueLabel(task, timeZone);
  return (
    <span className={cn('inline-flex items-center gap-1 text-xs tabular-nums', bucket === 'overdue' ? 'font-medium text-danger' : bucket === 'today' ? 'font-medium text-accent' : 'text-fg-muted')}>
      <CalendarDays className="size-3.5" aria-hidden />
      {label}
      {task.recurrence ? <Repeat className="size-3" aria-label="Repeats" /> : null}
    </span>
  );
}

function PersonAvatar({ userId, size = 20 }: { userId: string; size?: number }) {
  const profile = useStoreQuery(['profiles'], (s) => s.get('profiles', userId), [userId]);
  const src = useSignedImage(profile?.avatarPath);
  return <Avatar name={profile?.displayName ?? 'Member'} seed={userId} src={src} size={size} />;
}

export function TaskMeta({ task, showList, showWorkspace }: { task: Task; showList?: boolean; showWorkspace?: boolean }) {
  const { userId, timeZone } = useSync();
  const meta = useStoreQuery(
    ['labels', 'lists', 'workspaces', 'taskMessages', 'attachments', 'tasks'],
    (s) => ({
      labels: task.labelIds.map((id) => s.get('labels', id)).filter((l) => l && !l.deletedAt),
      list: task.listId ? s.get('lists', task.listId) : null,
      workspace: showWorkspace ? s.get('workspaces', task.workspaceId) : null,
      comments: s.all('taskMessages').filter((m) => m.taskId === task.id && !m.deletedAt && m.kind !== 'system').length,
      files: s.all('attachments').filter((a) => a.taskId === task.id && !a.deletedAt && a.status === 'ready').length,
      progress: subtaskProgress(s, task.id),
    }),
    [task.id, task.labelIds.join(), task.listId, task.workspaceId, showWorkspace],
  );
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-x-2.5 gap-y-1">
      <DueChip task={task} timeZone={timeZone} />
      {meta.progress.total > 0 ? (
        <span className="inline-flex items-center gap-1 text-xs text-fg-muted tabular-nums" aria-label={`${meta.progress.done} of ${meta.progress.total} subtasks done`}>
          <ProgressRing value={meta.progress.done} total={meta.progress.total} size={13} />
          {meta.progress.done}/{meta.progress.total}
        </span>
      ) : null}
      {task.hasDetails ? <AlignLeft className="size-3.5 text-fg-subtle" aria-label="Has notes" /> : null}
      {meta.comments ? (
        <span className="inline-flex items-center gap-0.5 text-xs text-fg-muted" aria-label={`${meta.comments} comments`}>
          <MessageSquare className="size-3.5" aria-hidden />
          {meta.comments}
        </span>
      ) : null}
      {meta.files ? (
        <span className="inline-flex items-center gap-0.5 text-xs text-fg-muted" aria-label={`${meta.files} files`}>
          <Paperclip className="size-3.5" aria-hidden />
          {meta.files}
        </span>
      ) : null}
      {task.reminders.length ? <Bell className="size-3.5 text-fg-subtle" aria-label="Has reminders" /> : null}
      {meta.labels.slice(0, 3).map((l) => (
        <LabelChip key={l!.id} name={l!.name} color={l!.color} size="xs" />
      ))}
      {meta.labels.length > 3 ? <span className="text-xs text-fg-subtle">+{meta.labels.length - 3}</span> : null}
      {showList && meta.list ? (
        <span className="inline-flex max-w-36 items-center gap-1 truncate text-xs text-fg-subtle">
          {meta.list.emoji ?? <FileText className="size-3" aria-hidden />}
          <span className="truncate">{meta.list.title || 'Untitled list'}</span>
        </span>
      ) : null}
      {meta.workspace ? <span className="text-xs text-fg-subtle">· {meta.workspace.name}</span> : null}
      {task.source?.provider && task.source.provider !== 'talk' ? <span className="rounded-xs bg-bg-hover px-1 text-[10px] font-medium uppercase tracking-wide text-fg-subtle">{task.source.provider.replace('_', ' ')}</span> : null}
      {task.assigneeId && task.assigneeId !== userId ? <PersonAvatar userId={task.assigneeId} size={18} /> : null}
    </div>
  );
}

/** Shared menu content for context menu and "more" dropdown. */
function TaskMenuBody({ task, ids, flavor, onPicker, onOpen }: { task: Task; ids: string[]; flavor: 'context' | 'dropdown'; onPicker: (k: PickerKind) => void; onOpen: () => void }) {
  const cmd = useTaskCommands();
  const { store, userId } = useSync();
  const Item = flavor === 'context' ? ContextMenuItem : MenuItem;
  const Sep = flavor === 'context' ? ContextMenuSeparator : MenuSeparator;
  const Sub = flavor === 'context' ? ContextMenuSub : MenuSub;
  const SubTrigger = flavor === 'context' ? ContextMenuSubTrigger : MenuSubTrigger;
  const SubContent = flavor === 'context' ? ContextMenuSubContent : MenuSubContent;
  const many = ids.length > 1;
  const inInbox = isInInbox(store, task, userId);
  return (
    <>
      {!many ? (
        <Item onSelect={onOpen} shortcut={SHORTCUTS.open}>
          <FileText /> Open
        </Item>
      ) : null}
      <Item onSelect={() => cmd.toggle(ids)} shortcut={SHORTCUTS.complete}>
        <TaskCheckIcon /> {task.completedAt ? 'Reopen' : many ? `Complete ${ids.length} tasks` : 'Complete'}
      </Item>
      {task.recurrence && !many ? (
        <Item onSelect={() => cmd.skip(task.id)}>
          <SkipForward /> Skip this occurrence
        </Item>
      ) : null}
      <Sep />
      <Sub>
        <SubTrigger>
          <CalendarDays /> Schedule
        </SubTrigger>
        <SubContent>
          <Item onSelect={() => cmd.schedule(ids, 'today')} shortcut={SHORTCUTS.scheduleToday}>
            <Sun /> Today
          </Item>
          <Item onSelect={() => cmd.schedule(ids, 'tomorrow')}>
            <Sunrise /> Tomorrow
          </Item>
          <Item onSelect={() => cmd.schedule(ids, 'weekend')}>
            <Sofa /> This weekend
          </Item>
          <Item onSelect={() => cmd.schedule(ids, 'nextweek')}>
            <ArrowRightLeft /> Next week
          </Item>
          <Item onSelect={() => onPicker('date')} shortcut={SHORTCUTS.schedule}>
            <CalendarDays /> Pick a date…
          </Item>
          {task.dueDate ? (
            <Item onSelect={() => cmd.schedule(ids, 'none')}>
              <X /> Remove date
            </Item>
          ) : null}
        </SubContent>
      </Sub>
      {!many ? (
        <>
          <Item onSelect={() => onPicker('repeat')}>
            <Repeat /> Repeat…
          </Item>
          <Item onSelect={() => onPicker('reminder')}>
            <Bell /> Reminders…
          </Item>
        </>
      ) : null}
      <Item onSelect={() => onPicker('assign')} shortcut={SHORTCUTS.assign}>
        <UserRound /> Assign…
      </Item>
      <Item onSelect={() => onPicker('labels')} shortcut={SHORTCUTS.label}>
        <Tag /> Labels…
      </Item>
      <Item onSelect={() => onPicker('move')}>
        <ArrowRightLeft /> Move to…
      </Item>
      {task.listId ? (
        <Item onSelect={() => cmd.setInbox(ids, !inInbox)}>
          <Inbox /> {inInbox ? 'Remove from Inbox' : 'Add to Inbox'}
        </Item>
      ) : null}
      <Sep />
      <Item onSelect={() => cmd.duplicate(ids)} shortcut={SHORTCUTS.duplicate}>
        <CopyPlus /> Duplicate
      </Item>
      <Item onSelect={() => cmd.copyText(ids)}>
        <Copy /> Copy as text
      </Item>
      <Item onSelect={() => cmd.copyMarkdown(ids)}>
        <Copy /> Copy as Markdown
      </Item>
      {!many ? (
        <>
          <Item onSelect={() => cmd.copyLink(task.id)}>
            <Link2 /> Copy link
          </Item>
          <Item onSelect={() => cmd.share(task.id)}>
            <Share2 /> Share…
          </Item>
        </>
      ) : null}
      <Sep />
      <Item danger onSelect={() => cmd.remove(ids)} shortcut={SHORTCUTS.delete}>
        <Trash2 /> {many ? `Delete ${ids.length} tasks` : 'Delete'}
      </Item>
    </>
  );
}

function TaskCheckIcon() {
  return (
    <svg viewBox="0 0 16 16" className="size-4" aria-hidden>
      <circle cx="8" cy="8" r="6.25" fill="none" stroke="currentColor" strokeWidth="1.5" />
      <path d="M5.2 8.2 7.1 10l3.7-4" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/** Pickers opened from menus/shortcuts, anchored to the row. */
export function RowPickers({ task, ids, picker, setPicker, anchor }: { task: Task; ids: string[]; picker: PickerKind | null; setPicker: (p: PickerKind | null) => void; anchor: React.ReactElement }) {
  const cmd = useTaskCommands();
  const { actions } = useSync();
  const ctl = (kind: PickerKind) => ({ open: picker === kind, onOpenChange: (o: boolean) => setPicker(o ? kind : null) });
  // Invisible anchor at the row's right edge: pickers open there when triggered by menu/keyboard.
  const anchorEl = <span aria-hidden className="pointer-events-none absolute top-0 right-10 h-full w-px" />;
  return (
    <>
      {anchor}
      {picker === 'date' ? (
        <DatePicker {...ctl('date')} value={{ dueDate: task.dueDate, dueTime: task.dueTime }} onChange={(v) => (cmd.setDue(ids, v.dueDate, v.dueTime), setPicker(null))}>
          {anchorEl}
        </DatePicker>
      ) : null}
      {picker === 'labels' ? (
        <LabelPicker {...ctl('labels')} workspaceId={task.workspaceId} value={task.labelIds} onToggle={(id, on) => cmd.toggleLabel(ids, id, on)}>
          {anchorEl}
        </LabelPicker>
      ) : null}
      {picker === 'assign' ? (
        <AssigneePicker {...ctl('assign')} workspaceId={task.workspaceId} listId={task.listId} value={task.assigneeId} onChange={(u) => (cmd.assign(ids, u), setPicker(null))}>
          {anchorEl}
        </AssigneePicker>
      ) : null}
      {picker === 'move' ? (
        <ListPicker {...ctl('move')} workspaceId={task.workspaceId} currentListId={task.listId} onPick={(l) => (cmd.move(ids, l), setPicker(null))}>
          {anchorEl}
        </ListPicker>
      ) : null}
      {picker === 'repeat' ? (
        <RecurrencePicker
          {...ctl('repeat')}
          value={task.recurrence}
          dueDate={task.dueDate}
          onChange={(r, start) => (actions.updateTask(task.id, { recurrence: r, ...(r && !task.dueDate ? { dueDate: start ?? null } : {}) }), setPicker(null))}
        >
          {anchorEl}
        </RecurrencePicker>
      ) : null}
      {picker === 'reminder' ? (
        <ReminderPicker {...ctl('reminder')} reminders={task.reminders} hasDue={Boolean(task.dueDate)} hasTime={Boolean(task.dueTime)} onChange={(r) => actions.updateTask(task.id, { reminders: r })}>
          {anchorEl}
        </ReminderPicker>
      ) : null}
    </>
  );
}

export const TaskRow = React.memo(function TaskRow({
  task,
  depth = 0,
  showList,
  showWorkspace,
  expanded,
  onToggleExpand,
  hasChildren,
  onOpen,
  dragHandleProps,
  isDragging,
  onEnterNext,
  autoEdit,
  className,
}: TaskRowProps) {
  const { actions } = useSync();
  const cmd = useTaskCommands();
  const selection = useOptionalSelection();
  const selected = selection?.isSelected(task.id) ?? false;
  const focused = selection?.focused === task.id;
  const [editing, setEditing] = React.useState(Boolean(autoEdit));
  const [draft, setDraft] = React.useState(task.title);
  const [picker, setPicker] = React.useState<PickerKind | null>(null);
  const rowRef = React.useRef<HTMLDivElement>(null);
  const inputRef = React.useRef<HTMLInputElement>(null);
  const [justCompleted, setJustCompleted] = React.useState(false);

  React.useEffect(() => {
    if (!editing) setDraft(task.title);
  }, [task.title, editing]);
  React.useEffect(() => {
    if (focused && !editing && rowRef.current && !rowRef.current.contains(document.activeElement)) rowRef.current.focus({ preventScroll: false });
  }, [focused, editing]);
  React.useEffect(() => {
    if (editing) inputRef.current?.focus();
  }, [editing]);

  // Keyboard-triggered pickers and edit mode (dispatched by the list).
  React.useEffect(() => {
    const el = rowRef.current;
    if (!el) return;
    const onCmd = (e: Event) => {
      const detail = (e as CustomEvent<{ kind: PickerKind | 'edit' }>).detail;
      if (detail.kind === 'edit') setEditing(true);
      else setPicker(detail.kind);
    };
    el.addEventListener('task-command', onCmd);
    return () => el.removeEventListener('task-command', onCmd);
  }, []);

  const commit = () => {
    const title = draft.trim();
    setEditing(false);
    if (title && title !== task.title) actions.updateTask(task.id, { title });
    else setDraft(task.title);
  };

  const longPress = useLongPress(() => selection?.enterSelectionMode(task.id));
  const ids = selected && selection ? selection.targets() : [task.id];
  const done = Boolean(task.completedAt);

  const row = (
    <div
      ref={rowRef}
      role="row"
      tabIndex={-1}
      data-task-id={task.id}
      aria-selected={selected}
      aria-label={task.title || 'Untitled task'}
      onPointerDown={longPress.onPointerDown}
      onPointerMove={longPress.onPointerMove}
      onPointerUp={longPress.onPointerUp}
      onPointerCancel={longPress.onPointerCancel}
      onClick={(e) => {
        if (longPress.consumed()) return;
        if (editing) return;
        const mods = { shift: e.shiftKey, toggle: e.metaKey || e.ctrlKey };
        if (selection && (mods.shift || mods.toggle || selection.selectionMode)) {
          selection.click(task.id, mods);
          return;
        }
        selection?.click(task.id, {});
        onOpen(task.id);
      }}
      onDoubleClick={(e) => {
        e.stopPropagation();
        setEditing(true);
      }}
      className={cn(
        'group/row relative flex min-h-11 cursor-default items-start gap-2 rounded-md py-2 pr-2 outline-none transition-colors sm:min-h-9 sm:py-1.5',
        selected ? 'bg-accent-subtle/70' : focused ? 'bg-bg-hover' : 'hover:bg-bg-hover/70',
        isDragging && 'opacity-40',
        justCompleted && 'animate-pulse',
        className,
      )}
      style={{ paddingLeft: 4 + depth * 22 }}
    >
      {dragHandleProps ? (
        <button
          type="button"
          aria-label="Drag to reorder"
          className="absolute top-2 -left-5 hidden h-5 w-4 cursor-grab touch-none place-items-center rounded-xs text-fg-subtle opacity-0 group-hover/row:opacity-100 focus-visible:opacity-100 active:cursor-grabbing sm:grid"
          onClick={(e) => e.stopPropagation()}
          {...dragHandleProps}
        >
          <GripVertical className="size-3.5" />
        </button>
      ) : null}
      {hasChildren ? (
        <button
          type="button"
          aria-label={expanded ? 'Collapse subtasks' : 'Expand subtasks'}
          aria-expanded={expanded}
          onClick={(e) => {
            e.stopPropagation();
            onToggleExpand?.();
          }}
          className="mt-0.5 grid size-5 shrink-0 place-items-center rounded-xs text-fg-subtle hover:bg-bg-active"
        >
          <ChevronRight className={cn('size-3.5 transition-transform', expanded && 'rotate-90')} />
        </button>
      ) : (
        <span className="w-0 shrink-0" />
      )}
      <span className="mt-px">
        <TaskCheckbox
          checked={done}
          tone={task.dueDate && !done && task.dueDate < actions.today() ? 'danger' : 'default'}
          label={`${done ? 'Reopen' : 'Complete'} “${task.title || 'Untitled task'}”`}
          onCheckedChange={() => {
            if (!done) {
              setJustCompleted(true);
              setTimeout(() => setJustCompleted(false), 400);
            }
            cmd.toggle(ids);
          }}
        />
      </span>
      <div className="min-w-0 flex-1">
        {editing ? (
          <input
            ref={inputRef}
            value={draft}
            aria-label="Task title"
            onChange={(e) => setDraft(e.target.value)}
            onBlur={commit}
            onClick={(e) => e.stopPropagation()}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === 'Enter') {
                e.preventDefault();
                commit();
                onEnterNext?.(task.id);
              } else if (e.key === 'Escape') {
                setDraft(task.title);
                setEditing(false);
                rowRef.current?.focus();
              }
            }}
            className="w-full bg-transparent text-[14.5px] leading-6 outline-none sm:text-sm sm:leading-5"
          />
        ) : (
          <p className={cn('break-words text-[14.5px] leading-6 sm:text-sm sm:leading-5', done && 'text-fg-subtle line-through decoration-fg-subtle/60', !task.title && 'text-fg-subtle')}>{task.title || 'Untitled task'}</p>
        )}
        <TaskMeta task={task} showList={showList} showWorkspace={showWorkspace} />
      </div>
      <div className={cn('flex shrink-0 items-center gap-0.5 transition-opacity', picker ? 'opacity-100' : 'opacity-0 group-hover/row:opacity-100 group-focus-within/row:opacity-100 max-sm:hidden')}>
        <Tooltip content="Schedule" shortcut={SHORTCUTS.schedule}>
          <Button variant="ghost" size="icon-sm" aria-label="Schedule" onClick={(e) => (e.stopPropagation(), setPicker('date'))}>
            <CalendarDays />
          </Button>
        </Tooltip>
        <Menu>
          <MenuTrigger asChild>
            <Button variant="ghost" size="icon-sm" aria-label="More actions" onClick={(e) => e.stopPropagation()}>
              <MoreHorizontal />
            </Button>
          </MenuTrigger>
          <MenuContent align="end" onClick={(e) => e.stopPropagation()}>
            <TaskMenuBody task={task} ids={ids} flavor="dropdown" onPicker={setPicker} onOpen={() => onOpen(task.id)} />
          </MenuContent>
        </Menu>
      </div>
    </div>
  );

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div className="relative">
          <RowPickers task={task} ids={ids} picker={picker} setPicker={setPicker} anchor={row} />
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent onClick={(e) => e.stopPropagation()}>
        <TaskMenuBody task={task} ids={ids} flavor="context" onPicker={setPicker} onOpen={() => onOpen(task.id)} />
      </ContextMenuContent>
    </ContextMenu>
  );
});

/** Dispatch a keyboard command to a rendered row (opens its picker or edit mode). */
export function dispatchRowCommand(taskId: string, kind: PickerKind | 'edit') {
  const el = document.querySelector(`[data-task-id="${taskId}"]`);
  el?.dispatchEvent(new CustomEvent('task-command', { detail: { kind } }));
}
