import { z } from 'zod';

/**
 * Environment validation. Each process validates only the variables it needs, at startup, and
 * fails with a readable list of problems instead of crashing later with `undefined`.
 */

const optionalString = z
  .string()
  .optional()
  .transform((v) => (v === '' ? undefined : v));

export const serverEnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  APP_URL: z.url().default('http://localhost:3000'),
  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).default('info'),

  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),

  SUPABASE_URL: z.url(),
  SUPABASE_ANON_KEY: z.string().min(1),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1),
  /** HS256 secret (local/legacy projects). If absent the JWKS endpoint is used. */
  SUPABASE_JWT_SECRET: optionalString,
  STORAGE_BUCKET: z.string().default('orbit-private'),

  /** 32-byte base64 key for encrypting OAuth tokens at rest (AES-256-GCM). */
  ENCRYPTION_KEY: z
    .string()
    .refine((v) => Buffer.from(v, 'base64').length === 32, 'ENCRYPTION_KEY must be 32 bytes base64'),
  /** Shared secret for service-to-service calls (API → collaboration server). */
  INTERNAL_API_SECRET: z.string().min(24),

  COLLAB_URL: z.string().default('ws://localhost:4001'),
  COLLAB_INTERNAL_URL: z.string().default('http://localhost:4001'),
  MCP_PUBLIC_URL: z.string().default('http://localhost:4002/mcp'),

  GOOGLE_CLIENT_ID: optionalString,
  GOOGLE_CLIENT_SECRET: optionalString,
  GOOGLE_PUBSUB_TOPIC: optionalString,
  SLACK_CLIENT_ID: optionalString,
  SLACK_CLIENT_SECRET: optionalString,
  SLACK_SIGNING_SECRET: optionalString,
  GITHUB_APP_CLIENT_ID: optionalString,
  GITHUB_APP_CLIENT_SECRET: optionalString,
  GITHUB_WEBHOOK_SECRET: optionalString,
  LINEAR_CLIENT_ID: optionalString,
  LINEAR_CLIENT_SECRET: optionalString,
  LINEAR_WEBHOOK_SECRET: optionalString,
  MICROSOFT_CLIENT_ID: optionalString,
  MICROSOFT_CLIENT_SECRET: optionalString,
  MICROSOFT_TENANT: z.string().default('common'),

  EMAIL_PROVIDER: z.enum(['console', 'resend', 'smtp']).default('console'),
  EMAIL_FROM: z.string().default('Orbit <no-reply@orbit.example>'),
  RESEND_API_KEY: optionalString,
  SMTP_URL: optionalString,
  INBOUND_EMAIL_DOMAIN: z.string().default('in.orbit.example'),
  INBOUND_EMAIL_PROVIDER: z.enum(['postmark', 'resend', 'generic']).default('generic'),
  INBOUND_EMAIL_SECRET: optionalString,

  STRIPE_SECRET_KEY: optionalString,
  STRIPE_WEBHOOK_SECRET: optionalString,
  STRIPE_PRICE_PLUS_MONTHLY: optionalString,
  STRIPE_PRICE_PLUS_YEARLY: optionalString,
  STRIPE_PRICE_ULTRA_MONTHLY: optionalString,
  STRIPE_PRICE_ULTRA_YEARLY: optionalString,
  REVENUECAT_WEBHOOK_AUTH: optionalString,
  REVENUECAT_API_KEY: optionalString,
  BILLING_DEV_MODE: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),

  AI_TEXT_PROVIDER: z.enum(['anthropic', 'openai', 'none']).default('none'),
  AI_TEXT_MODEL: optionalString,
  AI_FAST_MODEL: optionalString,
  AI_TRANSCRIPTION_PROVIDER: z.enum(['openai', 'deepgram', 'none']).default('none'),
  AI_TRANSCRIPTION_MODEL: optionalString,
  AI_EMBEDDING_PROVIDER: z.enum(['openai', 'none']).default('none'),
  ANTHROPIC_API_KEY: optionalString,
  OPENAI_API_KEY: optionalString,
  DEEPGRAM_API_KEY: optionalString,
  AI_REQUEST_TIMEOUT_MS: z.coerce.number().int().positive().default(60_000),

  VAPID_PUBLIC_KEY: optionalString,
  VAPID_PRIVATE_KEY: optionalString,
  VAPID_SUBJECT: z.string().default('mailto:support@orbit.example'),
  APNS_KEY_ID: optionalString,
  APNS_TEAM_ID: optionalString,
  APNS_PRIVATE_KEY: optionalString,
  APNS_BUNDLE_ID: optionalString,
  APNS_PRODUCTION: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
  FCM_PROJECT_ID: optionalString,
  FCM_CLIENT_EMAIL: optionalString,
  FCM_PRIVATE_KEY: optionalString,

  ANALYTICS_PROVIDER: z.enum(['none', 'console', 'posthog']).default('none'),
  POSTHOG_KEY: optionalString,
  POSTHOG_HOST: z.string().default('https://eu.i.posthog.com'),

  FLAGS: optionalString,
});

