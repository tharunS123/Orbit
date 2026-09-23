import {
  AppError,
  SYNC_TABLE_NAMES,
  type EntityMap,
  type SyncTableName,
  type Task,
  type TaskUserState,
} from '@orbit/shared';
import { isMutatorName, parseMutatorArgs } from '../mutators';
import type { PendingMutation } from '../protocol';
import { clientMutators, type ClientTx } from './apply';

/**
 * Local entity store.
 *
 *   base     = last known server state (persisted)
 *   pending  = outbox of local mutations not yet confirmed (persisted)
 *   view     = base + replay(pending)  (what the UI reads)
 *
 * Mutations apply to `view` immediately. When server rows arrive, `base` is updated and every
 * row touched by a pending mutation is reset to base and the pending mutations are replayed —
 * a rebase. Rows no pending mutation touches are updated in place, so rebases are cheap.
 */

type Row = { id: string };
type Table = Map<string, Row>;
type Tables = Record<SyncTableName, Table>;

const emptyTables = (): Tables =>
  Object.fromEntries(SYNC_TABLE_NAMES.map((t) => [t, new Map<string, Row>()])) as Tables;

export interface StoreChange {
  tables: Set<SyncTableName>;
}
export type StoreListener = (change: StoreChange) => void;

export interface MutationFailure {
  mutation: PendingMutation;
  error: AppError;
}

export class EntityStore {
  readonly base: Tables = emptyTables();
  private view: Tables = emptyTables();
  private pending: PendingMutation[] = [];
  /** Keys ("table:id") written by pending mutations in the current view. */
  private overlay = new Set<string>();
  private listeners = new Set<StoreListener>();
  private versions = Object.fromEntries(SYNC_TABLE_NAMES.map((t) => [t, 0])) as Record<SyncTableName, number>;
  private childIndex = new Map<string, Set<string>>();
  private stateIndex = new Map<string, string>();
  private batchDepth = 0;
  private batchTables = new Set<SyncTableName>();

  constructor(public userId: string) {}

  // ───────────── reads ─────────────
  get<T extends SyncTableName>(table: T, id: string): EntityMap[T] | undefined {
    return this.view[table].get(id) as EntityMap[T] | undefined;
  }

  all<T extends SyncTableName>(table: T): EntityMap[T][] {
    return [...this.view[table].values()] as EntityMap[T][];
  }

  /** Monotonic per-table version; changes whenever any row of the table changes. */
  version(table: SyncTableName): number {
    return this.versions[table];
  }

  childrenOf(taskId: string): Task[] {
    const ids = this.childIndex.get(taskId);
    if (!ids) return [];
    const out: Task[] = [];
    for (const id of ids) {
      const t = this.view.tasks.get(id) as Task | undefined;
      if (t) out.push(t);
    }
    return out;
  }

  userState(taskId: string): TaskUserState | undefined {
    const id = this.stateIndex.get(taskId);
    return id ? (this.view.taskUserStates.get(id) as TaskUserState | undefined) : undefined;
  }

  pendingMutations(): readonly PendingMutation[] {
    return this.pending;
  }

  hasPending(): boolean {
    return this.pending.length > 0;
  }

