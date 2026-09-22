import { describe, expect, it } from 'vitest';
import type { Task } from '@orbit/shared';
import { comparePositioned, planMove, positionBetween, positionsBetween, sortByPosition } from './ordering';
import { addMonths, dueBucket, formatDueLabel, isoWeekday, todayIn, zonedToUtc } from './dates';
import { canChangeRole, canList, canRemoveMember, canWorkspace, listAccess } from './permissions';
import { canUseIntegration, hasFeature, planForFeature, withinLimit } from './plans';
import { buildTaskTree, parseMarkdownOutline, taskTreeToMarkdown, tasksToCsv } from './markdown';

describe('ordering', () => {
  it('generates keys strictly between neighbours', () => {
    const a = positionBetween(null, null);
    const b = positionBetween(a, null);
    const mid = positionBetween(a, b);
    expect(a < mid && mid < b).toBe(true);
    const many = positionsBetween(a, b, 50);
    expect([...many].sort()).toEqual(many);
    expect(many[0]! > a && many.at(-1)! < b).toBe(true);
  });

  it('tolerates repeated inserts at the front', () => {
    let first = positionBetween(null, null);
    for (let i = 0; i < 500; i++) {
      const next = positionBetween(null, first);
      expect(next < first).toBe(true);
      first = next;
    }
  });

  it('breaks ties by id', () => {
    const items = [
      { id: 'b', position: 'a0' },
      { id: 'a', position: 'a0' },
    ];
    expect(sortByPosition(items).map((i) => i.id)).toEqual(['a', 'b']);
    expect(comparePositioned(items[0]!, items[1]!)).toBe(1);
  });

  it('plans moves with only the moved items updated', () => {
    const keys = positionsBetween(null, null, 4);
    const items = keys.map((position, i) => ({ id: `t${i}`, position }));
    const updates = planMove(items, ['t3'], 1);
    expect(updates).toHaveLength(1);
    const applied = items.map((it) => ({ ...it, ...updates.find((u) => u.id === it.id) }));
    expect(sortByPosition(applied).map((i) => i.id)).toEqual(['t0', 't3', 't1', 't2']);
  });

  it('moves several items together', () => {
    const items = positionsBetween(null, null, 5).map((position, i) => ({ id: `t${i}`, position }));
    const updates = planMove(items, ['t4', 't0'], 2);
    const applied = items.map((it) => ({ ...it, ...updates.find((u) => u.id === it.id) }));
    expect(sortByPosition(applied).map((i) => i.id)).toEqual(['t1', 't2', 't4', 't0', 't3']);
  });

  it('re-keys colliding neighbours (concurrent inserts)', () => {
    const items = [
      { id: 'a', position: 'a0' },
      { id: 'b', position: 'a1' },
      { id: 'c', position: 'a1' },
      { id: 'd', position: 'a2' },
      { id: 'x', position: 'a3' },
    ];
    const updates = planMove(items, ['x'], 2); // between b and c (equal keys)
    const applied = items.map((it) => ({ ...it, ...updates.find((u) => u.id === it.id) }));
    expect(sortByPosition(applied).map((i) => i.id)).toEqual(['a', 'b', 'x', 'c', 'd']);
  });
});

