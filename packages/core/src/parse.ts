import * as chrono from 'chrono-node';
import { WEEKDAYS, type Recurrence, type Weekday } from '@orbit/shared';
import { formatCivil, todayIn, wallTimeIn, type CivilDate } from './dates';
import { firstOccurrence, normalizeRecurrence } from './recurrence';

/**
 * Natural-language quick-add parser: "Send report tomorrow at 9am #work @alex every monday".
 * Extracts date/time (chrono), recurrence (own grammar), #labels and @assignee, and returns the
 * cleaned title plus character spans so the input can highlight what was understood.
 */

export interface ParseMember {
  userId: string;
  displayName: string;
  email?: string | null;
}
export interface ParseLabel {
  id: string;
  name: string;
}

export type SpanKind = 'date' | 'recurrence' | 'label' | 'assignee';
export interface ParsedSpan {
  start: number;
  end: number;
  kind: SpanKind;
  text: string;
}

export interface ParsedTask {
  title: string;
  dueDate: CivilDate | null;
  dueTime: string | null;
  recurrence: Recurrence | null;
  labelIds: string[];
  newLabelNames: string[];
  assigneeId: string | null;
  /** @mentions that matched several members — the UI should ask. */
  ambiguousAssignee: string | null;
  spans: ParsedSpan[];
}

export interface ParseOptions {
  timeZone: string;
  now?: Date;
  members?: ParseMember[];
  labels?: ParseLabel[];
  /** Disable date extraction (e.g. user escaped with quotes). */
  dates?: boolean;
}

const DAY_WORDS: Record<string, Weekday> = {
  monday: 'MO', mon: 'MO', mondays: 'MO',
  tuesday: 'TU', tue: 'TU', tues: 'TU', tuesdays: 'TU',
  wednesday: 'WE', wed: 'WE', wednesdays: 'WE',
  thursday: 'TH', thu: 'TH', thur: 'TH', thurs: 'TH', thursdays: 'TH',
  friday: 'FR', fri: 'FR', fridays: 'FR',
  saturday: 'SA', sat: 'SA', saturdays: 'SA',
  sunday: 'SU', sun: 'SU', sundays: 'SU',
};
const DAY_ALT = Object.keys(DAY_WORDS).sort((a, b) => b.length - a.length).join('|');
const ORD_WORDS: Record<string, number> = {
  first: 1, '1st': 1, second: 2, '2nd': 2, third: 3, '3rd': 3, fourth: 4, '4th': 4, last: -1,
};
const UNIT: Record<string, Recurrence['freq']> = {
  day: 'daily', days: 'daily', week: 'weekly', weeks: 'weekly', month: 'monthly', months: 'monthly',
  year: 'yearly', years: 'yearly',
};
const NUMBER_WORDS: Record<string, number> = { other: 2, two: 2, three: 3, four: 4, five: 5, six: 6 };

interface RecurrenceMatch {
  rule: Recurrence;
  start: number;
  end: number;
}

function sortDays(days: Iterable<Weekday>): Weekday[] {
  const set = new Set(days);
  return WEEKDAYS.filter((d) => set.has(d));
}

