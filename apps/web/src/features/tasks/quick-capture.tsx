'use client';

import * as React from 'react';
import { CalendarDays, ChevronDown, CornerDownLeft, FileText, Inbox, Repeat, Tag, UserRound } from 'lucide-react';
import { describeRecurrence, formatCivilLong } from '@orbit/core';
import { Button, Kbd, cn } from '@orbit/ui';
import { useSync } from '@/lib/sync';
import { useUndo } from '@/lib/undo';
import { useWorkspace } from '@/lib/workspace';
import { ListPicker } from './pickers';

/**
 * Fast capture: one input with natural language ("Pay rent every month #home @sam"), a
 * destination (Inbox or list) and a live preview. Enter saves; ⌘Enter saves and keeps typing.
 */
export function QuickCaptureForm({ defaultListId = null, onDone, compact }: { defaultListId?: string | null; onDone?: (createdId: string | null) => void; compact?: boolean }) {
  const { actions, store } = useSync();
  const { workspaceId } = useWorkspace();
  const { run } = useUndo();
  const [text, setText] = React.useState('');
  const [listId, setListId] = React.useState<string | null>(defaultListId);
  const [count, setCount] = React.useState(0);
  const list = listId ? store.get('lists', listId) : null;
  const ws = list?.workspaceId ?? workspaceId;
  const parsed = React.useMemo(() => (text.trim() && ws ? actions.preview(text, ws, listId) : null), [text, actions, ws, listId]);

  const save = (keepOpen: boolean) => {
    if (!text.trim() || !ws) return;
    const res = run(list ? `Added to ${list.title || 'list'}` : 'Added to Inbox', () => actions.createTask({ workspaceId: ws, text, listId, inInbox: !listId }), { toast: !keepOpen }) as { id: string } | undefined;
    setText('');
    setCount((c) => c + 1);
    if (!keepOpen) onDone?.(res?.id ?? null);
  };

  return (
    <div className="flex flex-col gap-2">
      <textarea
        autoFocus
        rows={compact ? 1 : 2}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault();
            save(e.metaKey || e.ctrlKey);
          } else if (e.key === 'Escape') {
            onDone?.(null);
          }
        }}
        placeholder="What needs doing? Try “Send invoice tomorrow at 9am #finance”"
        aria-label="New task"
        className="w-full resize-none bg-transparent text-[16px] leading-relaxed outline-none placeholder:text-fg-subtle"
      />
      <div className="flex min-h-6 flex-wrap items-center gap-1.5 text-xs" aria-live="polite">
        {parsed?.dueDate ? (
          <span className="inline-flex items-center gap-1 rounded-full bg-accent-subtle px-2 py-0.5 text-accent-subtle-fg">
            <CalendarDays className="size-3" /> {formatCivilLong(parsed.dueDate)}
            {parsed.dueTime ? ` · ${parsed.dueTime}` : ''}
          </span>
        ) : null}
        {parsed?.recurrence ? (
          <span className="inline-flex items-center gap-1 rounded-full bg-accent-subtle px-2 py-0.5 text-accent-subtle-fg">
            <Repeat className="size-3" /> {describeRecurrence(parsed.recurrence)}
          </span>
        ) : null}
        {parsed ? [...parsed.labelIds.map((id) => store.get('labels', id)?.name ?? ''), ...parsed.newLabelNames.map((n) => `${n} (new)`)].filter(Boolean).map((n) => (
          <span key={n} className="inline-flex items-center gap-1 rounded-full bg-bg-hover px-2 py-0.5 text-fg-muted">
            <Tag className="size-3" /> {n}
          </span>
        )) : null}
        {parsed?.assigneeId ? (
          <span className="inline-flex items-center gap-1 rounded-full bg-bg-hover px-2 py-0.5 text-fg-muted">
            <UserRound className="size-3" /> {store.get('profiles', parsed.assigneeId)?.displayName}
          </span>
        ) : null}
        {count ? <span className="text-fg-subtle">{count} added</span> : null}
      </div>
      <div className="flex items-center justify-between gap-2 border-t border-border pt-3">
        {ws ? (
          <ListPicker workspaceId={ws} currentListId={listId} onPick={setListId}>
            <Button variant="ghost" size="sm" className={cn('max-w-56')}>
              {list ? <span aria-hidden>{list.emoji ?? <FileText className="size-4" />}</span> : <Inbox />}
              <span className="truncate">{list ? list.title || 'Untitled list' : 'Inbox'}</span>
              <ChevronDown className="size-3.5 opacity-60" />
            </Button>
          </ListPicker>
        ) : (
          <span />
        )}
        <div className="flex items-center gap-2">
          <span className="hidden text-[11px] text-fg-subtle sm:inline">
            <Kbd>⌘</Kbd>
            <Kbd>↵</Kbd> add another
          </span>
          <Button variant="primary" size="sm" disabled={!text.trim()} onClick={() => save(false)}>
            Add task <CornerDownLeft />
          </Button>
        </div>
      </div>
    </div>
  );
}
