import { describe, expect, it } from 'vitest';
import { SignJWT } from 'jose';
import { createTokenVerifier, decryptSecret, encryptSecret, issueSecret, requireRecentAuth, sha256, signState, verifyState } from './index';

const secret = 'super-secret-jwt-token-with-at-least-32-characters-long';
const supabaseUrl = 'http://127.0.0.1:54321';

async function token(claims: Record<string, unknown>, opts: { exp?: string; iss?: string } = {}) {
  return new SignJWT(claims)
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuer(opts.iss ?? `${supabaseUrl}/auth/v1`)
    .setAudience('authenticated')
    .setIssuedAt()
    .setExpirationTime(opts.exp ?? '1h')
    .sign(new TextEncoder().encode(secret));
}

describe('token verifier', () => {
  const verify = createTokenVerifier({ supabaseUrl, jwtSecret: secret });
  it('accepts valid Supabase tokens', async () => {
    const user = await verify(await token({ sub: '0190f3b4-7c1a-7000-8000-000000000001', role: 'authenticated', email: 'A@x.com', session_id: 's1' }));
    expect(user).toMatchObject({ userId: '0190f3b4-7c1a-7000-8000-000000000001', email: 'a@x.com', sessionId: 's1' });
  });
  it('rejects expired, anon and foreign-issuer tokens', async () => {
    await expect(verify(await token({ sub: 'x', role: 'authenticated' }, { exp: '-1m' }))).rejects.toMatchObject({ code: 'unauthorized' });
    await expect(verify(await token({ sub: 'x', role: 'anon' }))).rejects.toMatchObject({ code: 'unauthorized' });
    await expect(verify(await token({ sub: 'x', role: 'authenticated' }, { iss: 'https://evil/auth/v1' }))).rejects.toMatchObject({ code: 'unauthorized' });
    await expect(verify('garbage')).rejects.toMatchObject({ code: 'unauthorized' });
  });
});

describe('secrets', () => {
  it('encrypts and decrypts with integrity', () => {
    const key = Buffer.alloc(32, 7).toString('base64');
    const enc = encryptSecret('refresh-token', key);
    expect(enc).not.toContain('refresh-token');
    expect(decryptSecret(enc, key)).toBe('refresh-token');
    const tampered = enc.slice(0, -2) + (enc.endsWith('A') ? 'B' : 'A') + enc.slice(-1);
    expect(() => decryptSecret(tampered, key)).toThrow();
  });
  it('issues hashed tokens', () => {
    const s = issueSecret('orb_');
    expect(s.token.startsWith('orb_')).toBe(true);
    expect(s.hash).toBe(sha256(s.token));
  });
  it('signs and verifies state with expiry', () => {
    const st = signState({ userId: 'u1' }, 'k');
    expect(verifyState<{ userId: string }>(st, 'k').userId).toBe('u1');
    expect(() => verifyState(st, 'other')).toThrow();
    expect(() => verifyState(signState({}, 'k', -10), 'k')).toThrow(/expired/);
  });
  it('requires recent authentication', () => {
    const now = Math.floor(Date.now() / 1000);
    expect(() => requireRecentAuth({ userId: 'u', email: null, sessionId: null, authTime: now - 5, amr: [] })).not.toThrow();
    expect(() => requireRecentAuth({ userId: 'u', email: null, sessionId: null, authTime: now - 3600, amr: [] })).toThrow();
  });
});
