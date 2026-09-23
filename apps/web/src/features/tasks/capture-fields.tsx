'use client';

import * as React from 'react';
import { CalendarDays, ChevronDown, FileText, Inbox, Repeat, Tag, UserRound } from 'lucide-react';
import { describeRecurrence } from '@orbit/core';
import { uuidv7 } from '@orbit/shared';
import { Avatar, Button, Tooltip, cn } from '@orbit/ui';
import { prefersHour12 } from '@/lib/format';
import { useNow, useStoreQuery, useSync } from '@/lib/sync';
import { useUndo } from '@/lib/undo';
import { buildCreateInput, captureDueLabel, effectiveMetadata, SubmitGuard, type CaptureMetadata, type CaptureOverrides } from './capture-core';
import { AssigneePicker, DatePicker, LabelPicker, ListPicker } from './pickers';

/**
 * Draft state for task capture: text, explicit metadata choices, the live parse (the same parser
 * `createTask` uses) and a save that runs at most once per draft.
 */
export function useCaptureDraft({ workspaceId, defaultListId }: { workspaceId: string | null; defaultListId: string | null }) {
  const { actions, store } = useSync();
  const { run } = useUndo();
  const [text, setText] = React.useState('');
  const [overrides, setOverrides] = React.useState<CaptureOverrides>({});
  const guard = React.useRef<SubmitGuard | null>(null);
  guard.current ??= new SubmitGuard();

  const listId = overrides.listId !== undefined ? overrides.listId : defaultListId;
  const list = listId ? store.get('lists', listId) : null;
  const ws = list?.workspaceId ?? workspaceId;
  const parsed = React.useMemo(() => (text.trim() && ws ? actions.preview(text, ws, listId) : null), [text, actions, ws, listId]);
  const meta = effectiveMetadata(parsed, overrides, defaultListId);

  const reset = React.useCallback(() => {
    setText('');
    setOverrides({});
    guard.current!.next();
  }, []);

  /**
   * Create the task. Returns its id, or null when there is nothing to save, this draft was already
   * saved (double Enter), or the store rejected it (already reported; the draft stays intact).
   */
  const save = React.useCallback(
    (opts: { toast?: boolean } = {}): { id: string; destination: string } | null => {
      const g = guard.current!;
      if (!text.trim() || !ws || !g.begin()) return null;
      const destination = list ? list.title || 'Untitled list' : 'Inbox';
      const draftId = g.id;
      let first = true;
      // Redo (after undo deleted it) creates a fresh task rather than reviving this id.
      const create = () => actions.createTask(buildCreateInput({ id: first ? draftId : uuidv7(), workspaceId: ws, text, overrides, defaultListId }));
      const result = run(`Added to ${destination}`, () => {
        const r = create();
        first = false;
        return r;
      }, { toast: opts.toast ?? true });
      if (!result) {
        g.fail();
        return null;
      }
      reset();
      return { id: draftId, destination };
    },
    [text, ws, list, run, actions, overrides, defaultListId, reset],
  );

  return { text, setText, overrides, setOverrides, parsed, meta, workspaceId: ws, list, reset, save };
}

export type CaptureDraft = ReturnType<typeof useCaptureDraft>;

const chip = 'inline-flex max-w-full items-center gap-1 truncate rounded-full px-2 py-0.5';

/** Parsed/selected metadata as compact chips, announced politely to screen readers. */
export function CaptureChips({ draft, showDestination, extra, className }: { draft: CaptureDraft; showDestination?: boolean; extra?: React.ReactNode; className?: string }) {
  const { store, timeZone } = useSync();
  const now = useNow();
  const labels = useStoreQuery(['labels'], (s) => s.all('labels'), []);
  const { meta } = draft;
  const labelNames = [...meta.labelIds.map((id) => labels.find((l) => l.id === id)?.name ?? ''), ...meta.newLabelNames.map((n) => `${n} (new)`)].filter(Boolean);
  const assignee = meta.assigneeId ? store.get('profiles', meta.assigneeId) : null;
  const hasAny = Boolean(meta.dueDate || meta.recurrence || labelNames.length || assignee || showDestination);
  return (
    <div className={cn('flex min-h-6 flex-wrap items-center gap-1.5 text-xs', className)} aria-live="polite" aria-label={hasAny ? 'Task details' : undefined}>
      {meta.dueDate ? (
        <span className={cn(chip, 'bg-accent-subtle text-accent-subtle-fg')} data-testid="capture-chip-due">
          <CalendarDays className="size-3 shrink-0" aria-hidden /> {captureDueLabel(meta.dueDate, meta.dueTime, timeZone, now, prefersHour12())}
        </span>
      ) : null}
      {meta.recurrence ? (
        <span className={cn(chip, 'bg-accent-subtle text-accent-subtle-fg')}>
          <Repeat className="size-3 shrink-0" aria-hidden /> {describeRecurrence(meta.recurrence)}
        </span>
      ) : null}
      {labelNames.map((n) => (
        <span key={n} className={cn(chip, 'bg-bg-hover text-fg-muted')} data-testid="capture-chip-label">
          <Tag className="size-3 shrink-0" aria-hidden /> {n}
        </span>
      ))}
      {assignee ? (
        <span className={cn(chip, 'bg-bg-hover text-fg-muted')}>
          <UserRound className="size-3 shrink-0" aria-hidden /> {assignee.displayName}
        </span>
      ) : null}
      {draft.parsed?.ambiguousAssignee ? <span className="text-fg-subtle">Several people match @{draft.parsed.ambiguousAssignee} — pick one below</span> : null}
      {showDestination ? (
        <span className={cn(chip, 'bg-bg-hover text-fg-muted')} data-testid="capture-chip-destination">
          {draft.list ? <FileText className="size-3 shrink-0" aria-hidden /> : <Inbox className="size-3 shrink-0" aria-hidden />} {draft.list ? draft.list.title || 'Untitled list' : 'Inbox'}
        </span>
      ) : null}
      {extra}
    </div>
  );
}

