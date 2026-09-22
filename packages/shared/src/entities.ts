import { z } from 'zod';

/**
 * Wire/local representation of every synchronised entity. Column names are camelCase versions of
 * the Postgres columns (see supabase/migrations). Timestamps are ISO-8601 strings, `date` columns
 * are `YYYY-MM-DD`, `time` columns are `HH:MM[:SS]`.
 */

export const id = z.uuid();
export const isoDateTime = z.string();
export const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected YYYY-MM-DD');
export const isoTime = z.string().regex(/^\d{2}:\d{2}(:\d{2})?$/, 'Expected HH:MM');

const syncMeta = {
  createdAt: isoDateTime,
  updatedAt: isoDateTime,
  deletedAt: isoDateTime.nullable(),
};

export const WORKSPACE_ROLES = ['owner', 'admin', 'member', 'guest'] as const;
export type WorkspaceRole = (typeof WORKSPACE_ROLES)[number];

export const LIST_VISIBILITY = ['private', 'shared', 'workspace'] as const;
export type ListVisibility = (typeof LIST_VISIBILITY)[number];

export const LABEL_COLORS = [
  'slate',
  'red',
  'orange',
  'amber',
  'lime',
  'green',
  'teal',
  'sky',
  'blue',
  'indigo',
  'violet',
  'pink',
] as const;
export type LabelColor = (typeof LABEL_COLORS)[number];

export const profileSettingsSchema = z.object({
  theme: z.enum(['system', 'light', 'dark']).default('system'),
  sounds: z.boolean().default(true),
  reducedMotion: z.enum(['system', 'reduce', 'full']).default('system'),
  density: z.enum(['comfortable', 'compact']).default('comfortable'),
  weekStartsOn: z.union([z.literal(0), z.literal(1), z.literal(6)]).default(1),
  defaultReminderTime: isoTime.default('09:00'),
  showCalendarInToday: z.boolean().default(true),
  notifications: z
    .object({
      push: z.boolean().default(true),
      email: z.boolean().default(true),
      reminders: z.boolean().default(true),
      mentions: z.boolean().default(true),
      assignments: z.boolean().default(true),
      comments: z.boolean().default(true),
      emailDigest: z.boolean().default(false),
    })
    .prefault({}),
  ai: z
    .object({
      enabled: z.boolean().default(true),
      language: z.string().default('auto'),
      keepMeetingAudioDays: z.number().int().min(0).max(3650).default(30),
      summarizeIntegrations: z.boolean().default(true),
    })
    .prefault({}),
  analytics: z.boolean().default(true),
  quickCaptureShortcut: z.string().default('Shift+Alt+Space'),
});
export type ProfileSettings = z.infer<typeof profileSettingsSchema>;

export const profileSchema = z.object({
  id,
  email: z.string().nullable(),
  displayName: z.string(),
  avatarPath: z.string().nullable(),
  timezone: z.string(),
  locale: z.string(),
  usageType: z.enum(['personal', 'team']).nullable(),
  onboardedAt: isoDateTime.nullable(),
  settings: profileSettingsSchema,
  ...syncMeta,
});
export type Profile = z.infer<typeof profileSchema>;

export const workspaceSchema = z.object({
  id,
  name: z.string(),
  kind: z.enum(['personal', 'team']),
  ownerId: id,
  icon: z.string().nullable(),
  ...syncMeta,
});
export type Workspace = z.infer<typeof workspaceSchema>;

export const workspaceMemberSchema = z.object({
  id,
  workspaceId: id,
  userId: id,
  role: z.enum(WORKSPACE_ROLES),
  ...syncMeta,
});
export type WorkspaceMember = z.infer<typeof workspaceMemberSchema>;

export const invitationStatus = z.enum(['pending', 'accepted', 'declined', 'revoked', 'expired']);
export const workspaceInvitationSchema = z.object({
  id,
  workspaceId: id,
  listId: id.nullable(),
  email: z.string(),
  role: z.enum(WORKSPACE_ROLES),
  status: invitationStatus,
  invitedBy: id,
  expiresAt: isoDateTime,
  ...syncMeta,
});
export type WorkspaceInvitation = z.infer<typeof workspaceInvitationSchema>;

export const listSchema = z.object({
  id,
  workspaceId: id,
  parentListId: id.nullable(),
  createdBy: id,
  title: z.string(),
  emoji: z.string().nullable(),
  coverPath: z.string().nullable(),
  description: z.string().nullable(),
  visibility: z.enum(LIST_VISIBILITY),
  position: z.string(),
  archivedAt: isoDateTime.nullable(),
  ...syncMeta,
});
export type List = z.infer<typeof listSchema>;

