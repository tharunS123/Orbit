import { PgBoss } from 'pg-boss';
import { JOB_NAMES } from '@orbit/shared';
import type { Job, JobQueue } from '@orbit/sync/server';

/**
 * pg-boss-backed queue for producers. Retries with exponential backoff are configured per
 * queue; singleton keys make duplicate enqueues (e.g. retried webhooks) collapse.
 */
export async function createPgBossQueue(connectionString: string, onError: (e: unknown) => void): Promise<JobQueue & { boss: PgBoss; stop(): Promise<void> }> {
  const boss = new PgBoss({ connectionString, schema: 'pgboss', supervise: false, schedule: false });
  boss.on('error', onError);
  await boss.start();
  await ensureQueues(boss);
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

export async function ensureQueues(boss: PgBoss): Promise<void> {
  const existing = new Set((await boss.getQueues()).map((q) => q.name));
  for (const name of JOB_NAMES) {
    if (!existing.has(name)) await boss.createQueue(name, { retryLimit: 5, retryDelay: 15, retryBackoff: true });
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
