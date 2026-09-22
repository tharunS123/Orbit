'use client';

import * as React from 'react';
import {
  closestCenter,
  DndContext,
  DragOverlay,
  KeyboardSensor,
  PointerSensor,
  TouchSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
} from '@dnd-kit/core';
import { restrictToVerticalAxis } from '@dnd-kit/modifiers';
import { SortableContext, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { CalendarDays, CornerDownLeft, Plus, Repeat, Tag, UserRound } from 'lucide-react';
import type { Task } from '@orbit/shared';
import { describeRecurrence, formatCivilLong } from '@orbit/core';
import { selectChildren } from '@orbit/sync/client';
import { cn, Kbd } from '@orbit/ui';
import { useStoreQuery, useSync } from '@/lib/sync';
import { useUndo } from '@/lib/undo';
import { TaskRow } from './task-row';

export interface TaskListProps {
  tasks: Task[];
  onOpen: (id: string) => void;
  /** Persist a reorder: move `ids` to `toIndex` among `tasks`. Omit to disable dragging. */
  onReorder?: (ids: string[], toIndex: number) => void;
  tree?: boolean;
  showList?: boolean;
  showWorkspace?: boolean;
  empty?: React.ReactNode;
  ariaLabel: string;
  className?: string;
}

function SortableItem({ task, children }: { task: Task; children: (handle: React.HTMLAttributes<HTMLButtonElement>, dragging: boolean) => React.ReactNode }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: task.id });
  return (
    <div ref={setNodeRef} style={{ transform: CSS.Translate.toString(transform), transition }} className="relative">
      {children({ ...attributes, ...listeners } as React.HTMLAttributes<HTMLButtonElement>, isDragging)}
    </div>
  );
}

function useExpanded(key: string) {
  const [expanded, setExpanded] = React.useState<Record<string, boolean>>(() => {
    try {
      return JSON.parse(localStorage.getItem(`orbit.expanded.${key}`) ?? '{}') as Record<string, boolean>;
    } catch {
      return {};
    }
  });
  const toggle = React.useCallback(
    (id: string) =>
      setExpanded((prev) => {
        const next = { ...prev, [id]: !(prev[id] ?? true) };
        try {
          localStorage.setItem(`orbit.expanded.${key}`, JSON.stringify(next));
        } catch {
          /* ignore */
        }
        return next;
      }),
    [key],
  );
  return [expanded, toggle] as const;
}

function TreeChildren({ parent, depth, onOpen, expanded, toggle }: { parent: Task; depth: number; onOpen: (id: string) => void; expanded: Record<string, boolean>; toggle: (id: string) => void }) {
  const { actions } = useSync();
  const { run } = useUndo();
  const children = useStoreQuery(['tasks'], (s) => selectChildren(s, parent.id), [parent.id]);
  if (!children.length) return null;
  return (
    <SortableGroup
      tasks={children}
      onReorder={(ids, toIndex) => run(null, () => actions.reorder(children, ids, toIndex), { toast: false })}
      render={(task, handle, dragging) => <TreeNode task={task} depth={depth} onOpen={onOpen} expanded={expanded} toggle={toggle} handle={handle} dragging={dragging} />}
    />
  );
}

function TreeNode({ task, depth, onOpen, expanded, toggle, handle, dragging, showList, showWorkspace }: { task: Task; depth: number; onOpen: (id: string) => void; expanded: Record<string, boolean>; toggle: (id: string) => void; handle?: React.HTMLAttributes<HTMLButtonElement>; dragging?: boolean; showList?: boolean; showWorkspace?: boolean }) {
  const hasChildren = useStoreQuery(['tasks'], (s) => s.childrenOf(task.id).some((c) => !c.deletedAt), [task.id]);
  const isOpen = expanded[task.id] ?? true;
  return (
    <>
      <TaskRow task={task} depth={depth} onOpen={onOpen} hasChildren={hasChildren} expanded={isOpen} onToggleExpand={() => toggle(task.id)} dragHandleProps={handle} isDragging={dragging} showList={showList} showWorkspace={showWorkspace} />
      {hasChildren && isOpen ? <TreeChildren parent={task} depth={depth + 1} onOpen={onOpen} expanded={expanded} toggle={toggle} /> : null}
    </>
  );
}

