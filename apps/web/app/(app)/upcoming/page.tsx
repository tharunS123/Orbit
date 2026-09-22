'use client';

import * as React from 'react';
import { DndContext, PointerSensor, TouchSensor, KeyboardSensor, useDraggable, useDroppable, useSensor, useSensors, type DragEndEvent } from '@dnd-kit/core';
import { CalendarRange, ChevronLeft, ChevronRight } from 'lucide-react';
import type { Task } from '@orbit/shared';
import { addDays, diffDays, formatCivilLong, isoWeekday, parseCivil, startOfIsoWeek, todayIn } from '@orbit/core';
import { selectUpcoming } from '@orbit/sync/client';
import { Button, Calendar, Popover, PopoverContent, PopoverTrigger, Segmented, Switch, cn } from '@orbit/ui';
import { PageBody, PageHeader, SectionTitle } from '@/features/shell/page-header';
import { SelectionProvider } from '@/features/tasks/selection';
import { BulkActionBar, TaskKeyboard } from '@/features/tasks/task-keyboard';
import { QuickAddRow, TaskList } from '@/features/tasks/task-list';
import { TaskRow } from '@/features/tasks/task-row';
import { EventRow, eventsOn, useCalendarEvents } from '@/features/calendar/events';
import { useTaskPanel } from '@/lib/nav';
import { useNow, useStoreQuery, useSync } from '@/lib/sync';
import { useUndo } from '@/lib/undo';
import { useWorkspace } from '@/lib/workspace';

type Range = 'day' | 'week' | 'month';

function DraggableTask({ task, onOpen, multi }: { task: Task; onOpen: (id: string) => void; multi: boolean }) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({ id: task.id, data: { task } });
  return (
    <div ref={setNodeRef} className={cn(isDragging && 'opacity-40')}>
      <TaskRow task={task} onOpen={onOpen} showList showWorkspace={multi} dragHandleProps={{ ...attributes, ...listeners } as React.HTMLAttributes<HTMLButtonElement>} />
    </div>
  );
}

function DayGroup({ date, today, children, count }: { date: string; today: string; children: React.ReactNode; count: number }) {
  const { setNodeRef, isOver } = useDroppable({ id: `day:${date}` });
  const d = diffDays(date, today);
  const label = d === 0 ? 'Today' : d === 1 ? 'Tomorrow' : formatCivilLong(date).replace(/, \d{4}$/, '');
  const weekend = isoWeekday(date) >= 5;
  return (
    <section ref={setNodeRef} aria-label={formatCivilLong(date)} className={cn('mt-4 rounded-lg transition-colors', isOver && 'bg-accent-subtle/50 ring-2 ring-accent/30')}>
      <div className="sticky top-[68px] z-10 flex items-baseline gap-2 border-b border-border bg-bg/95 px-1 py-1.5 backdrop-blur sm:top-[92px]">
        <h2 className={cn('text-sm font-semibold', d === 0 ? 'text-accent' : weekend ? 'text-fg-muted' : 'text-fg')}>{label}</h2>
        {d > 1 ? <span className="text-xs text-fg-subtle">{formatCivilLong(date).split(',')[0]}</span> : null}
        {count ? <span className="ml-auto text-xs text-fg-subtle tabular-nums">{count}</span> : null}
      </div>
      <div className="min-h-9 pt-1">{children}</div>
    </section>
  );
}

