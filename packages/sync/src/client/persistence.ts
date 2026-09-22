import { openDB, type IDBPDatabase } from 'idb';
import type { SyncTableName } from '@orbit/shared';
import type { PendingMutation } from '../protocol';

/**
 * Durable local storage for the sync engine. One interface, three implementations:
 *   - IndexedDbPersistence  (web, PWA, Tauri desktop)
 *   - SqlitePersistence     (Capacitor iOS/Android via a driver the app injects)
 *   - MemoryPersistence     (tests, private windows where IndexedDB is unavailable)
 * Every `apply` is atomic: rows, outbox and cursor move together, so a crash can never
 * advance the cursor without the rows it covers.
 */

export const SCHEMA_VERSION = 3;

export interface SyncMeta {
  schemaVersion: number;
  userId: string;
  clientId: string;
  cursor: string;
  scope: { workspaceIds: string[]; listIds: string[] } | null;
  lastPullAt: string | null;
  lastReconcileAt: string | null;
}

export type Row = { id: string };

export interface PersistedState {
  rows: Partial<Record<SyncTableName, Row[]>>;
  pending: PendingMutation[];
  meta: SyncMeta | null;
}

export interface PersistBatch {
  puts?: { table: SyncTableName; row: Row }[];
  deletes?: { table: SyncTableName; id: string }[];
  pendingAdd?: PendingMutation[];
  pendingRemove?: string[];
  meta?: Partial<SyncMeta>;
}

export interface LocalPersistence {
  readonly kind: 'indexeddb' | 'sqlite' | 'memory';
  load(): Promise<PersistedState>;
  /** Outbox only — used to salvage unsynced work when the row cache is corrupt. */
  loadPending(): Promise<PendingMutation[]>;
  apply(batch: PersistBatch): Promise<void>;
  /** Drop cached rows + cursor but keep the outbox (cache rebuild). */
  clearCache(): Promise<void>;
  /** Remove everything (sign out / account deletion). */
  destroy(): Promise<void>;
  close(): Promise<void>;
}

// ───────────────────────────── memory ─────────────────────────────
export class MemoryPersistence implements LocalPersistence {
  readonly kind = 'memory' as const;
  private rows = new Map<string, { table: SyncTableName; row: Row }>();
  private pending = new Map<string, PendingMutation>();
  private meta: SyncMeta | null = null;

  async load(): Promise<PersistedState> {
    const rows: Partial<Record<SyncTableName, Row[]>> = {};
    for (const { table, row } of this.rows.values()) (rows[table] ??= []).push(row);
    return { rows, pending: [...this.pending.values()], meta: this.meta };
  }
  async loadPending() {
    return [...this.pending.values()];
  }
  async apply(b: PersistBatch) {
    for (const p of b.puts ?? []) this.rows.set(`${p.table}:${p.row.id}`, p);
    for (const d of b.deletes ?? []) this.rows.delete(`${d.table}:${d.id}`);
    for (const m of b.pendingAdd ?? []) this.pending.set(m.id, m);
    for (const id of b.pendingRemove ?? []) this.pending.delete(id);
    if (b.meta) this.meta = { ...(this.meta ?? defaultMeta()), ...b.meta };
  }
  async clearCache() {
    this.rows.clear();
    if (this.meta) this.meta = { ...this.meta, cursor: '0', scope: null };
  }
  async destroy() {
    this.rows.clear();
    this.pending.clear();
    this.meta = null;
  }
  async close() {}
}

export function defaultMeta(): SyncMeta {
  return {
    schemaVersion: SCHEMA_VERSION,
    userId: '',
    clientId: '',
    cursor: '0',
    scope: null,
    lastPullAt: null,
    lastReconcileAt: null,
  };
}

// ───────────────────────────── IndexedDB ─────────────────────────────
interface RowRecord {
  t: SyncTableName;
  id: string;
  row: Row;
}
interface PendingRecord {
  seq: number;
  id: string;
  m: PendingMutation;
}

export class IndexedDbPersistence implements LocalPersistence {
  readonly kind = 'indexeddb' as const;
  private dbp: Promise<IDBPDatabase>;
  private seq = Date.now() * 1000;

  constructor(readonly name: string) {
    this.dbp = openDB(name, 1, {
      upgrade(db) {
        db.createObjectStore('rows', { keyPath: ['t', 'id'] });
        const pending = db.createObjectStore('pending', { keyPath: 'id' });
        pending.createIndex('seq', 'seq');
        db.createObjectStore('meta');
      },
      blocked() {
        // Another tab holds an old version open; it will close on `versionchange`.
      },
    });
  }

  async load(): Promise<PersistedState> {
    const db = await this.dbp;
    const tx = db.transaction(['rows', 'pending', 'meta'], 'readonly');
    const [records, pendingRecords, meta] = await Promise.all([
      tx.objectStore('rows').getAll() as Promise<RowRecord[]>,
      tx.objectStore('pending').index('seq').getAll() as Promise<PendingRecord[]>,
      tx.objectStore('meta').get('meta') as Promise<SyncMeta | undefined>,
    ]);
    await tx.done;
    const rows: Partial<Record<SyncTableName, Row[]>> = {};
    for (const r of records) (rows[r.t] ??= []).push(r.row);
    const last = pendingRecords.at(-1);
    if (last && last.seq >= this.seq) this.seq = last.seq + 1;
    return { rows, pending: pendingRecords.map((p) => p.m), meta: meta ?? null };
  }

  async loadPending(): Promise<PendingMutation[]> {
    const db = await this.dbp;
    const recs = (await db.getAllFromIndex('pending', 'seq')) as PendingRecord[];
    return recs.map((r) => r.m);
  }

