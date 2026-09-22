import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { pg_trgm } from '@electric-sql/pglite/contrib/pg_trgm';
import { PGLiteSocketServer } from '@electric-sql/pglite-socket';
import { createDb, type Sql } from './client';

/**
 * In-process Postgres 17 (PGlite) with a minimal Supabase-compatible environment (roles, auth
 * schema, auth.uid()) and all migrations applied. Lets RLS, trigger and mutator tests run in CI
 * without Docker. The same SQL runs on real Supabase in development and production.
 */

const here = dirname(fileURLToPath(import.meta.url));
export const MIGRATIONS_DIR = resolve(here, '../../../supabase/migrations');

const SUPABASE_SHIM = `
create role anon nologin noinherit;
create role authenticated nologin noinherit;
create role service_role nologin noinherit bypassrls;
create schema if not exists extensions;
create schema if not exists auth;
create table auth.users (
  id uuid primary key default gen_random_uuid(),
  email text,
  raw_user_meta_data jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create function auth.uid() returns uuid language sql stable as $$
  select coalesce(
    nullif(current_setting('request.jwt.claim.sub', true), ''),
    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')
  )::uuid
$$;
grant usage on schema public, auth, extensions to anon, authenticated, service_role;
grant execute on function auth.uid() to anon, authenticated, service_role;
alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
alter default privileges in schema public grant execute on functions to anon, authenticated, service_role;
`;

export function migrationFiles(dir = MIGRATIONS_DIR): { name: string; sql: string }[] {
  return readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .map((name) => ({ name, sql: readFileSync(join(dir, name), 'utf8') }));
}

export interface TestDatabase {
  sql: Sql;
  pg: PGlite;
  url: string;
  close: () => Promise<void>;
}

export async function createTestDatabase(): Promise<TestDatabase> {
  const pg = await PGlite.create({ extensions: { pg_trgm } });
  await pg.exec(SUPABASE_SHIM);
  for (const m of migrationFiles()) {
    try {
      await pg.exec(m.sql);
    } catch (error) {
      throw new Error(`Migration ${m.name} failed: ${(error as Error).message}`);
    }
  }
  const server = new PGLiteSocketServer({ db: pg, port: 0, host: '127.0.0.1', maxConnections: 1 } as never);
  await server.start();
  const address = (server as unknown as { server: { address(): { port: number } } }).server.address();
  const url = `postgres://postgres:postgres@127.0.0.1:${address.port}/postgres`;
  const sql = createDb(url, { max: 1, prepare: false });
  return {
    sql,
    pg,
    url,
    close: async () => {
      await sql.end({ timeout: 1 });
      await server.stop();
      await pg.close();
    },
  };
}

export interface TestUser {
  id: string;
  email: string;
  personalWorkspaceId: string;
}

let userCounter = 0;

/** Create an auth user (the signup trigger creates profile + personal workspace). */
export async function createTestUser(sql: Sql, name?: string, meta: Record<string, unknown> = {}): Promise<TestUser> {
  userCounter += 1;
  const display = name ?? `User ${userCounter}`;
  const email = `${display.toLowerCase().replace(/[^a-z0-9]+/g, '.')}.${userCounter}@example.com`;
  const [row] = await sql<{ id: string }[]>`
    insert into auth.users (email, raw_user_meta_data)
    values (${email}, ${sql.json({ display_name: display, ...meta } as never)})
    returning id`;
  const [ws] = await sql<{ id: string }[]>`
    select id from public.workspaces where owner_id = ${row!.id} and kind = 'personal'`;
  return { id: row!.id, email, personalWorkspaceId: ws!.id };
}