function matchRecurrence(text: string): RecurrenceMatch | null {
  const lower = text.toLowerCase();
  const tryMatch = (re: RegExp, build: (m: RegExpExecArray) => Recurrence | null): RecurrenceMatch | null => {
    const m = re.exec(lower);
    if (!m) return null;
    const rule = build(m);
    return rule ? { rule, start: m.index, end: m.index + m[0].length } : null;
  };
  const base = { anchor: 'schedule' as const, interval: 1 };

  return (
    // every weekday except friday / every weekday
    tryMatch(new RegExp(`\\bevery\\s+week\\s*days?(?:\\s+(?:except|but(?: not)?)\\s+((?:${DAY_ALT})(?:\\s*(?:,|and|&|or)\\s*(?:${DAY_ALT}))*))?\\b`), (m) => {
      const excluded = new Set((m[1] ?? '').split(/\s*(?:,|and|&|or)\s*/).map((w) => DAY_WORDS[w.trim()]).filter(Boolean));
      return { ...base, freq: 'weekly', byWeekday: (['MO', 'TU', 'WE', 'TH', 'FR'] as Weekday[]).filter((d) => !excluded.has(d)) };
    }) ??
    tryMatch(/\bevery\s+weekend\b/, () => ({ ...base, freq: 'weekly', byWeekday: ['SA', 'SU'] })) ??
    // every (other|2nd) monday and thursday
    tryMatch(new RegExp(`\\bevery\\s+(?:(other|\\d+)(?:st|nd|rd|th)?\\s+(?:week\\s+on\\s+)?)?((?:${DAY_ALT})(?:\\s*(?:,|and|&)\\s*(?:${DAY_ALT}))*)\\b`), (m) => {
      const days = m[2]!.split(/\s*(?:,|and|&)\s*/).map((w) => DAY_WORDS[w.trim()]).filter((d): d is Weekday => Boolean(d));
      const interval = m[1] ? (m[1] === 'other' ? 2 : Number(m[1])) : 1;
      return days.length ? { ...base, freq: 'weekly', interval, byWeekday: sortDays(days) } : null;
    }) ??
    // every first monday (of the month)
    tryMatch(new RegExp(`\\bevery\\s+(first|second|third|fourth|last|1st|2nd|3rd|4th)\\s+(${DAY_ALT})(?:\\s+of\\s+(?:the|each|every)\\s+month)?\\b`), (m) => ({
      ...base, freq: 'monthly', byNthWeekday: { nth: ORD_WORDS[m[1]!]!, weekday: DAY_WORDS[m[2]!]! },
    })) ??
    // first day of each month / every 15th (of the month) / last day of the month
    tryMatch(/\b(?:(?:on\s+)?the\s+|every\s+)?(first|last|\d{1,2}(?:st|nd|rd|th))\s+(?:day\s+)?of\s+(?:the|each|every)\s+month\b/, (m) => {
      const token = m[1]!;
      const day = token === 'first' ? 1 : token === 'last' ? -1 : parseInt(token, 10);
      return day === -1 || (day >= 1 && day <= 31) ? { ...base, freq: 'monthly', byMonthDay: [day] } : null;
    }) ??
    tryMatch(/\bevery\s+(\d{1,2})(?:st|nd|rd|th)\b/, (m) => {
      const day = Number(m[1]);
      return day >= 1 && day <= 31 ? { ...base, freq: 'monthly', byMonthDay: [day] } : null;
    }) ??
    // every 3 days / every other week / every two months
    tryMatch(/\bevery\s+(\d+|other|two|three|four|five|six)\s+(days?|weeks?|months?|years?)\b/, (m) => {
      const n = /^\d+$/.test(m[1]!) ? Number(m[1]) : NUMBER_WORDS[m[1]!]!;
      return n >= 1 ? { ...base, freq: UNIT[m[2]!]!, interval: n } : null;
    }) ??
    tryMatch(/\bevery\s+(day|week|month|year)\b/, (m) => ({ ...base, freq: UNIT[m[1]!]! })) ??
    tryMatch(/\b(daily|weekly|monthly|yearly|annually)\b/, (m) => ({
      ...base,
      freq: m[1] === 'annually' ? 'yearly' : (m[1] as Recurrence['freq']),
    })) ??
    null
  );
}

/** Extend a recurrence match with "until <date>" or "for N times" suffixes. */
function matchRecurrenceBounds(text: string, from: number, rule: Recurrence, ref: chrono.ParsingReference) {
  const rest = text.slice(from);
  const times = /^\s*(?:for\s+)?(\d{1,4})\s+times\b/i.exec(rest);
  if (times) {
    rule.count = Number(times[1]);
    return from + times[0].length;
  }
  const until = /^\s*until\s+/i.exec(rest);
  if (until) {
    const results = chrono.parse(rest.slice(until[0].length), ref, { forwardDate: true });
    const first = results[0];
    if (first && first.index === 0) {
      const s = first.start;
      rule.until = formatCivil(s.get('year')!, s.get('month')!, s.get('day')!);
      return from + until[0].length + first.text.length;
    }
  }
  return from;
}

function cleanTitle(text: string, spans: ParsedSpan[]): string {
  let out = '';
  let cursor = 0;
  for (const span of [...spans].sort((a, b) => a.start - b.start)) {
    if (span.start < cursor) continue;
    out += text.slice(cursor, span.start) + ' ';
    cursor = span.end;
  }
  out += text.slice(cursor);
  return out
    .replace(/\s+/g, ' ')
    .replace(/\s+([,.;:!?])/g, '$1')
    .replace(/(?:\s+(?:on|at|by|due|from|starting|for|in))+\s*$/i, '')
    .replace(/^\s*(?:on|at|by|due)\s+/i, '')
    .replace(/[\s,;:-]+$/, '')
    .trim();
}

function isBareNumber(text: string) {
  return /^\s*\d{1,4}\s*$/.test(text);
}

