import type { Task } from '@orbit/shared';
import { comparePositioned } from './ordering';
import { describeRecurrence } from './recurrence';

/** Plain Markdown/CSV/text rendering of task trees (copy, export, MCP responses). */

export interface TaskTreeNode {
  task: Task;
  children: TaskTreeNode[];
}

export function buildTaskTree(tasks: readonly Task[], rootParentId: string | null = null): TaskTreeNode[] {
  const byParent = new Map<string | null, Task[]>();
  for (const t of tasks) {
    if (t.deletedAt) continue;
    const key = t.parentTaskId;
    const arr = byParent.get(key) ?? [];
    arr.push(t);
    byParent.set(key, arr);
  }
  const ids = new Set(tasks.map((t) => t.id));
  const build = (parent: string | null, seen: Set<string>): TaskTreeNode[] =>
    (byParent.get(parent) ?? [])
      .sort(comparePositioned)
      .filter((t) => !seen.has(t.id))
      .map((task) => ({ task, children: build(task.id, new Set([...seen, task.id])) }));
  // Tasks whose parent isn't in the set are treated as roots (e.g. filtered views).
  if (rootParentId === null) {
    const orphans = tasks.filter((t) => !t.deletedAt && t.parentTaskId !== null && !ids.has(t.parentTaskId));
    return [...build(null, new Set()), ...orphans.map((task) => ({ task, children: build(task.id, new Set([task.id])) }))];
  }
  return build(rootParentId, new Set());
}

export interface MarkdownOptions {
  labels?: Map<string, string>;
  people?: Map<string, string>;
  includeMeta?: boolean;
}

function escapeInline(text: string): string {
  return text.replace(/([\\`*_[\]])/g, '\\$1');
}

export function taskLine(task: Task, opts: MarkdownOptions = {}): string {
  const box = task.completedAt ? '[x]' : '[ ]';
  let line = `${box} ${escapeInline(task.title || 'Untitled')}`;
  if (opts.includeMeta !== false) {
    const meta: string[] = [];
    if (task.dueDate) meta.push(`📅 ${task.dueDate}${task.dueTime ? ` ${task.dueTime.slice(0, 5)}` : ''}`);
    if (task.recurrence) meta.push(`🔁 ${describeRecurrence(task.recurrence)}`);
    if (task.assigneeId && opts.people?.get(task.assigneeId)) meta.push(`@${opts.people.get(task.assigneeId)}`);
    for (const id of task.labelIds) {
      const name = opts.labels?.get(id);
      if (name) meta.push(`#${name.replace(/\s+/g, '-')}`);
    }
    if (meta.length) line += ` ${meta.join(' ')}`;
  }
  return line;
}

export function taskTreeToMarkdown(nodes: TaskTreeNode[], opts: MarkdownOptions = {}, depth = 0): string {
  return nodes
    .map((n) => {
      const self = `${'  '.repeat(depth)}- ${taskLine(n.task, opts)}`;
      const kids = n.children.length ? `\n${taskTreeToMarkdown(n.children, opts, depth + 1)}` : '';
      return self + kids;
    })
    .join('\n');
}

export function taskTreeToText(nodes: TaskTreeNode[], depth = 0): string {
  return nodes
    .map((n) => {
      const self = `${'  '.repeat(depth)}${n.task.completedAt ? '✓' : '○'} ${n.task.title}`;
      return n.children.length ? `${self}\n${taskTreeToText(n.children, depth + 1)}` : self;
    })
    .join('\n');
}

function csvCell(value: string): string {
  // Neutralise spreadsheet formula injection and quote.
  const safe = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
  return `"${safe.replace(/"/g, '""')}"`;
}

export function tasksToCsv(tasks: readonly Task[], opts: MarkdownOptions = {}): string {
  const header = ['id', 'title', 'completed', 'due_date', 'due_time', 'recurrence', 'assignee', 'labels', 'parent_id', 'created_at'];
  const rows = tasks
    .filter((t) => !t.deletedAt)
    .map((t) =>
      [
        t.id,
        t.title,
        t.completedAt ? 'yes' : 'no',
        t.dueDate ?? '',
        t.dueTime?.slice(0, 5) ?? '',
        t.recurrence ? describeRecurrence(t.recurrence) : '',
        (t.assigneeId && opts.people?.get(t.assigneeId)) || '',
        t.labelIds.map((id) => opts.labels?.get(id) ?? '').filter(Boolean).join('; '),
        t.parentTaskId ?? '',
        t.createdAt,
      ].map((v) => csvCell(String(v))),
    );
  return [header.join(','), ...rows.map((r) => r.join(','))].join('\n');
}

/** Parse "- [ ] foo" / "* [x] bar" / plain lines into a nested task outline (import & paste). */
export interface OutlineItem {
  title: string;
  completed: boolean;
  children: OutlineItem[];
  isTask: boolean;
}

export function parseMarkdownOutline(markdown: string): OutlineItem[] {
  const root: OutlineItem[] = [];
  const stack: { indent: number; item: OutlineItem }[] = [];
  for (const raw of markdown.replace(/\r\n?/g, '\n').split('\n')) {
    if (!raw.trim()) continue;
    const m = /^(\s*)(?:[-*+]|\d+[.)])\s+(?:\[( |x|X)\]\s+)?(.*)$/.exec(raw);
    const indent = m ? m[1]!.replace(/\t/g, '  ').length : raw.search(/\S/);
    const item: OutlineItem = {
      title: (m ? m[3]! : raw.trim()).trim(),
      completed: m?.[2]?.toLowerCase() === 'x',
      children: [],
      isTask: Boolean(m?.[2]),
    };
    while (stack.length && stack.at(-1)!.indent >= indent) stack.pop();
    (stack.at(-1)?.item.children ?? root).push(item);
    stack.push({ indent, item });
  }
  return root;
}
