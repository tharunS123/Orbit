import { WEEKDAYS, type Recurrence, type Weekday } from '@orbit/shared';
import {
  addDays,
  addMonths,
  compareCivil,
  daysInMonth,
  diffDays,
  formatCivil,
  isoWeekday,
  parseCivil,
  startOfIsoWeek,
  type CivilDate,
} from './dates';

/**
 * Recurrence engine. A recurring task is a single live task whose due date advances when it is
 * completed or skipped (see docs/PRODUCT_SPEC.md). All arithmetic is on civil dates, so it is
 * DST-safe; the wall-clock time and zone of the task are preserved.
 *
 * Month-day rules clamp to the month length (the 31st becomes the 30th/28th), which is what
 * people mean by "every month on the 31st". RRULE export uses BYMONTHDAY=-1 for "last day".
 */

const weekdayIndex = (w: Weekday) => WEEKDAYS.indexOf(w);

function nthWeekdayOfMonth(y: number, m: number, weekday: Weekday, nth: number): number | null {
  const target = weekdayIndex(weekday);
  const len = daysInMonth(y, m);
  if (nth > 0) {
    const firstDow = isoWeekday(formatCivil(y, m, 1));
    const day = 1 + ((target - firstDow + 7) % 7) + (nth - 1) * 7;
    return day <= len ? day : null;
  }
  const lastDow = isoWeekday(formatCivil(y, m, len));
  const day = len - ((lastDow - target + 7) % 7) + (nth + 1) * 7;
  return day >= 1 ? day : null;
}

function resolveMonthDay(y: number, m: number, md: number): number {
  const len = daysInMonth(y, m);
  if (md < 0) return Math.max(1, len + md + 1);
  return Math.min(md, len);
}

/** Candidate days (sorted, unique) in a given month for a monthly/yearly rule. */
function daysInMonthForRule(rule: Recurrence, y: number, m: number, anchorDay: number): number[] {
  const days = new Set<number>();
  if (rule.byNthWeekday) {
    const d = nthWeekdayOfMonth(y, m, rule.byNthWeekday.weekday, rule.byNthWeekday.nth);
    if (d !== null) days.add(d);
  } else if (rule.byMonthDay?.length) {
    for (const md of rule.byMonthDay) days.add(resolveMonthDay(y, m, md));
  } else {
    days.add(resolveMonthDay(y, m, anchorDay));
  }
  return [...days].sort((a, b) => a - b);
}

/**
 * First occurrence strictly after `after`, using `reference` (the current occurrence) to align
 * intervals. Returns null when the rule's `until` is passed.
 */
export function nextOccurrence(rule: Recurrence, reference: CivilDate, after: CivilDate = reference): CivilDate | null {
  const interval = Math.max(1, rule.interval ?? 1);
  let result: CivilDate | null = null;

  switch (rule.freq) {
    case 'daily': {
      const gap = diffDays(after, reference);
      const steps = gap < 0 ? 1 : Math.floor(gap / interval) + 1;
      result = addDays(reference, steps * interval);
      break;
    }
    case 'weekly': {
      const days = (rule.byWeekday?.length ? rule.byWeekday : [WEEKDAYS[isoWeekday(reference)]!])
        .map(weekdayIndex)
        .sort((a, b) => a - b);
      const refWeek = startOfIsoWeek(reference);
      let week = startOfIsoWeek(after);
      // Align to the interval grid.
      const weeksApart = Math.round(diffDays(week, refWeek) / 7);
      const mod = ((weeksApart % interval) + interval) % interval;
      if (mod !== 0) week = addDays(week, (interval - mod) * 7);
      for (let guard = 0; guard < 1000 && !result; guard++) {
        for (const dow of days) {
          const candidate = addDays(week, dow);
          if (compareCivil(candidate, after) > 0) {
            result = candidate;
            break;
          }
        }
        week = addDays(week, interval * 7);
      }
      break;
    }
    case 'monthly': {
      const ref = parseCivil(reference);
      const start = parseCivil(after);
      let monthsFromRef = (start.y - ref.y) * 12 + (start.m - ref.m);
      const mod = ((monthsFromRef % interval) + interval) % interval;
      if (mod !== 0) monthsFromRef += interval - mod;
      for (let guard = 0; guard < 1200 && !result; guard++) {
        const cursor = parseCivil(addMonths(formatCivil(ref.y, ref.m, 1), monthsFromRef));
        for (const d of daysInMonthForRule(rule, cursor.y, cursor.m, ref.d)) {
          const candidate = formatCivil(cursor.y, cursor.m, d);
          if (compareCivil(candidate, after) > 0) {
            result = candidate;
            break;
          }
        }
        monthsFromRef += interval;
      }
      break;
    }
    case 'yearly': {
      const ref = parseCivil(reference);
      const months = rule.byMonth?.length ? [...rule.byMonth].sort((a, b) => a - b) : [ref.m];
      let year = parseCivil(after).y;
      const mod = (((year - ref.y) % interval) + interval) % interval;
      if (mod !== 0) year += interval - mod;
      for (let guard = 0; guard < 200 && !result; guard++) {
        for (const m of months) {
          for (const d of daysInMonthForRule(rule, year, m, ref.d)) {
            const candidate = formatCivil(year, m, d);
            if (compareCivil(candidate, after) > 0) {
              result = candidate;
              break;
            }
          }
          if (result) break;
        }
        year += interval;
      }
      break;
    }
  }

  if (result && rule.until && compareCivil(result, rule.until) > 0) return null;
  return result;
}

