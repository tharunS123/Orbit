import { z } from 'zod';
import pino from 'pino';
import { parseEnv, EnvError } from '@orbit/shared/env';
import { createTokenVerifier } from '@orbit/auth';
import { createDb } from '@orbit/database';
import { createCollabServer } from './server';

const envSchema = z.object({
  DATABASE_URL: z.string().min(1),
  SUPABASE_URL: z.url(),
  SUPABASE_JWT_SECRET: z.string().optional().transform((v) => v || undefined),
  INTERNAL_API_SECRET: z.string().min(24),
  COLLAB_PORT: z.coerce.number().int().default(4001),
  LOG_LEVEL: z.string().default('info'),
});

async function main() {
  let env: z.infer<typeof envSchema>;
  try {
    env = parseEnv(envSchema);
  } catch (error) {
    console.error(error instanceof EnvError ? error.message : error);
    process.exit(1);
  }
  const logger = pino({ name: 'orbit-collab', level: env.LOG_LEVEL, redact: ['token', '*.token'] });
  const sql = createDb(env.DATABASE_URL, { max: 10 });
  const collab = createCollabServer({
    sql,
    verify: createTokenVerifier({ supabaseUrl: env.SUPABASE_URL, jwtSecret: env.SUPABASE_JWT_SECRET }),
    internalSecret: env.INTERNAL_API_SECRET,
    logger,
    port: env.COLLAB_PORT,
  });
  await collab.start();
  const shutdown = async () => {
    logger.info('shutting down');
    await collab.stop();
    await sql.end({ timeout: 5 });
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());
}

void main();
