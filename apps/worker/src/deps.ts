import type { Sql } from '@orbit/database';
import type { Logger, StorageAdapter } from '@orbit/api';
import type { Mailer, PushPayload } from '@orbit/notifications';
import type { JobName } from '@orbit/shared';

/**
 * Everything a job handler needs. Handlers are plain async functions over these dependencies so
 * they run identically under pg-boss in production and directly in tests.
 */
export interface WorkerDeps {
  sql: Sql;
  logger: Logger;
  storage: StorageAdapter;
  mailer: Mailer;
  push: PushSender;
  enqueue: (name: JobName, data: Record<string, unknown>, opts?: { singletonKey?: string; startAfter?: Date }) => Promise<void>;
  appUrl: string;
  now: () => Date;
}

export interface PushSender {
  /** Whether any push channel is configured at all. */
  readonly configured: boolean;
  /** Deliver to every active token of the user; returns how many devices accepted it. */
  send(userId: string, payload: PushPayload): Promise<number>;
}
