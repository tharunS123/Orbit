/**
 * Calendar-date and timezone helpers. Due dates are stored as a civil date (+ optional wall-clock
 * time + IANA zone), so all-day tasks never drift across zones and recurrence math is done on
 * civil dates, which makes it immune to DST transitions.
 */

export type CivilDate = string; // YYYY-MM-DD
export type WallTime = string; // HH:MM or HH:MM:SS

const pad = (n: number, w = 2) => String(n).padStart(w, '0');

export function parseCivil(date: CivilDate): { y: number; m: number; d: number } {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  return { y, m, d };
}

export function formatCivil(y: number, m: number, d: number): CivilDate {
  return `${pad(y, 4)}-${pad(m)}-${pad(d)}`;
}

/** Civil date → UTC-midnight epoch day number (days since 1970-01-01). */
export function toEpochDay(date: CivilDate): number {
  const { y, m, d } = parseCivil(date);
  return Math.floor(Date.UTC(y, m - 1, d) / 86_400_000);
}

export function fromEpochDay(day: number): CivilDate {
  const dt = new Date(day * 86_400_000);
  return formatCivil(dt.getUTCFullYear(), dt.getUTCMonth() + 1, dt.getUTCDate());
}

export function addDays(date: CivilDate, days: number): CivilDate {
  return fromEpochDay(toEpochDay(date) + days);
}

