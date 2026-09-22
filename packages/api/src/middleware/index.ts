import type { MiddlewareHandler } from 'hono';
import { ZodError, type ZodType, type z } from 'zod';
import { AppError, uuidv7 } from '@orbit/shared';
import { asService, mapDbError } from '@orbit/database';
import type { ApiDeps, ApiEnv, Ctx } from '../context';
import { clientIp } from '../context';

export function baseMiddleware(deps: ApiDeps): MiddlewareHandler<ApiEnv> {
  return async (c, next) => {
    const requestId = c.req.header('x-request-id')?.slice(0, 64) || uuidv7();
    const log = deps.logger.child({ requestId });
    c.set('requestId', requestId);
    c.set('log', log);
    c.set('deps', deps);
    c.header('x-request-id', requestId);
    const started = performance.now();
    await next();
    const ms = Math.round(performance.now() - started);
    const status = c.res.status;
    const line = { method: c.req.method, path: new URL(c.req.url).pathname, status, ms };
    if (status >= 500) log.error(line, 'request failed');
    else if (ms > 1500) log.warn(line, 'slow request');
    else log.debug(line, 'request');
  };
}

export function errorResponse(c: Ctx, error: unknown) {
  const log = c.get('log');
  let err: AppError;
  if (error instanceof ZodError) {
    err = new AppError('validation', error.issues.map((i) => `${i.path.join('.') || 'input'}: ${i.message}`).join('; '));
  } else {
    const mapped = mapDbError(error);
    err = mapped instanceof AppError ? mapped : AppError.from(mapped);
    if (!(mapped instanceof AppError)) log?.error({ err: error }, 'unhandled error');
  }
  // Never leak internals to clients.
  const body = err.code === 'internal' ? { code: err.code, message: 'Something went wrong on our side.' } : err.toJSON();
  if (err.details && 'db' in err.details) delete (body as { details?: unknown }).details;
  return c.json({ error: body }, err.status as never);
}

export function requireAuth(): MiddlewareHandler<ApiEnv> {
  return async (c, next) => {
    const header = c.req.header('authorization');
    const token = header?.startsWith('Bearer ') ? header.slice(7) : null;
    if (!token) throw new AppError('unauthorized', 'Please sign in.');
    const user = await c.get('deps').verify(token);
    c.set('user', user);
    await next();
  };
}

/**
 * Fixed-window rate limit backed by Postgres (works across instances). `key` receives the
 * context so limits can be per-user or per-IP.
 */
export function rateLimit(name: string, limit: number, windowSeconds: number, key: (c: Ctx) => string = (c) => c.get('user')?.userId ?? clientIp(c)): MiddlewareHandler<ApiEnv> {
  return async (c, next) => {
    const deps = c.get('deps');
    const bucket = `${name}:${key(c)}`;
    const windowStart = new Date(Math.floor(Date.now() / (windowSeconds * 1000)) * windowSeconds * 1000);
    const [row] = await asService(deps.sql, (tx) => tx<{ count: number }[]>`
      insert into rate_limits (key, window_start, count) values (${bucket}, ${windowStart}, 1)
      on conflict (key, window_start) do update set count = rate_limits.count + 1
      returning count`);
    const count = row?.count ?? 1;
    c.header('x-ratelimit-limit', String(limit));
    c.header('x-ratelimit-remaining', String(Math.max(0, limit - count)));
    if (count > limit) {
      c.header('retry-after', String(windowSeconds));
      throw new AppError('rate_limited', 'Too many requests. Please slow down.');
    }
    await next();
  };
}

export async function body<S extends ZodType>(c: Ctx, schema: S): Promise<z.infer<S>> {
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    throw new AppError('validation', 'Expected a JSON body.');
  }
  return schema.parse(raw);
}

export function query<S extends ZodType>(c: Ctx, schema: S): z.infer<S> {
  return schema.parse(Object.fromEntries(new URL(c.req.url).searchParams));
}
