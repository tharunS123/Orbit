import { SYNC_TABLE_NAMES, type SyncTableName } from '@orbit/shared';
import { SYNC_COLUMNS, asUser, sqlTable, type Sql, type Tx } from '@orbit/database';
import { pullRequestSchema, type ChangeSet, type PullRequest, type PullResponse } from '../protocol';

/**
 * Pull handler. Runs in one REPEATABLE READ transaction as the user, so every table and the
 * snapshot xmin come from the same snapshot and RLS decides visibility. Rows are returned when
 * `change_xid >= cursor`; the new cursor is the snapshot xmin, which is never ahead of any
 * transaction that could still commit — so no change is missed regardless of commit order.
 */

type Scope = 'workspace' | 'user' | 'special';

const TABLE_SCOPE: Record<SyncTableName, Scope> = {
  profiles: 'special',
  workspaces: 'special',
  workspaceMembers: 'special',
  workspaceInvitations: 'special',
  lists: 'workspace',
  listMembers: 'workspace',
  sections: 'user',
  sectionItems: 'user',
  labels: 'workspace',
  tasks: 'workspace',
  taskUserStates: 'user',
  taskMessages: 'workspace',
  messageReactions: 'workspace',
  attachments: 'workspace',
  notifications: 'user',
};

/** Tables with a list_id column that backfills can filter on. */
const LIST_SCOPED: Partial<Record<SyncTableName, string>> = {
  lists: 'id',
  listMembers: 'list_id',
  tasks: 'list_id',
  attachments: 'list_id',
};

interface RowWithXid {
  id: string;
  syncXid: string;
  [k: string]: unknown;
}

async function fetchTable(
  tx: Tx,
  table: SyncTableName,
  opts: {
    userId: string;
    base: string;
    full: boolean;
    workspaceIds: string[];
    after: { xid: string; id: string } | null;
    limit: number;
    backfill: { workspaceIds: string[]; listIds: string[] } | null;
  },
): Promise<RowWithXid[]> {
  const cols = SYNC_COLUMNS[table];
  const t = tx(sqlTable(table));
  const { userId, base, full, workspaceIds, after, limit, backfill } = opts;
  const deletedFilter = full ? tx`and deleted_at is null` : tx``;
  const keyset = after ? tx`and (change_xid, id) > (${after.xid}::xid8, ${after.id}::uuid)` : tx``;

  let scopeFilter;
  const scope = TABLE_SCOPE[table];
  if (backfill) {
    const listCol = LIST_SCOPED[table];
    const wsIds = backfill.workspaceIds;
    const listIds = backfill.listIds;
    if (table === 'profiles') scopeFilter = tx``;
    else if (table === 'workspaces') scopeFilter = tx`and id = any(${wsIds}::uuid[])`;
    else if (scope === 'user') scopeFilter = tx`and user_id = ${userId} and workspace_id = any(${wsIds}::uuid[])`;
    else if (listCol)
      scopeFilter = tx`and (workspace_id = any(${wsIds}::uuid[]) or ${tx(listCol)} = any(${listIds}::uuid[]))`;
    else if (table === 'workspaceInvitations' || table === 'workspaceMembers') scopeFilter = tx`and workspace_id = any(${wsIds}::uuid[])`;
    else if (table === 'taskMessages' || table === 'messageReactions')
      scopeFilter = tx`and (workspace_id = any(${wsIds}::uuid[]) or task_id in (select id from tasks where list_id = any(${listIds}::uuid[])))`;
    else scopeFilter = tx`and workspace_id = any(${wsIds}::uuid[])`;
  } else if (table === 'profiles' || table === 'workspaceInvitations') {
    scopeFilter = tx``; // RLS decides
  } else if (table === 'workspaces') {
    scopeFilter = tx`and id = any(${workspaceIds}::uuid[])`;
  } else if (table === 'workspaceMembers') {
    scopeFilter = tx`and (workspace_id = any(${workspaceIds}::uuid[]) or user_id = ${userId})`;
  } else if (scope === 'user') {
    scopeFilter = tx`and user_id = ${userId}`;
  } else {
    scopeFilter = tx`and workspace_id = any(${workspaceIds}::uuid[])`;
  }

  return tx<RowWithXid[]>`
    select ${tx(cols)}, change_xid::text as sync_xid
      from ${t}
     where change_xid >= ${base}::xid8 ${scopeFilter} ${deletedFilter} ${keyset}
     order by change_xid, id
     limit ${limit}`;
}

