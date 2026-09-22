'use client';

import * as React from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { CalendarRange, Inbox, LayoutList, Plus, Sun, Video } from 'lucide-react';
import { routes } from '@orbit/shared';
import { cn } from '@orbit/ui';

/**
 * One-handed bottom navigation for phones. The centre button creates a task; long-pressing it
 * starts Talk (voice capture).
 */
export function MobileNav({ onCreate, onTalk }: { onCreate: () => void; onTalk: () => void }) {
  const pathname = usePathname();
  const timer = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const longPressed = React.useRef(false);
  const items = [
    { href: routes.inbox(), icon: Inbox, label: 'Inbox', match: '/inbox' },
    { href: routes.today(), icon: Sun, label: 'Today', match: '/today' },
    null,
    { href: routes.upcoming(), icon: CalendarRange, label: 'Upcoming', match: '/upcoming' },
    { href: routes.lists(), icon: LayoutList, label: 'Lists', match: '/lists' },
  ];
  return (
    <nav aria-label="Main" className="fixed inset-x-0 bottom-0 z-30 border-t border-border bg-surface/95 backdrop-blur-md safe-bottom md:hidden">
      <div className="mx-auto flex h-16 max-w-lg items-center justify-around px-2">
        {items.map((item) =>
          item ? (
            <Link
              key={item.href}
              href={item.href}
              aria-current={pathname === item.match ? 'page' : undefined}
              className={cn('flex h-full min-w-14 flex-col items-center justify-center gap-0.5 text-[11px] font-medium', pathname === item.match ? 'text-accent' : 'text-fg-subtle')}
            >
              <item.icon className="size-[22px]" aria-hidden />
              {item.label}
            </Link>
          ) : (
            <button
              key="create"
              type="button"
              aria-label="New task (hold for Talk)"
              className="-mt-6 grid size-14 place-items-center rounded-full bg-accent text-accent-fg shadow-md active:scale-95"
              onPointerDown={() => {
                longPressed.current = false;
                timer.current = setTimeout(() => {
                  longPressed.current = true;
                  navigator.vibrate?.(15);
                  onTalk();
                }, 450);
              }}
              onPointerUp={() => timer.current && clearTimeout(timer.current)}
              onPointerLeave={() => timer.current && clearTimeout(timer.current)}
              onClick={() => {
                if (!longPressed.current) onCreate();
              }}
              onContextMenu={(e) => e.preventDefault()}
            >
              <Plus className="size-7" />
            </button>
          ),
        )}
      </div>
    </nav>
  );
}

export function MobileMeetingsLink() {
  return (
    <Link href={routes.meetings()} className="text-fg-muted" aria-label="Meetings">
      <Video className="size-5" />
    </Link>
  );
}
