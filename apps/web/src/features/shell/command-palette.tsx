'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import { Dialog as D } from 'radix-ui';
import {
  Bell,
  CalendarRange,
  CheckCircle2,
  FileText,
  Inbox,
  Keyboard,
  LayoutList,
  Mic,
  Moon,
  MessageSquare,
  Paperclip,
  Plus,
  Search,
  Settings,
  Sun,
  Tag,
  UserRound,
  Users,
  Video,
} from 'lucide-react';
import { routes } from '@orbit/shared';
import { searchLocal } from '@orbit/sync/client';
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList, Spinner } from '@orbit/ui';
import { apiFetch } from '@/lib/api';
import { SHORTCUTS } from '@/lib/hotkeys';
import { useSync } from '@/lib/sync';
import { useWorkspace } from '@/lib/workspace';
import type { SearchResultDto } from '@/features/search/types';

const TYPE_ICON = { task: CheckCircle2, list: FileText, note: FileText, comment: MessageSquare, meeting: Video, transcript: Video, file: Paperclip, person: UserRound, label: Tag } as const;

export function resultHref(r: SearchResultDto): string {
  switch (r.type) {
    case 'task':
      return routes.task(r.id);
    case 'list':
      return routes.list(r.id);
    case 'note':
      return r.taskId ? routes.task(r.taskId) : r.listId ? routes.list(r.listId) : routes.search(r.title);
    case 'comment':
      return `${routes.task(r.taskId!)}&tab=comments`;
    case 'meeting':
      return routes.meeting(r.id);
    case 'transcript':
      return `${routes.meeting(r.meetingId!)}&t=${String(r.meta.startMs ?? 0)}`;
    case 'file':
      return r.taskId ? routes.task(r.taskId) : r.listId ? routes.list(r.listId) : routes.search(r.title);
    case 'label':
      return `${routes.search()}?label=${r.id}`;
    default:
      return routes.search(r.title);
  }
}

