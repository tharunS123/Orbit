import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SignJWT } from 'jose';
import type { Hono } from 'hono';
import { configuredCapabilities, serverEnvSchema } from '@orbit/shared/env';
import { parseFlags } from '@orbit/shared';
import { uuidv7 } from '@orbit/shared';
import { createTokenVerifier } from '@orbit/auth';
import { asService, type Sql } from '@orbit/database';
import { createTestDatabase, createTestUser, type TestDatabase, type TestUser } from '@orbit/database/testing';
import type { EmailMessage } from '@orbit/notifications';
import { createApi } from './app';
import type { ApiEnv } from './context';
import { createLogger } from './logger';
import { createMemoryQueue } from './services/queue';
import { createMemoryStorage } from './services/storage';

const JWT_SECRET = 'test-secret-test-secret-test-secret-123';
const SUPABASE_URL = 'http://supabase.test';

let db: TestDatabase;
let sql: Sql;
let app: Hono<ApiEnv>;
let alice: TestUser;
let bob: TestUser;
const emails: EmailMessage[] = [];
const storage = createMemoryStorage();

async function tokenFor(u: TestUser, authAgoSeconds = 0) {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({ sub: u.id, role: 'authenticated', email: u.email, amr: [{ method: 'password', timestamp: now - authAgoSeconds }] })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuer(`${SUPABASE_URL}/auth/v1`)
    .setAudience('authenticated')
    .setIssuedAt()
    .setExpirationTime('1h')
    .sign(new TextEncoder().encode(JWT_SECRET));
}

async function call(u: TestUser | null, method: string, path: string, payload?: unknown, opts: { authAgo?: number } = {}) {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (u) headers.authorization = `Bearer ${await tokenFor(u, opts.authAgo ?? 0)}`;
  const res = await app.request(`/api${path}`, { method, headers, body: payload === undefined ? undefined : JSON.stringify(payload) });
  const text = await res.text();
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    json = text;
  }
  return { status: res.status, json: json as Record<string, unknown> & { error?: { code: string } }, headers: res.headers, text };
}

const push = (u: TestUser, name: string, args: unknown) =>
  call(u, 'POST', '/sync/push', { clientId: uuidv7(), mutations: [{ id: uuidv7(), name, args, createdAt: new Date().toISOString() }] });

beforeAll(async () => {
  db = await createTestDatabase();
  sql = db.sql;
  alice = await createTestUser(sql, 'Alice');
  bob = await createTestUser(sql, 'Bob');
  const env = serverEnvSchema.parse({
    DATABASE_URL: db.url,
    SUPABASE_URL,
    SUPABASE_ANON_KEY: 'anon',
    SUPABASE_SERVICE_ROLE_KEY: 'service',
    SUPABASE_JWT_SECRET: JWT_SECRET,
    ENCRYPTION_KEY: Buffer.alloc(32, 1).toString('base64'),
    INTERNAL_API_SECRET: 'internal-secret-internal-secret',
    APP_URL: 'http://localhost:3000',
  });
  app = createApi({
    env,
    sql,
    verify: createTokenVerifier({ supabaseUrl: SUPABASE_URL, jwtSecret: JWT_SECRET }),
    storage,
    mailer: { kind: 'test', send: async (m) => void emails.push(m) },
    queue: createMemoryQueue(),
    logger: createLogger(process.env.TEST_LOG ?? 'silent'),
    capabilities: configuredCapabilities(env),
    flags: parseFlags(null),
  });
}, 120_000);

afterAll(async () => db?.close());

