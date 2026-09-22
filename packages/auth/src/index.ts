import { createHash, createCipheriv, createDecipheriv, randomBytes, timingSafeEqual, createHmac } from 'node:crypto';
import { createRemoteJWKSet, decodeProtectedHeader, jwtVerify, type JWTPayload } from 'jose';
import { AppError, randomToken } from '@orbit/shared';

/**
 * Server-side auth primitives: Supabase access-token verification, token hashing for secrets we
 * hand out (invitations, public links, MCP tokens), AES-256-GCM encryption for OAuth tokens at
 * rest, and HMAC helpers for webhooks and OAuth state.
 */

export interface AuthenticatedUser {
  userId: string;
  email: string | null;
  sessionId: string | null;
  /** Authentication assurance / method info, used for sensitive-action re-auth checks. */
  authTime: number | null;
  amr: string[];
}

export interface VerifierOptions {
  supabaseUrl: string;
  /** HS256 secret (local dev / legacy projects). When absent, the project's JWKS is used. */
  jwtSecret?: string;
  audience?: string;
}

export function createTokenVerifier(opts: VerifierOptions) {
  const issuer = `${opts.supabaseUrl.replace(/\/$/, '')}/auth/v1`;
  const secret = opts.jwtSecret ? new TextEncoder().encode(opts.jwtSecret) : null;
  // Projects may sign with asymmetric keys (JWKS) or a legacy HS256 secret; pick by header.
  const jwks = createRemoteJWKSet(new URL(`${issuer}/.well-known/jwks.json`), { cooldownDuration: 60_000 });

  return async function verify(token: string): Promise<AuthenticatedUser> {
    let payload: JWTPayload & { email?: string; session_id?: string; role?: string; amr?: { method: string; timestamp: number }[] };
    try {
      const alg = (decodeProtectedHeader(token).alg ?? '').toUpperCase();
      const verifyOpts = { issuer, audience: opts.audience ?? 'authenticated' };
      const result = alg.startsWith('HS')
        ? secret
          ? await jwtVerify(token, secret, { ...verifyOpts, algorithms: ['HS256'] })
          : (() => {
              throw new Error('HS256 token but no secret configured');
            })()
        : await jwtVerify(token, jwks, { ...verifyOpts, algorithms: ['ES256', 'RS256', 'EdDSA'] });
      payload = result.payload as typeof payload;
    } catch {
      throw new AppError('unauthorized', 'Your session has expired. Please sign in again.');
    }
    if (!payload.sub || payload.role !== 'authenticated') {
      throw new AppError('unauthorized', 'Invalid session.');
    }
    const amr = Array.isArray(payload.amr) ? payload.amr : [];
    return {
      userId: payload.sub,
      email: typeof payload.email === 'string' ? payload.email.toLowerCase() : null,
      sessionId: typeof payload.session_id === 'string' ? payload.session_id : null,
      authTime: amr.length ? Math.max(...amr.map((a) => a.timestamp)) : (payload.iat ?? null),
      amr: amr.map((a) => a.method),
    };
  };
}

export type TokenVerifier = ReturnType<typeof createTokenVerifier>;

/** Require a recent sign-in (seconds) for sensitive actions like account deletion. */
export function requireRecentAuth(user: AuthenticatedUser, maxAgeSeconds = 600): void {
  const now = Math.floor(Date.now() / 1000);
  if (!user.authTime || now - user.authTime > maxAgeSeconds) {
    throw new AppError('unauthorized', 'Please confirm your password to continue.', { reauth: true });
  }
}

export function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

/** A secret token for the user plus the hash we store. */
export function issueSecret(prefix = '', bytes = 32): { token: string; hash: string; displayPrefix: string } {
  const token = `${prefix}${randomToken(bytes)}`;
  return { token, hash: sha256(token), displayPrefix: token.slice(0, prefix.length + 6) };
}

export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

// ───────────── encryption at rest (OAuth tokens) ─────────────
const VERSION = 'v1';

export function encryptSecret(plaintext: string, keyBase64: string): string {
  const key = Buffer.from(keyBase64, 'base64');
  if (key.length !== 32) throw new Error('ENCRYPTION_KEY must be 32 bytes');
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [VERSION, iv.toString('base64url'), tag.toString('base64url'), enc.toString('base64url')].join('.');
}

export function decryptSecret(payload: string, keyBase64: string): string {
  const [version, iv, tag, data] = payload.split('.');
  if (version !== VERSION || !iv || !tag || !data) throw new Error('Unsupported ciphertext');
  const key = Buffer.from(keyBase64, 'base64');
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64url'));
  decipher.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([decipher.update(Buffer.from(data, 'base64url')), decipher.final()]).toString('utf8');
}

// ───────────── signed state (OAuth "state", short-lived links) ─────────────
export function signState(data: Record<string, unknown>, secret: string, ttlSeconds = 600): string {
  const body = Buffer.from(JSON.stringify({ ...data, exp: Math.floor(Date.now() / 1000) + ttlSeconds })).toString('base64url');
  const sig = createHmac('sha256', secret).update(body).digest('base64url');
  return `${body}.${sig}`;
}

export function verifyState<T extends Record<string, unknown>>(state: string, secret: string): T {
  const [body, sig] = state.split('.');
  if (!body || !sig) throw new AppError('validation', 'Invalid state.');
  const expected = createHmac('sha256', secret).update(body).digest('base64url');
  if (!safeEqual(sig, expected)) throw new AppError('validation', 'Invalid state signature.');
  const data = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as T & { exp: number };
  if (data.exp < Math.floor(Date.now() / 1000)) throw new AppError('validation', 'This link has expired. Please try again.');
  return data;
}

export function hmacHex(secret: string, payload: string | Buffer, algo: 'sha256' | 'sha1' = 'sha256'): string {
  return createHmac(algo, secret).update(payload).digest('hex');
}
