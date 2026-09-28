'use client';

import { DESKTOP_EVENTS, desktop } from './desktop';

/**
 * Cross-window hint that the shared local outbox changed. Satellite windows (desktop Quick
 * Capture) write mutations to IndexedDB and announce them; the primary window re-reads the outbox
 * and adopts what it doesn't have. The hint carries no data — IndexedDB is the source of truth —
 * so a lost message only delays adoption until the next focus.
 */

const channelName = (userId: string) => `orbit.outbox.${userId}`;

export function announceOutboxChanged(userId: string): void {
  try {
    const ch = new BroadcastChannel(channelName(userId));
    ch.postMessage({ type: 'outbox-changed' });
    ch.close();
  } catch {
    /* BroadcastChannel unavailable: the desktop event below still reaches the main window */
  }
  void desktop.notifyOutboxChanged().catch(() => undefined);
}

export function onOutboxChanged(userId: string, handler: () => void): () => void {
  let ch: BroadcastChannel | null = null;
  try {
    ch = new BroadcastChannel(channelName(userId));
    ch.onmessage = () => handler();
  } catch {
    ch = null;
  }
  let unlisten: (() => void) | null = null;
  let disposed = false;
  void desktop
    .listen(DESKTOP_EVENTS.outboxChanged, () => handler())
    .then((un) => (disposed ? un() : (unlisten = un)))
    .catch(() => undefined);
  return () => {
    disposed = true;
    ch?.close();
    unlisten?.();
  };
}
