import { describe, expect, it } from 'vitest';
import type { Recurrence } from '@orbit/shared';
import {
  advanceRecurrence,
  describeRecurrence,
  firstOccurrence,
  fromRRule,
  nextOccurrence,
  normalizeRecurrence,
  toRRule,
} from './recurrence';

const r = (rule: Partial<Recurrence> & Pick<Recurrence, 'freq'>): Recurrence => ({
  interval: 1,
  anchor: 'schedule',
  ...rule,
});

/** Collect the first n occurrences starting from (and including) `start`. */
function series(rule: Recurrence, start: string, n: number): string[] {
  const out = [start];
  let cur = start;
  while (out.length < n) {
    const next = nextOccurrence(rule, cur);
    if (!next) break;
    out.push(next);
    cur = next;
  }
  return out;
}

describe('nextOccurrence', () => {
  it('daily and every N days', () => {
    expect(series(r({ freq: 'daily' }), '2026-02-27', 4)).toEqual(['2026-02-27', '2026-02-28', '2026-03-01', '2026-03-02']);
    expect(series(r({ freq: 'daily', interval: 3 }), '2026-01-30', 3)).toEqual(['2026-01-30', '2026-02-02', '2026-02-05']);
  });

  it('weekdays and weekday-except-friday', () => {
    const weekdays = r({ freq: 'weekly', byWeekday: ['MO', 'TU', 'WE', 'TH', 'FR'] });
    // 2026-09-25 is a Friday
    expect(series(weekdays, '2026-09-24', 4)).toEqual(['2026-09-24', '2026-09-25', '2026-09-28', '2026-09-29']);
    const noFriday = r({ freq: 'weekly', byWeekday: ['MO', 'TU', 'WE', 'TH'] });
    expect(series(noFriday, '2026-09-24', 3)).toEqual(['2026-09-24', '2026-09-28', '2026-09-29']);
  });

  it('Monday + Thursday', () => {
    expect(series(r({ freq: 'weekly', byWeekday: ['MO', 'TH'] }), '2026-09-21', 5)).toEqual([
      '2026-09-21',
      '2026-09-24',
      '2026-09-28',
      '2026-10-01',
      '2026-10-05',
    ]);
  });

  it('every 2 weeks on Monday and Thursday keeps the interval grid', () => {
    expect(series(r({ freq: 'weekly', interval: 2, byWeekday: ['MO', 'TH'] }), '2026-09-21', 5)).toEqual([
      '2026-09-21',
      '2026-09-24',
      '2026-10-05',
      '2026-10-08',
      '2026-10-19',
    ]);
  });

  it('weekly without explicit days uses the reference weekday', () => {
    expect(series(r({ freq: 'weekly', interval: 2 }), '2026-09-23', 3)).toEqual(['2026-09-23', '2026-10-07', '2026-10-21']);
  });

  it('monthly on the 31st clamps to month length', () => {
    expect(series(r({ freq: 'monthly', byMonthDay: [31] }), '2026-01-31', 4)).toEqual([
      '2026-01-31',
      '2026-02-28',
      '2026-03-31',
      '2026-04-30',
    ]);
  });

  it('monthly anchored on the reference day when no day given', () => {
    expect(series(r({ freq: 'monthly' }), '2026-01-15', 3)).toEqual(['2026-01-15', '2026-02-15', '2026-03-15']);
  });

  it('first day of each month, last day of each month', () => {
    expect(series(r({ freq: 'monthly', byMonthDay: [1] }), '2026-11-01', 3)).toEqual(['2026-11-01', '2026-12-01', '2027-01-01']);
    expect(series(r({ freq: 'monthly', byMonthDay: [-1] }), '2028-01-31', 3)).toEqual(['2028-01-31', '2028-02-29', '2028-03-31']);
  });

  it('first Monday and last Friday of the month', () => {
    expect(series(r({ freq: 'monthly', byNthWeekday: { weekday: 'MO', nth: 1 } }), '2026-09-07', 3)).toEqual([
      '2026-09-07',
      '2026-10-05',
      '2026-11-02',
    ]);
    expect(series(r({ freq: 'monthly', byNthWeekday: { weekday: 'FR', nth: -1 } }), '2026-09-25', 3)).toEqual([
      '2026-09-25',
      '2026-10-30',
      '2026-11-27',
    ]);
  });

  it('every 3 months does not drift after clamping once normalized', () => {
    const rule = normalizeRecurrence(r({ freq: 'monthly', interval: 3 }), '2026-11-30');
    expect(rule.byMonthDay).toEqual([30]);
    expect(series(rule, '2026-11-30', 3)).toEqual(['2026-11-30', '2027-02-28', '2027-05-30']);
  });

  it('yearly Feb 29 returns to the 29th in leap years once normalized', () => {
    const rule = normalizeRecurrence(r({ freq: 'yearly' }), '2028-02-29');
    expect(series(rule, '2028-02-29', 5)).toEqual(['2028-02-29', '2029-02-28', '2030-02-28', '2031-02-28', '2032-02-29']);
  });

  it('yearly, including Feb 29 clamping', () => {
    expect(series(r({ freq: 'yearly' }), '2028-02-29', 3)).toEqual(['2028-02-29', '2029-02-28', '2030-02-28']);
    expect(series(r({ freq: 'yearly', interval: 2 }), '2026-06-01', 3)).toEqual(['2026-06-01', '2028-06-01', '2030-06-01']);
  });

  it('respects until', () => {
    expect(series(r({ freq: 'daily', until: '2026-01-03' }), '2026-01-01', 10)).toEqual(['2026-01-01', '2026-01-02', '2026-01-03']);
  });

  it('crosses DST boundaries on civil dates (no drift)', () => {
    // US DST starts 2026-03-08, EU 2026-03-29. Civil dates are unaffected.
    expect(series(r({ freq: 'weekly' }), '2026-03-01', 3)).toEqual(['2026-03-01', '2026-03-08', '2026-03-15']);
  });
});

