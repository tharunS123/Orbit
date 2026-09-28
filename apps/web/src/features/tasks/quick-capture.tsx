'use client';

import * as React from 'react';
import { CornerDownLeft } from 'lucide-react';
import { Button, Shortcut } from '@orbit/ui';
import { useWorkspace } from '@/lib/workspace';
import { SHORTCUTS } from '@/lib/shortcuts';
import { CaptureChips, CaptureControls, useCaptureDraft } from './capture-fields';

/**
 * Fast capture: one input with natural language ("Pay rent every month #home @sam"), a
 * destination (Inbox or list), metadata controls and a live preview. Enter saves; ⌘Enter saves
 * and keeps the dialog open for the next task.
 */
export function QuickCaptureForm({ defaultListId = null, onDone, compact }: { defaultListId?: string | null; onDone?: (createdId: string | null) => void; compact?: boolean }) {
  const { workspaceId } = useWorkspace();
  const draft = useCaptureDraft({ workspaceId, defaultListId });
  const [count, setCount] = React.useState(0);
  const input = React.useRef<HTMLTextAreaElement>(null);

  const save = (keepOpen: boolean) => {
    const res = draft.save({ toast: !keepOpen });
    if (!res) return;
    setCount((c) => c + 1);
    if (keepOpen) input.current?.focus();
    else onDone?.(res.id);
  };

  return (
    <div className="flex flex-col gap-2">
      <textarea
        ref={input}
        autoFocus
        rows={compact ? 1 : 2}
        value={draft.text}
        onChange={(e) => draft.setText(e.target.value)}
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
      <CaptureChips draft={draft} extra={count ? <span className="text-fg-subtle">{count} added</span> : null} />
      <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border pt-3">
        <CaptureControls draft={draft} />
        <div className="ml-auto flex items-center gap-2">
          <span className="hidden items-center gap-1 text-[11px] text-fg-subtle sm:inline-flex">
            <Shortcut keys={SHORTCUTS.saveAnother} /> add another
          </span>
          <Button variant="primary" size="sm" disabled={!draft.text.trim()} onClick={() => save(false)}>
            Add task <CornerDownLeft />
          </Button>
        </div>
      </div>
    </div>
  );
}