function UpcomingView() {
  const { userId, timeZone, actions } = useSync();
  const { workspaceId, workspaces } = useWorkspace();
  const { run } = useUndo();
  const now = useNow();
  const panel = useTaskPanel();
  const today = todayIn(timeZone, now);
  const [range, setRange] = React.useState<Range>('week');
  const [start, setStart] = React.useState(today);
  const [showUnscheduled, setShowUnscheduled] = React.useState(false);
  const [onlyMine, setOnlyMine] = React.useState(true);

  const days = range === 'day' ? 1 : range === 'week' ? 7 : 35;
  const windowStart = range === 'month' ? startOfIsoWeek(`${start.slice(0, 7)}-01`) : start;
  const view = useStoreQuery(['tasks', 'lists'], (s) => selectUpcoming(s, { userId, timeZone, now, workspaceId: null }, { start: windowStart, days }, { includeUnscheduled: showUnscheduled, onlyMine }), [userId, windowStart, days, showUnscheduled, onlyMine, now.getMinutes()]);
  const events = useCalendarEvents(windowStart, addDays(windowStart, days));
  const marks = React.useMemo(() => Object.fromEntries(view.days.map((d) => [d.date, d.tasks.length])), [view.days]);
  const order = [...view.overdue, ...view.days.flatMap((d) => d.tasks), ...view.unscheduled].map((t) => t.id);
  const multi = workspaces.length > 1;

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }), useSensor(TouchSensor, { activationConstraint: { delay: 250, tolerance: 6 } }), useSensor(KeyboardSensor));
  const onDragEnd = (e: DragEndEvent) => {
    const date = typeof e.over?.id === 'string' && e.over.id.startsWith('day:') ? e.over.id.slice(4) : null;
    const task = e.active.data.current?.task as Task | undefined;
    if (!date || !task || task.dueDate === date) return;
    run(`Moved to ${formatCivilLong(date)}`, () => actions.setDue([task.id], date, task.dueTime));
  };
  const step = (dir: -1 | 1) => {
    if (range === 'day') setStart(addDays(start, dir));
    else if (range === 'week') setStart(addDays(start, 7 * dir));
    else {
      const { y, m } = parseCivil(start);
      const total = y * 12 + (m - 1) + dir;
      setStart(`${Math.floor(total / 12)}-${String((total % 12) + 1).padStart(2, '0')}-01`);
    }
  };
  const title = range === 'month' ? new Intl.DateTimeFormat(undefined, { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(new Date(`${start.slice(0, 7)}-01T00:00:00Z`)) : formatCivilLong(windowStart);

  return (
    <SelectionProvider>
      <PageHeader
        title="Upcoming"
        icon={<CalendarRange />}
        subtitle={title}
        actions={<Segmented ariaLabel="Range" value={range} onValueChange={setRange} options={[{ value: 'day', label: 'Day' }, { value: 'week', label: 'Week' }, { value: 'month', label: 'Month' }]} />}
      >
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="secondary" size="xs" onClick={() => setStart(today)}>
            Today
          </Button>
          <Button variant="ghost" size="icon-sm" aria-label="Previous" onClick={() => step(-1)}>
            <ChevronLeft />
          </Button>
          <Button variant="ghost" size="icon-sm" aria-label="Next" onClick={() => step(1)}>
            <ChevronRight />
          </Button>
          <Popover>
            <PopoverTrigger asChild>
              <Button variant="ghost" size="xs">
                Jump to date
              </Button>
            </PopoverTrigger>
            <PopoverContent>
              <Calendar value={start} today={today} marks={marks} onSelect={setStart} />
            </PopoverContent>
          </Popover>
          <label className="ml-auto flex items-center gap-2 text-xs text-fg-muted">
            <Switch checked={onlyMine} onCheckedChange={setOnlyMine} aria-label="Only my tasks" /> Only mine
          </label>
          <label className="flex items-center gap-2 text-xs text-fg-muted">
            <Switch checked={showUnscheduled} onCheckedChange={setShowUnscheduled} aria-label="Show unscheduled" /> No date
          </label>
        </div>
      </PageHeader>
      <PageBody>
        <TaskKeyboard order={order} onOpen={panel.open} />
        <DndContext sensors={sensors} onDragEnd={onDragEnd}>
          {view.overdue.length ? (
            <>
              <SectionTitle tone="danger" count={view.overdue.length}>
                Overdue
              </SectionTitle>
              {view.overdue.map((t) => (
                <DraggableTask key={t.id} task={t} onOpen={panel.open} multi={multi} />
              ))}
            </>
          ) : null}
          {view.days.map((day) => {
            const dayEvents = events.data ? eventsOn(events.data.events, day.date, timeZone) : [];
            if (range === 'month' && !day.tasks.length && !dayEvents.length && day.date !== today) return null;
            return (
              <DayGroup key={day.date} date={day.date} today={today} count={day.tasks.length}>
                {dayEvents.map((e) => (
                  <EventRow key={e.id} event={e} timeZone={timeZone} />
                ))}
                {day.tasks.map((t) => (
                  <DraggableTask key={t.id} task={t} onOpen={panel.open} multi={multi} />
                ))}
                {workspaceId && range !== 'month' ? <QuickAddRow workspaceId={workspaceId} inInbox defaultDue={day.date} placeholder="Add task" className="opacity-70 focus-within:opacity-100 hover:opacity-100" /> : null}
              </DayGroup>
            );
          })}
        </DndContext>
        {showUnscheduled ? (
          <>
            <SectionTitle count={view.unscheduled.length}>No date</SectionTitle>
            <TaskList ariaLabel="Unscheduled" tasks={view.unscheduled} onOpen={panel.open} showList showWorkspace={multi} />
          </>
        ) : null}
      </PageBody>
      <BulkActionBar />
    </SelectionProvider>
  );
}

export default function UpcomingPage() {
  return (
    <React.Suspense>
      <UpcomingView />
    </React.Suspense>
  );
}
