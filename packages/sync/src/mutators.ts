import { z } from 'zod';
import {
  LABEL_COLORS,
  LIST_VISIBILITY,
  isoDate,
  isoTime,
  profileSettingsSchema,
  recurrenceSchema,
  reminderSchema,
  taskSourceSchema,
  WORKSPACE_ROLES,
} from '@orbit/shared';

/**
 * The mutator catalogue: every write a client can make, as a named, validated, idempotent
 * operation. Each mutator has one Zod schema here, an optimistic client implementation
 * (client/apply.ts) and an authoritative server implementation (server/mutators.ts).
 * Mutators are intent-based ("add label X", "set completed") rather than whole-row writes, so
 * concurrent edits to different fields merge instead of overwriting each other.
 */

const uuid = z.uuid();
const ids = z.array(uuid).min(1).max(500);
const position = z.string().min(1).max(200);
const title = z.string().max(2000);

const dueFields = {
  dueDate: isoDate.nullable().optional(),
  dueTime: isoTime.nullable().optional(),
  dueTz: z.string().max(64).nullable().optional(),
};

export const taskPatchSchema = z
  .object({
    title: title.optional(),
    ...dueFields,
    reminders: z.array(reminderSchema).max(20).optional(),
    recurrence: recurrenceSchema.nullable().optional(),
    assigneeId: uuid.nullable().optional(),
  })
  .strict();
export type TaskPatch = z.infer<typeof taskPatchSchema>;

export const listPatchSchema = z
  .object({
    title: z.string().max(500).optional(),
    emoji: z.string().max(16).nullable().optional(),
    description: z.string().max(2000).nullable().optional(),
    coverPath: z.string().max(500).nullable().optional(),
    visibility: z.enum(LIST_VISIBILITY).optional(),
    parentListId: uuid.nullable().optional(),
    position: position.optional(),
  })
  .strict();

