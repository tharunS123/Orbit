import { AppError, uuidv7, type SyncTableName } from '@orbit/shared';
import { parseMutatorArgs, type MutatorInput, type MutatorName } from '../mutators';
import type { ChangeSet, PendingMutation, PullRequest, PullResponse, PushRequest, PushResponse } from '../protocol';
import type { LocalPersistence, PersistBatch, Row, SyncMeta } from './persistence';
import { SCHEMA_VERSION } from './persistence';
import type { EntityStore} from './store';
import { type MutationFailure } from './store';

/**
 * Orchestrates local-first sync:
 *   1. hydrate the store from local persistence (instant, offline-capable startup)
 *   2. push the outbox in order (idempotent mutation ids)
 *   3. pull changes since the cursor, rebase pending mutations, persist atomically
 *   4. repeat on pokes, reconnects, focus, and a slow fallback timer
 * Nothing the user did is ever dropped silently: rejected mutations become SyncIssues.
 */

export interface SyncTransport {
  push(req: PushRequest): Promise<PushResponse>;
  pull(req: PullRequest): Promise<PullResponse>;
  /** Ids of every row the user can currently see, per table (reconciliation). */
  reconcile?(): Promise<Partial<Record<SyncTableName, string[]>>>;
}

export type SyncState = 'idle' | 'syncing' | 'offline' | 'error';

export interface SyncStatus {
  state: SyncState;
  pending: number;
  lastSyncedAt: string | null;
  error: AppError | null;
  hydrated: boolean;
}

export interface SyncIssue {
  id: string;
  mutation: PendingMutation;
  error: { code: string; message: string };
  at: string;
}

export interface SyncClientOptions {
  store: EntityStore;
  persistence: LocalPersistence;
  transport: SyncTransport;
  userId: string;
  clientId?: string;
  /** Called with rejected mutations so the UI can explain what didn't save. */
  onIssue?: (issue: SyncIssue) => void;
  /** Called when the server says the session is invalid. */
  onUnauthorized?: () => void;
  now?: () => Date;
  pullIntervalMs?: number;
  reconcileIntervalMs?: number;
  log?: (msg: string, data?: unknown) => void;
}

const PUSH_BATCH = 100;

export class SyncClient {
  readonly store: EntityStore;
  private persistence: LocalPersistence;
  private transport: SyncTransport;
  private meta: SyncMeta;
  private status: SyncStatus = { state: 'idle', pending: 0, lastSyncedAt: null, error: null, hydrated: false };
  private statusListeners = new Set<(s: SyncStatus) => void>();
  private running = false;
  private cycle: Promise<void> | null = null;
  private again = false;
  private backoffMs = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private interval: ReturnType<typeof setInterval> | null = null;
  private persistChain: Promise<void> = Promise.resolve();
  readonly issues: SyncIssue[] = [];

  constructor(private readonly opts: SyncClientOptions) {
    this.store = opts.store;
    this.persistence = opts.persistence;
    this.transport = opts.transport;
    this.meta = {
      schemaVersion: SCHEMA_VERSION,
      userId: opts.userId,
      clientId: opts.clientId ?? uuidv7(),
      cursor: '0',
      scope: null,
      lastPullAt: null,
      lastReconcileAt: null,
    };
  }

  get clientId() {
    return this.meta.clientId;
  }

  // ───────────── lifecycle ─────────────

  /** Load the local cache. Never touches the network; safe to await before first render. */
  async hydrate(): Promise<void> {
    try {
      const state = await this.persistence.load();
      const meta = state.meta;
      if (meta && (meta.schemaVersion !== SCHEMA_VERSION || meta.userId !== this.opts.userId)) {
        // Schema changed or another user's cache: rebuild from the server, keep our outbox.
        const pending = meta.userId === this.opts.userId ? state.pending : [];
        await this.persistence.clearCache();
        await this.persistence.apply({ meta: { ...this.meta, clientId: meta.clientId || this.meta.clientId } });
        this.meta.clientId = meta.clientId || this.meta.clientId;
        this.reportFailures(this.store.hydrate({}, pending));
      } else {
        if (meta) this.meta = { ...this.meta, ...meta };
        else await this.persistence.apply({ meta: this.meta });
        this.reportFailures(this.store.hydrate(state.rows, state.pending));
      }
    } catch (error) {
      // Corrupt cache: salvage the outbox, wipe rows, rebuild from the server.
      this.log('local cache unreadable; rebuilding', error);
      let pending: PendingMutation[] = [];
      try {
        pending = await this.persistence.loadPending();
      } catch (e) {
        this.log('outbox unreadable', e);
      }
      await this.persistence.clearCache().catch((e) => this.log('clearCache failed', e));
      await this.persistence.apply({ meta: this.meta }).catch((e) => this.log('meta write failed', e));
      this.reportFailures(this.store.hydrate({}, pending));
    }
    this.setStatus({ hydrated: true, pending: this.store.pendingMutations().length, lastSyncedAt: this.meta.lastPullAt });
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.interval = setInterval(() => this.sync(), this.opts.pullIntervalMs ?? 60_000);
    void this.sync();
  }