describe('dates', () => {
  it('computes today in a zone', () => {
    const instant = new Date('2026-09-23T02:00:00Z');
    expect(todayIn('America/Los_Angeles', instant)).toBe('2026-09-22');
    expect(todayIn('Asia/Tokyo', instant)).toBe('2026-09-23');
  });

  it('converts zoned wall time to UTC across DST', () => {
    expect(zonedToUtc('2026-01-15', '09:00', 'America/New_York').toISOString()).toBe('2026-01-15T14:00:00.000Z');
    expect(zonedToUtc('2026-07-15', '09:00', 'America/New_York').toISOString()).toBe('2026-07-15T13:00:00.000Z');
    // Spring-forward gap: 02:30 does not exist on 2026-03-08 in New York → 03:30 EDT.
    expect(zonedToUtc('2026-03-08', '02:30', 'America/New_York').toISOString()).toBe('2026-03-08T07:30:00.000Z');
    // Fall-back ambiguity: 01:30 happens twice on 2026-11-01 → earlier (EDT).
    expect(zonedToUtc('2026-11-01', '01:30', 'America/New_York').toISOString()).toBe('2026-11-01T05:30:00.000Z');
    expect(zonedToUtc('2026-06-01', '00:00', 'Asia/Kolkata').toISOString()).toBe('2026-05-31T18:30:00.000Z');
  });

  it('month arithmetic clamps', () => {
    expect(addMonths('2026-01-31', 1)).toBe('2026-02-28');
    expect(addMonths('2026-12-15', 2)).toBe('2027-02-15');
    expect(addMonths('2026-03-31', -1)).toBe('2026-02-28');
  });

  it('iso weekday', () => {
    expect(isoWeekday('2026-09-21')).toBe(0); // Monday
    expect(isoWeekday('2026-09-27')).toBe(6); // Sunday
  });

  it('buckets and labels due dates', () => {
    const now = new Date('2026-09-22T16:00:00Z'); // 12:00 in New York
    const tz = 'America/New_York';
    const t = (dueDate: string | null, dueTime: string | null = null) => ({ dueDate, dueTime, dueTz: tz });
    expect(dueBucket(t('2026-09-21'), tz, now)).toBe('overdue');
    expect(dueBucket(t('2026-09-22'), tz, now)).toBe('today');
    expect(dueBucket(t('2026-09-22', '09:00'), tz, now)).toBe('overdue');
    expect(dueBucket(t('2026-09-22', '15:00'), tz, now)).toBe('today');
    expect(dueBucket(t('2026-09-23'), tz, now)).toBe('tomorrow');
    expect(dueBucket(t(null), tz, now)).toBe('none');
    expect(formatDueLabel(t('2026-09-23', '09:00'), tz, now)).toBe('Tomorrow 09:00');
    expect(formatDueLabel(t('2026-09-25'), tz, now)).toBe('Fri');
    expect(formatDueLabel(t('2026-10-30'), tz, now)).toBe('Oct 30');
    expect(formatDueLabel(t('2027-01-02'), tz, now)).toBe('Jan 2, 2027');
    expect(formatDueLabel(t('2026-09-22', '15:00'), tz, now, { hour12: true })).toBe('Today 3pm');
  });

  it('timed tasks display in the viewer zone', () => {
    const now = new Date('2026-09-22T16:00:00Z');
    // 09:00 Tokyo on the 23rd = 20:00 New York on the 22nd.
    expect(formatDueLabel({ dueDate: '2026-09-23', dueTime: '09:00', dueTz: 'Asia/Tokyo' }, 'America/New_York', now)).toBe('Today 20:00');
  });
});

