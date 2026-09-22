'use client';

import * as React from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import { CheckCircle2, FileText, MessageSquare, Paperclip, Search, Tag, UserRound, Video } from 'lucide-react';
import { selectLabels, selectMembers, searchLocal } from '@orbit/sync/client';
import { EmptyState, Input, Select, Spinner, cn } from '@orbit/ui';
import { PageBody, PageHeader } from '@/features/shell/page-header';
import { resultHref } from '@/features/shell/command-palette';
import type { SearchResultDto, SearchType } from '@/features/search/types';
import { apiFetch } from '@/lib/api';
import { useStoreQuery, useSync } from '@/lib/sync';
import { useWorkspace } from '@/lib/workspace';

const ICONS: Record<SearchType, React.ComponentType<{ className?: string }>> = { task: CheckCircle2, list: FileText, note: FileText, comment: MessageSquare, meeting: Video, transcript: Video, file: Paperclip, person: UserRound, label: Tag };
const TYPES: { value: string; label: string }[] = [
  { value: 'all', label: 'Everything' },
  { value: 'task', label: 'Tasks' },
  { value: 'list', label: 'Lists' },
  { value: 'note', label: 'Notes' },
  { value: 'comment', label: 'Comments' },
  { value: 'meeting,transcript', label: 'Meetings' },
  { value: 'file', label: 'Files' },
  { value: 'person', label: 'People' },
];

/** Render «highlight» markers from ts_headline as <mark> without using innerHTML. */
function Snippet({ text }: { text: string }) {
  const parts = text.split(/(«[^»]*»)/g);
  return (
    <p className="line-clamp-2 text-xs text-fg-muted">
      {parts.map((p, i) => (p.startsWith('«') ? <mark key={i} className="rounded-xs bg-warning-subtle px-0.5 text-fg">{p.slice(1, -1)}</mark> : p))}
    </p>
  );
}

