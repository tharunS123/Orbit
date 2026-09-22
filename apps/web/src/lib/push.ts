'use client';

import { AppError } from '@orbit/shared';
import { apiFetch } from './api';
import { deviceId, detectPlatform } from './platform';

/** Register the service worker (offline shell + push). Safe to call repeatedly. */
export async function registerServiceWorker(): Promise<ServiceWorkerRegistration | null> {
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return null;
  if (process.env.NODE_ENV !== 'production' && !localStorage.getItem('orbit.sw.dev')) return null;
  try {
    return await navigator.serviceWorker.register('/sw.js', { scope: '/' });
  } catch {
    return null;
  }
}

function urlBase64ToUint8Array(base64: string): Uint8Array {
  const padding = '='.repeat((4 - (base64.length % 4)) % 4);
  const raw = atob((base64 + padding).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}

export function pushSupported(): boolean {
  return typeof window !== 'undefined' && 'Notification' in window && 'serviceWorker' in navigator && 'PushManager' in window;
}

/** Ask for permission and register this browser for Web Push. Returns the permission state. */
export async function enableWebPush(vapidPublicKey: string | null): Promise<NotificationPermission> {
  if (!pushSupported()) throw new AppError('unavailable', 'This browser doesn’t support notifications.');
  if (!vapidPublicKey) throw new AppError('unavailable', 'Push notifications are not configured on this server.');
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') return permission;
  localStorage.setItem('orbit.sw.dev', '1');
  const reg = (await registerServiceWorker()) ?? (await navigator.serviceWorker.register('/sw.js'));
  await navigator.serviceWorker.ready;
  const sub = (await reg.pushManager.getSubscription()) ?? (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlBase64ToUint8Array(vapidPublicKey) as BufferSource }));
  const json = sub.toJSON() as { endpoint: string; keys: { p256dh: string; auth: string } };
  await apiFetch('/devices/push-token', {
    method: 'POST',
    body: {
      deviceId: deviceId(),
      platform: detectPlatform() === 'desktop' ? 'macos' : 'web',
      name: navigator.userAgent.slice(0, 120),
      channel: 'webpush',
      token: json.endpoint,
      endpoint: json.endpoint,
      keys: json.keys,
    },
  });
  return permission;
}