export function daysInMonth(y: number, m: number): number {
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

/** Add months, clamping the day to the target month's length (Jan 31 + 1 month = Feb 28/29). */
export function addMonths(date: CivilDate, months: number): CivilDate {
  const { y, m, d } = parseCivil(date);
  const total = y * 12 + (m - 1) + months;
  const ny = Math.floor(total / 12);
  const nm = (total % 12) + 1;
  return formatCivil(ny, nm, Math.min(d, daysInMonth(ny, nm)));
}

/** 0 = Monday … 6 = Sunday (ISO order, matching WEEKDAYS). */
export function isoWeekday(date: CivilDate): number {
  const dow = new Date(toEpochDay(date) * 86_400_000).getUTCDay(); // 0 = Sunday
  return (dow + 6) % 7;
}

export function startOfIsoWeek(date: CivilDate): CivilDate {
  return addDays(date, -isoWeekday(date));
}

export function compareCivil(a: CivilDate, b: CivilDate): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function diffDays(a: CivilDate, b: CivilDate): number {
  return toEpochDay(a) - toEpochDay(b);
}

function partsInZone(instant: Date, timeZone: string) {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  const out: Record<string, number> = {};
  for (const p of fmt.formatToParts(instant)) if (p.type !== 'literal') out[p.type] = Number(p.value);
  return out as { year: number; month: number; day: number; hour: number; minute: number; second: number };
}

/** The civil date "today" in the given zone. */
export function todayIn(timeZone: string, now: Date = new Date()): CivilDate {
  const p = partsInZone(now, timeZone);
  return formatCivil(p.year, p.month, p.day);
}

/** Wall-clock time (HH:MM) of an instant in the given zone. */
export function wallTimeIn(instant: Date, timeZone: string): WallTime {
  const p = partsInZone(instant, timeZone);
  return `${pad(p.hour)}:${pad(p.minute)}`;
}

export function civilDateOf(instant: Date, timeZone: string): CivilDate {
  const p = partsInZone(instant, timeZone);
  return formatCivil(p.year, p.month, p.day);
}

/** Offset (ms) of `timeZone` from UTC at `instant`. */
export function zoneOffsetMs(instant: Date, timeZone: string): number {
  const p = partsInZone(instant, timeZone);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUtc - Math.floor(instant.getTime() / 1000) * 1000;
}

/**
 * Convert civil date + wall time in `timeZone` to a UTC instant. Times inside a DST gap move
 * forward by the gap (02:30 on spring-forward day → 03:30); ambiguous times resolve to the
 * earlier instant.
 */
export function zonedToUtc(date: CivilDate, time: WallTime, timeZone: string): Date {
  const { y, m, d } = parseCivil(date);
  const [hh, mm, ss] = time.split(':').map(Number) as [number, number, number | undefined];
  const naive = Date.UTC(y, m - 1, d, hh, mm, ss ?? 0);
  const off = (t: number) => zoneOffsetMs(new Date(t), timeZone);
  const o1 = off(naive);
  const t1 = naive - o1;
  const o2 = off(t1);
  let result: number;
  if (o1 === o2) {
    result = t1;
  } else {
    const t2 = naive - o2;
    // Offsets disagree on both sides: the wall time falls in a DST gap. Using the pre-transition
    // offset lands after the gap (02:30 → 03:30), which is what users expect.
    result = off(t2) === o2 ? t2 : Math.max(t1, t2);
  }
  // Ambiguous (fall back): prefer the earlier instant if it maps to the same wall time.
  const earlier = result - 3_600_000;
  const pe = partsInZone(new Date(earlier), timeZone);
  if (pe.hour === hh && pe.minute === mm && pe.day === d) return new Date(earlier);
  return new Date(result);
}

export function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/**
 * The instant a task is due: timed tasks use their own zone; all-day tasks are due at the end
 * of the day in the viewer's zone (used only for overdue checks, never stored).
 */
export function dueInstant(
  task: { dueDate: string | null; dueTime: string | null; dueTz: string | null },
  viewerTz: string,
): Date | null {
  if (!task.dueDate) return null;
  if (task.dueTime) return zonedToUtc(task.dueDate, task.dueTime, task.dueTz ?? viewerTz);
  return zonedToUtc(addDays(task.dueDate, 1), '00:00', viewerTz);
}

export type DueBucket = 'overdue' | 'today' | 'tomorrow' | 'this_week' | 'later' | 'none';

export function dueBucket(
  task: { dueDate: string | null; dueTime: string | null; dueTz: string | null },
  viewerTz: string,
  now: Date = new Date(),
): DueBucket {
  if (!task.dueDate) return 'none';
  const today = todayIn(viewerTz, now);
  // Timed tasks are overdue once their instant passes; all-day tasks once their day passes.
  if (task.dueTime) {
    const at = zonedToUtc(task.dueDate, task.dueTime, task.dueTz ?? viewerTz);
    const localDate = civilDateOf(at, viewerTz);
    if (at.getTime() < now.getTime() && localDate <= today) return 'overdue';
    return bucketForDate(localDate, today);
  }
  if (task.dueDate < today) return 'overdue';
  return bucketForDate(task.dueDate, today);
}

function bucketForDate(date: CivilDate, today: CivilDate): DueBucket {
  const diff = diffDays(date, today);
  if (diff <= 0) return 'today';
  if (diff === 1) return 'tomorrow';
  if (diff < 7) return 'this_week';
  return 'later';
}

const WEEKDAY_NAMES = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
const MONTH_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** Short, friendly label like "Today", "Tomorrow 9:00", "Fri", "Sep 30", "Sep 30, 2027". */
export function formatDueLabel(
  task: { dueDate: string | null; dueTime: string | null; dueTz: string | null },
  viewerTz: string,
  now: Date = new Date(),
  opts: { hour12?: boolean } = {},
): string {
  if (!task.dueDate) return '';
  let date = task.dueDate;
  let time: string | null = null;
  if (task.dueTime) {
    const at = zonedToUtc(task.dueDate, task.dueTime, task.dueTz ?? viewerTz);
    date = civilDateOf(at, viewerTz);
    time = formatWallTime(wallTimeIn(at, viewerTz), opts.hour12);
  }
  const today = todayIn(viewerTz, now);
  const diff = diffDays(date, today);
  let label: string;
  if (diff === 0) label = 'Today';
  else if (diff === 1) label = 'Tomorrow';
  else if (diff === -1) label = 'Yesterday';
  else if (diff > 1 && diff < 7) label = WEEKDAY_NAMES[isoWeekday(date)]!.slice(0, 3);
  else {
    const { y, m, d } = parseCivil(date);
    label = `${MONTH_SHORT[m - 1]} ${d}`;
    if (y !== parseCivil(today).y) label += `, ${y}`;
  }
  return time ? `${label} ${time}` : label;
}

export function formatWallTime(time: WallTime, hour12 = false): string {
  const [h, m] = time.split(':').map(Number) as [number, number];
  if (!hour12) return `${pad(h)}:${pad(m)}`;
  const suffix = h >= 12 ? 'pm' : 'am';
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return m === 0 ? `${h12}${suffix}` : `${h12}:${pad(m)}${suffix}`;
}

export function formatCivilLong(date: CivilDate): string {
  const { y, m, d } = parseCivil(date);
  return `${WEEKDAY_NAMES[isoWeekday(date)]}, ${MONTH_SHORT[m - 1]} ${d}, ${y}`;
}