export async function handlePull(sql: Sql, userId: string, input: PullRequest): Promise<PullResponse> {
  const req = pullRequestSchema.parse(input);
  return asUser(sql, { userId }, async (tx) => {
    const [snap] = await tx<{ xmin: string; now: string }[]>`
      select pg_snapshot_xmin(pg_current_snapshot())::text as xmin, now() as now`;
    const workspaceIds = (await tx<{ id: string }[]>`select app.my_workspace_ids() as id`).map((r) => r.id);
    const listIds = (await tx<{ id: string }[]>`select app.accessible_list_ids() as id`).map((r) => r.id);

    const backfill = req.backfill;
    const base = backfill ? '0' : (req.page?.baseCursor ?? req.cursor);
    const nextCursor = req.page?.nextCursor ?? snap!.xmin;
    const full = base === '0';
    const changes: ChangeSet = {};
    let budget = req.limit;
    let page: PullResponse['page'] = null;

    const startIndex = req.page ? SYNC_TABLE_NAMES.indexOf(req.page.table) : 0;
    for (let i = startIndex; i < SYNC_TABLE_NAMES.length; i++) {
      const table = SYNC_TABLE_NAMES[i]!;
      const after =
        req.page && i === startIndex && req.page.afterXid && req.page.afterId
          ? { xid: req.page.afterXid, id: req.page.afterId }
          : null;
      const rows = await fetchTable(tx, table, { userId, base, full, workspaceIds, after, limit: budget + 1, backfill });
      const take = rows.slice(0, budget);
      if (take.length) {
        (changes as Record<string, unknown[]>)[table] = take.map(({ syncXid: _x, ...row }) => row);
      }
      budget -= take.length;
      if (rows.length > take.length || budget <= 0) {
        const last = take.at(-1);
        const more = rows.length > take.length;
        if (more || i < SYNC_TABLE_NAMES.length - 1) {
          page = {
            baseCursor: base,
            nextCursor,
            table: more ? table : SYNC_TABLE_NAMES[i + 1]!,
            afterXid: more && last ? last.syncXid : null,
            afterId: more && last ? last.id : null,
          };
        }
        break;
      }
    }

    // People who just became visible (new members/collaborators) need their profile rows even
    // though those rows did not change.
    const newPeople = new Set<string>();
    for (const m of (changes.workspaceMembers ?? []) as { userId: string }[]) newPeople.add(m.userId);
    for (const m of (changes.listMembers ?? []) as { userId: string }[]) newPeople.add(m.userId);
    for (const l of (changes.lists ?? []) as { createdBy: string }[]) newPeople.add(l.createdBy);
    const have = new Set(((changes.profiles ?? []) as { id: string }[]).map((p) => p.id));
    const missing = [...newPeople].filter((id) => !have.has(id));
    if (missing.length) {
      const extra = await tx`select ${tx(SYNC_COLUMNS.profiles)} from profiles where id = any(${missing}::uuid[])`;
      changes.profiles = [...(changes.profiles ?? []), ...(extra as unknown as NonNullable<ChangeSet['profiles']>)];
    }

    return {
      changes,
      cursor: page ? null : nextCursor,
      page,
      scope: { workspaceIds, listIds },
      serverTime: snap!.now,
    };
  }, { isolation: 'repeatable read', readOnly: true });
}

/** Ids of every visible row per table — lets clients purge rows they silently lost access to. */
export async function handleReconcile(sql: Sql, userId: string): Promise<Partial<Record<SyncTableName, string[]>>> {
  return asUser(sql, { userId }, async (tx) => {
    const workspaceIds = (await tx<{ id: string }[]>`select app.my_workspace_ids() as id`).map((r) => r.id);
    const out: Partial<Record<SyncTableName, string[]>> = {};
    for (const table of ['lists', 'tasks', 'listMembers', 'labels', 'attachments', 'taskMessages'] as const) {
      const rows = await tx<{ id: string }[]>`select id from ${tx(sqlTable(table))} where workspace_id = any(${workspaceIds}::uuid[])`;
      out[table] = rows.map((r) => r.id);
    }
    return out;
  }, { isolation: 'repeatable read', readOnly: true });
}