/** A metadata control: icon + value when set, icon-only (with tooltip) when empty. */
const ControlButton = React.forwardRef<HTMLButtonElement, React.ComponentProps<typeof Button> & { icon: React.ReactNode; label: string; value?: string }>(function ControlButton({ icon, label, value, className, ...props }, ref) {
  const button = (
    <Button ref={ref} variant="ghost" size="sm" aria-label={value ? `${label}: ${value}` : label} className={cn('gap-1.5', value ? 'max-w-52 px-2 text-fg' : 'px-2', className)} {...props}>
      {icon}
      {value ? (
        <>
          <span className="truncate">{value}</span>
          <ChevronDown className="size-3 opacity-50" aria-hidden />
        </>
      ) : null}
    </Button>
  );
  return value ? button : <Tooltip content={label}>{button}</Tooltip>;
});

/**
 * Destination / due / label / assignee controls. Tab moves between them; each opens a searchable
 * picker navigated with the arrow keys. Choices override what the text says.
 */
export function CaptureControls({ draft, onPickerOpenChange, destination = true }: { draft: CaptureDraft; onPickerOpenChange?: (open: boolean) => void; destination?: boolean }) {
  const { store, timeZone } = useSync();
  const now = useNow();
  const { meta, workspaceId, setOverrides } = draft;
  const [open, setOpen] = React.useState<null | 'list' | 'due' | 'label' | 'assignee'>(null);
  const openState = (which: NonNullable<typeof open>) => ({
    open: open === which,
    onOpenChange: (o: boolean) => {
      setOpen(o ? which : null);
      onPickerOpenChange?.(o);
    },
  });
  if (!workspaceId) return null;
  const assignee = meta.assigneeId ? store.get('profiles', meta.assigneeId) : null;
  const labelCount = meta.labelIds.length + meta.newLabelNames.length;
  const set = (patch: Partial<CaptureOverrides>) => setOverrides((o) => ({ ...o, ...patch }));
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-0.5" role="group" aria-label="Task details">
      {destination ? (
        <ListPicker workspaceId={workspaceId} currentListId={meta.listId} onPick={(listId) => set({ listId })} {...openState('list')}>
          <ControlButton icon={draft.list ? <span aria-hidden>{draft.list.emoji ?? <FileText className="size-4" />}</span> : <Inbox />} label="Destination" value={draft.list ? draft.list.title || 'Untitled list' : 'Inbox'} data-testid="capture-destination" />
        </ListPicker>
      ) : null}
      <DatePicker value={{ dueDate: meta.dueDate, dueTime: meta.dueTime }} onChange={(due) => set({ due })} {...openState('due')}>
        <ControlButton icon={<CalendarDays />} label="Due date" value={meta.dueDate ? captureDueLabel(meta.dueDate, meta.dueTime, timeZone, now, prefersHour12()) : undefined} />
      </DatePicker>
      <LabelPicker
        workspaceId={workspaceId}
        value={meta.labelIds}
        onToggle={(labelId, on) => setOverrides((o) => ({ ...o, labelIds: on ? [...new Set([...(o.labelIds ?? []), labelId])] : (o.labelIds ?? []).filter((l) => l !== labelId) }))}
        {...openState('label')}
      >
        <ControlButton icon={<Tag />} label="Labels" value={labelCount ? `${labelCount} label${labelCount === 1 ? '' : 's'}` : undefined} />
      </LabelPicker>
      <AssigneePicker workspaceId={workspaceId} listId={meta.listId} value={meta.assigneeId} onChange={(assigneeId) => set({ assigneeId })} {...openState('assignee')}>
        <ControlButton icon={assignee ? <Avatar name={assignee.displayName} seed={assignee.id} size={16} /> : <UserRound />} label="Assignee" value={assignee?.displayName} />
      </AssigneePicker>
    </div>
  );
}

export type { CaptureMetadata };