export type ServerEnv = z.infer<typeof serverEnvSchema>;

export class EnvError extends Error {
  constructor(public readonly issues: string[]) {
    super(`Invalid environment configuration:\n  - ${issues.join('\n  - ')}`);
    this.name = 'EnvError';
  }
}

export function parseEnv<S extends z.ZodType>(
  schema: S,
  source: Record<string, string | undefined> = process.env,
): z.infer<S> {
  const result = schema.safeParse(source);
  if (!result.success) {
    throw new EnvError(
      result.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`),
    );
  }
  return result.data;
}

let cached: ServerEnv | undefined;
/** Lazily validated full server environment. */
export function serverEnv(): ServerEnv {
  cached ??= parseEnv(serverEnvSchema);
  return cached;
}
/** For tests. */
export function resetServerEnvCache(): void {
  cached = undefined;
}

/** Which optional capabilities are configured. Used to render "needs setup" states honestly. */
export function configuredCapabilities(env: ServerEnv) {
  return {
    google: Boolean(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET),
    slack: Boolean(env.SLACK_CLIENT_ID && env.SLACK_CLIENT_SECRET && env.SLACK_SIGNING_SECRET),
    github: Boolean(env.GITHUB_APP_CLIENT_ID && env.GITHUB_APP_CLIENT_SECRET),
    linear: Boolean(env.LINEAR_CLIENT_ID && env.LINEAR_CLIENT_SECRET),
    microsoft: Boolean(env.MICROSOFT_CLIENT_ID && env.MICROSOFT_CLIENT_SECRET),
    inboundEmail: Boolean(env.INBOUND_EMAIL_SECRET),
    stripe: Boolean(env.STRIPE_SECRET_KEY && env.STRIPE_WEBHOOK_SECRET),
    revenuecat: Boolean(env.REVENUECAT_WEBHOOK_AUTH),
    aiText:
      (env.AI_TEXT_PROVIDER === 'anthropic' && Boolean(env.ANTHROPIC_API_KEY)) ||
      (env.AI_TEXT_PROVIDER === 'openai' && Boolean(env.OPENAI_API_KEY)),
    aiTranscription:
      (env.AI_TRANSCRIPTION_PROVIDER === 'openai' && Boolean(env.OPENAI_API_KEY)) ||
      (env.AI_TRANSCRIPTION_PROVIDER === 'deepgram' && Boolean(env.DEEPGRAM_API_KEY)),
    webPush: Boolean(env.VAPID_PUBLIC_KEY && env.VAPID_PRIVATE_KEY),
    apns: Boolean(env.APNS_KEY_ID && env.APNS_TEAM_ID && env.APNS_PRIVATE_KEY),
    fcm: Boolean(env.FCM_PROJECT_ID && env.FCM_CLIENT_EMAIL && env.FCM_PRIVATE_KEY),
    email: env.EMAIL_PROVIDER !== 'console',
  };
}
export type Capabilities = ReturnType<typeof configuredCapabilities>;
