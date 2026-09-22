'use client';

import * as React from 'react';
import { ArrowRightLeft, CalendarDays, CheckCircle2, CopyPlus, Inbox, Tag, Trash2, UserRound, X } from 'lucide-react';
import type { Task } from '@orbit/shared';
import { Button, Tooltip } from '@orbit/ui';
import { SHORTCUTS, useHotkeys } from '@/lib/hotkeys';
import { useSync } from '@/lib/sync';
import { useUndo } from '@/lib/undo';
import { useTaskCommands } from './commands';
import { AssigneePicker, DatePicker, LabelPicker, ListPicker } from './pickers';
import { useSelection } from './selection';
import { dispatchRowCommand } from './task-row';

/**
 * Keyboard control for a task view: navigation, selection and every row action. The view passes
 * its visible task order and how to find siblings for Alt+↑/↓ moves.
 */
export function TaskKeyboard({ order, onOpen, siblingsOf }: { order: string[]; onOpen: (id: string) => void; siblingsOf?: (task: Task) => Task[] }) {
  const selection = useSelection();
  const cmd = useTaskCommands();
  const { actions, store } = useSync();
  const { run } = useUndo();
  const key = order.join(',');
  React.useEffect(() => {
    selection.setOrder(order);
  }, [key]); // eslint-disable-line react-hooks/exhaustive-deps

  const targets = () => selection.targets();
  const withTargets = (fn: (ids: string[]) => void) => () => {
    const ids = targets();
    if (ids.length) fn(ids);
  };
  const moveBy = (delta: number) => () => {
    const id = selection.focused;
    const task = id ? store.get('tasks', id) : undefined;
    if (!task || !siblingsOf) return;
    const sibs = siblingsOf(task);
    const idx = sibs.findIndex((s) => s.id === task.id);
    const to = idx + delta;
    if (idx < 0 || to < 0 || to >= sibs.length) return;
    run(null, () => actions.reorder(sibs, [task.id], to), { toast: false });
  };

  useHotkeys(
    {
      down: () => selection.move(1),
      j: () => selection.move(1),
      up: () => selection.move(-1),
      k: () => selection.move(-1),
      'shift+down': () => selection.move(1, true),
      'shift+up': () => selection.move(-1, true),
      [SHORTCUTS.selectAll]: () => selection.selectAll(),
      escape: () => selection.clear(),
      [SHORTCUTS.open]: () => selection.focused && onOpen(selection.focused),
      [SHORTCUTS.complete]: withTargets((ids) => cmd.toggle(ids)),
      x: withTargets((ids) => ids.forEach((id) => selection.toggle(id))),
      [SHORTCUTS.edit]: () => selection.focused && dispatchRowCommand(selection.focused, 'edit'),
      [SHORTCUTS.schedule]: () => selection.focused && dispatchRowCommand(selection.focused, 'date'),
      [SHORTCUTS.scheduleToday]: withTargets((ids) => cmd.schedule(ids, 'today')),
      [SHORTCUTS.label]: () => selection.focused && dispatchRowCommand(selection.focused, 'labels'),
      [SHORTCUTS.assign]: () => selection.focused && dispatchRowCommand(selection.focused, 'assign'),
      m: () => selection.focused && dispatchRowCommand(selection.focused, 'move'),
      [SHORTCUTS.duplicate]: withTargets((ids) => cmd.duplicate(ids)),
      [SHORTCUTS.delete]: withTargets((ids) => (cmd.remove(ids), selection.clear())),
      delete: withTargets((ids) => (cmd.remove(ids), selection.clear())),
      [SHORTCUTS.moveUp]: moveBy(-1),
      [SHORTCUTS.moveDown]: moveBy(1),
    },
    [selection, cmd, key],
  );
  return null;
}

/** Floating bar for bulk actions when several tasks are selected (desktop & mobile). */
export function BulkActionBar() {
  const selection = useSelection();
  const cmd = useTaskCommands();
  const { store } = useSync();
  const ids = [...selection.selected];
  if (ids.length < 1 || (ids.length === 1 && !selection.selectionMode)) return null;
  const first = store.get('tasks', ids[0]!);
  if (!first) return null;
  return (
    <div role="toolbar" aria-label={`${ids.length} tasks selected`} className="fixed inset-x-0 bottom-20 z-40 mx-auto flex w-fit max-w-[calc(100vw-1.5rem)] items-center gap-0.5 overflow-x-auto rounded-xl border border-border bg-surface-raised p-1 shadow-lg animate-slide-up sm:bottom-6">
      <span className="px-2.5 text-[13px] font-medium whitespace-nowrap">{ids.length} selected</span>
      <Tooltip content="Complete" shortcut={SHORTCUTS.complete}>
        <Button variant="ghost" size="icon" aria-label="Complete" onClick={() => (cmd.toggle(ids), selection.clear())}>
          <CheckCircle2 />
        </Button>
      </Tooltip>
      <DatePicker value={{ dueDate: first.dueDate, dueTime: null }} onChange={(v) => cmd.setDue(ids, v.dueDate, v.dueTime)}>
        <Button variant="ghost" size="icon" aria-label="Set due date">
          <CalendarDays />
        </Button>
      </DatePicker>
      <AssigneePicker workspaceId={first.workspaceId} listId={first.listId} value={null} onChange={(u) => cmd.assign(ids, u)}>
        <Button variant="ghost" size="icon" aria-label="Assign">
          <UserRound />
        </Button>
      </AssigneePicker>
      <LabelPicker workspaceId={first.workspaceId} value={[]} onToggle={(labelId, on) => cmd.toggleLabel(ids, labelId, on)}>
        <Button variant="ghost" size="icon" aria-label="Labels">
          <Tag />
        </Button>
      </LabelPicker>
      <ListPicker workspaceId={first.workspaceId} currentListId={null} onPick={(l) => (cmd.move(ids, l), selection.clear())}>
        <Button variant="ghost" size="icon" aria-label="Move to list">
          <ArrowRightLeft />
        </Button>
      </ListPicker>
      <Tooltip content="Add to Inbox">
        <Button variant="ghost" size="icon" aria-label="Add to Inbox" onClick={() => cmd.setInbox(ids, true)}>
          <Inbox />
        </Button>
      </Tooltip>
      <Tooltip content="Duplicate" shortcut={SHORTCUTS.duplicate}>
        <Button variant="ghost" size="icon" aria-label="Duplicate" onClick={() => cmd.duplicate(ids)}>
          <CopyPlus />
        </Button>
      </Tooltip>
      <Tooltip content="Delete" shortcut={SHORTCUTS.delete}>
        <Button variant="danger-ghost" size="icon" aria-label="Delete" onClick={() => (cmd.remove(ids), selection.clear())}>
          <Trash2 />
        </Button>
      </Tooltip>
      <Tooltip content="Clear selection" shortcut="escape">
        <Button variant="ghost" size="icon" aria-label="Clear selection" onClick={() => selection.clear()}>
          <X />
        </Button>
      </Tooltip>
    </div>
  );
}
