'use client';

import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import { ExternalLink } from 'lucide-react';
import { cn } from '@orbit/ui';
import { apiFetch } from '@/lib/api';

/** External calendar events (read-only) shown alongside tasks in Today/Upcoming. */
export interface CalendarEventDto {
  id: string;
  title: string;
  startsAt: string | null;
  endsAt: string | null;
  startDate: string | null;
  endDate: string | null;
  allDay: boolean;
  location: string | null;
  htmlLink: string | null;
  color: string | null;
}

export function useCalendarEvents(from: string, to: string, enabled = true) {
  return useQuery({
    queryKey: ['calendar-events', from, to],
    enabled,
    staleTime: 5 * 60_000,
    networkMode: 'offlineFirst',
    queryFn: async () => {
      const res = await apiFetch<{ events: CalendarEventDto[]; connected: boolean }>(`/calendar/events?from=${from}&to=${to}`);
      return res;
    },
  });
}

/** Events that fall on a civil date in the viewer's zone. */
export function eventsOn(events: CalendarEventDto[], date: string, timeZone: string): CalendarEventDto[] {
  const fmt = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' });
  return events
    .filter((e) => {
      if (e.allDay && e.startDate) return e.startDate <= date && (e.endDate ?? e.startDate) > date;
      return e.startsAt ? fmt.format(new Date(e.startsAt)) === date : false;
    })
    .sort((a, b) => (a.allDay === b.allDay ? (a.startsAt ?? '').localeCompare(b.startsAt ?? '') : a.allDay ? -1 : 1));
}

export function EventRow({ event, timeZone }: { event: CalendarEventDto; timeZone: string }) {
  const time = event.allDay
    ? 'All day'
    : `${new Date(event.startsAt!).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit', timeZone })}${event.endsAt ? ` – ${new Date(event.endsAt).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit', timeZone })}` : ''}`;
  return (
    <div className="flex items-center gap-3 rounded-md py-1.5 pr-2 pl-1" aria-label={`Calendar event: ${event.title}, ${time}`}>
      {/* Events are outlined bars — visually distinct from checkable tasks. */}
      <span className={cn('h-8 w-1 shrink-0 rounded-full')} style={{ background: event.color ?? 'var(--accent)' }} aria-hidden />
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm">{event.title || '(No title)'}</p>
        <p className="text-xs text-fg-subtle">
          {time}
          {event.location ? ` · ${event.location}` : ''}
        </p>
      </div>
      {event.htmlLink ? (
        <a href={event.htmlLink} target="_blank" rel="noopener noreferrer" className="text-fg-subtle hover:text-fg" aria-label="Open in calendar">
          <ExternalLink className="size-3.5" />
        </a>
      ) : null}
    </div>
  );
}
