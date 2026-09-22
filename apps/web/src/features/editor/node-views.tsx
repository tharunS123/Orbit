'use client';

import * as React from 'react';
import Link from 'next/link';
import { NodeViewWrapper, type ReactNodeViewProps } from '@tiptap/react';
import { ChevronRight, Download, FileText, Maximize2, Paperclip, Video } from 'lucide-react';
import { routes } from '@orbit/shared';
import { selectChildren } from '@orbit/sync/client';
import { Button, Skeleton, TaskCheckbox, cn } from '@orbit/ui';
import { formatBytes } from '@orbit/core';
import { useAttachmentUrl } from '@/lib/images';
import { useStoreQuery, useSync } from '@/lib/sync';
import { useTaskCommands } from '@/features/tasks/commands';
import { TaskMeta, TaskRow } from '@/features/tasks/task-row';
import { FilePreview } from '@/features/files/attachments';

/** Context the node views need but the editor package doesn't know about. */
export interface DocContextValue {
  onOpenTask: (id: string) => void;
  readOnly: boolean;
}
export const DocContext = React.createContext<DocContextValue>({ onOpenTask: () => undefined, readOnly: false });

export const FOCUS_TASK_EVENT = 'orbit:focus-task';
/** A task row that should grab focus as soon as it mounts (freshly inserted rows). */
let pendingFocus: string | null = null;
export function requestTaskFocus(taskId: string) {
  pendingFocus = taskId;
  // Already-mounted rows react to the event; new rows check `pendingFocus` on mount.
  setTimeout(() => window.dispatchEvent(new CustomEvent(FOCUS_TASK_EVENT, { detail: taskId })), 0);
}
function takePendingFocus(taskId: string): boolean {
  if (pendingFocus !== taskId) return false;
  pendingFocus = null;
  return true;
}

function SubtaskTree({ parentId, depth }: { parentId: string; depth: number }) {
  const { onOpenTask } = React.useContext(DocContext);
  const children = useStoreQuery(['tasks'], (s) => selectChildren(s, parentId), [parentId]);
  return (
    <>
      {children.map((c) => (
        <React.Fragment key={c.id}>
          <TaskRow task={c} depth={depth} onOpen={onOpenTask} hasChildren={false} />
          <SubtaskTree parentId={c.id} depth={depth + 1} />
        </React.Fragment>
      ))}
    </>
  );
}