function SortableGroup({ tasks, onReorder, render }: { tasks: Task[]; onReorder?: (ids: string[], toIndex: number) => void; render: (task: Task, handle: React.HTMLAttributes<HTMLButtonElement> | undefined, dragging: boolean) => React.ReactNode }) {
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 250, tolerance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
  const [active, setActive] = React.useState<Task | null>(null);
  if (!onReorder) return <>{tasks.map((t) => <React.Fragment key={t.id}>{render(t, undefined, false)}</React.Fragment>)}</>;
  const onStart = (e: DragStartEvent) => setActive(tasks.find((t) => t.id === e.active.id) ?? null);
  const onEnd = (e: DragEndEvent) => {
    setActive(null);
    if (!e.over || e.active.id === e.over.id) return;
    const from = tasks.findIndex((t) => t.id === e.active.id);
    const to = tasks.findIndex((t) => t.id === e.over!.id);
    if (from < 0 || to < 0) return;
    // planMove expects the index among the remaining items after removal.
    onReorder([String(e.active.id)], to);
  };
  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCenter}
      modifiers={[restrictToVerticalAxis]}
      onDragStart={onStart}
      onDragEnd={onEnd}
      onDragCancel={() => setActive(null)}
      accessibility={{
        screenReaderInstructions: { draggable: 'To reorder, press space or enter to pick up a task, use the arrow keys to move it, and press space or enter again to drop it.' },
      }}
    >
      <SortableContext items={tasks.map((t) => t.id)} strategy={verticalListSortingStrategy}>
        {tasks.map((t) => (
          <SortableItem key={t.id} task={t}>
            {(handle, dragging) => render(t, handle, dragging)}
          </SortableItem>
        ))}
      </SortableContext>
      <DragOverlay dropAnimation={{ duration: 160, easing: 'cubic-bezier(.2,.8,.2,1)' }}>
        {active ? (
          <div className="rounded-md bg-surface-raised shadow-lg ring-1 ring-border">
            <TaskRow task={active} onOpen={() => undefined} />
          </div>
        ) : null}
      </DragOverlay>
    </DndContext>
  );
}

export function TaskList({ tasks, onOpen, onReorder, tree, showList, showWorkspace, empty, ariaLabel, className }: TaskListProps) {
  const [expanded, toggle] = useExpanded(ariaLabel);
  if (!tasks.length) return <>{empty ?? null}</>;
  return (
    <div role="grid" aria-label={ariaLabel} className={cn('flex flex-col', className)}>
      <SortableGroup
        tasks={tasks}
        onReorder={onReorder}
        render={(task, handle, dragging) =>
          tree ? (
            <TreeNode task={task} depth={0} onOpen={onOpen} expanded={expanded} toggle={toggle} handle={handle} dragging={dragging} showList={showList} showWorkspace={showWorkspace} />
          ) : (
            <TaskRow task={task} onOpen={onOpen} dragHandleProps={handle} isDragging={dragging} showList={showList} showWorkspace={showWorkspace} />
          )
        }
      />
    </div>
  );
}

