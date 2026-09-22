import { createServer } from 'node:http';
import { PgBoss } from 'pg-boss';
import { serverEnv } from '@orbit/shared/env';
import { createDb } from '@orbit/database';
import { createLogger, createSupabaseStorage, ensureQueues } from '@orbit/api';
import { createMailer } from '@orbit/notifications';
import type { JobName } from '@orbit/shared';
import type { WorkerDeps } from './deps';
import { HANDLERS, SCHEDULES } from './handlers';
import { createPushSender } from './push';

/**
 * Background worker: consumes pg-boss queues and runs scheduled scans. Stateless — run as many
 * replicas as needed; pg-boss hands each job to one worker and `singleton` queues keep scans
 * from overlapping.
 */
async function main() {
  const env = serverEnv();
  const logger = createLogger(env.LOG_LEVEL, 'orbit-worker');
  const sql = createDb(env.DATABASE_URL, { max: 8 });
  const boss = new PgBoss({ connectionString: env.DATABASE_URL, schema: 'pgboss' });
  boss.on('error', (e) => logger.error({ err: String(e) }, 'pg-boss error'));
  await boss.start();
  await ensureQueues(boss, (m) => logger.warn(m));

  const deps: WorkerDeps = {
    sql,
    logger,
    storage: createSupabaseStorage({ supabaseUrl: env.SUPABASE_URL, serviceKey: env.SUPABASE_SERVICE_ROLE_KEY, bucket: env.STORAGE_BUCKET }),
    mailer: createMailer({
      provider: env.EMAIL_PROVIDER,
      from: env.EMAIL_FROM,
      smtpUrl: env.SMTP_URL,
      resendApiKey: env.RESEND_API_KEY,
      log: (msg, data) => logger.info(data ?? {}, msg),
    }),
    push: createPushSender({
      sql,
      logger,
      webPush: env.VAPID_PUBLIC_KEY && env.VAPID_PRIVATE_KEY ? { publicKey: env.VAPID_PUBLIC_KEY, privateKey: env.VAPID_PRIVATE_KEY, subject: env.VAPID_SUBJECT } : undefined,
      apns:
        env.APNS_KEY_ID && env.APNS_TEAM_ID && env.APNS_PRIVATE_KEY && env.APNS_BUNDLE_ID
          ? { keyId: env.APNS_KEY_ID, teamId: env.APNS_TEAM_ID, privateKey: env.APNS_PRIVATE_KEY, bundleId: env.APNS_BUNDLE_ID, production: env.APNS_PRODUCTION }
          : undefined,
      fcm:
        env.FCM_PROJECT_ID && env.FCM_CLIENT_EMAIL && env.FCM_PRIVATE_KEY
          ? { projectId: env.FCM_PROJECT_ID, clientEmail: env.FCM_CLIENT_EMAIL, privateKey: env.FCM_PRIVATE_KEY }
          : undefined,
    }),
    enqueue: async (name, data, opts) => {
      await boss.send(name, data, { singletonKey: opts?.singletonKey, startAfter: opts?.startAfter });
    },
    appUrl: env.APP_URL.replace(/\/$/, ''),
    now: () => new Date(),
  };

  const lastRun = new Map<string, { at: string; ok: boolean }>();
  for (const [name, handler] of Object.entries(HANDLERS) as [JobName, NonNullable<(typeof HANDLERS)[JobName]>][]) {
    await boss.work(name, { batchSize: 1 }, async ([job]) => {
      if (!job) return;
      const started = Date.now();
      try {
        const result = await handler(deps, job.data);
        lastRun.set(name, { at: new Date().toISOString(), ok: true });
        logger.info({ job: name, id: job.id, ms: Date.now() - started, result }, 'job done');
        return result;
      } catch (error) {
        lastRun.set(name, { at: new Date().toISOString(), ok: false });
        logger.error({ job: name, id: job.id, ms: Date.now() - started, err: String(error) }, 'job failed');
        throw error;
      }
    });
  }
  for (const s of SCHEDULES) {
    await boss.schedule(s.name, s.cron, s.data ?? {}, { tz: 'UTC', ...(s.key ? { key: s.key } : {}) });
  }
  logger.info({ queues: Object.keys(HANDLERS).length, schedules: SCHEDULES.length, push: deps.push.configured, email: deps.mailer.kind }, 'worker started');

  const port = Number(process.env.WORKER_PORT ?? 4003);
  const health = createServer((req, res) => {
    if (req.url === '/health') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, jobs: Object.fromEntries(lastRun) }));
      return;
    }
    res.writeHead(404).end();
  }).listen(port, () => logger.info({ port }, 'health endpoint listening'));

  let stopping = false;
  const shutdown = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    logger.info({ signal }, 'shutting down');
    health.close();
    await boss.stop({ graceful: true, timeout: 30_000 });
    await sql.end({ timeout: 5 });
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
