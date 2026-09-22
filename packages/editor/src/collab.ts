import * as Y from 'yjs';
import { HocuspocusProvider, HocuspocusProviderWebsocket } from '@hocuspocus/provider';
import { IndexeddbPersistence } from 'y-indexeddb';

/**
 * Client side of real-time collaboration: one multiplexed WebSocket per session, one provider
 * per open document, and IndexedDB persistence so documents open and edit offline. Yjs merges
 * offline edits with everyone else's on reconnect (CRDT — no overwrites).
 */

export interface CollabSessionOptions {
  url: string;
  getToken: () => Promise<string | null>;
  onPoke?: () => void;
  onStatus?: (connected: boolean) => void;
  userId: string;
}

export interface OpenDocument {
  name: string;
  ydoc: Y.Doc;
  provider: HocuspocusProvider;
  /** Resolves when local (IndexedDB) content is loaded — safe to render. */
  localReady: Promise<void>;
  /** True once the server has sent its state at least once. */
  isSynced: () => boolean;
  onSynced: (fn: () => void) => () => void;
  readOnly: () => boolean;
  release: () => void;
}

export class CollabSession {
  readonly socket: HocuspocusProviderWebsocket;
  private docs = new Map<string, { doc: OpenDocument; refs: number; timer?: ReturnType<typeof setTimeout> }>();
  private syncChannel: HocuspocusProvider | null = null;

  constructor(private readonly opts: CollabSessionOptions) {
    this.socket = new HocuspocusProviderWebsocket({
      url: opts.url,
      // Keep retrying quietly while offline; the app works from local state meanwhile.
      delay: 1000,
      maxDelay: 30_000,
      onConnect: () => opts.onStatus?.(true),
      onDisconnect: () => opts.onStatus?.(false),
    });
    if (opts.onPoke) {
      // A pseudo-document carries server "pokes" (something changed → pull).
      this.syncChannel = new HocuspocusProvider({
        websocketProvider: this.socket,
        name: `sync:${opts.userId}`,
        token: () => this.token(),
        onStateless: ({ payload }) => {
          if (payload === 'poke') opts.onPoke?.();
        },
      });
      this.syncChannel.attach();
    }
  }

  private async token(): Promise<string> {
    return (await this.opts.getToken()) ?? '';
  }

  open(name: string): OpenDocument {
    const existing = this.docs.get(name);
    if (existing) {
      existing.refs++;
      if (existing.timer) clearTimeout(existing.timer);
      return existing.doc;
    }
    const ydoc = new Y.Doc();
    const persistence = typeof indexedDB === 'undefined' ? null : new IndexeddbPersistence(`orbit-doc:${name}`, ydoc);
    let synced = false;
    let readOnly = false;
    let released = false;
    let failures = 0;
    const listeners = new Set<() => void>();
    const provider: HocuspocusProvider = new HocuspocusProvider({
      websocketProvider: this.socket,
      name,
      document: ydoc,
      token: () => this.token(),
      onSynced: () => {
        synced = true;
        failures = 0;
        listeners.forEach((l) => l());
      },
      onAuthenticated: ({ scope }) => {
        readOnly = scope === 'readonly';
      },
      // A document for a list/task created offline (or moments ago) is refused until the entity
      // reaches the server. Retry with backoff; local edits stay in IndexedDB meanwhile.
      onAuthenticationFailed: () => {
        if (released) return;
        const delay = [2000, 5000, 15_000, 60_000][Math.min(failures++, 3)]!;
        setTimeout(() => {
          if (released) return;
          provider.detach();
          provider.attach();
        }, delay);
      },
    });
    provider.attach();
    const doc: OpenDocument = {
      name,
      ydoc,
      provider,
      localReady: persistence ? Promise.race([persistence.whenSynced.then(() => undefined), new Promise<void>((r) => setTimeout(r, 1500))]) : Promise.resolve(),
      isSynced: () => synced,
      onSynced: (fn) => {
        listeners.add(fn);
        return () => listeners.delete(fn);
      },
      readOnly: () => readOnly,
      release: () => {
        const entry = this.docs.get(name);
        if (!entry) return;
        entry.refs--;
        if (entry.refs > 0) return;
        // Keep briefly in case the user navigates back.
        entry.timer = setTimeout(() => {
          released = true;
          provider.destroy();
          void persistence?.destroy();
          ydoc.destroy();
          this.docs.delete(name);
        }, 30_000);
      },
    };
    this.docs.set(name, { doc, refs: 1 });
    return doc;
  }

  destroy(): void {
    for (const { doc } of this.docs.values()) {
      doc.provider.destroy();
      doc.ydoc.destroy();
    }
    this.docs.clear();
    this.syncChannel?.destroy();
    this.socket.destroy();
  }
}

/** Remove a document's offline copy (sign-out). */
export async function clearLocalDocuments(names: string[]): Promise<void> {
  await Promise.all(names.map((n) => new Promise<void>((resolve) => {
    const req = indexedDB.deleteDatabase(`orbit-doc:${n}`);
    req.onsuccess = req.onerror = req.onblocked = () => resolve();
  })));
}