/** Inline "Add a task" row with live natural-language parsing preview. */
export function QuickAddRow({
  workspaceId,
  listId = null,
  parentTaskId = null,
  inInbox,
  defaultDue,
  placeholder = 'Add a task',
  onCreated,
  autoFocus,
  className,
}: {
  workspaceId: string;
  listId?: string | null;
  parentTaskId?: string | null;
  inInbox?: boolean;
  defaultDue?: string | null;
  placeholder?: string;
  onCreated?: (id: string) => void;
  autoFocus?: boolean;
  className?: string;
}) {
  const { actions, store } = useSync();
  const { run } = useUndo();
  const [text, setText] = React.useState('');
  const [focused, setFocused] = React.useState(Boolean(autoFocus));
  const inputRef = React.useRef<HTMLInputElement>(null);
  const parsed = React.useMemo(() => (text.trim() ? actions.preview(text, workspaceId, listId) : null), [text, actions, workspaceId, listId]);

  const submit = () => {
    if (!text.trim()) return;
    const res = run(null, () =>
      actions.createTask({
        workspaceId,
        text,
        listId,
        parentTaskId,
        inInbox,
        ...(defaultDue && !parsed?.dueDate ? { dueDate: defaultDue } : {}),
      }),
      { toast: false },
    ) as { id: string } | undefined;
    setText('');
    if (res?.id) onCreated?.(res.id);
  };

  const assignee = parsed?.assigneeId ? store.get('profiles', parsed.assigneeId) : null;
  return (
    <div className={cn('rounded-md', focused && 'bg-surface shadow-xs ring-1 ring-border', className)}>
      <div className="flex min-h-11 items-center gap-2 px-1 sm:min-h-9">
        <span className="grid size-5 place-items-center text-fg-subtle" aria-hidden>
          <Plus className="size-4" />
        </span>
        <input
          ref={inputRef}
          value={text}
          autoFocus={autoFocus}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
              e.preventDefault();
              submit();
            } else if (e.key === 'Escape') {
              setText('');
              inputRef.current?.blur();
            }
          }}
          placeholder={placeholder}
          aria-label={placeholder}
          className="min-w-0 flex-1 bg-transparent text-[14.5px] outline-none placeholder:text-fg-subtle sm:text-sm"
        />
        {text ? (
          <span className="hidden items-center gap-1 text-xs text-fg-subtle sm:flex">
            <Kbd>
              <CornerDownLeft className="size-3" />
            </Kbd>
          </span>
        ) : null}
      </div>
      {parsed && (parsed.dueDate || parsed.recurrence || parsed.labelIds.length || parsed.newLabelNames.length || parsed.assigneeId || parsed.ambiguousAssignee) ? (
        <div className="flex flex-wrap items-center gap-1.5 px-8 pb-2 text-xs" aria-live="polite">
          {parsed.dueDate ? (
            <span className="inline-flex items-center gap-1 rounded-full bg-accent-subtle px-2 py-0.5 text-accent-subtle-fg">
              <CalendarDays className="size-3" /> {formatCivilLong(parsed.dueDate)}
              {parsed.dueTime ? ` · ${parsed.dueTime}` : ''}
            </span>
          ) : null}
          {parsed.recurrence ? (
            <span className="inline-flex items-center gap-1 rounded-full bg-accent-subtle px-2 py-0.5 text-accent-subtle-fg">
              <Repeat className="size-3" /> {describeRecurrence(parsed.recurrence)}
            </span>
          ) : null}
          {[...parsed.labelIds.map((id) => store.get('labels', id)?.name ?? ''), ...parsed.newLabelNames.map((n) => `${n} (new)`)].filter(Boolean).map((n) => (
            <span key={n} className="inline-flex items-center gap-1 rounded-full bg-bg-hover px-2 py-0.5 text-fg-muted">
              <Tag className="size-3" /> {n}
            </span>
          ))}
          {assignee ? (
            <span className="inline-flex items-center gap-1 rounded-full bg-bg-hover px-2 py-0.5 text-fg-muted">
              <UserRound className="size-3" /> {assignee.displayName}
            </span>
          ) : parsed.ambiguousAssignee ? (
            <span className="text-warning">Several people match “@{parsed.ambiguousAssignee}” — assign after creating.</span>
          ) : null}
          <span className="text-fg-subtle">→ “{parsed.title || text.trim()}”</span>
        </div>
      ) : null}
    </div>
  );
}
