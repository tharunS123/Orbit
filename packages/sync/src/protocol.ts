import { z } from 'zod';
import { SYNC_TABLE_NAMES, type EntityMap, type SyncTableName } from '@orbit/shared';

/** Wire protocol between SyncClient and /api/sync. See docs/SYNC_ENGINE.md. */

export const pendingMutationSchema = z.object({
  id: z.uuid(),
  name: z.string().min(1).max(64),
  args: z.unknown(),
  createdAt: z.string(),
});
export type PendingMutation = z.infer<typeof pendingMutationSchema>;

export const pushRequestSchema = z.object({
  clientId: z.uuid(),
  mutations: z.array(pendingMutationSchema).min(1).max(200),
});
export type PushRequest = z.infer<typeof pushRequestSchema>;

export const mutationResultSchema = z.object({
  id: z.uuid(),
  status: z.enum(['applied', 'rejected']),
  error: z.object({ code: z.string(), message: z.string() }).optional(),
});
export type MutationResult = z.infer<typeof mutationResultSchema>;

export interface PushResponse {
  results: MutationResult[];
  /** True when the server stopped early (transient failure) — client retries the rest later. */
  incomplete: boolean;
}

const tableName = z.enum(SYNC_TABLE_NAMES as [SyncTableName, ...SyncTableName[]]);

export const pullRequestSchema = z.object({
  clientId: z.uuid(),
  /** Snapshot xmin (xid8 as decimal string) from the previous complete pull; "0" = full. */
  cursor: z.string().regex(/^\d+$/).default('0'),
  /** Continuation within a paginated pull. */
  page: z
    .object({
      baseCursor: z.string().regex(/^\d+$/),
      nextCursor: z.string().regex(/^\d+$/),
      table: tableName,
      afterXid: z.string().regex(/^\d+$/).nullable(),
      afterId: z.uuid().nullable(),
    })
    .nullable()
    .default(null),
  /** Restrict to newly-visible scopes (full history for these ids only). */
  backfill: z
    .object({ workspaceIds: z.array(z.uuid()).max(200), listIds: z.array(z.uuid()).max(5000) })
    .nullable()
    .default(null),
  limit: z.number().int().min(10).max(5000).default(2000),
});
export type PullRequest = z.input<typeof pullRequestSchema>;

export type ChangeSet = { [T in SyncTableName]?: EntityMap[T][] };

export interface PullResponse {
  changes: ChangeSet;
  /** Present when the pull is complete: the cursor to use next time. */
  cursor: string | null;
  /** Present when more pages remain. */
  page: z.infer<typeof pullRequestSchema>['page'];
  /** What the user can currently see — the client purges anything outside it. */
  scope: { workspaceIds: string[]; listIds: string[] };
  serverTime: string;
}
