'use client';

import * as React from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { cn } from '../cn';
import { Button } from './primitives';

/**
 * Accessible month calendar (grid pattern): arrow keys move by day/week, PageUp/PageDown by
 * month, Home/End to week bounds, Enter/Space selects. Works on civil dates (YYYY-MM-DD).
 */

const pad = (n: number) => String(n).padStart(2, '0');
const toCivil = (d: Date) => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
const fromCivil = (s: string) => {
  const [y, m, d] = s.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d));
};
const addDays = (s: string, n: number) => {
  const d = fromCivil(s);
  d.setUTCDate(d.getUTCDate() + n);
  return toCivil(d);
};
const addMonths = (s: string, n: number) => {
  const d = fromCivil(s);
  const day = d.getUTCDate();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() + n);
  const len = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(day, len));
  return toCivil(d);
};

export interface CalendarProps {
  value: string | null;
  onSelect: (date: string) => void;
  today: string;
  /** 0 = Sunday, 1 = Monday, 6 = Saturday. */
  weekStartsOn?: 0 | 1 | 6;
  /** Dots under days (e.g. number of tasks). */
  marks?: Record<string, number>;
  className?: string;
}

export function Calendar({ value, onSelect, today, weekStartsOn = 1, marks, className }: CalendarProps) {
  const [focus, setFocus] = React.useState(value ?? today);
  const month = focus.slice(0, 7);
  const gridRef = React.useRef<HTMLDivElement>(null);
  const first = `${month}-01`;
  const firstDow = fromCivil(first).getUTCDay();
  const lead = (firstDow - weekStartsOn + 7) % 7;
  const start = addDays(first, -lead);
  const days = Array.from({ length: 42 }, (_, i) => addDays(start, i));
  const weekdayNames = Array.from({ length: 7 }, (_, i) => new Intl.DateTimeFormat(undefined, { weekday: 'narrow', timeZone: 'UTC' }).format(fromCivil(addDays('2023-01-01', (weekStartsOn + i) % 7))));
  const monthLabel = new Intl.DateTimeFormat(undefined, { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(fromCivil(first));

  React.useEffect(() => {
    const el = gridRef.current?.querySelector<HTMLButtonElement>(`[data-date="${focus}"]`);
    if (el && gridRef.current?.contains(document.activeElement)) el.focus();
  }, [focus]);

  const onKey = (e: React.KeyboardEvent) => {
    const moves: Record<string, () => string> = {
      ArrowLeft: () => addDays(focus, -1),
      ArrowRight: () => addDays(focus, 1),
      ArrowUp: () => addDays(focus, -7),
      ArrowDown: () => addDays(focus, 7),
      PageUp: () => addMonths(focus, e.shiftKey ? -12 : -1),
      PageDown: () => addMonths(focus, e.shiftKey ? 12 : 1),
      Home: () => addDays(focus, -((fromCivil(focus).getUTCDay() - weekStartsOn + 7) % 7)),
      End: () => addDays(focus, 6 - ((fromCivil(focus).getUTCDay() - weekStartsOn + 7) % 7)),
    };
    const move = moves[e.key];
    if (move) {
      e.preventDefault();
      setFocus(move());
    }
  };

  return (
    <div className={cn('w-[252px] select-none', className)}>
      <div className="mb-2 flex items-center justify-between px-1">
        <span className="text-[13px] font-semibold" aria-live="polite">
          {monthLabel}
        </span>
        <div className="flex">
          <Button variant="ghost" size="icon-sm" aria-label="Previous month" onClick={() => setFocus(addMonths(focus, -1))}>
            <ChevronLeft />
          </Button>
          <Button variant="ghost" size="icon-sm" aria-label="Next month" onClick={() => setFocus(addMonths(focus, 1))}>
            <ChevronRight />
          </Button>
        </div>
      </div>
      <div role="grid" aria-label={monthLabel} ref={gridRef} onKeyDown={onKey} className="grid grid-cols-7 gap-0.5">
        {weekdayNames.map((n, i) => (
          <div key={i} role="columnheader" className="grid h-7 place-items-center text-[11px] font-medium text-fg-subtle">
            {n}
          </div>
        ))}
        {days.map((d) => {
          const inMonth = d.startsWith(month);
          const selected = d === value;
          const isToday = d === today;
          const mark = marks?.[d] ?? 0;
          return (
            <button
              key={d}
              type="button"
              role="gridcell"
              data-date={d}
              tabIndex={d === focus ? 0 : -1}
              aria-selected={selected}
              aria-label={new Intl.DateTimeFormat(undefined, { dateStyle: 'full', timeZone: 'UTC' }).format(fromCivil(d))}
              onClick={() => {
                setFocus(d);
                onSelect(d);
              }}
              className={cn(
                'relative grid h-8 place-items-center rounded-md text-[13px] tabular-nums transition-colors outline-none focus-visible:ring-2 focus-visible:ring-focus',
                inMonth ? 'text-fg' : 'text-fg-subtle/60',
                selected ? 'bg-accent font-semibold text-accent-fg' : 'hover:bg-bg-hover',
                isToday && !selected && 'font-semibold text-accent',
              )}
            >
              {Number(d.slice(8))}
              {mark > 0 && !selected ? <span className="absolute bottom-1 size-1 rounded-full bg-accent/70" aria-hidden /> : null}
            </button>
          );
        })}
      </div>
    </div>
  );
}
