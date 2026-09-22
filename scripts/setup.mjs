#!/usr/bin/env node
/**
 * Local development setup: creates/updates the root .env from .env.example, filling in values
 * from the running local Supabase stack and generating local secrets. Existing non-empty values
 * are never overwritten. Prints only which keys were set — never their values.
 */
import { execSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const examplePath = path.join(root, '.env.example');
const envPath = path.join(root, '.env');

function parse(text) {
  const map = new Map();
  for (const line of text.split('\n')) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line);
    if (m) map.set(m[1], m[2]);
  }
  return map;
}

const existing = existsSync(envPath) ? parse(readFileSync(envPath, 'utf8')) : new Map();

let status = {};
try {
  status = JSON.parse(execSync('npx supabase status -o json', { cwd: root, stdio: ['ignore', 'pipe', 'ignore'] }).toString());
} catch {
  console.warn('! Local Supabase is not running. Start it with `pnpm db:start`, then re-run `pnpm setup`.');
}

const b64url = (buf) => Buffer.from(buf).toString('base64url');
function vapid() {
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const pub = publicKey.export({ format: 'jwk' });
  const priv = privateKey.export({ format: 'jwk' });
  const raw = Buffer.concat([Buffer.from([4]), Buffer.from(pub.x, 'base64url'), Buffer.from(pub.y, 'base64url')]);
  return { publicKey: b64url(raw), privateKey: priv.d };
}

const keys = vapid();
const generated = {
  DATABASE_URL: status.DB_URL,
  SUPABASE_URL: status.API_URL,
  NEXT_PUBLIC_SUPABASE_URL: status.API_URL,
  SUPABASE_ANON_KEY: status.ANON_KEY,
  NEXT_PUBLIC_SUPABASE_ANON_KEY: status.ANON_KEY,
  SUPABASE_SERVICE_ROLE_KEY: status.SERVICE_ROLE_KEY,
  SUPABASE_JWT_SECRET: status.JWT_SECRET,
  ENCRYPTION_KEY: randomBytes(32).toString('base64'),
  INTERNAL_API_SECRET: randomBytes(24).toString('base64url'),
  INBOUND_EMAIL_SECRET: randomBytes(24).toString('base64url'),
  VAPID_PUBLIC_KEY: keys.publicKey,
  VAPID_PRIVATE_KEY: keys.privateKey,
  BILLING_DEV_MODE: 'true',
  FLAGS: 'devEntitlements',
  NEXT_PUBLIC_FLAGS: 'devEntitlements',
  EMAIL_PROVIDER: 'smtp',
  SMTP_URL: 'smtp://127.0.0.1:54325',
};

const lines = readFileSync(examplePath, 'utf8').split('\n');
const set = [];
const out = lines.map((line) => {
  const m = /^([A-Z0-9_]+)=(.*)$/.exec(line);
  if (!m) return line;
  const [, key, exampleValue] = m;
  const current = existing.get(key);
  if (current !== undefined && current !== '') return `${key}=${current}`;
  const value = generated[key];
  if (value !== undefined && value !== '') {
    set.push(key);
    return `${key}=${value}`;
  }
  return `${key}=${exampleValue}`;
});
// Keep extra keys the developer added.
for (const [key, value] of existing) if (!lines.some((l) => l.startsWith(`${key}=`))) out.push(`${key}=${value}`);

writeFileSync(envPath, out.join('\n'));
console.log(`✓ .env ready (${set.length ? `set: ${set.join(', ')}` : 'no changes'})`);
