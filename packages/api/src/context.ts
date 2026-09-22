import type { Context, Hono } from 'hono';
import type { AuthenticatedUser, TokenVerifier } from '@orbit/auth';
import type { Sql } from '@orbit/database';
import type { Flags } from '@orbit/shared';
import type { Capabilities, ServerEnv } from '@orbit/shared/env';
import type { JobQueue } from '@orbit/sync/server';
import type { Mailer } from '@orbit/notifications';
import type { Logger } from './logger';
import type { StorageAdapter } from './services/storage';

/** Optional feature services wired by the host (web app / standalone server / tests). */
export interface ApiExtensions {
  /**
   * Extra route modules (AI, meetings, integrations, billing, MCP tokens) mounted under /api.
   * `pub` routes are anonymous (webhooks, OAuth callbacks); `authed` routes require a session.
   */
  routes?: ((pub: Hono<ApiEnv>, authed: Hono<ApiEnv>, deps: ApiDeps) => void)[];
}

export interface ApiDeps {
  env: ServerEnv;
  sql: Sql;
  verify: TokenVerifier;
  storage: StorageAdapter;
  mailer: Mailer;
  queue: JobQueue;
  logger: Logger;
  capabilities: Capabilities;
  flags: Flags;
  extensions?: ApiExtensions;
}

export interface ApiEnv {
  Variables: {
    user: AuthenticatedUser;
    requestId: string;
    log: Logger;
    deps: ApiDeps;
  };
}

export type Ctx = Context<ApiEnv>;

export function clientIp(c: Ctx): string {
  const fwd = c.req.header('x-forwarded-for');
  return (fwd?.split(',')[0] ?? c.req.header('x-real-ip') ?? 'unknown').trim();
}
