/**
 * Background job names (pg-boss queues). Producers (API, sync mutators, webhooks) and the worker
 * share this list so a typo can never create an orphan queue.
 */
export const JOBS = {
  notificationDeliver: 'notification.deliver',
  remindersScan: 'reminders.scan',
  reminderSend: 'reminder.send',
  attachmentsCopy: 'attachments.copy',
  attachmentsPurge: 'attachments.purge',
  accountDelete: 'account.delete',
  trashPurge: 'trash.purge',
  documentSnapshot: 'document.snapshot',
  meetingTranscribeChunk: 'meeting.transcribe_chunk',
  meetingFinalize: 'meeting.finalize',
  meetingRetention: 'meeting.retention',
  aiJob: 'ai.job',
  integrationWebhook: 'integration.webhook',
  integrationPoll: 'integration.poll',
  integrationSyncConnection: 'integration.sync_connection',
  calendarSync: 'calendar.sync',
  calendarWrite: 'calendar.write',
  inboundEmail: 'inbound.email',
  billingEvent: 'billing.event',
  maintenance: 'maintenance',
} as const;

export type JobName = (typeof JOBS)[keyof typeof JOBS];
export const JOB_NAMES = Object.values(JOBS) as JobName[];
