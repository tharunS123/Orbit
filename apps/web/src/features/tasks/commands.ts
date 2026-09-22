'use client';

import * as React from 'react';
import type { Task } from '@orbit/shared';
import { routes, shareLinks } from '@orbit/shared';
import { addDays, buildTaskTree, isoWeekday, taskTreeToMarkdown, taskTreeToText } from '@orbit/core';
import { selectLabels } from '@orbit/sync/client';
import { toast } from '@orbit/ui';
import { publicEnv } from '@/lib/env';
import { useSync } from '@/lib/sync';
import { useUndo } from '@/lib/undo';

export type PickerKind = 'date' | 'labels' | 'assign' | 'move' | 'repeat' | 'reminder';

async function copyText(text: string, what: string) {
  try {
    await navigator.clipboard.writeText(text);
    toast.success(`${what} copied`);
  } catch {
    toast.error('Copy failed — your browser blocked clipboard access.');
  }
}

/** All task operations in one place, operating on a set of ids (single or bulk). */
export function useTaskCommands() {
  const { actions, store } = useSync();
  const { run } = useUndo();

  return React.useMemo(() => {
    const tasksOf = (ids: string[]) => ids.map((id) => store.get('tasks', id)).filter((t): t is Task => Boolean(t && !t.deletedAt));
    const subtreeFor = (ids: string[]) => {
      const out: Task[] = [];
      const visit = (t: Task) => {
        out.push(t);
        for (const c of store.childrenOf(t.id)) if (!c.deletedAt) visit(c);
      };
      tasksOf(ids).forEach(visit);
      return out;
    };
    const today = () => actions.today();
    return {
      toggle(ids: string[]) {
        const tasks = tasksOf(ids);
        if (!tasks.length) return;
        const completing = tasks.some((t) => !t.completedAt);
        run(null, () => actions.setCompleted(tasks.map((t) => t.id), completing), { sound: completing ? 'complete' : null });
      },
      schedule(ids: string[], preset: 'today' | 'tomorrow' | 'weekend' | 'nextweek' | 'none') {
        const t = today();
        const date =
          preset === 'today' ? t
          : preset === 'tomorrow' ? addDays(t, 1)
          : preset === 'weekend' ? addDays(t, ((5 - isoWeekday(t) + 7) % 7) || 7)
          : preset === 'nextweek' ? addDays(t, ((7 - isoWeekday(t)) % 7) || 7)
          : null;
        run(null, () => actions.setDue(ids, date));
      },
      setDue(ids: string[], dueDate: string | null, dueTime: string | null) {
        run(null, () => actions.setDue(ids, dueDate, dueTime));
      },
      assign(ids: string[], userId: string | null) {
        run(null, () => actions.assign(ids, userId));
      },
      toggleLabel(ids: string[], labelId: string, on: boolean) {
        run(null, () => actions.setLabels(ids, on ? [labelId] : [], on ? [] : [labelId]), { toast: false });
      },
      move(ids: string[], listId: string | null) {
        const name = listId ? store.get('lists', listId)?.title || 'Untitled list' : 'Inbox';
        run(`Moved to ${name}`, () => actions.moveTasks(ids, { listId }));
      },
      setInbox(ids: string[], inInbox: boolean) {
        run(null, () => actions.setInbox(ids, inInbox));
      },
      duplicate(ids: string[]) {
        for (const id of ids) run('Duplicated', () => actions.duplicateTask(id));
      },
      remove(ids: string[]) {
        run(null, () => actions.deleteTasks(ids));
      },
      skip(id: string) {
        run(null, () => actions.skipOccurrence(id));
      },
      copyText(ids: string[]) {
        void copyText(taskTreeToText(buildTaskTree(subtreeFor(ids))), 'Text');
      },
      copyMarkdown(ids: string[]) {
        const first = tasksOf(ids)[0];
        const labels = new Map(selectLabels(store, first?.workspaceId ?? null).map((l) => [l.id, l.name]));
        const people = new Map(store.all('profiles').map((p) => [p.id, p.displayName]));
        void copyText(taskTreeToMarkdown(buildTaskTree(subtreeFor(ids)), { labels, people }), 'Markdown');
      },
      copyLink(id: string) {
        void copyText(shareLinks.task(publicEnv.appUrl || window.location.origin, id), 'Link');
      },
      share(id: string) {
        const t = store.get('tasks', id);
        const url = shareLinks.task(publicEnv.appUrl || window.location.origin, id);
        if (navigator.share) void navigator.share({ title: t?.title, url }).catch(() => undefined);
        else void copyText(url, 'Link');
      },
      routeFor(id: string) {
        return routes.task(id);
      },
    };
  }, [actions, store, run]);
}

export type TaskCommands = ReturnType<typeof useTaskCommands>;
