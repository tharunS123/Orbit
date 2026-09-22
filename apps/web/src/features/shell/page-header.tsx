'use client';

import * as React from 'react';
import Link from 'next/link';
import { Bell, Menu as MenuIcon } from 'lucide-react';
import { routes } from '@orbit/shared';
import { selectNotifications } from '@orbit/sync/client';
import { Button, cn } from '@orbit/ui';
import { useStoreQuery, useSync } from '@/lib/sync';
import { useShell } from './app-shell';
import { SyncIndicator } from './sync-indicator';

export function PageHeader({ title, subtitle, icon, actions, className, children }: { title: React.ReactNode; subtitle?: React.ReactNode; icon?: React.ReactNode; actions?: React.ReactNode; className?: string; children?: React.ReactNode }) {
  const { openSidebar, desktop, sidebarCollapsed } = useShell();
  const { userId } = useSync();
  const unread = useStoreQuery(['notifications'], (s) => selectNotifications(s, userId).unread, [userId]);
  return (
    <header className={cn('sticky top-0 z-20 border-b border-transparent bg-bg/90 backdrop-blur-md safe-top', className)}>
      <div className={cn('mx-auto flex max-w-4xl items-center gap-2 px-4 pt-4 pb-2 sm:px-8 sm:pt-8', desktop && sidebarCollapsed && 'pl-12 sm:pl-14')}>
        {!desktop ? (
          <Button variant="ghost" size="icon" aria-label="Open navigation" onClick={openSidebar} className="-ml-2">
            <MenuIcon />
          </Button>
        ) : null}
        <div className="flex min-w-0 flex-1 items-center gap-2.5">
          {icon ? <span className="text-accent [&_svg]:size-6">{icon}</span> : null}
          <div className="min-w-0">
            <h1 className="truncate text-2xl font-semibold tracking-tight">{title}</h1>
            {subtitle ? <p className="truncate text-sm text-fg-muted">{subtitle}</p> : null}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {actions}
          {!desktop ? (
            <>
              <SyncIndicator compact />
              <Button asChild variant="ghost" size="icon" aria-label={unread ? `Updates, ${unread} unread` : 'Updates'} className="relative">
                <Link href={routes.updates()}>
                  <Bell />
                  {unread ? <span className="absolute top-1.5 right-1.5 size-2 rounded-full bg-accent" aria-hidden /> : null}
                </Link>
              </Button>
            </>
          ) : null}
        </div>
      </div>
      {children ? <div className="mx-auto max-w-4xl px-4 pb-2 sm:px-8">{children}</div> : null}
    </header>
  );
}

export function PageBody({ children, className }: { children: React.ReactNode; className?: string }) {
  return <div className={cn('mx-auto max-w-4xl px-4 pb-16 sm:px-8', className)}>{children}</div>;
}

export function SectionTitle({ children, count, action, tone }: { children: React.ReactNode; count?: number; action?: React.ReactNode; tone?: 'danger' }) {
  return (
    <div className="mt-6 mb-1 flex items-center gap-2 px-1">
      <h2 className={cn('text-[13px] font-semibold', tone === 'danger' ? 'text-danger' : 'text-fg-muted')}>{children}</h2>
      {count ? <span className="text-xs text-fg-subtle tabular-nums">{count}</span> : null}
      <div className="ml-auto">{action}</div>
    </div>
  );
}
