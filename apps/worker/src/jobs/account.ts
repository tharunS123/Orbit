import { asService } from '@orbit/database';
import { emailTemplates } from '@orbit/notifications';
import type { WorkerDeps } from '../deps';

/**
 * Process an account deletion request (created by POST /account/delete after re-auth).
 *
 * - Workspaces the user alone belongs to (personal + solo team) are deleted with all content,
 *   files and meeting audio.
 * - In shared workspaces their contributions stay (tasks, comments) but the profile is
 *   anonymised to "Deleted user", assignments are cleared and memberships removed.
 * - Credentials, devices, integration tokens, API tokens and the auth user are removed.
 *
 * The request is re-checked here: if the user became the owner of a shared workspace since
 * requesting, the job fails with a recorded error instead of orphaning other people's data.
 * Every step is idempotent so a retry after a partial failure completes the deletion.
 */
export async function deleteAccount(deps: WorkerDeps, userId: string): Promise<{ status: 'deleted' | 'skipped' }> {
  const request = await asService(deps.sql, async (tx) => {
    const [req] = await tx<{ completedAt: Date | null }[]>`select completed_at from account_deletions where user_id = ${userId}`;
    const [profile] = await tx<{ email: string | null; avatarPath: string | null }[]>`select email, avatar_path from profiles where id = ${userId}`;
    return { req, profile };
  });
  if (!request.req || request.req.completedAt) return { status: 'skipped' };

  try {
    const plan = await asService(deps.sql, async (tx) => {
      const blocking = await tx<{ name: string }[]>`
        select w.name from workspaces w
         where w.owner_id = ${userId} and w.kind = 'team' and w.deleted_at is null
           and exists (select 1 from workspace_members m where m.workspace_id = w.id and m.user_id <> ${userId} and m.deleted_at is null)`;
      if (blocking.length) throw new Error(`Still owns shared workspaces: ${blocking.map((b) => b.name).join(', ')}`);
      const solo = (await tx<{ id: string }[]>`
        select w.id from workspaces w
         where w.owner_id = ${userId}
           and not exists (select 1 from workspace_members m where m.workspace_id = w.id and m.user_id <> ${userId} and m.deleted_at is null)`).map((r) => r.id);
      const files = await tx<{ path: string }[]>`
        select storage_path as path from attachments where workspace_id = any(${solo}::uuid[])
        union all select storage_path from meeting_audio_chunks c join meeting_sessions s on s.id = c.meeting_id
                   where s.workspace_id = any(${solo}::uuid[]) or s.created_by = ${userId}
        union all select audio_path from meeting_sessions where audio_path is not null
                   and (workspace_id = any(${solo}::uuid[]) or created_by = ${userId})`;
      return { solo, paths: files.map((f) => f.path) };
    });

    const paths = [...plan.paths, ...(request.profile?.avatarPath ? [request.profile.avatarPath] : [])];
    for (let i = 0; i < paths.length; i += 100) {
      try {
        await deps.storage.remove(paths.slice(i, i + 100));
      } catch (error) {
        if ((error as { code?: string }).code !== 'not_found') throw error;
      }
    }

    await asService(deps.sql, async (tx) => {
      // Solo workspaces: tasks first (tasks.list_id is set-null, not cascade), then the rest cascades.
      await tx`delete from tasks where workspace_id = any(${plan.solo}::uuid[])`;
      await tx`delete from workspaces where id = any(${plan.solo}::uuid[])`;
      // Meetings the user recorded in shared workspaces are theirs: remove them entirely.
      await tx`delete from meeting_sessions where created_by = ${userId}`;
      await tx`update tasks set assignee_id = null where assignee_id = ${userId}`;
      await tx`update workspace_members set deleted_at = now() where user_id = ${userId} and deleted_at is null`;
      await tx`update list_members set deleted_at = now() where user_id = ${userId} and deleted_at is null`;
      await tx`delete from task_user_states where user_id = ${userId}`;
      await tx`delete from notifications where user_id = ${userId}`;
      await tx`delete from integration_connections where user_id = ${userId}`;
      await tx`update inbound_email_addresses set revoked_at = now() where user_id = ${userId} and revoked_at is null`;
      await tx`delete from push_tokens where user_id = ${userId}`;
      await tx`delete from devices where user_id = ${userId}`;
      await tx`delete from mcp_tokens where user_id = ${userId}`;
      await tx`delete from sync_devices where user_id = ${userId}`;
      await tx`delete from reminder_deliveries where user_id = ${userId}`;
      await tx`delete from ai_jobs where user_id = ${userId}`;
      await tx`update profiles set email = null, display_name = 'Deleted user', avatar_path = null, settings = '{}'::jsonb,
                                  usage_type = null, deleted_at = coalesce(deleted_at, now())
                where id = ${userId}`;
      await tx`delete from auth.users where id = ${userId}`;
      await tx`update account_deletions set completed_at = now(), error = null where user_id = ${userId}`;
      await tx`insert into audit_log (user_id, action) values (${userId}, 'account.deleted')`;
    });
  } catch (error) {
    await asService(deps.sql, (tx) => tx`update account_deletions set error = ${String((error as Error).message).slice(0, 500)} where user_id = ${userId}`);
    throw error;
  }

  if (request.profile?.email) {
    try {
      await deps.mailer.send({ to: request.profile.email, ...emailTemplates.accountDeleted(), idempotencyKey: `account-deleted:${userId}` });
    } catch (error) {
      deps.logger.warn({ err: String(error) }, 'account deletion email failed');
    }
  }
  return { status: 'deleted' };
}