export function TaskRefView({ node, editor, getPos, deleteNode, selected }: ReactNodeViewProps<HTMLElement>) {
  const taskId = String(node.attrs.taskId ?? '');
  const { actions } = useSync();
  const cmd = useTaskCommands();
  const { onOpenTask, readOnly } = React.useContext(DocContext);
  const task = useStoreQuery(['tasks'], (s) => s.get('tasks', taskId), [taskId]);
  const childCount = useStoreQuery(['tasks'], (s) => s.childrenOf(taskId).filter((c) => !c.deletedAt).length, [taskId]);
  const [draft, setDraft] = React.useState(task?.title ?? '');
  const [expanded, setExpanded] = React.useState(true);
  const inputRef = React.useRef<HTMLInputElement>(null);

  React.useEffect(() => {
    if (task && document.activeElement !== inputRef.current) setDraft(task.title);
  }, [task?.title]); // eslint-disable-line react-hooks/exhaustive-deps

  React.useLayoutEffect(() => {
    if (takePendingFocus(taskId)) inputRef.current?.focus();
  }, [taskId, task?.id]);

  React.useEffect(() => {
    const onFocus = (e: Event) => {
      if ((e as CustomEvent<string>).detail === taskId) {
        takePendingFocus(taskId);
        inputRef.current?.focus();
      }
    };
    window.addEventListener(FOCUS_TASK_EVENT, onFocus);
    return () => window.removeEventListener(FOCUS_TASK_EVENT, onFocus);
  }, [taskId]);

  if (!task || task.deletedAt) return <NodeViewWrapper as="div" className="hidden" />;

  const pos = () => (typeof getPos === 'function' ? (getPos() ?? 0) : 0);
  const commit = () => {
    const title = draft.trim();
    if (title !== task.title) actions.updateTask(task.id, { title });
  };
  const focusNeighbour = (dir: -1 | 1) => {
    const p = pos();
    const target = dir < 0 ? Math.max(0, p - 1) : Math.min(editor.state.doc.content.size, p + node.nodeSize + 1);
    const $pos = editor.state.doc.resolve(target);
    const neighbour = dir < 0 ? $pos.nodeBefore : $pos.nodeAfter;
    if (neighbour?.type.name === 'taskRef') {
      window.dispatchEvent(new CustomEvent(FOCUS_TASK_EVENT, { detail: neighbour.attrs.taskId }));
      return;
    }
    editor.chain().focus(target).run();
  };

  const done = Boolean(task.completedAt);
  return (
    <NodeViewWrapper as="div" data-completed={done} className={cn('orbit-task-ref relative my-px rounded-md', selected && 'ring-2 ring-accent/40')}>
      <div className="group/row flex items-start gap-2 rounded-md py-1 pr-1 hover:bg-bg-hover/60" data-node-control>
        {childCount ? (
          <button type="button" aria-label={expanded ? 'Collapse subtasks' : 'Expand subtasks'} onClick={() => setExpanded(!expanded)} className="mt-0.5 -ml-6 grid size-5 place-items-center rounded-xs text-fg-subtle hover:bg-bg-active">
            <ChevronRight className={cn('size-3.5 transition-transform', expanded && 'rotate-90')} />
          </button>
        ) : null}
        <span className="mt-[3px]">
          <TaskCheckbox checked={done} disabled={readOnly} label={`${done ? 'Reopen' : 'Complete'} “${task.title || 'Untitled task'}”`} onCheckedChange={() => cmd.toggle([task.id])} />
        </span>
        <div className="min-w-0 flex-1">
          <input
            ref={inputRef}
            value={draft}
            readOnly={readOnly}
            placeholder="New task"
            aria-label="Task title"
            onChange={(e) => setDraft(e.target.value)}
            onBlur={commit}
            onKeyDown={(e) => {
              const el = e.currentTarget;
              if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
                e.preventDefault();
                commit();
                if (e.metaKey || e.ctrlKey) return cmd.toggle([task.id]);
                editor.commands.insertTaskAfter(pos() + node.nodeSize);
              } else if (e.key === 'Backspace' && !draft && el.selectionStart === 0) {
                e.preventDefault();
                actions.deleteTasks([task.id]);
                const p = pos();
                deleteNode();
                editor.chain().focus(Math.max(0, p - 1)).run();
              } else if (e.key === 'ArrowUp' || (e.key === 'ArrowLeft' && el.selectionStart === 0)) {
                e.preventDefault();
                commit();
                focusNeighbour(-1);
              } else if (e.key === 'ArrowDown' || (e.key === 'ArrowRight' && el.selectionStart === draft.length)) {
                e.preventDefault();
                commit();
                focusNeighbour(1);
              } else if (e.key === 'Tab' && !e.shiftKey) {
                // Indent: become a subtask of the task above.
                const $p = editor.state.doc.resolve(pos());
                const prev = $p.nodeBefore;
                if (prev?.type.name === 'taskRef') {
                  e.preventDefault();
                  commit();
                  actions.moveTasks([task.id], { listId: null, parentTaskId: String(prev.attrs.taskId) });
                  deleteNode();
                }
              } else if (e.key === 'Escape') {
                el.blur();
                editor.commands.setNodeSelection(pos());
              }
            }}
            className={cn('w-full bg-transparent text-[15px] leading-6 outline-none placeholder:text-fg-subtle', done && 'text-fg-subtle line-through')}
          />
          <TaskMeta task={task} />
        </div>
        <Button variant="ghost" size="icon-sm" aria-label="Open task details" className="opacity-0 group-hover/row:opacity-100 focus-visible:opacity-100 max-sm:opacity-100" onClick={() => onOpenTask(task.id)}>
          <Maximize2 />
        </Button>
      </div>
      {childCount && expanded ? (
        <div className="pl-7" contentEditable={false}>
          <SubtaskTree parentId={task.id} depth={0} />
        </div>
      ) : null}
    </NodeViewWrapper>
  );
}

