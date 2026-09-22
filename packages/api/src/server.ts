import { configuredCapabilities, serverEnv, type ServerEnv } from '@orbit/shared/env';
import { parseFlags } from '@orbit/shared';
import { createTokenVerifier } from '@orbit/auth';
import { createDb } from '@orbit/database';
import { createMailer } from '@orbit/notifications';
import type { Hono } from 'hono';
import { createApi } from './app';
import type { ApiDeps, ApiEnv, ApiExtensions } from './context';
import { createLogger } from './logger';
import { createPgBossQueue } from './services/queue';
import { createSupabaseStorage } from './services/storage';

/**
 * Build production dependencies from the validated environment. Cached on globalThis so Next.js
 * dev reloads and concurrent requests share one pool and one queue connection.
 */

type Cache = { deps?: Promise<ApiDeps>; app?: Promise<Hono<ApiEnv>> };
const g = globalThis as unknown as { __orbitApi?: Cache };
const cache: Cache = (g.__orbitApi ??= {});

export async function buildDeps(env: ServerEnv = serverEnv(), extensions?: ApiExtensions): Promise<ApiDeps> {
  const logger = createLogger(env.LOG_LEVEL, 'orbit-api');
  const sql = createDb(env.DATABASE_URL);
  const queue = await createPgBossQueue(env.DATABASE_URL, (e) => logger.error({ err: String(e) }, 'queue error'));
  return {
    env,
    sql,
    logger,
    queue,
    verify: createTokenVerifier({ supabaseUrl: env.SUPABASE_URL, jwtSecret: env.SUPABASE_JWT_SECRET }),
    storage: createSupabaseStorage({ supabaseUrl: env.SUPABASE_URL, serviceKey: env.SUPABASE_SERVICE_ROLE_KEY, bucket: env.STORAGE_BUCKET }),
    mailer: createMailer({
      provider: env.EMAIL_PROVIDER,
      from: env.EMAIL_FROM,
      smtpUrl: env.SMTP_URL,
      resendApiKey: env.RESEND_API_KEY,
      log: (msg, data) => logger.info(data ?? {}, msg),
    }),
    capabilities: configuredCapabilities(env),
    flags: parseFlags(env.FLAGS),
    extensions,
  };
}

export function getApi(extensions?: () => Promise<ApiExtensions>): Promise<Hono<ApiEnv>> {
  cache.app ??= (async () => {
    const ext = extensions ? await extensions() : undefined;
    const deps = await (cache.deps ??= buildDeps(serverEnv(), ext));
    return createApi(deps);
  })();
  cache.app.catch(() => {
    cache.app = undefined;
    cache.deps = undefined;
  });
  return cache.app;
}