/** Does `date` itself satisfy the rule's pattern (ignoring interval alignment)? */
export function matchesPattern(rule: Recurrence, date: CivilDate): boolean {
  const { y, m, d } = parseCivil(date);
  switch (rule.freq) {
    case 'daily':
      return true;
    case 'weekly':
      return !rule.byWeekday?.length || rule.byWeekday.includes(WEEKDAYS[isoWeekday(date)]!);
    case 'monthly':
      return !(rule.byMonthDay?.length || rule.byNthWeekday) || daysInMonthForRule(rule, y, m, d).includes(d);
    case 'yearly':
      return (!rule.byMonth?.length || rule.byMonth.includes(m)) && daysInMonthForRule(rule, y, m, d).includes(d);
  }
}

/**
 * Pin implicit parts of a rule to the date it starts on, so clamped months don't drift
 * (monthly from Jan 31 stays "on the 31st" instead of becoming "on the 28th" after February).
 */
export function normalizeRecurrence(rule: Recurrence, start: CivilDate): Recurrence {
  const { m, d } = parseCivil(start);
  const out: Recurrence = { ...rule, interval: Math.max(1, rule.interval ?? 1) };
  if (out.freq === 'monthly' && !out.byMonthDay?.length && !out.byNthWeekday) out.byMonthDay = [d];
  if (out.freq === 'yearly') {
    if (!out.byMonth?.length) out.byMonth = [m];
    if (!out.byMonthDay?.length && !out.byNthWeekday) out.byMonthDay = [d];
  }
  if (out.freq === 'weekly' && !out.byWeekday?.length) out.byWeekday = [WEEKDAYS[isoWeekday(start)]!];
  if (!out.until) delete out.until;
  if (!out.count) delete out.count;
  return out;
}

/** First occurrence on or after `from` — used to pick the initial due date for a new rule. */
export function firstOccurrence(rule: Recurrence, from: CivilDate): CivilDate {
  if (matchesPattern(rule, from)) return from;
  return nextOccurrence(rule, from, from) ?? from;
}

export interface AdvanceResult {
  /** Next due date, or null when the series has ended (task should simply complete). */
  nextDueDate: CivilDate | null;
  occurrenceCount: number;
}

/**
 * Advance a recurring task after completing (or skipping) its current occurrence.
 * `anchor: 'schedule'` moves to the next slot after the *scheduled* date, but never into the
 * past: if the task was overdue, it jumps to the first slot after today.
 */
export function advanceRecurrence(
  rule: Recurrence,
  current: CivilDate,
  today: CivilDate,
  occurrenceCount: number,
  completedOn: CivilDate = today,
): AdvanceResult {
  const count = occurrenceCount + 1;
  if (rule.count && count >= rule.count) return { nextDueDate: null, occurrenceCount: count };
  let next: CivilDate | null;
  if (rule.anchor === 'completion') {
    next = nextOccurrence(rule, completedOn, completedOn);
  } else {
    // Completing an overdue occurrence counts as doing today's: the next one is after today.
    const after = compareCivil(current, today) < 0 ? today : current;
    next = nextOccurrence(rule, current, after);
  }
  return { nextDueDate: next, occurrenceCount: count };
}

const DAY_NAMES: Record<Weekday, string> = {
  MO: 'Monday',
  TU: 'Tuesday',
  WE: 'Wednesday',
  TH: 'Thursday',
  FR: 'Friday',
  SA: 'Saturday',
  SU: 'Sunday',
};
const ORDINAL = (n: number) =>
  n === -1 ? 'last' : n === 1 ? '1st' : n === 2 ? '2nd' : n === 3 ? '3rd' : `${n}th`;
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

function joinWords(words: string[]): string {
  if (words.length <= 1) return words.join('');
  return `${words.slice(0, -1).join(', ')} and ${words.at(-1)}`;
}