describe('api', () => {
  it('health and auth', async () => {
    expect((await call(null, 'GET', '/health')).status).toBe(200);
    expect((await call(null, 'POST', '/sync/pull', { clientId: uuidv7() })).status).toBe(401);
    const bad = await app.request('/api/me', { headers: { authorization: 'Bearer nope' } });
    expect(bad.status).toBe(401);
  });

  it('bootstrap reports plan and limits', async () => {
    const me = await call(alice, 'GET', '/me');
    expect(me.status).toBe(200);
    expect(me.json).toMatchObject({ plan: 'free', userId: alice.id });
  });

  it('sync push/pull over HTTP, with rejection details', async () => {
    const id = uuidv7();
    const res = await push(alice, 'task.create', { id, workspaceId: alice.personalWorkspaceId, title: 'Quarterly report', position: 'a0', inInbox: true });
    expect(res.json).toMatchObject({ results: [{ status: 'applied' }], incomplete: false });
    const pulled = await call(alice, 'POST', '/sync/pull', { clientId: uuidv7(), cursor: '0' });
    expect((pulled.json.changes as { tasks: { id: string }[] }).tasks.map((t) => t.id)).toContain(id);
    const bad = await push(bob, 'task.update', { id, patch: { title: 'nope' } });
    expect(bad.json).toMatchObject({ results: [{ status: 'rejected', error: { code: 'not_found' } }] });
    const invalid = await call(alice, 'POST', '/sync/push', { clientId: 'x', mutations: [] });
    expect(invalid.status).toBe(422);
  });

  it('search is permission-aware and typo tolerant', async () => {
    const hidden = uuidv7();
    await push(bob, 'task.create', { id: hidden, workspaceId: bob.personalWorkspaceId, title: 'Quarterly secret', position: 'a0' });
    const res = await call(alice, 'GET', '/search?q=quartrly');
    const results = res.json.results as { id: string; type: string }[];
    expect(results.some((r) => r.type === 'task')).toBe(true);
    expect(results.some((r) => r.id === hidden)).toBe(false);
    const prefix = await call(alice, 'GET', '/search?q=Quarter&types=task');
    expect((prefix.json.results as unknown[]).length).toBeGreaterThan(0);
  });

  it('invitation flow: create → preview → accept', async () => {
    const ws = uuidv7();
    await push(alice, 'workspace.create', { id: ws, memberId: uuidv7(), name: 'Studio' });
    const res = await call(alice, 'POST', '/invitations', { workspaceId: ws, emails: [bob.email], role: 'member' });
    expect(res.json).toMatchObject({ results: [{ email: bob.email, status: 'invited' }] });
    const mail = emails.at(-1)!;
    expect(mail.to).toBe(bob.email);
    const token = /\/i\/([A-Za-z0-9_-]+)/.exec(mail.text)![1]!;
    const preview = await call(null, 'GET', `/invitations/preview?token=${token}`);
    expect(preview.json).toMatchObject({ workspace: 'Studio', inviter: 'Alice', status: 'pending' });
    expect(String(preview.json.emailHint)).not.toContain(bob.email.split('@')[0]);
    const wrong = await call(alice, 'POST', '/invitations/accept', { token });
    expect(wrong.status).toBe(403);
    const ok = await call(bob, 'POST', '/invitations/accept', { token });
    expect(ok.json).toMatchObject({ workspaceId: ws, role: 'member' });
    const again = await call(alice, 'POST', '/invitations', { workspaceId: ws, emails: [bob.email] });
    expect(again.json).toMatchObject({ results: [{ status: 'already_member' }] });
  });

  it('attachments enforce plan limits and authorization', async () => {
    const task = uuidv7();
    await push(alice, 'task.create', { id: task, workspaceId: alice.personalWorkspaceId, title: 'With file', position: 'a0' });
    const tooBig = await call(alice, 'POST', '/attachments/upload-url', { id: uuidv7(), workspaceId: alice.personalWorkspaceId, taskId: task, name: 'big.pdf', mimeType: 'application/pdf', sizeBytes: 50 * 1024 * 1024 });
    expect(tooBig.json.error?.code).toBe('quota_exceeded');
    const badType = await call(alice, 'POST', '/attachments/upload-url', { id: uuidv7(), workspaceId: alice.personalWorkspaceId, taskId: task, name: 'x.exe', mimeType: 'application/x-msdownload', sizeBytes: 10 });
    expect(badType.status).toBe(422);
    const attId = uuidv7();
    const up = await call(alice, 'POST', '/attachments/upload-url', { id: attId, workspaceId: alice.personalWorkspaceId, taskId: task, name: 'notes.pdf', mimeType: 'application/pdf', sizeBytes: 1234 });
    expect(up.status).toBe(200);
    const notUploaded = await call(alice, 'POST', `/attachments/${attId}/complete`, {});
    expect(notUploaded.status).toBe(422);
    await storage.upload(String(up.json.storagePath), new Uint8Array(1234), 'application/pdf');
    expect((await call(alice, 'POST', `/attachments/${attId}/complete`, {})).status).toBe(200);
    expect((await call(alice, 'GET', `/attachments/${attId}/url`)).json.url).toContain('memory://');
    expect((await call(bob, 'GET', `/attachments/${attId}/url`)).status).toBe(404);
    const foreign = await call(bob, 'POST', '/attachments/upload-url', { id: uuidv7(), workspaceId: alice.personalWorkspaceId, taskId: task, name: 'x.pdf', mimeType: 'application/pdf', sizeBytes: 10 });
    expect(foreign.status).toBe(403);
  });

  it('public links: create, read anonymously, revoke', async () => {
    const list = uuidv7();
    await push(alice, 'list.create', { id: list, workspaceId: alice.personalWorkspaceId, title: 'Trip plan', position: 'a0' });
    await push(alice, 'task.create', { id: uuidv7(), workspaceId: alice.personalWorkspaceId, listId: list, title: 'Book flights', position: 'a0' });
    const created = await call(alice, 'POST', `/lists/${list}/public-link`);
    const token = new URL(String(created.json.url)).searchParams.get('token')!;
    const pub = await call(null, 'GET', `/public/list?token=${token}`);
    expect(pub.json).toMatchObject({ list: { title: 'Trip plan' }, tasks: [{ title: 'Book flights' }] });
    // Bob cannot even see the list, so it doesn't exist for him (no existence leak).
    expect((await call(bob, 'POST', `/lists/${list}/public-link`)).status).toBe(404);
    await call(alice, 'DELETE', `/lists/${list}/public-link`);
    expect((await call(null, 'GET', `/public/list?token=${token}`)).status).toBe(404);
  });

  it('exports lists as markdown and csv', async () => {
    const list = uuidv7();
    await push(alice, 'list.create', { id: list, workspaceId: alice.personalWorkspaceId, title: 'Export me', position: 'a0' });
    const parent = uuidv7();
    await push(alice, 'task.create', { id: parent, workspaceId: alice.personalWorkspaceId, listId: list, title: 'Parent', position: 'a0' });
    await push(alice, 'task.create', { id: uuidv7(), workspaceId: alice.personalWorkspaceId, parentTaskId: parent, title: 'Child', position: 'a0', completed: true });
    const md = await call(alice, 'GET', `/lists/${list}/export?format=md`);
    expect(md.text).toBe('# Export me\n\n- [ ] Parent\n  - [x] Child\n');
    const csv = await call(alice, 'GET', `/lists/${list}/export?format=csv`);
    expect(csv.text.split('\n')).toHaveLength(3);
    expect((await call(bob, 'GET', `/lists/${list}/export`)).status).toBe(404);
  });

  it('heatmap counts completions', async () => {
    const t = uuidv7();
    await push(alice, 'task.create', { id: t, workspaceId: alice.personalWorkspaceId, title: 'done', position: 'a0' });
    await push(alice, 'task.setCompleted', { ids: [t], completed: true, today: '2026-09-22' });
    const res = await call(alice, 'GET', '/me/heatmap?days=30');
    expect(res.json.total).toBeGreaterThanOrEqual(1);
    expect(res.json.currentStreak).toBeGreaterThanOrEqual(1);
  });

  it('account deletion requires recent auth and no owned team workspaces with members', async () => {
    const stale = await call(alice, 'POST', '/account/delete', { confirm: 'DELETE' }, { authAgo: 3600 });
    expect(stale.json.error).toMatchObject({ code: 'unauthorized' });
    const blocked = await call(alice, 'POST', '/account/delete', { confirm: 'DELETE' });
    expect(blocked.json.error?.code).toBe('validation');
    const carol = await createTestUser(sql, 'Carol');
    expect((await call(carol, 'POST', '/account/delete', { confirm: 'DELETE' })).status).toBe(200);
    const [row] = await asService(sql, (tx) => tx`select 1 as x from account_deletions where user_id = ${carol.id}`);
    expect(row).toBeDefined();
  });

  it('rate limits by user', async () => {
    let last = 0;
    for (let i = 0; i < 7; i++) last = (await call(bob, 'POST', '/account/export')).status;
    expect(last).toBe(429);
  });
});