export const mutatorArgs = {
  // ── tasks ──
  'task.create': z.object({
    id: uuid,
    workspaceId: uuid,
    listId: uuid.nullable().default(null),
    parentTaskId: uuid.nullable().default(null),
    title: title.default(''),
    position,
    inInbox: z.boolean().default(false),
    inboxPosition: position.nullable().optional(),
    ...dueFields,
    reminders: z.array(reminderSchema).max(20).default([]),
    recurrence: recurrenceSchema.nullable().default(null),
    labelIds: z.array(uuid).max(50).default([]),
    assigneeId: uuid.nullable().default(null),
    source: taskSourceSchema.nullable().default(null),
    completed: z.boolean().default(false),
  }),
  'task.update': z.object({ id: uuid, patch: taskPatchSchema }),
  'task.setCompleted': z.object({
    ids,
    completed: z.boolean(),
    /** Client civil date "today" (user zone) — used to advance recurring tasks. */
    today: isoDate,
  }),
  'task.skipOccurrence': z.object({ id: uuid, today: isoDate }),
  'task.move': z.object({
    ids,
    listId: uuid.nullable(),
    parentTaskId: uuid.nullable(),
    positions: z.record(z.string(), position),
  }),
  'task.reorder': z.object({ updates: z.array(z.object({ id: uuid, position })).min(1).max(500) }),
  'task.setLabels': z.object({ ids, add: z.array(uuid).max(50).default([]), remove: z.array(uuid).max(50).default([]) }),
  'task.setDue': z.object({ ids, ...dueFields }),
  'task.assign': z.object({ ids, assigneeId: uuid.nullable() }),
  'task.delete': z.object({ ids }),
  'task.restore': z.object({ ids }),
  'task.setInbox': z.object({ ids, inInbox: z.boolean(), positions: z.record(z.string(), position).optional() }),
  'task.setTodayOrder': z.object({ updates: z.array(z.object({ id: uuid, position })).min(1).max(500) }),
  'task.duplicate': z.object({
    /** old task id → new task id, for the task and every descendant to copy. */
    idMap: z.record(z.string(), uuid),
    rootId: uuid,
    position,
    resetCompletion: z.boolean().default(true),
    clearDates: z.boolean().default(false),
    clearAssignees: z.boolean().default(false),
  }),

  // ── lists ──
  'list.create': z.object({
    id: uuid,
    workspaceId: uuid,
    parentListId: uuid.nullable().default(null),
    title: z.string().max(500).default(''),
    emoji: z.string().max(16).nullable().default(null),
    visibility: z.enum(LIST_VISIBILITY).default('private'),
    position,
    star: z.object({ itemId: uuid, sectionId: uuid.nullable(), position }).optional(),
  }),
  'list.update': z.object({ id: uuid, patch: listPatchSchema }),
  'list.archive': z.object({ id: uuid, archived: z.boolean() }),
  'list.delete': z.object({ id: uuid }),
  'list.restore': z.object({ id: uuid }),
  'list.duplicate': z.object({
    id: uuid,
    newId: uuid,
    title: z.string().max(500),
    position,
    /** old id → new id for all tasks and sublists copied. */
    taskIdMap: z.record(z.string(), uuid),
    listIdMap: z.record(z.string(), uuid).default({}),
    clearDates: z.boolean().default(false),
    clearAssignees: z.boolean().default(true),
    copyAttachments: z.boolean().default(false),
  }),
  'list.share': z.object({ listId: uuid, userId: uuid, role: z.enum(['editor', 'viewer']).default('editor'), memberId: uuid }),
  'list.unshare': z.object({ listId: uuid, userId: uuid }),

  // ── sidebar ──
  'section.create': z.object({ id: uuid, workspaceId: uuid, name: z.string().min(1).max(100), position }),
  'section.update': z.object({
    id: uuid,
    name: z.string().min(1).max(100).optional(),
    position: position.optional(),
    collapsed: z.boolean().optional(),
  }),
  'section.delete': z.object({ id: uuid }),
  'list.star': z.object({ id: uuid, listId: uuid, workspaceId: uuid, sectionId: uuid.nullable(), position }),
  'list.unstar': z.object({ listId: uuid }),
  'sectionItem.move': z.object({ listId: uuid, sectionId: uuid.nullable(), position }),

  // ── labels ──
  'label.create': z.object({ id: uuid, workspaceId: uuid, name: z.string().trim().min(1).max(60), color: z.enum(LABEL_COLORS) }),
  'label.update': z.object({
    id: uuid,
    name: z.string().trim().min(1).max(60).optional(),
    color: z.enum(LABEL_COLORS).optional(),
  }),
  'label.delete': z.object({ id: uuid }),

  // ── messages ──
  'message.create': z.object({
    id: uuid,
    taskId: uuid,
    body: z.string().max(20000),
    parentMessageId: uuid.nullable().default(null),
    kind: z.enum(['text', 'voice']).default('text'),
    attachmentId: uuid.nullable().default(null),
    mentions: z.array(uuid).max(50).default([]),
  }),
  'message.edit': z.object({ id: uuid, body: z.string().max(20000), mentions: z.array(uuid).max(50).default([]) }),
  'message.delete': z.object({ id: uuid }),
  'reaction.toggle': z.object({ id: uuid, messageId: uuid, emoji: z.string().min(1).max(16), on: z.boolean() }),

  // ── notifications ──
  'notification.markRead': z.object({ ids: z.array(uuid).max(1000).optional(), all: z.boolean().default(false), read: z.boolean().default(true) }),

  // ── attachments ──
  'attachment.rename': z.object({ id: uuid, name: z.string().trim().min(1).max(255) }),
  'attachment.delete': z.object({ ids }),

  // ── profile ──
  'profile.update': z.object({
    displayName: z.string().trim().min(1).max(120).optional(),
    avatarPath: z.string().max(500).nullable().optional(),
    timezone: z.string().max(64).optional(),
    locale: z.string().max(16).optional(),
    usageType: z.enum(['personal', 'team']).optional(),
    onboarded: z.boolean().optional(),
    settings: profileSettingsSchema.partial().optional(),
  }),

  // ── workspaces ──
  'workspace.create': z.object({ id: uuid, memberId: uuid, name: z.string().trim().min(1).max(100), icon: z.string().max(16).nullable().default(null) }),
  'workspace.update': z.object({ id: uuid, name: z.string().trim().min(1).max(100).optional(), icon: z.string().max(16).nullable().optional() }),
  'workspace.delete': z.object({ id: uuid }),
  'member.setRole': z.object({ workspaceId: uuid, userId: uuid, role: z.enum(WORKSPACE_ROLES).exclude(['owner']) }),
  'member.remove': z.object({ workspaceId: uuid, userId: uuid }),
  'workspace.leave': z.object({ workspaceId: uuid }),
  'workspace.transfer': z.object({ workspaceId: uuid, toUserId: uuid }),
} as const;

export type MutatorName = keyof typeof mutatorArgs;
export type MutatorArgs<N extends MutatorName> = z.infer<(typeof mutatorArgs)[N]>;
export type MutatorInput<N extends MutatorName> = z.input<(typeof mutatorArgs)[N]>;
export const MUTATOR_NAMES = Object.keys(mutatorArgs) as MutatorName[];

export function isMutatorName(name: string): name is MutatorName {
  return Object.prototype.hasOwnProperty.call(mutatorArgs, name);
}

export function parseMutatorArgs<N extends MutatorName>(name: N, args: unknown): MutatorArgs<N> {
  return mutatorArgs[name].parse(args) as MutatorArgs<N>;
}
