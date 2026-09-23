'use client';

import * as React from 'react';
import { detectPlatform } from './platform';
import { tauri } from './tauri-bridge';

/**
 * Typed access to the desktop shell (apps/desktop/src-tauri). Every function is safe to call in a
 * browser: queries resolve to null and actions are no-ops, so feature code can stay unconditional.
 */

export interface QuickCaptureConfig {
  enabled: boolean;
  /** Global accelerator, e.g. "Shift+Alt+Space". */
  shortcut: string;
  defaultShortcut: string;
  hideOnBlur: boolean;
  /** Whether the OS accepted the registration. */
  registered: boolean;
  /** Human-readable registration problem (e.g. taken by another app). */
  error: string | null;
}

export type QuickCapturePatch = Partial<Pick<QuickCaptureConfig, 'enabled' | 'shortcut' | 'hideOnBlur'>>;

/** Events emitted by the shell. */
export const DESKTOP_EVENTS = {
  quickCaptureShown: 'orbit://quick-capture-shown',
  quickCaptureConfig: 'orbit://quick-capture-config',
  navigate: 'orbit://navigate',
  outboxChanged: 'orbit://outbox-changed',
} as const;

export const isDesktop = () => detectPlatform() === 'desktop';

async function call<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  return tauri().invoke<T>(cmd, args);
}

/** Tauri rejects with the Rust error string; normalise to Error. */
function asError(e: unknown): Error {
  return e instanceof Error ? e : new Error(typeof e === 'string' ? e : 'The desktop app could not complete that action.');
}

export const desktop = {
  async quickCaptureConfig(): Promise<QuickCaptureConfig | null> {
    if (!isDesktop()) return null;
    return call<QuickCaptureConfig>('quick_capture_config');
  },
  async updateQuickCapture(patch: QuickCapturePatch): Promise<QuickCaptureConfig> {
    try {
      return await call<QuickCaptureConfig>('quick_capture_update', { patch });
    } catch (e) {
      throw asError(e);
    }
  },
  async resetQuickCapture(): Promise<QuickCaptureConfig> {
    try {
      return await call<QuickCaptureConfig>('quick_capture_reset');
    } catch (e) {
      throw asError(e);
    }
  },
  /** Temporarily release the global shortcut (while recording a new one). */
  async pauseQuickCapture(paused: boolean): Promise<void> {
    if (isDesktop()) await call('quick_capture_pause', { paused });
  },
  async showQuickCapture(): Promise<boolean> {
    if (!isDesktop()) return false;
    await call('quick_capture_show');
    return true;
  },
  async hideQuickCapture(): Promise<void> {
    if (isDesktop()) await call('quick_capture_hide');
  },
  async resizeQuickCapture(height: number): Promise<void> {
    if (isDesktop()) await call('quick_capture_resize', { height: Math.round(height) });
  },
  /** Tell the main window that the shared outbox has new mutations (belt and braces for BroadcastChannel). */
  async notifyOutboxChanged(): Promise<void> {
    if (isDesktop()) await call('outbox_changed');
  },
  /** Show and focus the main window, optionally navigating it. */
  async showMainWindow(path?: string): Promise<void> {
    if (isDesktop()) await call('show_main_window', { path: path ?? null });
  },
  async listen<T>(event: string, handler: (payload: T) => void): Promise<() => void> {
    if (!isDesktop()) return () => undefined;
    const { listen } = await import('@tauri-apps/api/event');
    return listen<T>(event, (e) => handler(e.payload));
  },
};

/** Subscribe to a desktop event for the lifetime of the component. */
export function useDesktopEvent<T>(event: string, handler: (payload: T) => void) {
  const ref = React.useRef(handler);
  ref.current = handler;
  React.useEffect(() => {
    let dispose: (() => void) | null = null;
    let cancelled = false;
    void desktop
      .listen<T>(event, (p) => ref.current(p))
      .then((un) => {
        if (cancelled) un();
        else dispose = un;
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
      dispose?.();
    };
  }, [event]);
}

/** Live Quick Capture config (null in a browser or while loading). */
export function useQuickCaptureConfig(): [QuickCaptureConfig | null, (c: QuickCaptureConfig) => void] {
  const [config, setConfig] = React.useState<QuickCaptureConfig | null>(null);
  React.useEffect(() => {
    let active = true;
    void desktop
      .quickCaptureConfig()
      .then((c) => active && setConfig(c))
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, []);
  useDesktopEvent<QuickCaptureConfig>(DESKTOP_EVENTS.quickCaptureConfig, setConfig);
  return [config, setConfig];
}