export const listMemberSchema = z.object({
  id,
  listId: id,
  workspaceId: id,
  userId: id,
  role: z.enum(['editor', 'viewer']),
  addedBy: id,
  ...syncMeta,
});
export type ListMember = z.infer<typeof listMemberSchema>;

export const sectionSchema = z.object({
  id,
  userId: id,
  workspaceId: id,
  name: z.string(),
  position: z.string(),
  collapsed: z.boolean(),
  ...syncMeta,
});
export type Section = z.infer<typeof sectionSchema>;

/** A starred/pinned list in the user's sidebar, optionally inside a section. */
export const sectionItemSchema = z.object({
  id,
  userId: id,
  workspaceId: id,
  sectionId: id.nullable(),
  listId: id,
  position: z.string(),
  ...syncMeta,
});
export type SectionItem = z.infer<typeof sectionItemSchema>;

export const labelSchema = z.object({
  id,
  workspaceId: id,
  name: z.string(),
  color: z.enum(LABEL_COLORS),
  createdBy: id,
  ...syncMeta,
});
export type Label = z.infer<typeof labelSchema>;

export const REMINDER_PRESETS = [0, 5, 15, 30, 60, 1440] as const;

export const reminderSchema = z.discriminatedUnion('kind', [
  z.object({
    id,
    kind: z.literal('relative'),
    /** Minutes before the due instant (0 = at due time). */
    offsetMinutes: z.number().int().min(0).max(60 * 24 * 60),
  }),
  z.object({ id, kind: z.literal('absolute'), at: isoDateTime }),
]);
export type Reminder = z.infer<typeof reminderSchema>;

export const WEEKDAYS = ['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU'] as const;
export type Weekday = (typeof WEEKDAYS)[number];

export const recurrenceSchema = z.object({
  freq: z.enum(['daily', 'weekly', 'monthly', 'yearly']),
  interval: z.number().int().min(1).max(999).default(1),
  /** weekly: days of week. */
  byWeekday: z.array(z.enum(WEEKDAYS)).optional(),
  /** monthly: day of month (1..31, -1 = last day). */
  byMonthDay: z.array(z.number().int().min(-31).max(31)).optional(),
  /** monthly: nth weekday, e.g. { weekday: 'MO', nth: 1 } = first Monday; nth -1 = last. */
  byNthWeekday: z
    .object({ weekday: z.enum(WEEKDAYS), nth: z.number().int().min(-5).max(5) })
    .optional(),
  /** yearly: month (1..12) — day comes from byMonthDay or the anchor date. */
  byMonth: z.array(z.number().int().min(1).max(12)).optional(),
  until: isoDate.nullable().optional(),
  count: z.number().int().min(1).max(10000).nullable().optional(),
  /** 'schedule' = next occurrence after the scheduled date; 'completion' = after completion date. */
  anchor: z.enum(['schedule', 'completion']).default('schedule'),
});
export type Recurrence = z.infer<typeof recurrenceSchema>;

export const taskSourceSchema = z.object({
  provider: z.enum([
    'gmail',
    'slack',
    'github',
    'linear',
    'microsoft_todo',
    'email_forward',
    'meeting',
    'talk',
    'mcp',
    'import',
  ]),
  url: z.string().nullable().optional(),
  externalId: z.string().nullable().optional(),
  account: z.string().nullable().optional(),
  sender: z.string().nullable().optional(),
  summary: z.string().nullable().optional(),
  meetingId: id.nullable().optional(),
});
export type TaskSource = z.infer<typeof taskSourceSchema>;

export const taskSchema = z.object({
  id,
  workspaceId: id,
  listId: id.nullable(),
  parentTaskId: id.nullable(),
  rootTaskId: id.nullable(),
  createdBy: id,
  assigneeId: id.nullable(),
  title: z.string(),
  position: z.string(),
  completedAt: isoDateTime.nullable(),
  completedBy: id.nullable(),
  dueDate: isoDate.nullable(),
  dueTime: isoTime.nullable(),
  dueTz: z.string().nullable(),
  dueAt: isoDateTime.nullable(),
  reminders: z.array(reminderSchema),
  recurrence: recurrenceSchema.nullable(),
  occurrenceCount: z.number().int(),
  labelIds: z.array(id),
  source: taskSourceSchema.nullable(),
  hasDetails: z.boolean(),
  detailsPreview: z.string().nullable(),
  childCount: z.number().int(),
  childCompletedCount: z.number().int(),
  ...syncMeta,
});
export type Task = z.infer<typeof taskSchema>;

