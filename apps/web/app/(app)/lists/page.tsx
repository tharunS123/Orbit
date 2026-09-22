'use client';

import * as React from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Archive, ChevronRight, FileText, LayoutList, LayoutTemplate, Plus, Star } from 'lucide-react';
import { routes } from '@orbit/shared';
import { isStarred, selectListTree, type ListNode } from '@orbit/sync/client';
import { Button, EmptyState, cn, toast } from '@orbit/ui';
import { PageBody, PageHeader, SectionTitle } from '@/features/shell/page-header';
import { TemplateGallery, createListFromTemplate } from '@/features/lists/templates';
import { useCollab } from '@/lib/collab';
import { useStoreQuery, useSync } from '@/lib/sync';
import { useUndo } from '@/lib/undo';
import { useWorkspace } from '@/lib/workspace';

function Node({ node, depth }: { node: ListNode; depth: number }) {
  const { userId } = useSync();
  const starred = useStoreQuery(['sectionItems'], (s) => isStarred(s, userId, node.list.id), [node.list.id]);
  const [open, setOpen] = React.useState(true);
  return (
    <li>
      <div className="group flex items-center gap-1 rounded-md hover:bg-bg-hover" style={{ paddingLeft: depth * 20 }}>
        {node.children.length ? (
          <button type="button" aria-label={open ? 'Collapse' : 'Expand'} aria-expanded={open} onClick={() => setOpen(!open)} className="grid size-6 place-items-center text-fg-subtle">
            <ChevronRight className={cn('size-3.5 transition-transform', open && 'rotate-90')} />
          </button>
        ) : (
          <span className="w-6" />
        )}
        <Link href={routes.list(node.list.id)} className="flex min-h-10 min-w-0 flex-1 items-center gap-2.5 py-1 pr-2">
          <span className="grid size-6 place-items-center" aria-hidden>
            {node.list.emoji ?? <FileText className="size-4 text-fg-muted" />}
          </span>
          <span className="truncate text-[14.5px]">{node.list.title || 'Untitled list'}</span>
          {starred ? <Star className="size-3.5 fill-warning text-warning" aria-label="Starred" /> : null}
          {node.list.visibility !== 'private' ? <span className="text-[11px] text-fg-subtle">{node.list.visibility === 'workspace' ? 'Workspace' : 'Shared'}</span> : null}
          <span className="ml-auto text-xs text-fg-subtle tabular-nums">{node.openCount || ''}</span>
        </Link>
      </div>
      {open && node.children.length ? (
        <ul>
          {node.children.map((c) => (
            <Node key={c.list.id} node={c} depth={depth + 1} />
          ))}
        </ul>
      ) : null}
    </li>
  );
}

function ListsView() {
  const { actions } = useSync();
  const { workspaceId, current } = useWorkspace();
  const { run } = useUndo();
  const router = useRouter();
  const collab = useCollab();
  const [templates, setTemplates] = React.useState(false);
  const [showArchived, setShowArchived] = React.useState(false);
  const tree = useStoreQuery(['lists', 'tasks'], (s) => (workspaceId ? selectListTree(s, workspaceId) : []), [workspaceId]);
  const archived = useStoreQuery(['lists', 'tasks'], (s) => (workspaceId ? selectListTree(s, workspaceId, { archived: true }) : []), [workspaceId]);
  const create = () => {
    if (!workspaceId) return;
    const res = run(null, () => actions.createList({ workspaceId, title: '' }), { toast: false }) as { id: string } | undefined;
    if (res) router.push(`${routes.list(res.id)}&new=1`);
  };
  return (
    <>
      <PageHeader
        title="Lists"
        icon={<LayoutList />}
        subtitle={current?.name}
        actions={
          <>
            <Button variant="ghost" size="sm" onClick={() => setTemplates(true)}>
              <LayoutTemplate /> Templates
            </Button>
            <Button variant="primary" size="sm" onClick={create}>
              <Plus /> New list
            </Button>
          </>
        }
      />
      <PageBody>
        {tree.length ? (
          <ul className="mt-3 flex flex-col">
            {tree.map((n) => (
              <Node key={n.list.id} node={n} depth={0} />
            ))}
          </ul>
        ) : (
          <EmptyState
            icon={<LayoutList />}
            title="No lists yet"
            description="Lists hold tasks and notes together. Start blank or from a template."
            action={
              <div className="flex gap-2">
                <Button variant="primary" onClick={create}>
                  <Plus /> New list
                </Button>
                <Button variant="secondary" onClick={() => setTemplates(true)}>
                  <LayoutTemplate /> Browse templates
                </Button>
              </div>
            }
          />
        )}
        {archived.length ? (
          <>
            <SectionTitle count={archived.length} action={<Button variant="ghost" size="xs" onClick={() => setShowArchived(!showArchived)}>{showArchived ? 'Hide' : 'Show'}</Button>}>
              <span className="inline-flex items-center gap-1">
                <Archive className="size-3.5" /> Archived
              </span>
            </SectionTitle>
            {showArchived ? (
              <ul className="flex flex-col opacity-80">
                {archived.map((n) => (
                  <Node key={n.list.id} node={n} depth={0} />
                ))}
              </ul>
            ) : null}
          </>
        ) : null}
      </PageBody>
      <TemplateGallery
        open={templates}
        onOpenChange={setTemplates}
        onPick={(t) => {
          if (!workspaceId) return;
          setTemplates(false);
          void createListFromTemplate(actions, collab, workspaceId, t)
            .then((id) => router.push(routes.list(id)))
            .catch(() => toast.error('Couldn’t create the list from this template.'));
        }}
      />
    </>
  );
}

export default function ListsPage() {
  return (
    <React.Suspense>
      <ListsView />
    </React.Suspense>
  );
}
