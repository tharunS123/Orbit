import { SQL_TABLE, SYNC_TABLES, type SyncTableName } from '@orbit/shared';

export const toSnake = (key: string) => key.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);

/** Explicit column list for each replicated table, derived from its Zod entity schema. */
export const SYNC_COLUMNS: Record<SyncTableName, string[]> = Object.fromEntries(
  (Object.keys(SYNC_TABLES) as SyncTableName[]).map((name) => [
    name,
    Object.keys(SYNC_TABLES[name].shape).map(toSnake),
  ]),
) as Record<SyncTableName, string[]>;

export function sqlTable(name: SyncTableName): string {
  return SQL_TABLE[name];
}