describe('firstOccurrence', () => {
  it('uses today when it matches, otherwise the next slot', () => {
    // 2026-09-22 is a Tuesday
    expect(firstOccurrence(r({ freq: 'weekly', byWeekday: ['TU'] }), '2026-09-22')).toBe('2026-09-22');
    expect(firstOccurrence(r({ freq: 'weekly', byWeekday: ['MO', 'TH'] }), '2026-09-22')).toBe('2026-09-24');
    expect(firstOccurrence(r({ freq: 'monthly', byMonthDay: [1] }), '2026-09-22')).toBe('2026-10-01');
  });
});

describe('advanceRecurrence', () => {
  const today = '2026-09-22';
  it('moves to the next scheduled slot when completed on time', () => {
    expect(advanceRecurrence(r({ freq: 'weekly', byWeekday: ['MO', 'TH'] }), '2026-09-21', today, 0)).toEqual({
      nextDueDate: '2026-09-24',
      occurrenceCount: 1,
    });
  });
  it('overdue tasks jump past today, never into the past', () => {
    expect(advanceRecurrence(r({ freq: 'daily' }), '2026-09-10', today, 4).nextDueDate).toBe('2026-09-23');
    expect(advanceRecurrence(r({ freq: 'weekly', byWeekday: ['MO'] }), '2026-08-03', today, 0).nextDueDate).toBe('2026-09-28');
  });
  it('completing early moves after the scheduled date', () => {
    expect(advanceRecurrence(r({ freq: 'weekly' }), '2026-09-25', today, 0).nextDueDate).toBe('2026-10-02');
  });
  it('anchor=completion counts from the completion date', () => {
    expect(advanceRecurrence(r({ freq: 'daily', interval: 3, anchor: 'completion' }), '2026-09-15', today, 0, today).nextDueDate).toBe('2026-09-25');
  });
  it('ends after count occurrences', () => {
    expect(advanceRecurrence(r({ freq: 'daily', count: 3 }), '2026-09-22', today, 2)).toEqual({ nextDueDate: null, occurrenceCount: 3 });
  });
  it('ends at until', () => {
    expect(advanceRecurrence(r({ freq: 'daily', until: '2026-09-22' }), '2026-09-22', today, 0).nextDueDate).toBeNull();
  });
});

describe('describe / rrule', () => {
  it('describes rules in plain language', () => {
    expect(describeRecurrence(r({ freq: 'weekly', byWeekday: ['MO', 'TU', 'WE', 'TH', 'FR'] }))).toBe('Every weekday');
    expect(describeRecurrence(r({ freq: 'weekly', byWeekday: ['TH', 'MO'] }))).toBe('Every Monday and Thursday');
    expect(describeRecurrence(r({ freq: 'weekly', interval: 2, byWeekday: ['FR'] }))).toBe('Every 2 weeks on Friday');
    expect(describeRecurrence(r({ freq: 'monthly', byMonthDay: [1] }))).toBe('Every month on the 1st');
    expect(describeRecurrence(r({ freq: 'monthly', byNthWeekday: { weekday: 'MO', nth: 1 } }))).toBe('Every month on the 1st Monday');
    expect(describeRecurrence(r({ freq: 'yearly' }))).toBe('Every year');
  });
  it('round-trips RRULE', () => {
    const rules: Recurrence[] = [
      r({ freq: 'weekly', interval: 2, byWeekday: ['MO', 'TH'], until: '2027-01-01' }),
      r({ freq: 'monthly', byNthWeekday: { weekday: 'FR', nth: -1 } }),
      r({ freq: 'monthly', byMonthDay: [1, 15], count: 12 }),
      r({ freq: 'yearly', byMonth: [3] }),
    ];
    for (const rule of rules) expect(fromRRule(toRRule(rule))).toEqual(rule);
    expect(fromRRule('RRULE:FREQ=HOURLY')).toBeNull();
  });
});
