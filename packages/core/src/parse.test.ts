import { describe, expect, it } from 'vitest';
import { parseTaskInput } from './parse';

// Tuesday 2026-09-22 08:30 in New York (12:30 UTC).
const now = new Date('2026-09-22T12:30:00Z');
const timeZone = 'America/New_York';
const members = [
  { userId: 'u-alex', displayName: 'Alex Kim', email: 'alex@example.com' },
  { userId: 'u-sam', displayName: 'Sam Rivera' },
  { userId: 'u-samantha', displayName: 'Samantha Lee' },
];
const labels = [{ id: 'l-fin', name: 'finance' }];
const parse = (text: string) => parseTaskInput(text, { timeZone, now, members, labels });

describe('parseTaskInput', () => {
  it('tomorrow at 9am', () => {
    const p = parse('Send invoice tomorrow at 9am');
    expect(p).toMatchObject({ title: 'Send invoice', dueDate: '2026-09-23', dueTime: '09:00', recurrence: null });
  });

  it('next Friday', () => {
    const p = parse('Call mom next Friday');
    expect(p.title).toBe('Call mom');
    expect(p.dueDate).toBe('2026-10-02');
    expect(p.dueTime).toBeNull();
  });

  it('this Friday via bare weekday', () => {
    expect(parse('Call mom friday').dueDate).toBe('2026-09-25');
  });

  it('every month', () => {
    const p = parse('Pay rent every month');
    expect(p.title).toBe('Pay rent');
    expect(p.recurrence).toMatchObject({ freq: 'monthly', interval: 1 });
    expect(p.dueDate).toBe('2026-09-22');
  });

  it('every Monday and Thursday with first due date on the next matching day', () => {
    const p = parse('Workout every Monday and Thursday');
    expect(p.title).toBe('Workout');
    expect(p.recurrence).toMatchObject({ freq: 'weekly', byWeekday: ['MO', 'TH'] });
    expect(p.dueDate).toBe('2026-09-24');
  });

  it('recurrence with a time', () => {
    const p = parse('Workout every Monday and Thursday at 7am');
    expect(p.title).toBe('Workout');
    expect(p.dueDate).toBe('2026-09-24');
    expect(p.dueTime).toBe('07:00');
  });

  it('every weekday except Friday', () => {
    const p = parse('Standup every weekday except friday');
    expect(p.title).toBe('Standup');
    expect(p.recurrence?.byWeekday).toEqual(['MO', 'TU', 'WE', 'TH']);
  });

  it('every 2 weeks, every other week, first day of each month', () => {
    expect(parse('Payroll every 2 weeks').recurrence).toMatchObject({ freq: 'weekly', interval: 2 });
    expect(parse('Clean fridge every other week').recurrence).toMatchObject({ freq: 'weekly', interval: 2 });
    const p = parse('Review budget on the first day of each month');
    expect(p.recurrence).toMatchObject({ freq: 'monthly', byMonthDay: [1] });
    expect(p.dueDate).toBe('2026-10-01');
    expect(p.title).toBe('Review budget');
  });

  it('every first Monday, daily, yearly', () => {
    expect(parse('Board meeting every first monday').recurrence).toMatchObject({ byNthWeekday: { weekday: 'MO', nth: 1 } });
    expect(parse('Journal daily').recurrence).toMatchObject({ freq: 'daily' });
    expect(parse('Renew passport yearly').recurrence).toMatchObject({ freq: 'yearly' });
  });

  it('recurrence bounds', () => {
    expect(parse('Take pills daily for 10 times').recurrence).toMatchObject({ freq: 'daily', count: 10 });
    expect(parse('Water plants every day until Oct 31').recurrence).toMatchObject({ until: '2026-10-31' });
  });

  it('date with #label', () => {
    const p = parse('Review budget Sep 30 #finance');
    expect(p).toMatchObject({ title: 'Review budget', dueDate: '2026-09-30', labelIds: ['l-fin'], newLabelNames: [] });
  });

  it('unknown labels are proposed', () => {
    expect(parse('Plan offsite #team-events').newLabelNames).toEqual(['team-events']);
  });

  it('@assignee', () => {
    const p = parse('Send report tomorrow @Alex');
    expect(p).toMatchObject({ title: 'Send report', dueDate: '2026-09-23', assigneeId: 'u-alex' });
  });

  it('ambiguous @assignee is not guessed', () => {
    const p = parse('Draft copy @sa');
    expect(p.assigneeId).toBeNull();
    expect(p.ambiguousAssignee).toBe('sa');
  });

  it('exact first-name wins over prefix matches', () => {
    expect(parse('Draft copy @sam').assigneeId).toBe('u-sam');
  });

  it('does not treat bare numbers as dates', () => {
    const p = parse('Read 1984');
    expect(p.title).toBe('Read 1984');
    expect(p.dueDate).toBeNull();
  });

  it('time already passed today means tomorrow', () => {
    const p = parse('Call the bank at 7am');
    expect(p.dueDate).toBe('2026-09-23');
    expect(p.dueTime).toBe('07:00');
    expect(p.title).toBe('Call the bank');
  });

  it('respects the user timezone for "today"', () => {
    // 02:00 UTC on the 23rd is still the 22nd in Los Angeles.
    const p = parseTaskInput('Ship it today', { timeZone: 'America/Los_Angeles', now: new Date('2026-09-23T02:00:00Z') });
    expect(p.dueDate).toBe('2026-09-22');
  });

  it('returns highlight spans', () => {
    const p = parse('Send report tomorrow @Alex #finance');
    expect(p.spans.map((s) => s.kind)).toEqual(['date', 'assignee', 'label']);
  });

  it('can disable date parsing', () => {
    expect(parseTaskInput('Watch Friday Night Lights', { timeZone, now, dates: false }).title).toBe('Watch Friday Night Lights');
  });
});