describe('permissions', () => {
  it('workspace actions by role', () => {
    expect(canWorkspace('guest', 'lists.create')).toBe(false);
    expect(canWorkspace('member', 'lists.create')).toBe(true);
    expect(canWorkspace('member', 'members.remove')).toBe(false);
    expect(canWorkspace('admin', 'members.remove')).toBe(true);
    expect(canWorkspace('admin', 'workspace.delete')).toBe(false);
    expect(canWorkspace('owner', 'workspace.transfer')).toBe(true);
    expect(canWorkspace(null, 'lists.create')).toBe(false);
  });

  it('role changes', () => {
    expect(canChangeRole('owner', 'member', 'admin')).toBe(true);
    expect(canChangeRole('admin', 'member', 'guest')).toBe(true);
    expect(canChangeRole('admin', 'member', 'admin')).toBe(false);
    expect(canChangeRole('admin', 'admin', 'member')).toBe(false);
    expect(canChangeRole('owner', 'owner', 'member')).toBe(false);
    expect(canChangeRole('member', 'guest', 'member')).toBe(false);
  });

  it('member removal', () => {
    expect(canRemoveMember('admin', 'member', false)).toBe(true);
    expect(canRemoveMember('admin', 'admin', false)).toBe(false);
    expect(canRemoveMember('member', 'member', true)).toBe(true);
    expect(canRemoveMember('owner', 'owner', true)).toBe(false);
  });

  it('list access', () => {
    const list = { createdBy: 'u1', visibility: 'private' as const, workspaceId: 'w' };
    expect(listAccess({ userId: 'u1', role: 'member', list, membership: null })).toBe('owner');
    expect(listAccess({ userId: 'u2', role: 'member', list, membership: null })).toBeNull();
    expect(listAccess({ userId: 'u2', role: 'guest', list, membership: { role: 'viewer' } })).toBe('viewer');
    expect(listAccess({ userId: 'u2', role: 'member', list: { ...list, visibility: 'workspace' }, membership: null })).toBe('editor');
    expect(listAccess({ userId: 'u2', role: 'guest', list: { ...list, visibility: 'workspace' }, membership: null })).toBeNull();
    expect(listAccess({ userId: 'u2', role: null, list, membership: { role: 'editor' } })).toBeNull();
    expect(canList('viewer', 'guest', 'edit')).toBe(false);
    expect(canList('editor', 'guest', 'share')).toBe(false);
    expect(canList('editor', 'member', 'delete')).toBe(false);
    expect(canList('editor', 'admin', 'delete')).toBe(true);
  });
});

describe('plans', () => {
  it('gates features', () => {
    expect(hasFeature('free', 'meeting_chat')).toBe(false);
    expect(hasFeature('ultra', 'meeting_chat')).toBe(true);
    expect(planForFeature('make_ai')).toBe('plus');
    expect(canUseIntegration('free', 'slack')).toBe(false);
    expect(canUseIntegration('free', 'google_calendar')).toBe(true);
    expect(withinLimit(20, 19)).toBe(true);
    expect(withinLimit(20, 20)).toBe(false);
    expect(withinLimit(null, 1e9)).toBe(true);
  });
});

describe('markdown', () => {
  const base: Omit<Task, 'id' | 'title' | 'position' | 'parentTaskId' | 'completedAt'> = {
    workspaceId: 'w', listId: 'l', rootTaskId: null, createdBy: 'u', assigneeId: null, completedBy: null,
    dueDate: null, dueTime: null, dueTz: null, dueAt: null, reminders: [], recurrence: null, occurrenceCount: 0,
    labelIds: [], source: null, hasDetails: false, detailsPreview: null, childCount: 0, childCompletedCount: 0,
    createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z', deletedAt: null,
  };
  const task = (id: string, title: string, position: string, parentTaskId: string | null = null, done = false): Task => ({
    ...base, id, title, position, parentTaskId, completedAt: done ? '2026-01-02T00:00:00Z' : null,
  });

  it('renders nested task trees', () => {
    const tasks = [
      task('1', 'Launch', 'a1'),
      task('2', 'Write copy', 'a0', '1', true),
      task('3', 'Design *hero*', 'a1', '1'),
      task('0', 'First', 'a0'),
    ];
    const md = taskTreeToMarkdown(buildTaskTree(tasks));
    expect(md).toBe('- [ ] First\n- [ ] Launch\n  - [x] Write copy\n  - [ ] Design \\*hero\\*');
  });

  it('neutralises CSV formula injection', () => {
    const csv = tasksToCsv([task('1', '=HYPERLINK("x")', 'a0')]);
    expect(csv.split('\n')[1]).toContain(`"'=HYPERLINK(""x"")"`);
  });

  it('parses markdown outlines', () => {
    const outline = parseMarkdownOutline('- [ ] Plan\n  - [x] Budget\n  - Venue\n- Notes line');
    expect(outline).toHaveLength(2);
    expect(outline[0]).toMatchObject({ title: 'Plan', isTask: true, completed: false });
    expect(outline[0]!.children.map((c) => [c.title, c.completed, c.isTask])).toEqual([
      ['Budget', true, true],
      ['Venue', false, false],
    ]);
  });
});
