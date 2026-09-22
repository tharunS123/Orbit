import { asService } from '@orbit/database';
import { emailTemplates, notificationCopy } from '@orbit/notifications';
import { JOBS, profileSettingsSchema, type NotificationType, type ProfileSettings } from '@orbit/shared';
import type { WorkerDeps } from '../deps';

/**
 * Notification fan-out. In-app rows are written by the sync mutators (`app.notify`); this module
 * pushes them to devices right away and, if they are still unread a little later, emails them.
 * Both steps claim rows by stamping pushed_at / emailed_at inside the claiming transaction, so a
 * retried or duplicated job never sends twice.
 */

/** How long a notification must stay unread before it is emailed. */
export const EMAIL_DELAY_MS = 10 * 60_000;

type Prefs = ProfileSettings['notifications'];
const CATEGORY: Partial<Record<NotificationType, keyof Prefs>> = {
  task_assigned: 'assignments',
  mention: 'mentions',
  comment: 'comments',
  task_due: 'reminders',
};
/** Types worth an email when left unread; the rest are in-app/push only. */
const EMAIL_TYPES: NotificationType[] = ['task_assigned', 'mention', 'comment', 'invitation', 'list_shared', 'meeting_ready', 'integration_error'];

export function wantsChannel(prefs: Prefs, channel: 'push' | 'email', type: NotificationType): boolean {
  if (!prefs[channel]) return false;
  const category = CATEGORY[type];
  return category ? Boolean(prefs[category]) : true;
}

interface PendingRow {
  id: string;
  type: NotificationType;
  actorName: string | null;
  taskId: string | null;
  listId: string | null;
  meetingId: string | null;
  data: Record<string, unknown>;
  readAt: Date | null;
}

function parsePrefs(settings: unknown): Prefs {
  return profileSettingsSchema.parse(settings ?? {}).notifications;
}

export async function deliverPush(deps: WorkerDeps, userId: string): Promise<{ pushed: number }> {
  const since = new Date(deps.now().getTime() - 86_400_000);
  const claimed = await asService(deps.sql, async (tx) => {
    const [profile] = await tx<{ settings: unknown; deletedAt: Date | null }[]>`select settings, deleted_at from profiles where id = ${userId}`;
    const rows = await tx<PendingRow[]>`
      update notifications n set pushed_at = ${deps.now()}
        from notifications cur left join profiles a on a.id = cur.actor_id
       where n.id = cur.id and cur.user_id = ${userId} and cur.pushed_at is null
         and cur.deleted_at is null and cur.created_at > ${since}
      returning n.id, n.type, a.display_name as actor_name, n.task_id, n.list_id, n.meeting_id, n.data, n.read_at`;
    const [{ unread } = { unread: 0 }] = await tx<{ unread: number }[]>`
      select count(*)::int as unread from notifications where user_id = ${userId} and read_at is null and deleted_at is null`;
    if (!profile || profile.deletedAt) return null;
    return { prefs: parsePrefs(profile.settings), rows, unread };
  });
  if (!claimed || !deps.push.configured) return { pushed: 0 };

  let pushed = 0;
  for (const n of claimed.rows) {
    if (n.readAt || !wantsChannel(claimed.prefs, 'push', n.type)) continue;
    const copy = notificationCopy({ ...n, actorName: n.actorName || null });
    const delivered = await deps.push.send(userId, {
      title: copy.headline,
      body: copy.detail ?? '',
      path: copy.path,
      tag: n.taskId ?? n.listId ?? n.id,
      badge: claimed.unread,
      category: n.type,
    });
    if (delivered) pushed += 1;
  }
  if (claimed.rows.some((n) => EMAIL_TYPES.includes(n.type))) {
    await deps.enqueue(JOBS.notificationDeliver, { userId, phase: 'email' }, {
      singletonKey: `email:${userId}`,
      startAfter: new Date(deps.now().getTime() + EMAIL_DELAY_MS),
    });
  }
  return { pushed };
}

export async function deliverEmail(deps: WorkerDeps, userId: string): Promise<{ emailed: number }> {
  const now = deps.now();
  const olderThan = new Date(now.getTime() - EMAIL_DELAY_MS + 30_000);
  const since = new Date(now.getTime() - 3 * 86_400_000);
  const claimed = await asService(deps.sql, async (tx) => {
    const [profile] = await tx<{ email: string | null; settings: unknown; deletedAt: Date | null }[]>`
      select email, settings, deleted_at from profiles where id = ${userId}`;
    // Claim every due row, even ones the user opted out of, so sweeps don't revisit them.
    const rows = await tx<PendingRow[]>`
      update notifications n set emailed_at = ${now}
        from notifications cur left join profiles a on a.id = cur.actor_id
       where n.id = cur.id and cur.user_id = ${userId} and cur.emailed_at is null and cur.read_at is null
         and cur.deleted_at is null and cur.type = any(${EMAIL_TYPES}) and cur.created_at <= ${olderThan} and cur.created_at > ${since}
      returning n.id, n.type, a.display_name as actor_name, n.task_id, n.list_id, n.meeting_id, n.data, n.read_at`;
    if (!profile?.email || profile.deletedAt) return null;
    const prefs = parsePrefs(profile.settings);
    return { email: profile.email, rows: rows.filter((n) => wantsChannel(prefs, 'email', n.type)) };
  });
  if (!claimed?.rows.length) return { emailed: 0 };

  const items = claimed.rows.map((n) => {
    const copy = notificationCopy({ ...n, actorName: n.actorName || null });
    return { headline: copy.headline, detail: copy.detail ?? undefined, url: `${deps.appUrl}${copy.path}` };
  });
  const message =
    items.length === 1
      ? emailTemplates.notification(items[0]!)
      : emailTemplates.digest({ items, url: `${deps.appUrl}/updates` });
  await deps.mailer.send({ to: claimed.email, ...message, idempotencyKey: `notif:${claimed.rows.map((r) => r.id).sort()[0]}:${items.length}` });
  return { emailed: items.length };
}

/** Safety net for jobs lost before enqueue (e.g. crash between commit and send). */
export async function sweepNotifications(deps: WorkerDeps): Promise<{ push: number; email: number }> {
  const now = deps.now();
  const { pushUsers, emailUsers } = await asService(deps.sql, async (tx) => {
    const pushUsers = await tx<{ userId: string }[]>`
      select distinct user_id from notifications
       where pushed_at is null and deleted_at is null
         and created_at between ${new Date(now.getTime() - 86_400_000)} and ${new Date(now.getTime() - 60_000)}
       limit 500`;
    const emailUsers = await tx<{ userId: string }[]>`
      select distinct user_id from notifications
       where emailed_at is null and read_at is null and deleted_at is null and type = any(${EMAIL_TYPES})
         and created_at between ${new Date(now.getTime() - 3 * 86_400_000)} and ${new Date(now.getTime() - EMAIL_DELAY_MS - 5 * 60_000)}
       limit 500`;
    return { pushUsers, emailUsers };
  });
  for (const u of pushUsers) await deps.enqueue(JOBS.notificationDeliver, { userId: u.userId }, { singletonKey: `push:${u.userId}` });
  for (const u of emailUsers) await deps.enqueue(JOBS.notificationDeliver, { userId: u.userId, phase: 'email' }, { singletonKey: `email:${u.userId}` });
  return { push: pushUsers.length, email: emailUsers.length };
}
