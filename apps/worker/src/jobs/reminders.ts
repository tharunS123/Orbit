import { asService } from '@orbit/database';
import { formatDueLabel, reminderFireTimes } from '@orbit/core';
import { emailTemplates } from '@orbit/notifications';
import { JOBS, profileSettingsSchema, reminderSchema, routes, type Reminder } from '@orbit/shared';
import { z } from 'zod';
import type { WorkerDeps } from '../deps';

/**
 * Reminder delivery. Runs every minute over the window (last scan, now]. For each open task with
 * reminders, the recipient (assignee, else creator) gets one `reminder_deliveries` row per fire
 * instant — its unique key makes delivery exactly-once even if scans overlap or retry. Delivery
 * writes a `task_due` in-app notification (which the push pipeline picks up) and, for people
 * with no push-capable device, an email.
 *
 * Because fire times are computed from the task's current state at scan time, edits (new due
 * date, removed reminder, completion, deletion, lost access) need no cancellation bookkeeping.
 */

const CURSOR_KEY = 'reminders.scan';
/** After downtime, reminders up to this old are still sent (late) — older ones are skipped. */
export const MAX_CATCH_UP_MS = 6 * 3_600_000;
const FIRST_RUN_LOOKBACK_MS = 2 * 60_000;
/** Relative reminders can be up to 60 days before the due date. */
const MAX_OFFSET_DAYS = 61;

interface CandidateRow {
  id: string;
  workspaceId: string;
  listId: string | null;
  title: string;
  dueDate: string | null;
  dueTime: string | null;
  dueTz: string | null;
  reminders: unknown;
  recipientId: string;
  timezone: string;
  settings: unknown;
  email: string | null;
  hasAccess: boolean;
  hasPush: boolean;
}

const remindersSchema = z.array(reminderSchema).catch([]);

export async function scanReminders(deps: WorkerDeps): Promise<{ sent: number; window: [Date, Date] }> {
  const now = deps.now();
  const from = await asService(deps.sql, async (tx) => {
    const [row] = await tx<{ value: { until?: string } }[]>`select value from worker_state where key = ${CURSOR_KEY}`;
    const last = row?.value.until ? new Date(row.value.until) : new Date(now.getTime() - FIRST_RUN_LOOKBACK_MS);
    return new Date(Math.max(last.getTime(), now.getTime() - MAX_CATCH_UP_MS));
  });
  if (from >= now) return { sent: 0, window: [from, now] };

  const dayMs = 86_400_000;
  const minDate = new Date(from.getTime() - 2 * dayMs).toISOString().slice(0, 10);
  const maxDate = new Date(now.getTime() + MAX_OFFSET_DAYS * dayMs).toISOString().slice(0, 10);

  const candidates = await asService(deps.sql, (tx) => tx<CandidateRow[]>`
    select t.id, t.workspace_id, t.list_id, t.title, t.due_date::text as due_date,
           to_char(t.due_time, 'HH24:MI') as due_time, t.due_tz, t.reminders,
           p.id as recipient_id, p.timezone, p.settings, p.email,
           app.user_can_access_task(p.id, t.id) as has_access,
           exists (select 1 from push_tokens pt where pt.user_id = p.id and pt.failed_at is null) as has_push
      from tasks t
      join profiles p on p.id = coalesce(t.assignee_id, t.created_by) and p.deleted_at is null
     where t.deleted_at is null and t.completed_at is null and jsonb_array_length(t.reminders) > 0
       and ((t.due_date between ${minDate}::date and ${maxDate}::date)
            or jsonb_path_exists(t.reminders, '$[*] ? (@.kind == "absolute")'))`);

  const due: { row: CandidateRow; reminder: Reminder; fireAt: Date }[] = [];
  for (const row of candidates) {
    if (!row.hasAccess) continue;
    const settings = profileSettingsSchema.parse(row.settings ?? {});
    const reminders = remindersSchema.parse(row.reminders);
    const fires = reminderFireTimes(
      { dueDate: row.dueDate, dueTime: row.dueTime, dueTz: row.dueTz, reminders },
      { timeZone: row.timezone, defaultReminderTime: settings.defaultReminderTime },
    );
    for (const f of fires) {
      if (f.fireAt > from && f.fireAt <= now) due.push({ row, reminder: reminders.find((r) => r.id === f.reminderId)!, fireAt: f.fireAt });
    }
  }

  let sent = 0;
  const notifyUsers = new Set<string>();
  for (const { row, reminder, fireAt } of due) {
    const settings = profileSettingsSchema.parse(row.settings ?? {});
    const dueLabel = formatDueLabel(row, row.timezone, now, { hour12: false }) || null;
    const delivered = await asService(deps.sql, async (tx) => {
      const [claim] = await tx<{ id: string }[]>`
        insert into reminder_deliveries (task_id, user_id, reminder_id, fire_at, status, sent_at)
        values (${row.id}, ${row.recipientId}, ${reminder.id}, ${fireAt}, 'sent', ${now})
        on conflict (task_id, user_id, reminder_id, fire_at) do nothing
        returning id`;
      if (!claim) return false;
      if (!settings.notifications.reminders) return true;
      await tx`
        insert into notifications (user_id, workspace_id, type, task_id, list_id, data, dedupe_key)
        values (${row.recipientId}, ${row.workspaceId}, 'task_due', ${row.id}, ${row.listId},
                ${tx.json({ title: row.title, due: dueLabel, lateMinutes: Math.round((now.getTime() - fireAt.getTime()) / 60_000) })},
                ${`reminder:${row.id}`})
        on conflict (user_id, dedupe_key) where dedupe_key is not null
        do update set read_at = null, created_at = now(), data = excluded.data, deleted_at = null, pushed_at = null, emailed_at = null`;
      return true;
    });
    if (!delivered) continue;
    sent += 1;
    if (!settings.notifications.reminders) continue;
    notifyUsers.add(row.recipientId);
    // Email only when there is no device to push to, so reminders are never silently lost.
    const pushReachable = deps.push.configured && row.hasPush && settings.notifications.push;
    if (!pushReachable && settings.notifications.email && row.email) {
      const msg = emailTemplates.reminder({ title: row.title || 'Untitled task', due: dueLabel ?? 'soon', url: `${deps.appUrl}${routes.task(row.id)}` });
      try {
        await deps.mailer.send({ to: row.email, ...msg, idempotencyKey: `reminder:${row.id}:${reminder.id}:${fireAt.toISOString()}` });
      } catch (error) {
        deps.logger.warn({ taskId: row.id, err: String(error) }, 'reminder email failed');
      }
    }
  }

  for (const userId of notifyUsers) {
    await deps.enqueue(JOBS.notificationDeliver, { userId }, { singletonKey: `push:${userId}` });
  }
  await asService(deps.sql, (tx) => tx`
    insert into worker_state (key, value, updated_at) values (${CURSOR_KEY}, ${tx.json({ until: now.toISOString() })}, now())
    on conflict (key) do update set value = excluded.value, updated_at = now()`);
  return { sent, window: [from, now] };
}
