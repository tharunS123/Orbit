import { AppError, uuidv7 } from '@orbit/shared';
import type { Sql } from '@orbit/database';
import { EntityStore } from './client/store';
import { MemoryPersistence, type LocalPersistence } from './client/persistence';
import { SyncClient, type SyncTransport } from './client/sync-client';
import { handlePull, handlePush, handleReconcile, type Job } from './server';

/** In-process transport with an on/off switch to simulate connectivity. */
export class TestTransport implements SyncTransport {
  online = true;
  jobs: Job[] = [];
  pushes = 0;
  constructor(
    private sql: Sql,
    private userId: string,
  ) {}
  private check() {
    if (!this.online) throw new AppError('network', 'offline');
  }
  async push(req: Parameters<SyncTransport['push']>[0]) {
    this.check();
    this.pushes++;
    return handlePush({ sql: this.sql, queue: { send: async (jobs) => void this.jobs.push(...jobs) } }, this.userId, req);
  }
  async pull(req: Parameters<SyncTransport['pull']>[0]) {
    this.check();
    return handlePull(this.sql, this.userId, req);
  }
  async reconcile() {
    this.check();
    return handleReconcile(this.sql, this.userId);
  }
}

export interface TestDevice {
  client: SyncClient;
  store: EntityStore;
  transport: TestTransport;
  persistence: LocalPersistence;
  issues: string[];
}

export async function createDevice(sql: Sql, userId: string, persistence: LocalPersistence = new MemoryPersistence(), clientId = uuidv7()): Promise<TestDevice> {
  const store = new EntityStore(userId);
  const transport = new TestTransport(sql, userId);
  const issues: string[] = [];
  const client = new SyncClient({
    store,
    persistence,
    transport,
    userId,
    clientId,
    onIssue: (i) => issues.push(`${i.mutation.name}:${i.error.code}`),
    reconcileIntervalMs: Number.MAX_SAFE_INTEGER,
  });
  await client.hydrate();
  return { client, store, transport, persistence, issues };
}
