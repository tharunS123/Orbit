import { PgBoss, type QueuePolicy } from 'pg-boss';
import { JOB_NAMES, JOBS, type JobName } from '@orbit/shared';
import type { Job, JobQueue } from '@orbit/sync/server';

/**
 * pg-boss-backed queue for producers. Retries with exponential backoff are configured per
 * queue; singleton keys make duplicate enqueues (e.g. retried webhooks) collapse.
 */
export async function createPgBossQueue(connectionString: string, onError: (e: unknown) => void): Promise<JobQueue & { boss: PgBoss; stop(): Promise<void> }> {
  const boss = new PgBoss({ connectionString, schema: 'pgboss', supervise: false, schedule: false });
  boss.on('error', onError);
  await boss.start();
  await ensureQueues(boss, (m) => onError(new Error(m)));
  return {
    boss,
    async send(jobs: Job[]) {
      for (const job of jobs) {
        await boss.send(job.name, job.data, {
          singletonKey: job.opts?.singletonKey,
          startAfter: job.opts?.startAfter,
          retryLimit: 5,
          retryDelay: 15,
          retryBackoff: true,
        });
      }
    },
    async stop() {
      await boss.stop({ graceful: true });
    },
  };
}

/**
 * Queue policies. `short` keeps at most one *waiting* job per singletonKey (debounce: producers
 * must always pass a key); `singleton` allows one *running* job at a time (scheduled scans).
 */
export const QUEUE_POLICIES: Partial<Record<JobName, QueuePolicy>> = {
  [JOBS.notificationDeliver]: 'short',
  [JOBS.accountDelete]: 'short',
  [JOBS.remindersScan]: 'singleton',
  [JOBS.trashPurge]: 'singleton',
  [JOBS.maintenance]: 'singleton',
  [JOBS.meetingRetention]: 'singleton',
  [JOBS.integrationPoll]: 'singleton',
};

export async function ensureQueues(boss: PgBoss, warn: (msg: string) => void = () => {}): Promise<void> {
  const existing = new Map((await boss.getQueues()).map((q) => [q.name, q]));
  for (const name of JOB_NAMES) {
    const policy = QUEUE_POLICIES[name] ?? 'standard';
    const queue = existing.get(name);
    if (queue && queue.policy !== policy) {
      // Policies are immutable in pg-boss; recreate only when nothing would be lost.
      const stats = await boss.getQueue(name);
      if (stats && stats.totalCount === 0) {
        await boss.deleteQueue(name);
        existing.delete(name);
      } else {
        warn(`queue ${name} has policy ${queue.policy}, expected ${policy}; drain it to migrate`);
      }
    }
    if (!existing.has(name)) await boss.createQueue(name, { policy, retryLimit: 5, retryDelay: 15, retryBackoff: true });
  }
}

/** Queue that records jobs in memory (tests) or drops them with a log (no DB queue configured). */
export function createMemoryQueue(): JobQueue & { jobs: Job[] } {
  const jobs: Job[] = [];
  return {
    jobs,
    async send(batch) {
      jobs.push(...batch);
    },
  };
}