function SearchView() {
  const params = useSearchParams();
  const router = useRouter();
  const { store, userId, timeZone } = useSync();
  const { workspaceId, workspaces } = useWorkspace();
  const [q, setQ] = React.useState(params.get('q') ?? '');
  const [type, setType] = React.useState('all');
  const [scope, setScope] = React.useState<'all' | 'current'>('all');
  const [status, setStatus] = React.useState<'any' | 'open' | 'done'>('any');
  const [due, setDue] = React.useState('any');
  const [assignee, setAssignee] = React.useState('any');
  const [label, setLabel] = React.useState(params.get('label') ?? 'any');
  const [debounced, setDebounced] = React.useState(q);
  React.useEffect(() => {
    const t = setTimeout(() => {
      setDebounced(q.trim());
      router.replace(q.trim() ? `/search?q=${encodeURIComponent(q.trim())}` : '/search', { scroll: false });
    }, 250);
    return () => clearTimeout(t);
  }, [q, router]);
  const labels = useStoreQuery(['labels'], (s) => selectLabels(s, workspaceId), [workspaceId]);
  const people = useStoreQuery(['workspaceMembers', 'profiles'], (s) => (workspaceId ? selectMembers(s, workspaceId) : []), [workspaceId]);

  const qs = new URLSearchParams({ q: debounced, limit: '30', tz: timeZone });
  if (type !== 'all') qs.set('types', type);
  if (scope === 'current' && workspaceId) qs.set('workspaceId', workspaceId);
  if (status !== 'any') qs.set('completed', status);
  if (due !== 'any') qs.set('due', due);
  if (assignee !== 'any') qs.set('assigneeId', assignee === 'me' ? userId : assignee);
  if (label !== 'any') qs.set('labelId', label);
  const remote = useQuery({
    queryKey: ['search', qs.toString()],
    enabled: debounced.length >= 1,
    queryFn: ({ signal }) => apiFetch<{ results: SearchResultDto[] }>(`/search?${qs.toString()}`, { signal }).then((r) => r.results),
  });
  const offlineHits = React.useMemo(() => (remote.isError && debounced ? searchLocal(store, debounced, 30) : []), [remote.isError, debounced, store]);

  return (
    <>
      <PageHeader title="Search" icon={<Search />}>
        <div className="flex flex-col gap-2">
          <Input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search tasks, notes, comments, meetings, files…" aria-label="Search" className="h-11 text-[15px]" />
          <div className="flex flex-wrap gap-1.5">
            <Select value={type} onValueChange={setType} options={TYPES} ariaLabel="Type" className="h-8" />
            {workspaces.length > 1 ? <Select value={scope} onValueChange={setScope} options={[{ value: 'all', label: 'All workspaces' }, { value: 'current', label: 'This workspace' }]} ariaLabel="Workspace" className="h-8" /> : null}
            <Select value={status} onValueChange={setStatus} options={[{ value: 'any', label: 'Any status' }, { value: 'open', label: 'Open' }, { value: 'done', label: 'Completed' }]} ariaLabel="Status" className="h-8" />
            <Select value={due} onValueChange={setDue} options={[{ value: 'any', label: 'Any date' }, { value: 'overdue', label: 'Overdue' }, { value: 'today', label: 'Due today' }, { value: 'week', label: 'Next 7 days' }, { value: 'scheduled', label: 'Has date' }, { value: 'none', label: 'No date' }]} ariaLabel="Due" className="h-8" />
            <Select value={assignee} onValueChange={setAssignee} options={[{ value: 'any', label: 'Anyone' }, { value: 'me', label: 'Assigned to me' }, ...people.filter((p) => p.member.userId !== userId).map((p) => ({ value: p.member.userId, label: p.profile?.displayName ?? 'Member' }))]} ariaLabel="Assignee" className="h-8" />
            {labels.length ? <Select value={label} onValueChange={setLabel} options={[{ value: 'any', label: 'Any label' }, ...labels.map((l) => ({ value: l.id, label: l.name }))]} ariaLabel="Label" className="h-8" /> : null}
          </div>
        </div>
      </PageHeader>
      <PageBody>
        {!debounced ? (
          <EmptyState icon={<Search />} title="Search everything" description="Find tasks, list notes, comments, meeting transcripts, files, people and labels. Tip: press ⌘K from anywhere." />
        ) : remote.isLoading ? (
          <div className="py-10">
            <Spinner />
          </div>
        ) : remote.isError ? (
          <>
            <p className="mt-4 text-sm text-fg-muted">You’re offline — showing matches saved on this device.</p>
            <ul className="mt-2">
              {offlineHits.map((h) => (
                <li key={h.id}>
                  <Link href={h.kind === 'task' ? `/task?id=${h.id}` : `/list?id=${h.id}`} className="flex items-center gap-3 rounded-md px-2 py-2 hover:bg-bg-hover">
                    {h.kind === 'task' ? <CheckCircle2 className="size-4 text-fg-muted" /> : <FileText className="size-4 text-fg-muted" />}
                    {h.title}
                  </Link>
                </li>
              ))}
            </ul>
          </>
        ) : remote.data?.length ? (
          <ul className="mt-3 flex flex-col gap-0.5">
            {remote.data.map((r) => {
              const Icon = ICONS[r.type];
              return (
                <li key={`${r.type}-${r.id}`}>
                  <Link href={resultHref(r)} className="flex items-start gap-3 rounded-md px-2 py-2 hover:bg-bg-hover">
                    <Icon className={cn('mt-0.5 size-4 shrink-0 text-fg-muted', r.type === 'task' && r.meta.completed === true && 'text-success')} />
                    <div className="min-w-0 flex-1">
                      <p className={cn('truncate text-sm', r.meta.completed === true && 'text-fg-subtle line-through')}>{r.title || 'Untitled'}</p>
                      {r.snippet ? <Snippet text={r.snippet} /> : null}
                    </div>
                    <span className="shrink-0 text-[11px] text-fg-subtle capitalize">{r.type}</span>
                  </Link>
                </li>
              );
            })}
          </ul>
        ) : (
          <EmptyState title="No results" description="Try other words or remove a filter." />
        )}
      </PageBody>
    </>
  );
}

export default function SearchPage() {
  return (
    <React.Suspense>
      <SearchView />
    </React.Suspense>
  );
}