export function ListRefView({ node }: ReactNodeViewProps<HTMLElement>) {
  const listId = String(node.attrs.listId ?? '');
  const list = useStoreQuery(['lists'], (s) => s.get('lists', listId), [listId]);
  const open = useStoreQuery(['tasks'], (s) => s.all('tasks').filter((t) => t.listId === listId && !t.completedAt && !t.deletedAt && !t.parentTaskId).length, [listId]);
  if (!list || list.deletedAt) return <NodeViewWrapper as="div" className="hidden" />;
  return (
    <NodeViewWrapper as="div" className="my-1">
      <Link href={routes.list(list.id)} data-node-control className="flex items-center gap-3 rounded-lg border border-border bg-surface px-3 py-2.5 shadow-xs hover:bg-bg-hover">
        <span className="grid size-8 place-items-center rounded-md bg-accent-subtle text-base" aria-hidden>
          {list.emoji ?? <FileText className="size-4 text-accent-subtle-fg" />}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[14px] font-medium">{list.title || 'Untitled list'}</span>
          <span className="text-xs text-fg-subtle">{open ? `${open} open task${open > 1 ? 's' : ''}` : 'Sublist'}</span>
        </span>
        <ChevronRight className="size-4 text-fg-subtle" aria-hidden />
      </Link>
    </NodeViewWrapper>
  );
}

export function MeetingRefView({ node }: ReactNodeViewProps<HTMLElement>) {
  const meetingId = String(node.attrs.meetingId ?? '');
  return (
    <NodeViewWrapper as="div" className="my-1">
      <Link href={routes.meeting(meetingId)} data-node-control className="flex items-center gap-2 rounded-lg border border-border bg-surface px-3 py-2 text-[14px] hover:bg-bg-hover">
        <Video className="size-4 text-accent" aria-hidden /> Meeting notes
      </Link>
    </NodeViewWrapper>
  );
}

export function ImageView({ node, selected, updateAttributes }: ReactNodeViewProps<HTMLElement>) {
  const attachmentId = node.attrs.attachmentId as string | null;
  const { url, loading, error } = useAttachmentUrl(attachmentId);
  const src = attachmentId ? url : (node.attrs.src as string | null);
  const width = (node.attrs.width as number | null) ?? null;
  return (
    <NodeViewWrapper as="figure" className={cn('my-3', selected && 'rounded-lg ring-2 ring-accent/50')}>
      {loading && attachmentId ? (
        <Skeleton className="h-48 w-full" />
      ) : error || !src ? (
        <div className="rounded-lg bg-surface-sunken p-4 text-sm text-fg-subtle">Image unavailable offline or deleted.</div>
      ) : (
        <div className="group/img relative inline-block max-w-full" data-node-control>
          <img src={src} alt={(node.attrs.alt as string) ?? ''} className="max-w-full rounded-lg" style={width ? { width } : undefined} draggable={false} />
          <div className="absolute top-2 right-2 hidden gap-1 group-hover/img:flex">
            {[320, 560, null].map((w) => (
              <button key={String(w)} type="button" className="rounded-md bg-surface/90 px-2 py-0.5 text-xs shadow-sm" onClick={() => updateAttributes({ width: w })}>
                {w === 320 ? 'S' : w === 560 ? 'M' : 'Full'}
              </button>
            ))}
          </div>
        </div>
      )}
    </NodeViewWrapper>
  );
}

export function AttachmentView({ node }: ReactNodeViewProps<HTMLElement>) {
  const attachmentId = String(node.attrs.attachmentId ?? '');
  const attachment = useStoreQuery(['attachments'], (s) => s.get('attachments', attachmentId), [attachmentId]);
  const [preview, setPreview] = React.useState(false);
  if (!attachment || attachment.deletedAt) {
    return (
      <NodeViewWrapper as="div" className="my-1 rounded-lg border border-dashed border-border px-3 py-2 text-sm text-fg-subtle">
        {attachment?.deletedAt ? 'File deleted' : `Uploading ${String(node.attrs.name)}…`}
      </NodeViewWrapper>
    );
  }
  return (
    <NodeViewWrapper as="div" className="my-1">
      <div data-node-control className="flex items-center gap-3 rounded-lg border border-border bg-surface px-3 py-2">
        <Paperclip className="size-4 text-fg-muted" aria-hidden />
        <button type="button" onClick={() => setPreview(true)} className="min-w-0 flex-1 truncate text-left text-[14px] font-medium hover:underline">
          {attachment.name}
        </button>
        <span className="text-xs text-fg-subtle">{formatBytes(attachment.sizeBytes)}</span>
        <Button variant="ghost" size="icon-sm" aria-label="Preview" onClick={() => setPreview(true)}>
          <Download />
        </Button>
      </div>
      <FilePreview attachment={attachment} open={preview} onOpenChange={setPreview} />
    </NodeViewWrapper>
  );
}