/** Per-user state for a task: Inbox membership and personal ordering in Inbox/Today. */
export const taskUserStateSchema = z.object({
  id,
  userId: id,
  taskId: id,
  workspaceId: id,
  inInbox: z.boolean(),
  inboxPosition: z.string().nullable(),
  todayPosition: z.string().nullable(),
  ...syncMeta,
});
export type TaskUserState = z.infer<typeof taskUserStateSchema>;

export const taskMessageSchema = z.object({
  id,
  workspaceId: id,
  taskId: id,
  authorId: id,
  parentMessageId: id.nullable(),
  kind: z.enum(['text', 'voice', 'system']),
  body: z.string(),
  attachmentId: id.nullable(),
  mentions: z.array(id),
  editedAt: isoDateTime.nullable(),
  ...syncMeta,
});
export type TaskMessage = z.infer<typeof taskMessageSchema>;

export const messageReactionSchema = z.object({
  id,
  workspaceId: id,
  messageId: id,
  taskId: id,
  userId: id,
  emoji: z.string().min(1).max(16),
  ...syncMeta,
});
export type MessageReaction = z.infer<typeof messageReactionSchema>;

export const attachmentSchema = z.object({
  id,
  workspaceId: id,
  taskId: id.nullable(),
  listId: id.nullable(),
  messageId: id.nullable(),
  uploadedBy: id,
  name: z.string(),
  mimeType: z.string(),
  sizeBytes: z.number().int(),
  storagePath: z.string(),
  status: z.enum(['pending', 'ready', 'failed']),
  width: z.number().int().nullable(),
  height: z.number().int().nullable(),
  ...syncMeta,
});
export type Attachment = z.infer<typeof attachmentSchema>;

export const NOTIFICATION_TYPES = [
  'task_assigned',
  'mention',
  'comment',
  'invitation',
  'task_updated',
  'task_due',
  'list_shared',
  'list_changed',
  'meeting_ready',
  'integration_error',
] as const;
export type NotificationType = (typeof NOTIFICATION_TYPES)[number];

export const notificationSchema = z.object({
  id,
  userId: id,
  workspaceId: id.nullable(),
  type: z.enum(NOTIFICATION_TYPES),
  actorId: id.nullable(),
  taskId: id.nullable(),
  listId: id.nullable(),
  meetingId: id.nullable(),
  data: z.record(z.string(), z.unknown()),
  readAt: isoDateTime.nullable(),
  ...syncMeta,
});
export type Notification = z.infer<typeof notificationSchema>;

/** Every table replicated to clients, in dependency order. */
export const SYNC_TABLES = {
  profiles: profileSchema,
  workspaces: workspaceSchema,
  workspaceMembers: workspaceMemberSchema,
  workspaceInvitations: workspaceInvitationSchema,
  lists: listSchema,
  listMembers: listMemberSchema,
  sections: sectionSchema,
  sectionItems: sectionItemSchema,
  labels: labelSchema,
  tasks: taskSchema,
  taskUserStates: taskUserStateSchema,
  taskMessages: taskMessageSchema,
  messageReactions: messageReactionSchema,
  attachments: attachmentSchema,
  notifications: notificationSchema,
} as const;

export type SyncTableName = keyof typeof SYNC_TABLES;
export type SyncEntity<T extends SyncTableName> = z.infer<(typeof SYNC_TABLES)[T]>;
export const SYNC_TABLE_NAMES = Object.keys(SYNC_TABLES) as SyncTableName[];

export interface EntityMap {
  profiles: Profile;
  workspaces: Workspace;
  workspaceMembers: WorkspaceMember;
  workspaceInvitations: WorkspaceInvitation;
  lists: List;
  listMembers: ListMember;
  sections: Section;
  sectionItems: SectionItem;
  labels: Label;
  tasks: Task;
  taskUserStates: TaskUserState;
  taskMessages: TaskMessage;
  messageReactions: MessageReaction;
  attachments: Attachment;
  notifications: Notification;
}

/** Postgres table name for each sync table key. */
export const SQL_TABLE: Record<SyncTableName, string> = {
  profiles: 'profiles',
  workspaces: 'workspaces',
  workspaceMembers: 'workspace_members',
  workspaceInvitations: 'workspace_invitations',
  lists: 'lists',
  listMembers: 'list_members',
  sections: 'sections',
  sectionItems: 'section_items',
  labels: 'labels',
  tasks: 'tasks',
  taskUserStates: 'task_user_states',
  taskMessages: 'task_messages',
  messageReactions: 'message_reactions',
  attachments: 'attachments',
  notifications: 'notifications',
};
