import { formatDueLabel } from '@orbit/core';

/** Whether the user's locale shows 12-hour clock times (resolved once from Intl). */
let hour12: boolean | undefined;
export function prefersHour12(): boolean {
  if (hour12 === undefined) {
    try {
      const cycle = new Intl.DateTimeFormat(undefined, { hour: 'numeric' }).resolvedOptions().hourCycle;
      hour12 = cycle === 'h11' || cycle === 'h12';
    } catch {
      hour12 = false;
    }
  }
  return hour12;
}

/** Due label in the viewer's zone and clock style — the one formatter every surface uses. */
export function dueLabel(task: Parameters<typeof formatDueLabel>[0], timeZone: string, now: Date = new Date()): string {
  return formatDueLabel(task, timeZone, now, { hour12: prefersHour12() });
}
