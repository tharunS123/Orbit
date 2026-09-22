import { createHash } from 'node:crypto';
import { asService } from '@orbit/database';
import type { WorkerDeps } from '../deps';

/** Stable id for a copy, so retries of the same job never create duplicates. */
function copyId(sourceId: string, targetParent: string): string {
  const h = createHash('sha256').update(`${sourceId}:${targetParent}`).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-${((parseInt(h[16]!, 16) & 0x3) | 0x8).toString(16)}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

/**
 * Copy files into a duplicated list (`list.duplicate` with "include attachments"). Only ready,
 * non-deleted task/list attachments are copied (comment files stay with their comments). The
 * duplicating user must still be able to read the source list and edit the copy.
 */
export async function copyAttachments(
  deps: WorkerDeps,
  data: { userId: string; taskIdMap: Record<string, string>; listIdMap: Record<string, string> },
): Promise<{ copied: number }> {
  const taskIds = Object.keys(data.taskIdMap);
  const listIds = Object.keys(data.listIdMap);
  const sources = await asService(deps.sql, (tx) => tx<
    { id: string; workspaceId: string; taskId: string | null; listId: string | null; name: string; mimeType: string; sizeBytes: number; storagePath: string; width: number | null; height: number | null; allowed: boolean }[]
  >`
    select a.id, a.workspace_id, a.task_id, a.list_id, a.name, a.mime_type, a.size_bytes, a.storage_path, a.width, a.height,
           case when a.list_id is not null then app.user_list_level(${data.userId}, a.list_id) >= 1
                else app.user_can_access_task(${data.userId}, a.task_id) end as allowed
      from attachments a
     where a.deleted_at is null and a.status = 'ready' and a.message_id is null
       and (a.task_id = any(${taskIds}::uuid[]) or a.list_id = any(${listIds}::uuid[]))`);

  let copied = 0;
  for (const src of sources) {
    if (!src.allowed) continue;
    const targetTask = src.taskId ? data.taskIdMap[src.taskId] ?? null : null;
    const targetList = src.listId ? data.listIdMap[src.listId] ?? null : null;
    const parent = targetTask ?? targetList;
    if (!parent) continue;
    const id = copyId(src.id, parent);
    const [target] = await asService(deps.sql, (tx) => tx<{ workspaceId: string; canEdit: boolean }[]>`
      select coalesce(t.workspace_id, l.workspace_id) as workspace_id,
             app.user_list_level(${data.userId}, coalesce(t.list_id, l.id)) >= 2 as can_edit
        from (select 1) x
        left join tasks t on t.id = ${targetTask} and t.deleted_at is null
        left join lists l on l.id = ${targetList} and l.deleted_at is null`);
    if (!target?.workspaceId || !target.canEdit) continue;
    const path = `attachments/${target.workspaceId}/${id}/${src.storagePath.split('/').pop()}`;
    if (!(await deps.storage.exists(path))) await deps.storage.copy(src.storagePath, path);
    const res = await asService(deps.sql, (tx) => tx`
      insert into attachments (id, workspace_id, task_id, list_id, uploaded_by, name, mime_type, size_bytes, storage_path, status, width, height)
      values (${id}, ${target.workspaceId}, ${targetTask}, ${targetList}, ${data.userId}, ${src.name}, ${src.mimeType},
              ${src.sizeBytes}, ${path}, 'ready', ${src.width}, ${src.height})
      on conflict (id) do nothing`);
    copied += res.count;
  }
  return { copied };
}
