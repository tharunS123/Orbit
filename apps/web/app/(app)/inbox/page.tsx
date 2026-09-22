'use client';

import * as React from 'react';
import { ChevronRight, Inbox, Mic, PartyPopper } from 'lucide-react';
import { selectInbox } from '@orbit/sync/client';
import { Button, EmptyState, Segmented, Tooltip, cn } from '@orbit/ui';
import { PageBody, PageHeader, SectionTitle } from '@/features/shell/page-header';
import { SelectionProvider } from '@/features/tasks/selection';
import { BulkActionBar, TaskKeyboard } from '@/features/tasks/task-keyboard';
import { QuickAddRow, TaskList } from '@/features/tasks/task-list';
import { useTaskPanel } from '@/lib/nav';
import { useNow, useStoreQuery, useSync } from '@/lib/sync';
import { useUndo } from '@/lib/undo';
import { useWorkspace } from '@/lib/workspace';
import { SHORTCUTS } from '@/lib/hotkeys';

type Sort = 'manual' | 'due' | 'newest';

function InboxView() {
  const { userId, timeZone, actions } = useSync();
  const { workspaceId, workspaces } = useWorkspace();
  const { run } = useUndo();
  const now = useNow();
  const panel = useTaskPanel();
  const [sort, setSort] = React.useState<Sort>('manual');
  const [showDone, setShowDone] = React.useState(false);
  const view = useStoreQuery(['tasks', 'taskUserStates', 'lists'], (s) => selectInbox(s, { userId, timeZone, now, workspaceId: null }), [userId, now.getMinutes()]);
  const open = React.useMemo(() => {
    if (sort === 'due') return [...view.open].sort((a, b) => (a.dueDate ?? '9999').localeCompare(b.dueDate ?? '9999') || (a.dueAt ?? '').localeCompare(b.dueAt ?? ''));
    if (sort === 'newest') return [...view.open].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return view.open;
  }, [view.open, sort]);

  return (
    <SelectionProvider>
      <PageHeader
        title="Inbox"
        icon={<Inbox />}
        subtitle={open.length ? `${open.length} to process` : undefined}
        actions={
          <>
            <Segmented ariaLabel="Sort" value={sort} onValueChange={setSort} options={[{ value: 'manual', label: 'Manual' }, { value: 'due', label: 'Due' }, { value: 'newest', label: 'Newest' }]} className="max-sm:hidden" />
            <Tooltip content="Talk" shortcut={SHORTCUTS.talk}>
              <Button variant="ghost" size="icon" aria-label="Add tasks by voice" onClick={() => window.dispatchEvent(new CustomEvent('orbit:talk-open'))}>
                <Mic />
              </Button>
            </Tooltip>
          </>
        }
      />
      <PageBody>
        {workspaceId ? <QuickAddRow workspaceId={workspaceId} inInbox placeholder="Add to Inbox — try “Call Sam tomorrow 3pm #work”" className="mt-2" /> : null}
        <TaskKeyboard order={open.map((t) => t.id)} onOpen={panel.open} />
        <div className="mt-2">
          <TaskList
            ariaLabel="Inbox"
            tasks={open}
            onOpen={panel.open}
            showList
            showWorkspace={workspaces.length > 1}
            onReorder={sort === 'manual' ? (ids, to) => run(null, () => actions.reorderInbox(open, ids, to), { toast: false }) : undefined}
            empty={
              <EmptyState
                icon={<PartyPopper />}
                title="Inbox zero"
                description="Everything is processed. Capture new thoughts here with N, or forward emails and messages to land them in your Inbox."
              />
            }
          />
        </div>
        {view.completedToday.length ? (
          <>
            <SectionTitle
              count={view.completedToday.length}
              action={
                <Button variant="ghost" size="xs" onClick={() => setShowDone(!showDone)} aria-expanded={showDone}>
                  <ChevronRight className={cn('transition-transform', showDone && 'rotate-90')} /> {showDone ? 'Hide' : 'Show'}
                </Button>
              }
            >
              Completed today
            </SectionTitle>
            {showDone ? <TaskList ariaLabel="Completed today" tasks={view.completedToday} onOpen={panel.open} showList /> : null}
          </>
        ) : null}
      </PageBody>
      <BulkActionBar />
    </SelectionProvider>
  );
}

export default function InboxPage() {
  return (
    <React.Suspense>
      <InboxView />
    </React.Suspense>
  );
}
