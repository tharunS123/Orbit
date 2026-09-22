'use client';

import * as React from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { Spinner } from '@orbit/ui';
import { AppShell } from '@/features/shell/app-shell';
import { useSession } from '@/lib/session';
import { SyncProvider } from '@/lib/sync';
import { UndoProvider } from '@/lib/undo';
import { WorkspaceProvider } from '@/lib/workspace';
import { LogoMark } from '@/components/brand';

function Splash({ label }: { label: string }) {
  return (
    <main className="grid min-h-dvh place-items-center bg-bg" aria-busy>
      <div className="flex flex-col items-center gap-4">
        <LogoMark size={40} className="animate-pulse" />
        <span className="flex items-center gap-2 text-sm text-fg-muted">
          <Spinner /> {label}
        </span>
      </div>
    </main>
  );
}

export default function AppLayout({ children }: { children: React.ReactNode }) {
  const { session, loading, userId, signOut } = useSession();
  const router = useRouter();
  const pathname = usePathname();

  React.useEffect(() => {
    if (!loading && !session) {
      const next = typeof window !== 'undefined' ? window.location.pathname + window.location.search : pathname;
      router.replace(`/login?next=${encodeURIComponent(next)}`);
    }
  }, [loading, session, router, pathname]);

  if (loading || !userId) return <Splash label="Loading your workspace…" />;

  return (
    <SyncProvider
      key={userId}
      userId={userId}
      onUnauthorized={() => {
        void signOut().then(() => router.replace('/login'));
      }}
      fallback={<Splash label="Opening your workspace…" />}
    >
      <WorkspaceProvider>
        <UndoProvider>
          <AppShell>{children}</AppShell>
        </UndoProvider>
      </WorkspaceProvider>
    </SyncProvider>
  );
}
