import { asService, type Tx } from '@orbit/database';
import type { WorkerDeps } from '../deps';

/** Items stay restorable in the trash this long before they are permanently deleted. */
export const TRASH_RETENTION_DAYS = 30;

async function removeObjects(deps: WorkerDeps, paths: string[]): Promise<void> {
  // Storage deletes are idempotent; batch to keep requests small.
  for (let i = 0; i < paths.length; i += 100) {
    const batch = paths.slice(i, i + 100);
    try {
      await deps.storage.remove(batch);
    } catch (error) {
      if ((error as { code?: string }).code !== 'not_found') throw error;
    }
  }
}

/**
 * Permanently remove attachments that are still deleted (a restore in the meantime cancels the
 * purge). Objects are removed before rows so a failure leaves a retryable row, never an orphan.
 */
export async function purgeAttachments(deps: WorkerDeps, ids: string[]): Promise<{ purged: number }> {
  if (!ids.length) return { purged: 0 };
  const rows = await asService(deps.sql, (tx) => tx<{ id: string; storagePath: string }[]>`
    select id, storage_path from attachments where id = any(${ids}::uuid[]) and deleted_at is not null`);
  if (!rows.length) return { purged: 0 };
  await removeObjects(deps, rows.map((r) => r.storagePath));
  await asService(deps.sql, (tx) => tx`delete from attachments where id = any(${rows.map((r) => r.id)}::uuid[]) and deleted_at is not null`);
  return { purged: rows.length };
}

/** Storage paths of every attachment that will disappear with these tasks/lists/workspaces. */
async function attachmentPathsFor(tx: Tx, scope: { taskIds?: string[]; listIds?: string[]; workspaceIds?: string[] }): Promise<string[]> {
  const rows = await tx<{ storagePath: string }[]>`
    select a.storage_path from attachments a
     where a.workspace_id = any(${scope.workspaceIds ?? []}::uuid[])
        or a.list_id = any(${scope.listIds ?? []}::uuid[])
        or a.task_id = any(${scope.taskIds ?? []}::uuid[])
        or a.task_id in (select id from tasks where root_task_id = any(${scope.taskIds ?? []}::uuid[])
                                              or list_id = any(${scope.listIds ?? []}::uuid[]))`;
  return rows.map((r) => r.storagePath);
}

/**
 * Daily: permanently delete trashed tasks, lists and team workspaces older than the retention
 * window, plus attachments deleted that long ago. Children go with their parents (FK cascades);
 * list tasks are deleted explicitly because tasks.list_id is `on delete set null`.
 */
export async function purgeTrash(deps: WorkerDeps): Promise<{ tasks: number; lists: number; workspaces: number; attachments: number }> {
  const cutoff = new Date(deps.now().getTime() - TRASH_RETENTION_DAYS * 86_400_000);
  const plan = await asService(deps.sql, async (tx) => {
    const workspaces = (await tx<{ id: string }[]>`
      select id from workspaces where deleted_at < ${cutoff} and kind = 'team' limit 50`).map((r) => r.id);
    const lists = (await tx<{ id: string }[]>`select id from lists where deleted_at < ${cutoff} limit 500`).map((r) => r.id);
    const tasks = (await tx<{ id: string }[]>`
      select id from tasks where deleted_at < ${cutoff} and (parent_task_id is null
             or parent_task_id not in (select id from tasks where deleted_at < ${cutoff})) limit 2000`).map((r) => r.id);
    const attachments = (await tx<{ id: string }[]>`select id from attachments where deleted_at < ${cutoff} limit 2000`).map((r) => r.id);
    const paths = await attachmentPathsFor(tx, { taskIds: tasks, listIds: lists, workspaceIds: workspaces });
    return { workspaces, lists, tasks, attachments, paths };
  });

  await removeObjects(deps, plan.paths);
  await asService(deps.sql, async (tx) => {
    if (plan.tasks.length) await tx`delete from tasks where id = any(${plan.tasks}::uuid[]) and deleted_at < ${cutoff}`;
    if (plan.lists.length) {
      await tx`delete from tasks where list_id = any(${plan.lists}::uuid[]) and list_id in (select id from lists where deleted_at < ${cutoff})`;
      await tx`delete from lists where id = any(${plan.lists}::uuid[]) and deleted_at < ${cutoff}`;
    }
    if (plan.workspaces.length) await tx`delete from workspaces where id = any(${plan.workspaces}::uuid[]) and deleted_at < ${cutoff}`;
  });
  const { purged } = await purgeAttachments(deps, plan.attachments);
  return { tasks: plan.tasks.length, lists: plan.lists.length, workspaces: plan.workspaces.length, attachments: purged };
}
