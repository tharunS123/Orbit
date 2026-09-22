import { z } from 'zod';
import { JOBS, type JobName } from '@orbit/shared';
import type { WorkerDeps } from './deps';
import { deleteAccount } from './jobs/account';
import { copyAttachments } from './jobs/attachments';
import { applyMeetingRetention, runMaintenance } from './jobs/maintenance';
import { deliverEmail, deliverPush, sweepNotifications } from './jobs/notifications';
import { purgeAttachments, purgeTrash } from './jobs/purge';
import { scanReminders } from './jobs/reminders';

/**
 * Job name → handler. Payloads are validated here: a malformed job fails loudly (and lands in
 * pg-boss's failed state for inspection) instead of doing something partial.
 */
type Handler = (deps: WorkerDeps, data: unknown) => Promise<unknown>;

const uuid = z.uuid();

export const HANDLERS: Partial<Record<JobName, Handler>> = {
  [JOBS.notificationDeliver]: (deps, data) => {
    const d = z.object({ userId: uuid, phase: z.enum(['push', 'email']).default('push') }).loose().parse(data);
    return d.phase === 'email' ? deliverEmail(deps, d.userId) : deliverPush(deps, d.userId);
  },
  [JOBS.remindersScan]: (deps) => scanReminders(deps),
  [JOBS.attachmentsCopy]: (deps, data) =>
    copyAttachments(deps, z.object({ userId: uuid, taskIdMap: z.record(uuid, uuid), listIdMap: z.record(uuid, uuid) }).parse(data)),
  [JOBS.attachmentsPurge]: (deps, data) => purgeAttachments(deps, z.object({ ids: z.array(uuid).max(5000) }).parse(data).ids),
  [JOBS.trashPurge]: (deps) => purgeTrash(deps),
  [JOBS.accountDelete]: (deps, data) => deleteAccount(deps, z.object({ userId: uuid }).parse(data).userId),
  [JOBS.meetingRetention]: (deps) => applyMeetingRetention(deps),
  [JOBS.maintenance]: async (deps, data) => {
    const { task } = z.object({ task: z.enum(['sweep', 'prune']).default('prune') }).parse(data ?? {});
    return task === 'sweep' ? sweepNotifications(deps) : runMaintenance(deps);
  },
};

/** Cron schedules (UTC). `key` lets one queue carry several schedules. */
export const SCHEDULES: { name: JobName; cron: string; data?: Record<string, unknown>; key?: string }[] = [
  { name: JOBS.remindersScan, cron: '* * * * *' },
  { name: JOBS.maintenance, cron: '*/5 * * * *', data: { task: 'sweep' }, key: 'sweep' },
  { name: JOBS.maintenance, cron: '17 * * * *', data: { task: 'prune' }, key: 'prune' },
  { name: JOBS.meetingRetention, cron: '41 * * * *' },
  { name: JOBS.trashPurge, cron: '23 3 * * *' },
];
