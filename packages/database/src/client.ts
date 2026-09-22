import postgres from 'postgres';
import { AppError } from '@orbit/shared';

/**
 * Postgres access. All user-initiated work goes through `asUser`, which opens a transaction,
 * switches to the `authenticated` role and sets the JWT claims Supabase's `auth.uid()` reads —
 * so Row Level Security is enforced for every statement. `asService` is reserved for webhooks,
 * the worker and explicitly-audited server flows.
 */

export type Sql = postgres.Sql<Record<string, never>>;
export type Tx = postgres.TransactionSql<Record<string, never>>;
export type Db = Sql | Tx;

export interface DbOptions {
  /** Max pool size (default 10). */
  max?: number;
  /** Disable prepared statements (required behind PgBouncer transaction mode). */
  prepare?: boolean;
  debug?: boolean;
}

const toIso = (value: string) => {
  // Postgres text format: "2026-09-22 15:32:48.123456+00"
  const d = new Date(value.includes('T') ? value : value.replace(' ', 'T').replace(/([+-]\d{2})$/, '$1:00'));
  return Number.isNaN(d.getTime()) ? value : d.toISOString();
};

export function createDb(url: string, options: DbOptions = {}): Sql {
  return postgres(url, {
    max: options.max ?? 10,
    prepare: options.prepare ?? !/pooler|:6543\b/.test(url),
    idle_timeout: 30,
    connect_timeout: 10,
    // pg_trgm operators live in the `extensions` schema on Supabase.
    connection: { TimeZone: 'UTC', application_name: 'orbit', search_path: '"$user", public, extensions' },
    transform: postgres.camel,
    onnotice: () => {},
    debug: options.debug ? (_conn, query) => console.debug(query) : undefined,
    types: {
      // Timestamps as ISO strings (wire format for the sync protocol).
      timestamptz: {
        to: 1184,
        from: [1184, 1114],
        serialize: (x: unknown) => (x instanceof Date ? x.toISOString() : String(x)),
        parse: (x: string) => toIso(x),
      },
      // Civil dates stay strings (never shifted by time zones).
      date: { to: 1082, from: [1082], serialize: (x: unknown) => String(x), parse: (x: string) => x },
      // Counts and sizes as numbers.
      bigint: { to: 20, from: [20], serialize: (x: unknown) => String(x), parse: (x: string) => Number(x) },
    },
  }) as unknown as Sql;
}

export interface UserContext {
  userId: string;
  /** Extra claims (e.g. email, session id) forwarded to `request.jwt.claims`. */
  claims?: Record<string, unknown>;
}

export interface TxOptions {
  isolation?: 'read committed' | 'repeatable read' | 'serializable';
  readOnly?: boolean;
}

function beginMode(opts: TxOptions): string {
  return [opts.isolation ? `isolation level ${opts.isolation}` : '', opts.readOnly ? 'read only' : 'read write']
    .filter(Boolean)
    .join(' ');
}

/** Run `fn` in a transaction as the given user with RLS enforced. */
export async function asUser<T>(sql: Sql, ctx: UserContext, fn: (tx: Tx) => Promise<T>, opts: TxOptions = {}): Promise<T> {
  const claims = JSON.stringify({ ...ctx.claims, sub: ctx.userId, role: 'authenticated' });
  try {
    return (await sql.begin(beginMode(opts), async (tx) => {
      await tx`select set_config('request.jwt.claims', ${claims}, true), set_config('request.jwt.claim.sub', ${ctx.userId}, true)`;
      await tx.unsafe('set local role authenticated');
      return fn(tx);
    })) as T;
  } catch (error) {
    throw mapDbError(error);
  }
}

/** Run `fn` in a transaction with service privileges. Callers must authorize explicitly. */
export async function asService<T>(sql: Sql, fn: (tx: Tx) => Promise<T>): Promise<T> {
  try {
    return (await sql.begin(async (tx) => fn(tx))) as T;
  } catch (error) {
    throw mapDbError(error);
  }
}

/** Run as anonymous (only public entry points are executable). */
export async function asAnon<T>(sql: Sql, fn: (tx: Tx) => Promise<T>): Promise<T> {
  try {
    return (await sql.begin(async (tx) => {
      await tx.unsafe('set local role anon');
      return fn(tx);
    })) as T;
  } catch (error) {
    throw mapDbError(error);
  }
}

/** Savepoint helper: run `fn` and roll back only its changes on failure. */
export async function savepoint<T>(tx: Tx, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return (await tx.savepoint(async (sp) => fn(sp as unknown as Tx))) as T;
}

interface PgErrorLike {
  code?: string;
  message?: string;
  detail?: string;
  constraint_name?: string;
}

export function mapDbError(error: unknown): unknown {
  if (error instanceof AppError) return error;
  const e = error as PgErrorLike;
  if (!e || typeof e.code !== 'string') return error;
  switch (e.code) {
    case '42501':
      return new AppError('forbidden', "You don't have access to this item.", { db: e.message });
    case '23505':
      return new AppError('conflict', 'That already exists.', { constraint: e.constraint_name });
    case '23503':
      return new AppError('not_found', 'A referenced item no longer exists.', { constraint: e.constraint_name });
    case '23514':
    case '23502':
    case '22P02':
    case '22001':
    case '22007':
    case '22008':
      return new AppError('validation', e.message ?? 'Invalid value.', { constraint: e.constraint_name });
    case 'P0002':
      return new AppError('not_found', e.message ?? 'Not found.');
    case '40001':
    case '40P01':
      return new AppError('conflict', 'The change collided with another one. Please retry.');
    case '57014':
      return new AppError('timeout', 'The database took too long to respond.');
    default:
      return error;
  }
}
