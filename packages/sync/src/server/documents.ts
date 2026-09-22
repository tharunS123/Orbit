import type { Tx } from '@orbit/database';
import { remapRefs } from '@orbit/editor/ydoc';

/**
 * Copy a Yjs document (list or task details) to a new name, remapping task/list references to
 * their duplicates. Runs inside the caller's RLS transaction: the source must be readable and
 * the target insertable by the user.
 */
export async function copyDocument(
  tx: Tx,
  fromName: string,
  toName: string,
  target: { taskId?: string; listId?: string; workspaceId: string },
  taskIdMap: Record<string, string>,
  listIdMap: Record<string, string> = {},
): Promise<void> {
  const [src] = await tx<{ state: Buffer | null; plainText: string }[]>`
    select state, plain_text from documents where name = ${fromName} and deleted_at is null`;
  if (!src?.state) return;
  const state = remapRefs(new Uint8Array(src.state), taskIdMap, listIdMap);
  await tx`
    insert into documents (name, workspace_id, list_id, task_id, state, plain_text, size_bytes)
    values (${toName}, ${target.workspaceId}, ${target.listId ?? null}, ${target.taskId ?? null},
            ${Buffer.from(state)}, ${src.plainText}, ${state.byteLength})
    on conflict (name) do nothing`;
}