  stop(): void {
    this.running = false;
    if (this.interval) clearInterval(this.interval);
    if (this.timer) clearTimeout(this.timer);
    this.interval = this.timer = null;
  }

  /** Flush pending persistence writes (e.g. before page unload). */
  async flush(): Promise<void> {
    await this.persistChain;
  }

  // ───────────── mutations ─────────────

  /**
   * Apply a mutation locally and queue it. Validates args synchronously; throws AppError for
   * invalid input or impossible local state (nothing is queued in that case).
   */
  mutate<N extends MutatorName>(name: N, args: MutatorInput<N>): PendingMutation {
    const parsed = parseMutatorArgs(name, args);
    const mutation: PendingMutation = { id: uuidv7(), name, args: parsed, createdAt: this.now().toISOString() };
    this.store.mutate(mutation);
    this.persist({ pendingAdd: [mutation] });
    this.setStatus({ pending: this.store.pendingMutations().length });
    this.schedule(0);
    return mutation;
  }

  // ───────────── sync loop ─────────────

  /** Request a sync soon (coalesced). Call on pokes, focus, online events. */
  poke(): void {
    this.schedule(30);
  }

  private schedule(delay: number) {
    if (!this.running) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.sync();
    }, Math.max(delay, this.backoffMs));
  }

  /** Run one push+pull cycle; concurrent calls coalesce into one follow-up cycle. */
  sync(): Promise<void> {
    if (this.cycle) {
      this.again = true;
      return this.cycle;
    }
    this.cycle = (async () => {
      do {
        this.again = false;
        await this.runCycle();
      } while (this.again && this.running);
    })().finally(() => {
      this.cycle = null;
    });
    return this.cycle;
  }

  private async runCycle(): Promise<void> {
    this.setStatus({ state: 'syncing' });
    try {
      const acked = await this.push();
      await this.pull();
      if (acked.length) {
        this.reportFailures(this.store.acknowledge(acked));
        this.persist({ pendingRemove: acked });
      }
      await this.maybeReconcile();
      this.backoffMs = 0;
      this.setStatus({ state: 'idle', error: null, pending: this.store.pendingMutations().length, lastSyncedAt: this.meta.lastPullAt });
      if (this.store.pendingMutations().length) this.again = true;
    } catch (error) {
      const err = AppError.from(error);
      if (err.code === 'unauthorized') this.opts.onUnauthorized?.();
      const offline = err.code === 'network' || err.code === 'timeout';
      this.backoffMs = Math.min(60_000, this.backoffMs ? this.backoffMs * 2 : 1_000);
      this.setStatus({ state: offline ? 'offline' : 'error', error: err, pending: this.store.pendingMutations().length });
      this.log('sync failed', err);
      this.schedule(this.backoffMs);
    }
  }

  /** Push the outbox in order. Returns ids the server has decided (applied or rejected). */
  private async push(): Promise<string[]> {
    const decided: string[] = [];
    const pending = [...this.store.pendingMutations()];
    for (let i = 0; i < pending.length; i += PUSH_BATCH) {
      const batch = pending.slice(i, i + PUSH_BATCH);
      const res = await this.transport.push({ clientId: this.meta.clientId, mutations: batch });
      for (const r of res.results) {
        decided.push(r.id);
        if (r.status === 'rejected') {
          const mutation = batch.find((m) => m.id === r.id);
          if (mutation) {
            const issue: SyncIssue = {
              id: r.id,
              mutation,
              error: r.error ?? { code: 'internal', message: 'Rejected by server' },
              at: this.now().toISOString(),
            };
            this.issues.push(issue);
            this.opts.onIssue?.(issue);
          }
        }
      }
      if (res.incomplete) break;
    }
    return decided;
  }

  private async pull(): Promise<void> {
    let request: PullRequest = { clientId: this.meta.clientId, cursor: this.meta.cursor };
    for (let guard = 0; guard < 1000; guard++) {
      const res = await this.transport.pull(request);
      await this.applyPull(res);
      if (res.page) {
        request = { clientId: this.meta.clientId, cursor: this.meta.cursor, page: res.page, backfill: request.backfill ?? null };
        continue;
      }
      if (!request.backfill && res.cursor) this.meta.cursor = res.cursor;
      // Newly visible scopes need their full history.
      const prev = this.meta.scope;
      const newWs = prev ? res.scope.workspaceIds.filter((w) => !prev.workspaceIds.includes(w)) : [];
      const newLists = prev ? res.scope.listIds.filter((l) => !prev.listIds.includes(l)) : [];
      this.meta.scope = res.scope;
      this.meta.lastPullAt = res.serverTime;
      this.persist({ meta: { cursor: this.meta.cursor, scope: res.scope, lastPullAt: res.serverTime } });
      if (newWs.length || newLists.length) {
        request = { clientId: this.meta.clientId, cursor: '0', backfill: { workspaceIds: newWs, listIds: newLists } };
        continue;
      }
      return;
    }
  }

  private async applyPull(res: PullResponse): Promise<void> {
    const scope = res.scope;
    const ws = new Set(scope.workspaceIds);
    const lists = new Set(scope.listIds);
    const userId = this.opts.userId;
    const purge = (table: SyncTableName, row: Row): boolean => {
      const r = row as Record<string, unknown>;
      switch (table) {
        case 'profiles':
          return false;
        case 'workspaces':
          return !ws.has(row.id);
        case 'workspaceInvitations':
          return false; // addressed to us even without membership; server tombstones them
        case 'notifications':
          return r.userId !== userId;
        case 'lists':
          return !lists.has(row.id);
        default: {
          if (typeof r.workspaceId === 'string' && !ws.has(r.workspaceId)) return true;
          if (table === 'tasks' && typeof r.listId === 'string' && !lists.has(r.listId)) return true;
          if (table === 'listMembers' && typeof r.listId === 'string' && !lists.has(r.listId) && r.userId !== userId) return true;
          return false;
        }
      }
    };
    const { changedBase, removed, failures } = this.store.applyServerChanges(res.changes as ChangeSet as Partial<Record<SyncTableName, Row[]>>, purge);
    this.reportFailures(failures);
    const batch: PersistBatch = {
      puts: changedBase.flatMap((c) => c.rows.map((row) => ({ table: c.table, row }))),
      deletes: removed,
    };
    this.persist(batch);
    await this.persistChain;
  }

  private async maybeReconcile(): Promise<void> {
    if (!this.transport.reconcile) return;
    const last = this.meta.lastReconcileAt ? Date.parse(this.meta.lastReconcileAt) : 0;
    if (this.now().getTime() - last < (this.opts.reconcileIntervalMs ?? 6 * 3600_000)) return;
    const visible = await this.transport.reconcile();
    const deletes: { table: SyncTableName; id: string }[] = [];
    this.store.applyServerChanges({}, (table, row) => {
      const ids = visible[table];
      if (!ids) return false;
      const gone = !ids.includes(row.id);
      if (gone) deletes.push({ table, id: row.id });
      return gone;
    });
    this.meta.lastReconcileAt = this.now().toISOString();
    this.persist({ deletes, meta: { lastReconcileAt: this.meta.lastReconcileAt } });
  }

  /** Throw away the row cache and rebuild from the server (keeps the outbox). */
  async rebuildCache(): Promise<void> {
    const pending = [...this.store.pendingMutations()];
    await this.persistence.clearCache();
    this.meta.cursor = '0';
    this.meta.scope = null;
    this.store.hydrate({}, pending);
    await this.sync();
  }

  // ───────────── status ─────────────

  getStatus(): SyncStatus {
    return this.status;
  }

  subscribeStatus(fn: (s: SyncStatus) => void): () => void {
    this.statusListeners.add(fn);
    return () => this.statusListeners.delete(fn);
  }

  private setStatus(patch: Partial<SyncStatus>) {
    this.status = { ...this.status, ...patch };
    for (const l of this.statusListeners) l(this.status);
  }

  private persist(batch: PersistBatch) {
    this.persistChain = this.persistChain
      .then(() => this.persistence.apply(batch))
      .catch((error) => {
        this.log('persist failed', error);
        this.setStatus({ state: 'error', error: new AppError('internal', 'Could not save to this device.') });
      });
  }

  private reportFailures(failures: MutationFailure[]) {
    for (const f of failures) this.log(`pending mutation ${f.mutation.name} no longer applies locally`, f.error.code);
  }

  private now(): Date {
    return this.opts.now?.() ?? new Date();
  }

  private log(msg: string, data?: unknown) {
    this.opts.log?.(msg, data);
  }
}