export function parseTaskInput(input: string, options: ParseOptions): ParsedTask {
  const now = options.now ?? new Date();
  const tz = options.timeZone;
  const spans: ParsedSpan[] = [];
  const ref: chrono.ParsingReference = { instant: now, timezone: tz };
  const mask = (start: number, end: number) => {
    working = working.slice(0, start) + ' '.repeat(end - start) + working.slice(end);
  };
  let working = input;

  // Labels
  const labelIds: string[] = [];
  const newLabelNames: string[] = [];
  for (const m of input.matchAll(/(^|\s)#([\p{L}\p{N}_-]{1,40})/gu)) {
    const start = m.index! + m[1]!.length;
    const name = m[2]!;
    const existing = options.labels?.find((l) => l.name.toLowerCase() === name.toLowerCase());
    if (existing) {
      if (!labelIds.includes(existing.id)) labelIds.push(existing.id);
    } else if (!newLabelNames.some((n) => n.toLowerCase() === name.toLowerCase())) {
      newLabelNames.push(name);
    }
    spans.push({ start, end: start + name.length + 1, kind: 'label', text: `#${name}` });
    mask(start, start + name.length + 1);
  }

  // Assignee
  let assigneeId: string | null = null;
  let ambiguousAssignee: string | null = null;
  if (options.members?.length) {
    for (const m of input.matchAll(/(^|\s)@([\p{L}\p{N}._-]{1,40})/gu)) {
      const start = m.index! + m[1]!.length;
      const handle = m[2]!.toLowerCase();
      const candidates = options.members.filter((mem) => {
        const name = mem.displayName.toLowerCase();
        const first = name.split(/\s+/)[0] ?? '';
        const emailLocal = mem.email?.split('@')[0]?.toLowerCase();
        return name.replace(/\s+/g, '') === handle || first === handle || emailLocal === handle || name.startsWith(handle);
      });
      const exact = candidates.filter((c) => c.displayName.toLowerCase().split(/\s+/)[0] === handle);
      const pick = candidates.length === 1 ? candidates[0] : exact.length === 1 ? exact[0] : undefined;
      if (pick && !assigneeId) {
        assigneeId = pick.userId;
        spans.push({ start, end: start + handle.length + 1, kind: 'assignee', text: `@${m[2]}` });
        mask(start, start + handle.length + 1);
      } else if (candidates.length > 1 && !assigneeId) {
        ambiguousAssignee = m[2]!;
      }
    }
  }

  // Recurrence
  let recurrence: Recurrence | null = null;
  if (options.dates !== false) {
    const rec = matchRecurrence(working);
    if (rec) {
      recurrence = rec.rule;
      const end = matchRecurrenceBounds(working, rec.end, rec.rule, ref);
      // Swallow a leading "on"/"repeat" connector.
      let start = rec.start;
      const before = working.slice(0, start);
      const connector = /(?:\s(?:on|repeat(?:s|ing)?))\s*$/i.exec(before);
      if (connector) start = connector.index;
      spans.push({ start, end, kind: 'recurrence', text: input.slice(start, end) });
      mask(start, end);
    }
  }

  // Date / time
  let dueDate: CivilDate | null = null;
  let dueTime: string | null = null;
  if (options.dates !== false) {
    const results = chrono.parse(working, ref, { forwardDate: true }).filter((r) => !isBareNumber(r.text));
    const result = results[0];
    if (result) {
      const s = result.start;
      const date = s.date();
      dueDate = civilFrom(s, date, tz);
      if (s.isCertain('hour')) dueTime = wallTimeIn(date, tz);
      let start = result.index;
      const connector = /(?:\s(?:on|at|by|due))\s*$/i.exec(working.slice(0, start));
      if (connector) start = connector.index;
      spans.push({ start, end: result.index + result.text.length, kind: 'date', text: input.slice(start, result.index + result.text.length) });
      // Only a time was given ("at 7am") with no explicit day: chrono implies today.
      const dayGiven = s.isCertain('day') || s.isCertain('weekday') || s.isCertain('month');
      if (!dayGiven && recurrence) dueDate = null;
      if (!dayGiven && !recurrence && dueTime) {
        // "call at 7am" when it's already 9am means tomorrow.
        const today = todayIn(tz, now);
        if (dueDate === today && date.getTime() < now.getTime()) dueDate = civilFrom(s, new Date(date.getTime() + 86_400_000), tz);
      }
    }
  }

  if (recurrence && !dueDate) dueDate = firstOccurrence(recurrence, todayIn(tz, now));
  if (recurrence && dueDate) recurrence = normalizeRecurrence(recurrence, dueDate);

  return {
    title: cleanTitle(input, spans),
    dueDate,
    dueTime,
    recurrence,
    labelIds,
    newLabelNames,
    assigneeId,
    ambiguousAssignee,
    spans: spans.sort((a, b) => a.start - b.start),
  };
}

function civilFrom(_components: chrono.ParsedComponents, instant: Date, tz: string): CivilDate {
  return todayIn(tz, instant);
}
