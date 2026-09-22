'use client';

import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import { Mic, MoreHorizontal, Pencil, Reply, SendHorizontal, SmilePlus, Square, Trash2, X } from 'lucide-react';
import { uuidv7, type Profile, type TaskMessage } from '@orbit/shared';
import { selectAssignable, selectMessages } from '@orbit/sync/client';
import { Avatar, Button, Menu, MenuContent, MenuItem, MenuTrigger, Popover, PopoverContent, PopoverTrigger, Spinner, cn, toast } from '@orbit/ui';
import { apiFetch } from '@/lib/api';
import { useAttachmentUrl, useSignedImage } from '@/lib/images';
import { useStoreQuery, useSync } from '@/lib/sync';
import { useUploads } from '@/features/files/uploads';

const MENTION_RE = /@\[([^\]]{1,80})\]\(([0-9a-f-]{36})\)/g;
const QUICK_REACTIONS = ['👍', '❤️', '🎉', '😄', '👀', '✅'];

export function extractMentions(body: string): string[] {
  return [...new Set([...body.matchAll(MENTION_RE)].map((m) => m[2]!))];
}

function relTime(iso: string): string {
  const d = new Date(iso);
  const diff = (Date.now() - d.getTime()) / 1000;
  if (diff < 60) return 'just now';
  if (diff < 3600) return `${Math.floor(diff / 60)}m`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h`;
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function MessageBody({ body }: { body: string }) {
  const parts: React.ReactNode[] = [];
  let last = 0;
  for (const m of body.matchAll(MENTION_RE)) {
    parts.push(body.slice(last, m.index));
    parts.push(
      <span key={m.index} className="rounded-xs bg-accent-subtle px-0.5 font-medium text-accent-subtle-fg">
        @{m[1]}
      </span>,
    );
    last = m.index! + m[0].length;
  }
  parts.push(body.slice(last));
  // Plain text only — no HTML is ever rendered from message bodies (XSS-safe).
  return <p className="text-[13.5px] leading-relaxed break-words whitespace-pre-wrap">{parts}</p>;
}

function VoiceMessage({ attachmentId }: { attachmentId: string }) {
  const { url, loading } = useAttachmentUrl(attachmentId);
  return loading || !url ? <Spinner /> : <audio controls src={url} className="h-9 w-full max-w-xs" />;
}

function Author({ profile, userId }: { profile: Profile | undefined; userId: string }) {
  const src = useSignedImage(profile?.avatarPath);
  return <Avatar name={profile?.displayName ?? 'Former member'} src={src} seed={userId} size={26} />;
}

function MessageItem({ message, onReply }: { message: TaskMessage; onReply: (m: TaskMessage) => void }) {
  const { userId, client } = useSync();
  const author = useStoreQuery(['profiles'], (s) => s.get('profiles', message.authorId), [message.authorId]);
  const parent = useStoreQuery(['taskMessages'], (s) => (message.parentMessageId ? s.get('taskMessages', message.parentMessageId) : undefined), [message.parentMessageId]);
  const reactions = useStoreQuery(['messageReactions'], (s) => s.all('messageReactions').filter((r) => r.messageId === message.id && !r.deletedAt), [message.id]);
  const [editing, setEditing] = React.useState(false);
  const [draft, setDraft] = React.useState(message.body);
  const mine = message.authorId === userId;
  const grouped = new Map<string, string[]>();
  for (const r of reactions) grouped.set(r.emoji, [...(grouped.get(r.emoji) ?? []), r.userId]);
  const toggle = (emoji: string) => {
    const on = !(grouped.get(emoji) ?? []).includes(userId);
    client.mutate('reaction.toggle', { id: uuidv7(), messageId: message.id, emoji, on });
  };
  if (message.deletedAt) {
    return <li className="py-1 pl-9 text-xs italic text-fg-subtle">Message deleted</li>;
  }
  return (
    <li className="group/msg flex gap-2.5 py-2">
      <Author profile={author} userId={message.authorId} />
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2">
          <span className="text-[13px] font-semibold">{author?.displayName ?? 'Former member'}</span>
          <time className="text-xs text-fg-subtle" dateTime={message.createdAt} title={new Date(message.createdAt).toLocaleString()}>
            {relTime(message.createdAt)}
          </time>
          {message.editedAt ? <span className="text-xs text-fg-subtle">(edited)</span> : null}
          <div className="ml-auto flex opacity-0 transition-opacity group-hover/msg:opacity-100 focus-within:opacity-100 max-sm:opacity-100">
            <Popover>
              <PopoverTrigger asChild>
                <Button variant="ghost" size="icon-sm" aria-label="Add reaction">
                  <SmilePlus />
                </Button>
              </PopoverTrigger>
              <PopoverContent className="flex gap-1 p-1">
                {QUICK_REACTIONS.map((e) => (
                  <button key={e} type="button" className="grid size-8 place-items-center rounded-md text-lg hover:bg-bg-hover" onClick={() => toggle(e)} aria-label={`React ${e}`}>
                    {e}
                  </button>
                ))}
              </PopoverContent>
            </Popover>
            <Button variant="ghost" size="icon-sm" aria-label="Reply" onClick={() => onReply(message)}>
              <Reply />
            </Button>
            {mine ? (
              <Menu>
                <MenuTrigger asChild>
                  <Button variant="ghost" size="icon-sm" aria-label="Message options">
                    <MoreHorizontal />
                  </Button>
                </MenuTrigger>
                <MenuContent align="end">
                  {message.kind === 'text' ? (
                    <MenuItem onSelect={() => (setDraft(message.body), setEditing(true))}>
                      <Pencil /> Edit
                    </MenuItem>
                  ) : null}
                  <MenuItem danger onSelect={() => client.mutate('message.delete', { id: message.id })}>
                    <Trash2 /> Delete
                  </MenuItem>
                </MenuContent>
              </Menu>
            ) : null}
          </div>
        </div>
        {parent ? <p className="mb-1 truncate border-l-2 border-border pl-2 text-xs text-fg-subtle">{parent.deletedAt ? 'Deleted message' : parent.body.replace(MENTION_RE, '@$1').slice(0, 120)}</p> : null}
        {editing ? (
          <div className="mt-1 flex flex-col gap-2">
            <textarea value={draft} onChange={(e) => setDraft(e.target.value)} className="min-h-16 w-full rounded-md border border-border bg-surface p-2 text-[13.5px] outline-none focus:border-accent" aria-label="Edit message" />
            <div className="flex justify-end gap-2">
              <Button size="xs" variant="ghost" onClick={() => setEditing(false)}>
                Cancel
              </Button>
              <Button
                size="xs"
                variant="primary"
                disabled={!draft.trim()}
                onClick={() => {
                  client.mutate('message.edit', { id: message.id, body: draft.trim(), mentions: extractMentions(draft) });
                  setEditing(false);
                }}
              >
                Save
              </Button>
            </div>
          </div>
        ) : message.kind === 'voice' && message.attachmentId ? (
          <VoiceMessage attachmentId={message.attachmentId} />
        ) : (
          <MessageBody body={message.body} />
        )}
        {grouped.size ? (
          <div className="mt-1.5 flex flex-wrap gap-1">
            {[...grouped.entries()].map(([emoji, users]) => (
              <button
                key={emoji}
                type="button"
                onClick={() => toggle(emoji)}
                aria-pressed={users.includes(userId)}
                className={cn('inline-flex h-6 items-center gap-1 rounded-full border px-2 text-xs', users.includes(userId) ? 'border-accent/50 bg-accent-subtle' : 'border-border bg-surface hover:bg-bg-hover')}
              >
                {emoji} <span className="tabular-nums">{users.length}</span>
              </button>
            ))}
          </div>
        ) : null}
      </div>
    </li>
  );
}

function useRecorder() {
  const [recording, setRecording] = React.useState(false);
  const [seconds, setSeconds] = React.useState(0);
  const rec = React.useRef<MediaRecorder | null>(null);
  const chunks = React.useRef<Blob[]>([]);
  const timer = React.useRef<ReturnType<typeof setInterval> | null>(null);
  const start = async () => {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const mr = new MediaRecorder(stream);
    chunks.current = [];
    mr.ondataavailable = (e) => e.data.size && chunks.current.push(e.data);
    mr.start();
    rec.current = mr;
    setRecording(true);
    setSeconds(0);
    timer.current = setInterval(() => setSeconds((s) => s + 1), 1000);
  };
  const stop = (): Promise<Blob | null> =>
    new Promise((resolve) => {
      const mr = rec.current;
      if (timer.current) clearInterval(timer.current);
      setRecording(false);
      if (!mr) return resolve(null);
      mr.onstop = () => {
        mr.stream.getTracks().forEach((t) => t.stop());
        resolve(new Blob(chunks.current, { type: mr.mimeType || 'audio/webm' }));
      };
      mr.stop();
    });
  const cancel = () => {
    void stop();
    chunks.current = [];
  };
  return { recording, seconds, start, stop, cancel };
}

export function Comments({ taskId, workspaceId, listId }: { taskId: string; workspaceId: string; listId: string | null }) {
  const { client } = useSync();
  const uploads = useUploads();
  const messages = useStoreQuery(['taskMessages'], (s) => selectMessages(s, taskId).filter((m) => m.kind !== 'system'), [taskId]);
  const people = useStoreQuery(['workspaceMembers', 'profiles', 'listMembers', 'lists'], (s) => selectAssignable(s, workspaceId, listId), [workspaceId, listId]);
  const [text, setText] = React.useState('');
  const [replyTo, setReplyTo] = React.useState<TaskMessage | null>(null);
  const [mention, setMention] = React.useState<{ query: string; start: number } | null>(null);
  const inputRef = React.useRef<HTMLTextAreaElement>(null);
  const endRef = React.useRef<HTMLDivElement>(null);
  const recorder = useRecorder();

  React.useEffect(() => {
    endRef.current?.scrollIntoView({ block: 'nearest' });
  }, [messages.length]);

  const onChange = (value: string, caret: number) => {
    setText(value);
    const before = value.slice(0, caret);
    const m = /(^|\s)@([\p{L}\p{N}._-]{0,30})$/u.exec(before);
    setMention(m ? { query: m[2]!.toLowerCase(), start: caret - m[2]!.length - 1 } : null);
  };
  const candidates = mention ? people.filter((p) => p.displayName.toLowerCase().includes(mention.query) || p.email?.toLowerCase().startsWith(mention.query)).slice(0, 6) : [];
  const insertMention = (p: Profile) => {
    if (!mention) return;
    const caret = inputRef.current?.selectionStart ?? text.length;
    const token = `@[${p.displayName}](${p.id}) `;
    const next = text.slice(0, mention.start) + token + text.slice(caret);
    setText(next);
    setMention(null);
    requestAnimationFrame(() => {
      inputRef.current?.focus();
      const pos = mention.start + token.length;
      inputRef.current?.setSelectionRange(pos, pos);
    });
  };
  const send = () => {
    const body = text.trim();
    if (!body) return;
    client.mutate('message.create', { id: uuidv7(), taskId, body, parentMessageId: replyTo?.id ?? null, mentions: extractMentions(body) });
    setText('');
    setReplyTo(null);
  };
  const sendVoice = async () => {
    const blob = await recorder.stop();
    if (!blob || blob.size < 1000) return;
    const messageId = uuidv7();
    const file = new File([blob], `voice-${new Date().toISOString().slice(0, 19)}.webm`, { type: blob.type });
    // The message row must exist before the attachment can reference it.
    client.mutate('message.create', { id: messageId, taskId, body: '', kind: 'voice', parentMessageId: replyTo?.id ?? null });
    await client.sync();
    const [attachmentId] = await uploads.upload([file], { workspaceId, messageId });
    if (attachmentId) {
      client.mutate('message.edit', { id: messageId, body: '', mentions: [], attachmentId });
      toast.success('Voice message sent');
    }
  };

  return (
    <div className="flex flex-col">
      {messages.length ? (
        <ul className="flex flex-col">
          {messages.map((m) => (
            <MessageItem key={m.id} message={m} onReply={(msg) => (setReplyTo(msg), inputRef.current?.focus())} />
          ))}
        </ul>
      ) : (
        <p className="py-3 text-sm text-fg-subtle">No comments yet. Start the conversation — use @ to mention someone.</p>
      )}
      <div ref={endRef} />
      <div className="relative mt-2 rounded-lg border border-border bg-surface focus-within:border-accent focus-within:ring-3 focus-within:ring-focus/30">
        {replyTo ? (
          <div className="flex items-center gap-2 border-b border-border px-3 py-1.5 text-xs text-fg-muted">
            <Reply className="size-3.5" /> Replying to {replyTo.body.replace(MENTION_RE, '@$1').slice(0, 60) || 'voice message'}
            <button type="button" className="ml-auto" onClick={() => setReplyTo(null)} aria-label="Cancel reply">
              <X className="size-3.5" />
            </button>
          </div>
        ) : null}
        {recorder.recording ? (
          <div className="flex items-center gap-3 px-3 py-3 text-sm">
            <span className="size-2.5 animate-pulse rounded-full bg-danger" aria-hidden />
            Recording {Math.floor(recorder.seconds / 60)}:{String(recorder.seconds % 60).padStart(2, '0')}
            <div className="ml-auto flex gap-1">
              <Button size="xs" variant="ghost" onClick={recorder.cancel}>
                Cancel
              </Button>
              <Button size="xs" variant="primary" onClick={() => void sendVoice()}>
                <Square /> Send
              </Button>
            </div>
          </div>
        ) : (
          <>
            <textarea
              ref={inputRef}
              value={text}
              rows={2}
              onChange={(e) => onChange(e.target.value, e.target.selectionStart)}
              onKeyDown={(e) => {
                if (mention && candidates.length && (e.key === 'Enter' || e.key === 'Tab')) {
                  e.preventDefault();
                  insertMention(candidates[0]!);
                  return;
                }
                if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                  e.preventDefault();
                  send();
                }
                if (e.key === 'Escape') setMention(null);
              }}
              placeholder="Write a comment… (@ to mention)"
              aria-label="Write a comment"
              className="block w-full resize-none bg-transparent px-3 pt-2.5 text-[13.5px] outline-none placeholder:text-fg-subtle"
            />
            <div className="flex items-center justify-end gap-1 px-2 pb-2">
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label="Record a voice message"
                onClick={() => void recorder.start().catch(() => toast.error('Microphone access was blocked.'))}
              >
                <Mic />
              </Button>
              <Button variant="primary" size="icon-sm" aria-label="Send comment" disabled={!text.trim()} onClick={send}>
                <SendHorizontal />
              </Button>
            </div>
          </>
        )}
        {mention && candidates.length ? (
          <ul role="listbox" aria-label="Mention someone" className="absolute bottom-full left-2 z-10 mb-1 w-60 rounded-lg border border-border bg-surface-raised p-1 shadow-md">
            {candidates.map((p) => (
              <li key={p.id}>
                <button type="button" role="option" aria-selected={false} onMouseDown={(e) => (e.preventDefault(), insertMention(p))} className="flex h-8 w-full items-center gap-2 rounded-md px-2 text-left text-[13px] hover:bg-bg-hover">
                  <Avatar name={p.displayName} seed={p.id} size={18} />
                  <span className="truncate">{p.displayName}</span>
                </button>
              </li>
            ))}
          </ul>
        ) : null}
      </div>
    </div>
  );
}

// ───────────── Activity ─────────────
interface ActivityEvent {
  id: string;
  type: string;
  actorId: string | null;
  data: Record<string, unknown>;
  createdAt: string;
}

function describeActivity(e: ActivityEvent, name: (id: string | null | undefined) => string, listName: (id: unknown) => string): string {
  const d = e.data;
  switch (e.type) {
    case 'created':
      return d.source ? `created this task from ${String(d.source).replace('_', ' ')}` : 'created this task';
    case 'completed':
      return 'completed this task';
    case 'completed_occurrence':
      return `completed the ${String(d.occurrence)} occurrence (next: ${String(d.next)})`;
    case 'occurrence_skipped':
      return `skipped the ${String(d.skipped)} occurrence`;
    case 'reopened':
      return 'reopened this task';
    case 'title_changed':
      return `renamed this task from “${String(d.from ?? '')}”`;
    case 'due_changed':
      return d.to ? `set the due date to ${String(d.to)}${d.time ? ` ${String(d.time).slice(0, 5)}` : ''}` : 'removed the due date';
    case 'recurrence_changed':
      return d.to ? 'changed how this task repeats' : 'stopped this task repeating';
    case 'reminders_changed':
      return `updated reminders (${String(d.count)})`;
    case 'assignee_changed':
      return d.to ? `assigned ${name(d.to as string)}` : 'removed the assignee';
    case 'labels_changed':
      return 'changed labels';
    case 'moved':
      return `moved this task to ${d.toList ? listName(d.toList) : d.toParent ? 'another task' : 'Inbox'}`;
    case 'attachment_added':
      return `attached ${String(d.name)}`;
    case 'attachment_removed':
      return `removed ${String(d.name)}`;
    case 'commented':
      return 'commented';
    case 'deleted':
      return 'deleted this task';
    case 'restored':
      return 'restored this task';
    case 'duplicated':
      return 'duplicated this task';
    default:
      return e.type.replace(/_/g, ' ');
  }
}

export function ActivityLog({ taskId }: { taskId: string }) {
  const { store } = useSync();
  const q = useQuery({
    queryKey: ['activity', taskId],
    queryFn: () => apiFetch<{ events: ActivityEvent[] }>(`/tasks/${taskId}/activity`).then((r) => r.events),
    staleTime: 5_000,
  });
  const name = (id: string | null | undefined) => (id ? (store.get('profiles', id)?.displayName ?? 'someone') : 'someone');
  const listName = (id: unknown) => (typeof id === 'string' ? store.get('lists', id)?.title || 'a list' : 'a list');
  if (q.isLoading) return <Spinner className="my-4" />;
  if (q.error) return <p className="py-3 text-sm text-fg-subtle">Activity is available when you’re online.</p>;
  if (!q.data?.length) return <p className="py-3 text-sm text-fg-subtle">No activity yet.</p>;
  return (
    <ol className="flex flex-col gap-2.5 py-2">
      {q.data.map((e) => (
        <li key={e.id} className="flex items-start gap-2 text-[13px]">
          <span className="mt-1.5 size-1.5 shrink-0 rounded-full bg-border-strong" aria-hidden />
          <p className="min-w-0 flex-1 text-fg-muted">
            <span className="font-medium text-fg">{name(e.actorId)}</span> {describeActivity(e, name, listName)}
            <time className="ml-2 text-xs text-fg-subtle" dateTime={e.createdAt}>
              {new Date(e.createdAt).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}
            </time>
          </p>
        </li>
      ))}
    </ol>
  );
}
