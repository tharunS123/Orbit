'use client';

import * as React from 'react';
import { ChevronRight, Mic, Sun, Sunrise } from 'lucide-react';
import { addDays, formatCivilLong, todayIn } from '@orbit/core';
import { selectToday } from '@orbit/sync/client';
import { Button, EmptyState, Tooltip, cn } from '@orbit/ui';
import { PageBody, PageHeader, SectionTitle } from '@/features/shell/page-header';
import { SelectionProvider } from '@/features/tasks/selection';
import { BulkActionBar, TaskKeyboard } from '@/features/tasks/task-keyboard';
import { QuickAddRow, TaskList } from '@/features/tasks/task-list';
import { EventRow, eventsOn, useCalendarEvents } from '@/features/calendar/events';
import { useTaskPanel } from '@/lib/nav';
import { useNow, useStoreQuery, useSync } from '@/lib/sync';
import { useUndo } from '@/lib/undo';
import { useWorkspace } from '@/lib/workspace';
import { AVAILABLE_FEATURES, SHORTCUTS } from '@/lib/shortcuts';

function TodayView() {
  const { userId, timeZone, actions } = useSync();
  const { workspaceId, workspaces, profile } = useWorkspace();
  const { run } = useUndo();
  const now = useNow();
  const panel = useTaskPanel();
  const [showDone, setShowDone] = React.useState(false);
  const today = todayIn(timeZone, now);
  const view = useStoreQuery(['tasks', 'taskUserStates', 'lists'], (s) => selectToday(s, { userId, timeZone, now, workspaceId: null }), [userId, now.getMinutes()]);
  const showCalendar = profile?.settings.showCalendarInToday ?? true;
  const events = useCalendarEvents(today, addDays(today, 1), showCalendar);
  const todaysEvents = events.data ? eventsOn(events.data.events, today, timeZone) : [];
  const order = [...view.overdue, ...view.today, ...view.laterToday].map((t) => t.id);
  const total = view.overdue.length + view.today.length + view.laterToday.length;
  const greeting = now.getHours() < 12 ? 'Good morning' : now.getHours() < 18 ? 'Good afternoon' : 'Good evening';
  const multi = workspaces.length > 1;

  return (
    <SelectionProvider>
      <PageHeader
        title="Today"
        icon={<Sun />}
        subtitle={`${formatCivilLong(today)}${profile?.displayName ? ` · ${greeting}, ${profile.displayName.split(' ')[0]}` : ''}`}
        actions={
          AVAILABLE_FEATURES.talk ? (
            <Tooltip content="Talk" shortcut={SHORTCUTS.talk}>
              <Button variant="ghost" size="icon" aria-label="Add tasks by voice" onClick={() => window.dispatchEvent(new CustomEvent('orbit:talk-open'))}>
                <Mic />
              </Button>
            </Tooltip>
          ) : null
        }
      />
      <PageBody>
        {workspaceId ? <QuickAddRow workspaceId={workspaceId} inInbox defaultDue={today} placeholder="Add a task for today" className="mt-2" /> : null}
        <TaskKeyboard order={order} onOpen={panel.open} />

        {todaysEvents.length ? (
          <>
            <SectionTitle count={todaysEvents.length}>Calendar</SectionTitle>
            <div className="flex flex-col">
              {todaysEvents.map((e) => (
                <EventRow key={e.id} event={e} timeZone={timeZone} />
              ))}
            </div>
          </>
        ) : null}

        {view.overdue.length ? (
          <>
            <SectionTitle
              tone="danger"
              count={view.overdue.length}
              action={
                <Button variant="ghost" size="xs" onClick={() => run(null, () => actions.setDue(view.overdue.map((t) => t.id), today))}>
                  <Sunrise /> Move all to today
                </Button>
              }
            >
              Overdue
            </SectionTitle>
            <TaskList ariaLabel="Overdue" tasks={view.overdue} onOpen={panel.open} showList showWorkspace={multi} />
          </>
        ) : null}

        {view.today.length ? (
          <>
            <SectionTitle count={view.today.length}>Today</SectionTitle>
            <TaskList ariaLabel="Today" tasks={view.today} onOpen={panel.open} showList showWorkspace={multi} onReorder={(ids, to) => run(null, () => actions.reorderToday(view.today, ids, to), { toast: false })} />
          </>
        ) : null}

        {view.laterToday.length ? (
          <>
            <SectionTitle count={view.laterToday.length}>Later today</SectionTitle>
            <TaskList ariaLabel="Later today" tasks={view.laterToday} onOpen={panel.open} showList showWorkspace={multi} />
          </>
        ) : null}

        {!total ? (
          <EmptyState icon={<Sun />} title={view.completedToday.length ? 'All done for today' : 'A clear day'} description={view.completedToday.length ? `You completed ${view.completedToday.length} task${view.completedToday.length > 1 ? 's' : ''}. Enjoy the rest of your day.` : 'Nothing is due today. Plan ahead in Upcoming or add something above.'} />
        ) : null}

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

export default function TodayPage() {
  return (
    <React.Suspense>
      <TodayView />
    </React.Suspense>
  );
}