  async apply(b: PersistBatch): Promise<void> {
    const db = await this.dbp;
    const tx = db.transaction(['rows', 'pending', 'meta'], 'readwrite');
    const rows = tx.objectStore('rows');
    const pending = tx.objectStore('pending');
    const ops: Promise<unknown>[] = [];
    for (const p of b.puts ?? []) ops.push(rows.put({ t: p.table, id: p.row.id, row: p.row } satisfies RowRecord));
    for (const d of b.deletes ?? []) ops.push(rows.delete([d.table, d.id]));
    for (const m of b.pendingAdd ?? []) ops.push(pending.put({ seq: this.seq++, id: m.id, m } satisfies PendingRecord));
    for (const id of b.pendingRemove ?? []) ops.push(pending.delete(id));
    if (b.meta) {
      const metaStore = tx.objectStore('meta');
      const current = ((await metaStore.get('meta')) as SyncMeta | undefined) ?? defaultMeta();
      ops.push(metaStore.put({ ...current, ...b.meta }, 'meta'));
    }
    await Promise.all(ops);
    await tx.done;
  }

  async clearCache(): Promise<void> {
    const db = await this.dbp;
    const tx = db.transaction(['rows', 'meta'], 'readwrite');
    await tx.objectStore('rows').clear();
    const meta = ((await tx.objectStore('meta').get('meta')) as SyncMeta | undefined) ?? defaultMeta();
    await tx.objectStore('meta').put({ ...meta, cursor: '0', scope: null }, 'meta');
    await tx.done;
  }

  async destroy(): Promise<void> {
    const db = await this.dbp;
    db.close();
    await new Promise<void>((resolve, reject) => {
      const req = indexedDB.deleteDatabase(this.name);
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
      req.onblocked = () => resolve();
    });
  }

  async close(): Promise<void> {
    (await this.dbp).close();
  }
}

// ───────────────────────────── SQLite (native) ─────────────────────────────
/** Minimal driver surface; apps/mobile adapts @capacitor-community/sqlite to it. */
export interface SqliteDriver {
  execute(sql: string): Promise<void>;
  run(sql: string, params?: unknown[]): Promise<void>;
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;
  transaction(fn: () => Promise<void>): Promise<void>;
}

export class SqlitePersistence implements LocalPersistence {
  readonly kind = 'sqlite' as const;
  private ready: Promise<void>;

  constructor(private readonly db: SqliteDriver) {
    this.ready = db.execute(`
      create table if not exists rows (t text not null, id text not null, json text not null, primary key (t, id));
      create table if not exists pending (seq integer primary key autoincrement, id text not null unique, json text not null);
      create table if not exists meta (k text primary key, v text not null);
    `);
  }

  async load(): Promise<PersistedState> {
    await this.ready;
    const rowsRaw = await this.db.query<{ t: SyncTableName; json: string }>('select t, json from rows');
    const pendingRaw = await this.db.query<{ json: string }>('select json from pending order by seq');
    const metaRaw = await this.db.query<{ v: string }>("select v from meta where k = 'meta'");
    const rows: Partial<Record<SyncTableName, Row[]>> = {};
    for (const r of rowsRaw) (rows[r.t] ??= []).push(JSON.parse(r.json) as Row);
    return {
      rows,
      pending: pendingRaw.map((p) => JSON.parse(p.json) as PendingMutation),
      meta: metaRaw[0] ? (JSON.parse(metaRaw[0].v) as SyncMeta) : null,
    };
  }

  async loadPending(): Promise<PendingMutation[]> {
    await this.ready;
    const pendingRaw = await this.db.query<{ json: string }>('select json from pending order by seq');
    return pendingRaw.map((p) => JSON.parse(p.json) as PendingMutation);
  }

  async apply(b: PersistBatch): Promise<void> {
    await this.ready;
    await this.db.transaction(async () => {
      for (const p of b.puts ?? [])
        await this.db.run('insert or replace into rows (t, id, json) values (?, ?, ?)', [p.table, p.row.id, JSON.stringify(p.row)]);
      for (const d of b.deletes ?? []) await this.db.run('delete from rows where t = ? and id = ?', [d.table, d.id]);
      for (const m of b.pendingAdd ?? [])
        await this.db.run('insert or ignore into pending (id, json) values (?, ?)', [m.id, JSON.stringify(m)]);
      for (const id of b.pendingRemove ?? []) await this.db.run('delete from pending where id = ?', [id]);
      if (b.meta) {
        const [cur] = await this.db.query<{ v: string }>("select v from meta where k = 'meta'");
        const next = { ...(cur ? (JSON.parse(cur.v) as SyncMeta) : defaultMeta()), ...b.meta };
        await this.db.run("insert or replace into meta (k, v) values ('meta', ?)", [JSON.stringify(next)]);
      }
    });
  }

  async clearCache(): Promise<void> {
    await this.ready;
    await this.db.transaction(async () => {
      await this.db.run('delete from rows');
      const [cur] = await this.db.query<{ v: string }>("select v from meta where k = 'meta'");
      const meta = cur ? (JSON.parse(cur.v) as SyncMeta) : defaultMeta();
      await this.db.run("insert or replace into meta (k, v) values ('meta', ?)", [JSON.stringify({ ...meta, cursor: '0', scope: null })]);
    });
  }

  async destroy(): Promise<void> {
    await this.ready;
    await this.db.execute('delete from rows; delete from pending; delete from meta;');
  }

  async close(): Promise<void> {}
}
