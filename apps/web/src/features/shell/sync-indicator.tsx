'use client';

import * as React from 'react';
import { AlertTriangle, Check, CloudOff, Loader2 } from 'lucide-react';
import { Popover, PopoverContent, PopoverTrigger, Button, cn } from '@orbit/ui';
import { useSync, useSyncStatus } from '@/lib/sync';

function ago(iso: string | null): string {
  if (!iso) return 'never';
  const s = Math.round((Date.now() - Date.parse(iso)) / 1000);
  if (s < 10) return 'just now';
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  return new Date(iso).toLocaleString(undefined, { hour: 'numeric', minute: '2-digit', month: 'short', day: 'numeric' });
}

/** Subtle sync state: saved · syncing · offline · error — never blocks the UI. */
export function SyncIndicator({ compact }: { compact?: boolean }) {
  const status = useSyncStatus();
  const { client } = useSync();
  const [online, setOnline] = React.useState(true);
  React.useEffect(() => {
    const update = () => setOnline(navigator.onLine);
    update();
    window.addEventListener('online', update);
    window.addEventListener('offline', update);
    return () => {
      window.removeEventListener('online', update);
      window.removeEventListener('offline', update);
    };
  }, []);
  const state = !online ? 'offline' : status.state;
  const pending = status.pending;
  const label =
    state === 'offline' ? (pending ? `Offline · ${pending} change${pending > 1 ? 's' : ''} saved on this device` : 'Offline')
    : state === 'error' ? 'Sync issue'
    : state === 'syncing' || pending ? 'Syncing…'
    : 'All changes saved';
  const Icon = state === 'offline' ? CloudOff : state === 'error' ? AlertTriangle : state === 'syncing' || pending ? Loader2 : Check;
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={label}
          className={cn(
            'inline-flex h-7 items-center gap-1.5 rounded-md px-2 text-xs transition-colors hover:bg-bg-hover',
            state === 'offline' ? 'text-warning' : state === 'error' ? 'text-danger' : 'text-fg-subtle',
          )}
        >
          <Icon className={cn('size-3.5', (state === 'syncing' || (pending > 0 && state !== 'offline')) && 'animate-spin')} aria-hidden />
          {compact ? null : <span className="truncate">{label}</span>}
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-72 p-3 text-sm">
        <p className="font-medium">{label}</p>
        <p className="mt-1 text-xs leading-relaxed text-fg-muted">
          {state === 'offline'
            ? 'You can keep working. Everything is stored on this device and will sync automatically when you reconnect.'
            : state === 'error'
              ? (status.error?.message ?? 'We’ll keep retrying in the background.')
              : `Last synced ${ago(status.lastSyncedAt)}.`}
        </p>
        {pending ? <p className="mt-2 text-xs text-fg-muted">{pending} pending change{pending > 1 ? 's' : ''}</p> : null}
        <div className="mt-3 flex gap-2">
          <Button size="xs" variant="secondary" onClick={() => void client.sync()}>
            Sync now
          </Button>
          {state === 'error' ? (
            <Button size="xs" variant="ghost" onClick={() => void client.rebuildCache()}>
              Rebuild local cache
            </Button>
          ) : null}
        </div>
      </PopoverContent>
    </Popover>
  );
}
