/**
 * Runtime platform detection and thin native bridges. The same UI runs in a browser, in Tauri
 * (desktop) and in Capacitor (iOS/Android); anything platform-specific goes through here.
 */

type TauriWindow = { __TAURI_INTERNALS__?: unknown; __TAURI__?: unknown };
type CapacitorWindow = { Capacitor?: { isNativePlatform?: () => boolean; getPlatform?: () => string } };

export type Platform = 'web' | 'desktop' | 'ios' | 'android';

export function detectPlatform(): Platform {
  if (typeof window === 'undefined') return 'web';
  const w = window as unknown as TauriWindow & CapacitorWindow;
  if (w.__TAURI_INTERNALS__ || w.__TAURI__) return 'desktop';
  if (w.Capacitor?.isNativePlatform?.()) {
    const p = w.Capacitor.getPlatform?.();
    return p === 'ios' ? 'ios' : 'android';
  }
  return 'web';
}

export const isNativeShell = () => detectPlatform() !== 'web';
export const isMobileShell = () => ['ios', 'android'].includes(detectPlatform());
export const isApple = () => typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);

/** Where OAuth/magic-link flows should return to. Native shells use the custom scheme. */
export function authRedirectUrl(appUrl: string, path = '/auth/callback'): string {
  if (typeof window === 'undefined') return `${appUrl}${path}`;
  return isNativeShell() ? `orbit://auth/callback` : `${window.location.origin}${path}`;
}

export async function openExternal(url: string): Promise<void> {
  const platform = detectPlatform();
  if (platform === 'desktop') {
    const { invoke } = (await import('./tauri-bridge')).tauri();
    await invoke('open_external', { url });
    return;
  }
  window.open(url, '_blank', 'noopener,noreferrer');
}

/** Stable per-install id used for devices/push registration and sync client ids. */
export function deviceId(): string {
  const key = 'orbit.deviceId';
  try {
    let id = localStorage.getItem(key);
    if (!id) {
      id = crypto.randomUUID();
      localStorage.setItem(key, id);
    }
    return id;
  } catch {
    return crypto.randomUUID();
  }
}
