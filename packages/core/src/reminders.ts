import type { Reminder } from '@orbit/shared';
import { zonedToUtc } from './dates';

/**
 * When each of a task's reminders fires for a given recipient.
 *
 * - Absolute reminders fire at their instant.
 * - Relative reminders on timed tasks fire `offsetMinutes` before the due instant (in the task's
 *   own zone, falling back to the recipient's).
 * - Relative reminders on all-day tasks fire relative to the recipient's default reminder time
 *   on the due date, in the recipient's zone ("0 minutes" = 09:00 on the day by default).
 */
export interface ReminderTask {
  dueDate: string | null;
  dueTime: string | null;
  dueTz: string | null;
  reminders: Reminder[];
}

export interface ReminderFire {
  reminderId: string;
  fireAt: Date;
}

export function reminderFireTimes(task: ReminderTask, recipient: { timeZone: string; defaultReminderTime: string }): ReminderFire[] {
  const out: ReminderFire[] = [];
  for (const r of task.reminders) {
    if (r.kind === 'absolute') {
      const at = new Date(r.at);
      if (!Number.isNaN(at.getTime())) out.push({ reminderId: r.id, fireAt: at });
      continue;
    }
    if (!task.dueDate) continue;
    const anchor = task.dueTime
      ? zonedToUtc(task.dueDate, task.dueTime, task.dueTz ?? recipient.timeZone)
      : zonedToUtc(task.dueDate, recipient.defaultReminderTime, recipient.timeZone);
    out.push({ reminderId: r.id, fireAt: new Date(anchor.getTime() - r.offsetMinutes * 60_000) });
  }
  return out.sort((a, b) => a.fireAt.getTime() - b.fireAt.getTime());
}

