import { fromRRule, parseMarkdownOutline, type OutlineItem } from '@orbit/core';
import type { Actions } from '@orbit/sync/client';

/**
 * Import adapters. Each turns a file into a neutral outline, then one writer creates lists and
 * tasks through the normal actions (so imports work offline and sync like any other change).
 * Adding a new source (e.g. another app's export) means writing one adapter.
 */

export interface ImportedTask {
  title: string;
  completed: boolean;
  dueDate?: string | null;
  labels?: string[];
  rrule?: string | null;
  children: ImportedTask[];
}
export interface ImportedList {
  title: string;
  tasks: ImportedTask[];
}

export interface ImportAdapter {
  id: string;
  label: string;
  accept: string;
  parse(text: string, fileName: string): ImportedList[];
}

function outlineToTasks(items: OutlineItem[]): ImportedTask[] {
  return items.map((i) => ({ title: i.title, completed: i.completed, children: outlineToTasks(i.children) }));
}

/** Minimal RFC-4180 CSV parser (quotes, escaped quotes, newlines in quotes). */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') {
      row.push(field);
      field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else field += c;
  }
  if (field || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.some((c) => c.trim()));
}

export const importAdapters: ImportAdapter[] = [
  {
    id: 'markdown',
    label: 'Markdown checklist',
    accept: '.md,.markdown,.txt,text/markdown,text/plain',
    parse(text, fileName) {
      const title = /^#\s+(.+)$/m.exec(text)?.[1]?.trim() ?? fileName.replace(/\.[^.]+$/, '');
      return [{ title, tasks: outlineToTasks(parseMarkdownOutline(text.replace(/^#\s+.+$/m, ''))) }];
    },
  },
  {
    id: 'csv',
    label: 'CSV (title, completed, due_date, labels, list, parent)',
    accept: '.csv,text/csv',
    parse(text, fileName) {
      const [header, ...rows] = parseCsv(text);
      if (!header) return [];
      const col = (names: string[]) => header.findIndex((h) => names.includes(h.trim().toLowerCase()));
      const cTitle = col(['title', 'name', 'task', 'content']);
      const cDone = col(['completed', 'done', 'status', 'is_completed']);
      const cDue = col(['due_date', 'due', 'date', 'deadline']);
      const cLabels = col(['labels', 'tags', 'label']);
      const cList = col(['list', 'project', 'section']);
      const cParent = col(['parent_id', 'parent']);
      const cId = col(['id']);
      if (cTitle < 0) throw new Error('The CSV needs a "title" column.');
      const lists = new Map<string, ImportedList>();
      const byId = new Map<string, ImportedTask>();
      const pendingParents: { task: ImportedTask; parent: string; list: string }[] = [];
      for (const r of rows) {
        const listName = (cList >= 0 ? r[cList] : '')?.trim() || fileName.replace(/\.[^.]+$/, '');
        if (!lists.has(listName)) lists.set(listName, { title: listName, tasks: [] });
        const due = cDue >= 0 ? r[cDue]?.trim() : '';
        const task: ImportedTask = {
          title: r[cTitle]?.trim() ?? '',
          completed: cDone >= 0 ? /^(yes|true|1|x|done|completed)$/i.test(r[cDone]?.trim() ?? '') : false,
          dueDate: due && /^\d{4}-\d{2}-\d{2}/.test(due) ? due.slice(0, 10) : null,
          labels: cLabels >= 0 ? (r[cLabels] ?? '').split(/[;,]/).map((s) => s.trim()).filter(Boolean) : [],
          children: [],
        };
        if (!task.title) continue;
        if (cId >= 0 && r[cId]) byId.set(r[cId]!, task);
        const parent = cParent >= 0 ? r[cParent]?.trim() : '';
        if (parent) pendingParents.push({ task, parent, list: listName });
        else lists.get(listName)!.tasks.push(task);
      }
      for (const p of pendingParents) {
        const parent = byId.get(p.parent);
        if (parent) parent.children.push(p.task);
        else lists.get(p.list)!.tasks.push(p.task);
      }
      return [...lists.values()];
    },
  },
  {
    id: 'json',
    label: 'JSON (Orbit backup or generic)',
    accept: '.json,application/json',
    parse(text) {
      const data = JSON.parse(text) as unknown;
      // Orbit backup format.
      if (data && typeof data === 'object' && 'lists' in data && 'tasks' in data) {
        const d = data as { lists: { id: string; title: string }[]; tasks: { id: string; listId: string | null; parentTaskId: string | null; title: string; completedAt: string | null; dueDate: string | null }[] };
        const build = (parentId: string | null, listId: string | null): ImportedTask[] =>
          d.tasks
            .filter((t) => t.parentTaskId === parentId && (parentId !== null || t.listId === listId))
            .map((t) => ({ title: t.title, completed: Boolean(t.completedAt), dueDate: t.dueDate, children: build(t.id, null) }));
        return [...d.lists.map((l) => ({ title: l.title, tasks: build(null, l.id) })), { title: 'Imported inbox', tasks: build(null, null) }].filter((l) => l.tasks.length);
      }
      // Generic: [{ title, tasks: [{ title, completed, children }] }]
      if (Array.isArray(data)) return data as ImportedList[];
      throw new Error('Unrecognised JSON format.');
    },
  },
];

export function writeImport(actions: Actions, workspaceId: string, lists: ImportedList[], labelIdFor: (name: string) => string): { lists: number; tasks: number } {
  let tasks = 0;
  const write = (items: ImportedTask[], listId: string | null, parentTaskId: string | null) => {
    for (const t of items) {
      const { id } = actions.createTask({
        workspaceId,
        text: t.title,
        parse: false,
        listId: parentTaskId ? null : listId,
        parentTaskId,
        inInbox: false,
        dueDate: t.dueDate ?? null,
        recurrence: t.rrule ? fromRRule(t.rrule) : null,
        labelIds: (t.labels ?? []).map(labelIdFor),
      });
      if (t.completed) actions.setCompleted([id], true);
      tasks++;
      write(t.children, listId, id);
    }
  };
  for (const l of lists) {
    const { id } = actions.createList({ workspaceId, title: l.title });
    write(l.tasks, id, null);
  }
  return { lists: lists.length, tasks };
}