/** Human description, e.g. "Every 2 weeks on Monday and Thursday". */
export function describeRecurrence(rule: Recurrence): string {
  const n = rule.interval ?? 1;
  let text: string;
  switch (rule.freq) {
    case 'daily':
      text = n === 1 ? 'Every day' : `Every ${n} days`;
      break;
    case 'weekly': {
      const days = rule.byWeekday ?? [];
      const set = new Set(days);
      const weekdays = ['MO', 'TU', 'WE', 'TH', 'FR'] as const;
      if (n === 1 && set.size === 5 && weekdays.every((d) => set.has(d))) {
        text = 'Every weekday';
      } else if (n === 1 && set.size === 7) {
        text = 'Every day';
      } else {
        text = n === 1 ? 'Every week' : `Every ${n} weeks`;
        if (days.length) {
          const ordered = WEEKDAYS.filter((d) => set.has(d)).map((d) => DAY_NAMES[d]);
          text = n === 1 ? `Every ${joinWords(ordered)}` : `${text} on ${joinWords(ordered)}`;
        }
      }
      break;
    }
    case 'monthly':
      text = n === 1 ? 'Every month' : `Every ${n} months`;
      if (rule.byNthWeekday)
        text += ` on the ${ORDINAL(rule.byNthWeekday.nth)} ${DAY_NAMES[rule.byNthWeekday.weekday]}`;
      else if (rule.byMonthDay?.length)
        text += ` on the ${joinWords(rule.byMonthDay.map((d) => (d === -1 ? 'last day' : ORDINAL(d))))}`;
      break;
    case 'yearly':
      text = n === 1 ? 'Every year' : `Every ${n} years`;
      if (rule.byMonth?.length) text += ` in ${joinWords(rule.byMonth.map((m) => MONTHS[m - 1]!))}`;
      break;
  }
  if (rule.anchor === 'completion') text += ' after completion';
  if (rule.until) text += ` until ${rule.until}`;
  if (rule.count) text += `, ${rule.count} times`;
  return text;
}

/** RFC 5545 RRULE for interoperability (calendar export, imports). */
export function toRRule(rule: Recurrence): string {
  const parts = [`FREQ=${rule.freq.toUpperCase()}`];
  if ((rule.interval ?? 1) > 1) parts.push(`INTERVAL=${rule.interval}`);
  if (rule.byWeekday?.length) parts.push(`BYDAY=${rule.byWeekday.join(',')}`);
  if (rule.byNthWeekday) parts.push(`BYDAY=${rule.byNthWeekday.nth}${rule.byNthWeekday.weekday}`);
  if (rule.byMonthDay?.length) parts.push(`BYMONTHDAY=${rule.byMonthDay.join(',')}`);
  if (rule.byMonth?.length) parts.push(`BYMONTH=${rule.byMonth.join(',')}`);
  if (rule.until) parts.push(`UNTIL=${rule.until.replace(/-/g, '')}`);
  if (rule.count) parts.push(`COUNT=${rule.count}`);
  return `RRULE:${parts.join(';')}`;
}

/** Parse a subset of RRULE (what calendars and importers produce) into our rule model. */
export function fromRRule(input: string): Recurrence | null {
  const body = input.replace(/^RRULE:/i, '').trim();
  const map = new Map<string, string>();
  for (const part of body.split(';')) {
    const [k, v] = part.split('=');
    if (k && v) map.set(k.toUpperCase(), v.toUpperCase());
  }
  const freq = map.get('FREQ')?.toLowerCase();
  if (freq !== 'daily' && freq !== 'weekly' && freq !== 'monthly' && freq !== 'yearly') return null;
  const rule: Recurrence = { freq, interval: Number(map.get('INTERVAL') ?? 1) || 1, anchor: 'schedule' };
  const byday = map.get('BYDAY');
  if (byday) {
    const nth = byday.match(/^([+-]?\d)(MO|TU|WE|TH|FR|SA|SU)$/);
    if (nth) rule.byNthWeekday = { nth: Number(nth[1]), weekday: nth[2] as Weekday };
    else rule.byWeekday = byday.split(',').filter((d): d is Weekday => (WEEKDAYS as readonly string[]).includes(d));
  }
  const bmd = map.get('BYMONTHDAY');
  if (bmd) rule.byMonthDay = bmd.split(',').map(Number).filter((n) => Number.isInteger(n) && n !== 0);
  const bm = map.get('BYMONTH');
  if (bm) rule.byMonth = bm.split(',').map(Number).filter((n) => n >= 1 && n <= 12);
  const until = map.get('UNTIL');
  if (until && /^\d{8}/.test(until)) rule.until = `${until.slice(0, 4)}-${until.slice(4, 6)}-${until.slice(6, 8)}`;
  const count = map.get('COUNT');
  if (count) rule.count = Number(count);
  return rule;
}
