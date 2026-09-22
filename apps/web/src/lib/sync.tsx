'use client';

import * as React from 'react';
import { describeError, type SyncTableName } from '@orbit/shared';
import type { PullRequest, PushRequest } from '@orbit/sync';
import {
  Actions,
  EntityStore,
  IndexedDbPersistence,
  MemoryPersistence,
  SyncClient,
  type LocalPersistence,
  type SyncIssue,
  type SyncStatus,
  type SyncTransport,
} from '@orbit/sync/client';
import { toast } from '@orbit/ui';
import { apiFetch } from './api';
import { deviceId } from './platform';

/**
 * Local-first runtime for one signed-in user: IndexedDB-backed store, outbox and sync loop.
 * UI reads from `store` synchronously; writes go through `actions` / `client.mutate`.
 */

interface SyncContextValue {
  store: EntityStore;
  client: SyncClient;
  actions: Actions;
  userId: string;
  timeZone: string;
}

const Ctx = React.createContext<SyncContextValue | null>(null);

const httpTransport: SyncTransport = {
  push: (req: PushRequest) => apiFetch('/sync/push', { method: 'POST', body: req, timeoutMs: 60_000 }),
  pull: (req: PullRequest) => apiFetch('/sync/pull', { method: 'POST', body: req, timeoutMs: 60_000 }),
  reconcile: () => apiFetch('/sync/reconcile'),
};

function persistenceFor(userId: string): LocalPersistence {
  try {
    if (typeof indexedDB === 'undefined') return new MemoryPersistence();
    return new IndexedDbPersistence(`orbit-${userId}`);
  } catch {
    return new MemoryPersistence();
  }
}

export function detectTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

export function SyncProvider({ userId, onUnauthorized, children, fallback }: { userId: string; onUnauthorized: () => void; children: React.ReactNode; fallback: React.ReactNode }) {
  const [value, setValue] = React.useState<SyncContextValue | null>(null);
  const unauthorized = React.useRef(onUnauthorized);
  unauthorized.current = onUnauthorized;

  React.useEffect(() => {
    let disposed = false;
    const store = new EntityStore(userId);
    const timeZone = detectTimeZone();
    const client = new SyncClient({
      store,
      persistence: persistenceFor(userId),
      transport: httpTransport,
      userId,
      clientId: deviceId(),
      onIssue: (issue: SyncIssue) => {
        toast.error(`Couldn't save a change`, { description: describeError(issue.error as never), duration: 8000 });
      },
      onUnauthorized: () => unauthorized.current(),
      log: (msg, data) => {
        if (process.env.NODE_ENV !== 'production') console.debug('[sync]', msg, data ?? '');
      },
    });
    const actions = new Actions(client, { userId, timeZone });
    void client.hydrate().then(() => {
      if (disposed) return;
      setValue({ store, client, actions, userId, timeZone });
      client.start();
    });

    const poke = () => client.poke();
    const onVisible = () => document.visibilityState === 'visible' && client.poke();
    const onUnload = () => void client.flush();
    window.addEventListener('online', poke);
    window.addEventListener('focus', poke);
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('pagehide', onUnload);
    return () => {
      disposed = true;
      client.stop();
      window.removeEventListener('online', poke);
      window.removeEventListener('focus', poke);
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('pagehide', onUnload);
    };
  }, [userId]);

  if (!value) return <>{fallback}</>;
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useSync(): SyncContextValue {
  const ctx = React.useContext(Ctx);
  if (!ctx) throw new Error('useSync must be used inside SyncProvider');
  return ctx;
}

/**
 * Subscribe to a derived value of the store. Recomputes only when one of `tables` changes (or
 * deps change), so rows re-render only for relevant writes.
 */
export function useStoreQuery<T>(tables: readonly SyncTableName[], select: (store: EntityStore) => T, deps: React.DependencyList = []): T {
  const { store } = useSync();
  const key = tables.join(',');
  const subscribe = React.useCallback(
    (cb: () => void) =>
      store.subscribe(({ tables: changed }) => {
        for (const t of tables) if (changed.has(t)) return cb();
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [store, key],
  );
  const snapshot = React.useCallback(() => tables.map((t) => store.version(t)).join(':'), [store, key]); // eslint-disable-line react-hooks/exhaustive-deps
  const version = React.useSyncExternalStore(subscribe, snapshot, snapshot);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  return React.useMemo(() => select(store), [version, store, ...deps]);
}

export function useEntity<T extends SyncTableName>(table: T, id: string | null | undefined) {
  return useStoreQuery([table], (s) => (id ? s.get(table, id) : undefined), [id]);
}

export function useSyncStatus(): SyncStatus {
  const { client } = useSync();
  return React.useSyncExternalStore(
    (cb) => client.subscribeStatus(cb),
    () => client.getStatus(),
    () => client.getStatus(),
  );
}

/** Current time that re-renders every `intervalMs` (for Today/overdue boundaries). */
export function useNow(intervalMs = 60_000): Date {
  const [now, setNow] = React.useState(() => new Date());
  React.useEffect(() => {
    const id = setInterval(() => setNow(new Date()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}