export function CommandPalette({ open, onOpenChange, onNewTask, onNewList, onTalk, onRecordMeeting }: { open: boolean; onOpenChange: (o: boolean) => void; onNewTask: () => void; onNewList: () => void; onTalk: () => void; onRecordMeeting: () => void }) {
  const router = useRouter();
  const { store, client } = useSync();
  const { workspaces, setWorkspace, current } = useWorkspace();
  const [q, setQ] = React.useState('');
  const [debounced, setDebounced] = React.useState('');
  React.useEffect(() => {
    const t = setTimeout(() => setDebounced(q.trim()), 180);
    return () => clearTimeout(t);
  }, [q]);
  React.useEffect(() => {
    if (!open) setQ('');
  }, [open]);

  const local = React.useMemo(() => (q.trim() ? searchLocal(store, q, 8) : []), [q, store]);
  const remote = useQuery({
    queryKey: ['palette-search', debounced],
    enabled: open && debounced.length >= 2,
    queryFn: ({ signal }) => apiFetch<{ results: SearchResultDto[] }>(`/search?q=${encodeURIComponent(debounced)}&limit=8`, { signal }).then((r) => r.results),
    staleTime: 10_000,
  });
  const localIds = new Set(local.map((h) => h.id));
  const remoteExtra = (remote.data ?? []).filter((r) => !localIds.has(r.id)).slice(0, 10);

  const go = (href: string) => {
    onOpenChange(false);
    router.push(href);
  };
  const act = (fn: () => void) => () => {
    onOpenChange(false);
    fn();
  };

  return (
    <D.Root open={open} onOpenChange={onOpenChange}>
      <D.Portal>
        <D.Overlay className="fixed inset-0 z-50 bg-overlay data-[state=open]:animate-in data-[state=open]:fade-in-0" />
        <D.Content className="fixed top-[12vh] left-1/2 z-50 w-[calc(100vw-1.5rem)] max-w-xl -translate-x-1/2 overflow-hidden rounded-xl border border-border bg-surface-raised shadow-lg outline-none data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-[0.98]">
          <D.Title className="sr-only">Command palette</D.Title>
          <D.Description className="sr-only">Search everything or run a command</D.Description>
          <Command shouldFilter={false} loop>
            <CommandInput placeholder="Search or type a command…" value={q} onValueChange={setQ} />
            <CommandList>
              {q.trim() ? (
                <>
                  <CommandEmpty>{remote.isFetching ? <Spinner /> : 'No results.'}</CommandEmpty>
                  {local.length ? (
                    <CommandGroup heading="On this device">
                      {local.map((h) => (
                        <CommandItem key={h.id} value={`local-${h.id}`} onSelect={() => go(h.kind === 'task' ? routes.task(h.id) : routes.list(h.id))}>
                          {h.kind === 'task' ? <CheckCircle2 /> : <FileText />}
                          <span className="truncate">{h.title}</span>
                        </CommandItem>
                      ))}
                    </CommandGroup>
                  ) : null}
                  {remoteExtra.length ? (
                    <CommandGroup heading="Everywhere">
                      {remoteExtra.map((r) => {
                        const Icon = TYPE_ICON[r.type] ?? Search;
                        return (
                          <CommandItem key={`${r.type}-${r.id}`} value={`remote-${r.type}-${r.id}`} onSelect={() => go(resultHref(r))}>
                            <Icon />
                            <span className="min-w-0 flex-1 truncate">
                              {r.title}
                              {r.snippet ? <span className="ml-2 text-xs text-fg-subtle">{r.snippet.replace(/[«»]/g, '')}</span> : null}
                            </span>
                            <span className="text-[11px] text-fg-subtle capitalize">{r.type}</span>
                          </CommandItem>
                        );
                      })}
                    </CommandGroup>
                  ) : null}
                  <CommandGroup heading="Actions">
                    <CommandItem value="search-all" onSelect={() => go(routes.search(q.trim()))}>
                      <Search /> Search all for “{q.trim()}”
                    </CommandItem>
                    <CommandItem value="create-task" onSelect={act(onNewTask)}>
                      <Plus /> Create a task
                    </CommandItem>
                  </CommandGroup>
                </>
              ) : (
                <>
                  <CommandGroup heading="Create">
                    <CommandItem value="new-task" onSelect={act(onNewTask)} shortcut={SHORTCUTS.newTask}>
                      <Plus /> New task
                    </CommandItem>
                    <CommandItem value="new-list" onSelect={act(onNewList)} shortcut={SHORTCUTS.newList}>
                      <FileText /> New list
                    </CommandItem>
                    <CommandItem value="talk" onSelect={act(onTalk)} shortcut={SHORTCUTS.talk}>
                      <Mic /> Talk — add tasks by voice
                    </CommandItem>
                    <CommandItem value="record" onSelect={act(onRecordMeeting)}>
                      <Video /> Record meeting notes
                    </CommandItem>
                  </CommandGroup>
                  <CommandGroup heading="Go to">
                    <CommandItem value="inbox" onSelect={() => go(routes.inbox())} shortcut={SHORTCUTS.inbox}>
                      <Inbox /> Inbox
                    </CommandItem>
                    <CommandItem value="today" onSelect={() => go(routes.today())} shortcut={SHORTCUTS.today}>
                      <Sun /> Today
                    </CommandItem>
                    <CommandItem value="upcoming" onSelect={() => go(routes.upcoming())} shortcut={SHORTCUTS.upcoming}>
                      <CalendarRange /> Upcoming
                    </CommandItem>
                    <CommandItem value="meetings" onSelect={() => go(routes.meetings())} shortcut={SHORTCUTS.meetings}>
                      <Video /> Meetings
                    </CommandItem>
                    <CommandItem value="updates" onSelect={() => go(routes.updates())} shortcut={SHORTCUTS.updates}>
                      <Bell /> Updates
                    </CommandItem>
                    <CommandItem value="lists" onSelect={() => go(routes.lists())}>
                      <LayoutList /> All lists
                    </CommandItem>
                    <CommandItem value="settings" onSelect={() => go(routes.settings())} shortcut={SHORTCUTS.settings}>
                      <Settings /> Settings
                    </CommandItem>
                    <CommandItem value="shortcuts" onSelect={() => go(routes.shortcuts())} shortcut={SHORTCUTS.help}>
                      <Keyboard /> Keyboard shortcuts
                    </CommandItem>
                  </CommandGroup>
                  {workspaces.length > 1 ? (
                    <CommandGroup heading="Switch workspace">
                      {workspaces
                        .filter((w) => w.id !== current?.id)
                        .map((w) => (
                          <CommandItem key={w.id} value={`ws-${w.id}`} onSelect={act(() => setWorkspace(w.id))}>
                            <Users /> {w.name}
                          </CommandItem>
                        ))}
                    </CommandGroup>
                  ) : null}
                  <CommandGroup heading="Appearance">
                    <CommandItem value="theme-dark" onSelect={act(() => client.mutate('profile.update', { settings: { theme: 'dark' } }))}>
                      <Moon /> Dark theme
                    </CommandItem>
                    <CommandItem value="theme-light" onSelect={act(() => client.mutate('profile.update', { settings: { theme: 'light' } }))}>
                      <Sun /> Light theme
                    </CommandItem>
                  </CommandGroup>
                </>
              )}
            </CommandList>
          </Command>
        </D.Content>
      </D.Portal>
    </D.Root>
  );
}