  subscribe(listener: StoreListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  // ───────────── writes ─────────────

  /**
   * Apply a new local mutation optimistically and queue it. Throws (without queuing) if the
   * mutation is invalid against local state, so the UI can report it immediately.
   */
  mutate(mutation: PendingMutation): void {
    this.batch(() => {
      this.runMutation(mutation);
      this.pending.push(mutation);
    });
  }

  /**
   * Queue a mutation that another client of the same local outbox created (e.g. the desktop
   * Quick Capture window). It is already durable, so it's queued even if it no longer applies
   * locally — the server is the judge, exactly as for mutations replayed at startup.
   */
  adopt(mutation: PendingMutation): MutationFailure | null {
    let failure: MutationFailure | null = null;
    this.batch(() => {
      try {
        this.runMutation(mutation);
      } catch (error) {
        failure = { mutation, error: AppError.from(error) };
      }
      this.pending.push(mutation);
    });
    return failure;
  }

  /** Load persisted state at startup. */
  hydrate(rows: Partial<Record<SyncTableName, Row[]>>, pending: PendingMutation[]): MutationFailure[] {
    let failures: MutationFailure[] = [];
    this.batch(() => {
      for (const table of SYNC_TABLE_NAMES) {
        this.base[table].clear();
        for (const row of rows[table] ?? []) this.base[table].set(row.id, row);
      }
      this.pending = [...pending];
      failures = this.rebuild();
    });
    return failures;
  }

  /**
   * Apply server rows (from a pull) and rebase pending mutations on top. `purge` removes rows
   * the user can no longer see. Returns mutations that no longer apply locally (they stay
   * queued: the server is the judge).
   */
  applyServerChanges(
    changes: Partial<Record<SyncTableName, Row[]>>,
    purge?: (table: SyncTableName, row: Row) => boolean,
  ): { changedBase: { table: SyncTableName; rows: Row[] }[]; removed: { table: SyncTableName; id: string }[]; failures: MutationFailure[] } {
    const changedBase: { table: SyncTableName; rows: Row[] }[] = [];
    const removed: { table: SyncTableName; id: string }[] = [];
    let failures: MutationFailure[] = [];
    this.batch(() => {
      for (const table of SYNC_TABLE_NAMES) {
        const rows = changes[table];
        if (rows?.length) {
          for (const row of rows) {
            this.base[table].set(row.id, row);
            if (!this.overlay.has(`${table}:${row.id}`)) this.setView(table, row);
          }
          changedBase.push({ table, rows });
        }
        if (purge) {
          for (const row of [...this.base[table].values()]) {
            if (purge(table, row)) {
              this.base[table].delete(row.id);
              this.deleteView(table, row.id);
              removed.push({ table, id: row.id });
            }
          }
        }
      }
      if (this.overlay.size) failures = this.rebase();
    });
    return { changedBase, removed, failures };
  }

  /** Drop confirmed (applied or rejected) mutations and rebase. */
  acknowledge(ids: Iterable<string>): MutationFailure[] {
    const done = new Set(ids);
    if (!done.size) return [];
    let failures: MutationFailure[] = [];
    this.batch(() => {
      this.pending = this.pending.filter((m) => !done.has(m.id));
      failures = this.rebase();
    });
    return failures;
  }

  /** Forget everything (sign-out / cache reset). */
  reset(userId: string): void {
    this.userId = userId;
    this.batch(() => {
      for (const t of SYNC_TABLE_NAMES) {
        this.base[t].clear();
        this.view[t].clear();
        this.batchTables.add(t);
      }
      this.pending = [];
      this.overlay.clear();
      this.childIndex.clear();
      this.stateIndex.clear();
    });
  }

  // ───────────── internals ─────────────

  private rebuild(): MutationFailure[] {
    this.view = emptyTables();
    this.childIndex.clear();
    this.stateIndex.clear();
    this.overlay.clear();
    for (const table of SYNC_TABLE_NAMES) {
      for (const row of this.base[table].values()) this.setView(table, row);
      this.batchTables.add(table);
    }
    return this.replayPending();
  }

  private rebase(): MutationFailure[] {
    // Reset every overlaid row to its base value, then replay the outbox.
    for (const key of this.overlay) {
      const idx = key.indexOf(':');
      const table = key.slice(0, idx) as SyncTableName;
      const id = key.slice(idx + 1);
      const baseRow = this.base[table].get(id);
      if (baseRow) this.setView(table, baseRow);
      else this.deleteView(table, id);
    }
    this.overlay.clear();
    return this.replayPending();
  }

  private replayPending(): MutationFailure[] {
    const failures: MutationFailure[] = [];
    for (const m of this.pending) {
      try {
        this.runMutation(m);
      } catch (error) {
        failures.push({ mutation: m, error: AppError.from(error) });
      }
    }
    return failures;
  }

  private runMutation(m: PendingMutation): void {
    if (!isMutatorName(m.name)) throw new AppError('validation', `Unknown mutation ${m.name}`);
    const args = parseMutatorArgs(m.name, m.args);
    // Collect writes first so a throwing mutator leaves the view untouched.
    const writes: { table: SyncTableName; row: Row }[] = [];
    const staged = new Map<string, Row>();
    const read = <T extends SyncTableName>(table: T, id: string) =>
      (staged.get(`${table}:${id}`) ?? this.view[table].get(id)) as EntityMap[T] | undefined;
    const tx: ClientTx = {
      userId: this.userId,
      now: m.createdAt,
      get: read,
      all: <T extends SyncTableName>(table: T) => {
        const merged = new Map(this.view[table]);
        for (const [key, row] of staged) if (key.startsWith(`${table}:`)) merged.set(row.id, row);
        return merged.values() as Iterable<EntityMap[T]>;
      },
      put: (table, row) => {
        staged.set(`${table}:${row.id}`, row);
        writes.push({ table, row });
      },
      patch: (table, id, patch) => {
        const current = read(table, id);
        if (!current) return;
        const row = { ...current, ...patch, updatedAt: m.createdAt };
        staged.set(`${table}:${id}`, row);
        writes.push({ table, row });
      },
      childrenOf: (taskId) => {
        const base = this.childrenOf(taskId).map((t) => (staged.get(`tasks:${t.id}`) as Task | undefined) ?? t);
        for (const [key, row] of staged) {
          if (key.startsWith('tasks:') && (row as Task).parentTaskId === taskId && !base.some((b) => b.id === row.id)) base.push(row as Task);
        }
        return base.filter((t) => t.parentTaskId === taskId);
      },
      userState: (taskId) => {
        for (const [key, row] of staged) if (key.startsWith('taskUserStates:') && (row as TaskUserState).taskId === taskId) return row as TaskUserState;
        return this.userState(taskId);
      },
    };
    (clientMutators[m.name] as (tx: ClientTx, a: unknown) => void)(tx, args);
    for (const w of writes) {
      const finalRow = staged.get(`${w.table}:${w.row.id}`)!;
      this.setView(w.table, finalRow);
      this.overlay.add(`${w.table}:${w.row.id}`);
    }
  }

  private setView(table: SyncTableName, row: Row): void {
    const prev = this.view[table].get(row.id);
    if (prev === row) return;
    this.view[table].set(row.id, row);
    if (table === 'tasks') {
      const prevParent = (prev as Task | undefined)?.parentTaskId;
      const parent = (row as Task).parentTaskId;
      if (prevParent && prevParent !== parent) this.childIndex.get(prevParent)?.delete(row.id);
      if (parent) {
        let set = this.childIndex.get(parent);
        if (!set) this.childIndex.set(parent, (set = new Set()));
        set.add(row.id);
      }
    } else if (table === 'taskUserStates') {
      const s = row as TaskUserState;
      if (s.userId === this.userId) this.stateIndex.set(s.taskId, s.id);
    }
    this.touch(table);
  }

  private deleteView(table: SyncTableName, id: string): void {
    const prev = this.view[table].get(id);
    if (!prev) return;
    this.view[table].delete(id);
    if (table === 'tasks') {
      const parent = (prev as Task).parentTaskId;
      if (parent) this.childIndex.get(parent)?.delete(id);
    } else if (table === 'taskUserStates') {
      const s = prev as TaskUserState;
      if (this.stateIndex.get(s.taskId) === id) this.stateIndex.delete(s.taskId);
    }
    this.touch(table);
  }

  private touch(table: SyncTableName) {
    this.batchTables.add(table);
  }

  private batch(fn: () => void) {
    this.batchDepth++;
    try {
      fn();
    } finally {
      this.batchDepth--;
      if (this.batchDepth === 0 && this.batchTables.size) {
        const tables = this.batchTables;
        this.batchTables = new Set();
        for (const t of tables) this.versions[t]++;
        for (const l of this.listeners) l({ tables });
      }
    }
  }
}
