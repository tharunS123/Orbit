/**
 * Pure pieces of task capture shared by the in-app "New task" dialog and the desktop Quick
 * Capture window: merging natural-language results with explicit choices, the create input, the
 * metadata chip labels, and the guard that makes a draft save at most once.
 */

import { diffDays, formatWallTime, isoWeekday, todayIn, type ParsedTask } from '@orbit/core';
import { uuidv7 } from '@orbit/shared';
import type { CreateTaskInput } from '@orbit/sync/client';

/** Explicit choices made with the metadata controls; `undefined` = follow the text. */
export interface CaptureOverrides {
  listId?: string | null;
  due?: { dueDate: string | null; dueTime: string | null };
  /** Labels picked in the label control, in addition to #labels in the text. */
  labelIds?: string[];
  assigneeId?: string | null;
}

export interface CaptureMetadata {
  listId: string | null;
  dueDate: string | null;
  dueTime: string | null;
  labelIds: string[];
  newLabelNames: string[];
  assigneeId: string | null;
  recurrence: ParsedTask['recurrence'];
}

/** What will be saved: explicit choices win over what the parser found in the text. */
export function effectiveMetadata(parsed: ParsedTask | null, overrides: CaptureOverrides, defaultListId: string | null): CaptureMetadata {
  const due = overrides.due ?? { dueDate: parsed?.dueDate ?? null, dueTime: parsed?.dueTime ?? null };
  const labelIds = [...new Set([...(parsed?.labelIds ?? []), ...(overrides.labelIds ?? [])])];
  return {
    listId: overrides.listId !== undefined ? overrides.listId : defaultListId,
    dueDate: due.dueDate,
    dueTime: due.dueDate ? due.dueTime : null,
    labelIds,
    newLabelNames: parsed?.newLabelNames ?? [],
    assigneeId: overrides.assigneeId !== undefined ? overrides.assigneeId : (parsed?.assigneeId ?? null),
    recurrence: parsed?.recurrence ?? null,
  };
}

/**
 * The createTask input for a draft. The text is still parsed by `Actions.createTask` (one
 * parser for every surface); explicit choices are passed as overrides on top of it.
 */
export function buildCreateInput(args: { id: string; workspaceId: string; text: string; overrides: CaptureOverrides; defaultListId: string | null }): CreateTaskInput {
  const { overrides } = args;
  const listId = overrides.listId !== undefined ? overrides.listId : args.defaultListId;
  const input: CreateTaskInput = { id: args.id, workspaceId: args.workspaceId, text: args.text, listId, inInbox: !listId };
  if (overrides.due) {
    input.dueDate = overrides.due.dueDate;
    input.dueTime = overrides.due.dueDate ? overrides.due.dueTime : null;
  }
  if (overrides.labelIds?.length) input.labelIds = overrides.labelIds;
  if (overrides.assigneeId !== undefined) input.assigneeId = overrides.assigneeId;
  return input;
}

// Indexed by isoWeekday (0 = Monday).
const WEEKDAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/**
 * Chip label that shows both the relative day and the actual date so the parse is verifiable
 * before saving: "Tomorrow, Sep 23 · 7pm", "Friday, Oct 2", "Nov 14, 2027".
 */
export function captureDueLabel(dueDate: string, dueTime: string | null, timeZone: string, now: Date, hour12: boolean): string {
  const today = todayIn(timeZone, now);
  const diff = diffDays(dueDate, today);
  const [y, m, d] = dueDate.split('-').map(Number) as [number, number, number];
  const short = `${MONTHS[m - 1]} ${d}${y !== Number(today.slice(0, 4)) ? `, ${y}` : ''}`;
  let day: string;
  if (diff === 0) day = `Today, ${short}`;
  else if (diff === 1) day = `Tomorrow, ${short}`;
  else if (diff === -1) day = `Yesterday, ${short}`;
  // The date is always shown, so naming the weekday stays unambiguous up to two weeks out.
  else if (diff > 1 && diff < 14) day = `${WEEKDAYS[isoWeekday(dueDate)]}, ${short}`;
  else day = short;
  return dueTime ? `${day} · ${formatWallTime(dueTime, hour12)}` : day;
}

/**
 * Makes a draft save at most once, however many times Enter is pressed or the button clicked
 * while the save (and the window closing) is in flight. Each draft has its own task id, so even a
 * save that slipped through could only ever address the same task.
 */
export class SubmitGuard {
  private draftId = uuidv7();
  private submitted = false;

  /** Id the task will be created with. */
  get id(): string {
    return this.draftId;
  }

  /** True exactly once per draft. */
  begin(): boolean {
    if (this.submitted) return false;
    this.submitted = true;
    return true;
  }

  /** The save failed: allow retrying the same draft (same id). */
  fail(): void {
    this.submitted = false;
  }

  /** Start a new draft (after a successful save). */
  next(): string {
    this.draftId = uuidv7();
    this.submitted = false;
    return this.draftId;
  }
}
