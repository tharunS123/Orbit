import { describe, expect, it } from 'vitest';
import { reminderFireTimes } from './reminders';

const id = (n: number) => `00000000-0000-4000-8000-00000000000${n}`;
const recipient = { timeZone: 'Europe/Berlin', defaultReminderTime: '09:00' };

describe('reminderFireTimes', () => {
  it('fires relative reminders before a timed due instant in the task zone', () => {
    const fires = reminderFireTimes(
      { dueDate: '2026-10-05', dueTime: '14:30', dueTz: 'America/New_York', reminders: [{ id: id(1), kind: 'relative', offsetMinutes: 15 }] },
      recipient,
    );
    expect(fires).toEqual([{ reminderId: id(1), fireAt: new Date('2026-10-05T18:15:00.000Z') }]);
  });

  it('uses the recipient default time for all-day tasks', () => {
    const fires = reminderFireTimes(
      { dueDate: '2026-10-05', dueTime: null, dueTz: null, reminders: [{ id: id(1), kind: 'relative', offsetMinutes: 1440 }, { id: id(2), kind: 'relative', offsetMinutes: 0 }] },
      recipient,
    );
    // 09:00 Berlin (CEST, UTC+2) = 07:00Z; one day before = previous day.
    expect(fires.map((f) => f.fireAt.toISOString())).toEqual(['2026-10-04T07:00:00.000Z', '2026-10-05T07:00:00.000Z']);
  });

  it('keeps absolute reminders and skips relative ones without a due date', () => {
    const fires = reminderFireTimes(
      { dueDate: null, dueTime: null, dueTz: null, reminders: [{ id: id(1), kind: 'relative', offsetMinutes: 5 }, { id: id(2), kind: 'absolute', at: '2026-10-01T08:00:00.000Z' }] },
      recipient,
    );
    expect(fires).toEqual([{ reminderId: id(2), fireAt: new Date('2026-10-01T08:00:00.000Z') }]);
  });
});
