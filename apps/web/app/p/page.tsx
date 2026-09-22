'use client';

import * as React from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import * as Y from 'yjs';
import { yDocToProsemirrorJSON } from '@tiptap/y-tiptap';
import { CheckCircle2, Circle } from 'lucide-react';
import { PRODUCT } from '@orbit/shared';
import { Button, EmptyState, Spinner } from '@orbit/ui';
import { Logo } from '@/components/brand';
import { apiFetch } from '@/lib/api';

interface PublicTask {
  id: string;
  parentTaskId: string | null;
  title: string;
  position: string;
  completed: boolean;
  dueDate: string | null;
}
interface PublicList {
  list: { title: string; emoji: string | null; description: string | null; updatedAt: string };
  tasks: PublicTask[];
  document: string | null;
}
interface PMNode {
  type: string;
  attrs?: Record<string, unknown>;
  content?: PMNode[];
  text?: string;
  marks?: { type: string; attrs?: Record<string, unknown> }[];
}

function Inline({ nodes }: { nodes?: PMNode[] }) {
  return (
    <>
      {(nodes ?? []).map((n, i) => {
        if (n.type === 'hardBreak') return <br key={i} />;
        let el: React.ReactNode = n.text ?? '';
        for (const m of n.marks ?? []) {
          if (m.type === 'bold') el = <strong>{el}</strong>;
          else if (m.type === 'italic') el = <em>{el}</em>;
          else if (m.type === 'strike') el = <s>{el}</s>;
          else if (m.type === 'code') el = <code>{el}</code>;
          else if (m.type === 'link' && typeof m.attrs?.href === 'string' && /^(https?:|mailto:)/.test(m.attrs.href)) el = <a href={m.attrs.href} rel="noopener noreferrer nofollow" target="_blank">{el}</a>;
        }
        return <React.Fragment key={i}>{el}</React.Fragment>;
      })}
    </>
  );
}

function TaskLine({ task, tasks, depth }: { task: PublicTask; tasks: PublicTask[]; depth: number }) {
  const kids = tasks.filter((t) => t.parentTaskId === task.id);
  return (
    <>
      <div className="flex items-start gap-2 py-1" style={{ paddingLeft: depth * 22 }}>
        {task.completed ? <CheckCircle2 className="mt-0.5 size-5 text-success" aria-label="Done" /> : <Circle className="mt-0.5 size-5 text-border-strong" aria-label="Open" />}
        <span className={task.completed ? 'text-fg-subtle line-through' : ''}>{task.title || 'Untitled task'}</span>
        {task.dueDate ? <span className="ml-auto text-xs text-fg-subtle">{task.dueDate}</span> : null}
      </div>
      {kids.map((k) => (
        <TaskLine key={k.id} task={k} tasks={tasks} depth={depth + 1} />
      ))}
    </>
  );
}

/** Read-only rendering of document JSON (text only; no raw HTML is ever injected). */
function Block({ node, tasks }: { node: PMNode; tasks: PublicTask[] }): React.ReactNode {
  switch (node.type) {
    case 'paragraph':
      return <p><Inline nodes={node.content} /></p>;
    case 'heading': {
      const L = Number(node.attrs?.level ?? 1);
      return L === 1 ? <h1><Inline nodes={node.content} /></h1> : L === 2 ? <h2><Inline nodes={node.content} /></h2> : <h3><Inline nodes={node.content} /></h3>;
    }
    case 'bulletList':
      return <ul>{node.content?.map((c, i) => <li key={i}>{c.content?.map((b, j) => <Block key={j} node={b} tasks={tasks} />)}</li>)}</ul>;
    case 'orderedList':
      return <ol>{node.content?.map((c, i) => <li key={i}>{c.content?.map((b, j) => <Block key={j} node={b} tasks={tasks} />)}</li>)}</ol>;
    case 'blockquote':
      return <blockquote>{node.content?.map((b, j) => <Block key={j} node={b} tasks={tasks} />)}</blockquote>;
    case 'codeBlock':
      return <pre><code>{node.content?.map((t) => t.text).join('')}</code></pre>;
    case 'horizontalRule':
      return <hr />;
    case 'callout':
      return <div className="orbit-callout"><span>{String(node.attrs?.emoji ?? '💡')}</span><div className="orbit-callout-body"><Inline nodes={node.content} /></div></div>;
    case 'taskRef': {
      const t = tasks.find((x) => x.id === node.attrs?.taskId);
      return t ? <TaskLine task={t} tasks={tasks} depth={0} /> : null;
    }
    default:
      return null;
  }
}

function PublicView() {
  const token = useSearchParams().get('token') ?? '';
  const q = useQuery({ queryKey: ['public', token], enabled: Boolean(token), retry: false, queryFn: () => apiFetch<PublicList>(`/public/list?token=${encodeURIComponent(token)}`, { anonymous: true }) });
  const content = React.useMemo(() => {
    if (!q.data?.document) return null;
    const doc = new Y.Doc();
    Y.applyUpdate(doc, Uint8Array.from(atob(q.data.document), (c) => c.charCodeAt(0)));
    return (yDocToProsemirrorJSON(doc, 'default') as { content?: PMNode[] }).content ?? [];
  }, [q.data?.document]);

  return (
    <main className="min-h-dvh bg-bg">
      <header className="mx-auto flex max-w-3xl items-center justify-between px-6 py-5">
        <Logo />
        <Button asChild variant="primary" size="sm">
          <Link href="/signup">Try {PRODUCT.name} free</Link>
        </Button>
      </header>
      <article className="mx-auto max-w-3xl px-6 pb-24">
        {q.isLoading ? (
          <Spinner />
        ) : !q.data ? (
          <EmptyState title="This link is no longer available" description="The owner may have turned off sharing." />
        ) : (
          <>
            <h1 className="mt-6 text-4xl font-bold tracking-tight">
              {q.data.list.emoji ? `${q.data.list.emoji} ` : ''}
              {q.data.list.title || 'Untitled list'}
            </h1>
            <p className="mt-2 text-xs text-fg-subtle">Read-only · updated {new Date(q.data.list.updatedAt).toLocaleDateString()}</p>
            <div className="orbit-prose mt-8">
              {content && content.length
                ? content.map((n, i) => <Block key={i} node={n} tasks={q.data.tasks} />)
                : q.data.tasks.filter((t) => !t.parentTaskId).map((t) => <TaskLine key={t.id} task={t} tasks={q.data.tasks} depth={0} />)}
            </div>
          </>
        )}
      </article>
    </main>
  );
}

export default function PublicListPage() {
  return (
    <React.Suspense>
      <PublicView />
    </React.Suspense>
  );
}
