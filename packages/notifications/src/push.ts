import { connect, constants, type ClientHttp2Session } from 'node:http2';
import webpush from 'web-push';
import { importPKCS8, SignJWT } from 'jose';

/**
 * Push channels. Each returns 'ok', 'gone' (token invalid → caller deletes it) or throws for
 * retryable failures. Payloads carry only a title/body/deep link — never document content.
 */

export interface PushPayload {
  title: string;
  body: string;
  /** In-app path to open, e.g. /task?id=… */
  path: string;
  /** Collapse key so repeated notifications replace each other. */
  tag?: string;
  badge?: number;
  category?: string;
}

export type PushResult = 'ok' | 'gone';

export interface WebPushConfig {
  publicKey: string;
  privateKey: string;
  subject: string;
}

export async function sendWebPush(cfg: WebPushConfig, sub: { endpoint: string; keys: { p256dh: string; auth: string } }, payload: PushPayload): Promise<PushResult> {
  try {
    await webpush.sendNotification(sub, JSON.stringify(payload), {
      vapidDetails: { subject: cfg.subject, publicKey: cfg.publicKey, privateKey: cfg.privateKey },
      TTL: 60 * 60 * 24,
      topic: payload.tag?.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 32),
      urgency: 'normal',
    });
    return 'ok';
  } catch (error) {
    const status = (error as { statusCode?: number }).statusCode;
    if (status === 404 || status === 410) return 'gone';
    throw error;
  }
}

// ───────────── APNs (token-based auth, HTTP/2) ─────────────
export interface ApnsConfig {
  keyId: string;
  teamId: string;
  /** Contents of the .p8 key (PEM). */
  privateKey: string;
  bundleId: string;
  production: boolean;
}

let apnsJwt: { token: string; at: number } | null = null;
let apnsSession: ClientHttp2Session | null = null;

async function apnsToken(cfg: ApnsConfig): Promise<string> {
  // Tokens are valid 60 minutes; Apple rejects refreshing more than once per 20 minutes.
  if (apnsJwt && Date.now() - apnsJwt.at < 50 * 60_000) return apnsJwt.token;
  const key = await importPKCS8(cfg.privateKey.replace(/\\n/g, '\n'), 'ES256');
  const token = await new SignJWT({}).setProtectedHeader({ alg: 'ES256', kid: cfg.keyId }).setIssuer(cfg.teamId).setIssuedAt().sign(key);
  apnsJwt = { token, at: Date.now() };
  return token;
}

export async function sendApns(cfg: ApnsConfig, deviceToken: string, payload: PushPayload): Promise<PushResult> {
  const host = cfg.production ? 'https://api.push.apple.com' : 'https://api.sandbox.push.apple.com';
  if (!apnsSession || apnsSession.closed || apnsSession.destroyed) {
    apnsSession = connect(host);
    apnsSession.on('error', () => {
      apnsSession = null;
    });
  }
  const token = await apnsToken(cfg);
  const body = JSON.stringify({
    aps: {
      alert: { title: payload.title, body: payload.body },
      sound: 'default',
      ...(payload.badge !== undefined ? { badge: payload.badge } : {}),
      ...(payload.category ? { category: payload.category } : {}),
      'thread-id': payload.tag,
    },
    path: payload.path,
  });
  return new Promise<PushResult>((resolve, reject) => {
    const req = apnsSession!.request({
      [constants.HTTP2_HEADER_METHOD]: 'POST',
      [constants.HTTP2_HEADER_PATH]: `/3/device/${deviceToken}`,
      authorization: `bearer ${token}`,
      'apns-topic': cfg.bundleId,
      'apns-push-type': 'alert',
      ...(payload.tag ? { 'apns-collapse-id': payload.tag.slice(0, 64) } : {}),
    });
    let status = 0;
    let data = '';
    req.setEncoding('utf8');
    req.on('response', (headers) => {
      status = Number(headers[constants.HTTP2_HEADER_STATUS]);
    });
    req.on('data', (chunk: string) => (data += chunk));
    req.on('end', () => {
      if (status === 200) resolve('ok');
      else if (status === 410 || (status === 400 && /BadDeviceToken|DeviceTokenNotForTopic/.test(data))) resolve('gone');
      else reject(new Error(`APNs ${status}: ${data}`));
    });
    req.on('error', reject);
    req.end(body);
  });
}

// ───────────── FCM HTTP v1 (service account) ─────────────
export interface FcmConfig {
  projectId: string;
  clientEmail: string;
  privateKey: string;
}

let fcmAccess: { token: string; exp: number } | null = null;

async function fcmAccessToken(cfg: FcmConfig): Promise<string> {
  if (fcmAccess && fcmAccess.exp - 60 > Date.now() / 1000) return fcmAccess.token;
  const key = await importPKCS8(cfg.privateKey.replace(/\\n/g, '\n'), 'RS256');
  const now = Math.floor(Date.now() / 1000);
  const assertion = await new SignJWT({ scope: 'https://www.googleapis.com/auth/firebase.messaging' })
    .setProtectedHeader({ alg: 'RS256', typ: 'JWT' })
    .setIssuer(cfg.clientEmail)
    .setSubject(cfg.clientEmail)
    .setAudience('https://oauth2.googleapis.com/token')
    .setIssuedAt(now)
    .setExpirationTime(now + 3600)
    .sign(key);
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }),
  });
  if (!res.ok) throw new Error(`FCM auth ${res.status}`);
  const data = (await res.json()) as { access_token: string; expires_in: number };
  fcmAccess = { token: data.access_token, exp: now + data.expires_in };
  return data.access_token;
}

export async function sendFcm(cfg: FcmConfig, deviceToken: string, payload: PushPayload): Promise<PushResult> {
  const token = await fcmAccessToken(cfg);
  const res = await fetch(`https://fcm.googleapis.com/v1/projects/${cfg.projectId}/messages:send`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      message: {
        token: deviceToken,
        notification: { title: payload.title, body: payload.body },
        data: { path: payload.path },
        android: { collapse_key: payload.tag, notification: { tag: payload.tag, click_action: 'OPEN_PATH' } },
      },
    }),
  });
  if (res.ok) return 'ok';
  const text = await res.text();
  if (res.status === 404 || /UNREGISTERED|INVALID_ARGUMENT.*registration/i.test(text)) return 'gone';
  throw new Error(`FCM ${res.status}: ${text}`);
}
