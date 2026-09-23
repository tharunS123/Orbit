'use client';

import * as React from 'react';
import Link from 'next/link';
import { Search, Settings2 } from 'lucide-react';
import { acceleratorText, describeAccelerator, formatAccelerator, routes } from '@orbit/shared';
import { Dialog, DialogContent, Kbd, Shortcut, cn, useKeyboardOS } from '@orbit/ui';
import { isDesktop, useQuickCaptureConfig } from '@/lib/desktop';
import { SHORTCUTS, displayGroups, shortcutSections, type ShortcutDefinition } from '@/lib/shortcuts';

function Keys({ def, globalAccelerator }: { def: ShortcutDefinition; globalAccelerator: string | null }) {
  const os = useKeyboardOS();
  if (def.scope === 'desktop' && globalAccelerator) {
    return (
      <span className="inline-flex items-center gap-0.5" role="img" aria-label={describeAccelerator(globalAccelerator, os)}>
        {formatAccelerator(globalAccelerator, os).map((k, i) => (
          <Kbd key={`${k}-${i}`}>{k}</Kbd>
        ))}
      </span>
    );
  }
  if (def.literal) return <code className="rounded-xs bg-bg-hover px-1.5 py-0.5 font-mono text-xs text-fg">{def.keys}</code>;
  return (
    <span className="inline-flex flex-wrap items-center justify-end gap-1">
      {displayGroups(def, os).map((group, i) => (
        <React.Fragment key={group.join()}>
          {i > 0 ? <span className="text-[11px] text-fg-subtle">or</span> : null}
          {group.map((c, j) => (
            <React.Fragment key={c}>
              {j > 0 ? <span className="text-[11px] text-fg-subtle" aria-label="and">/</span> : null}
              <Shortcut keys={c} />
            </React.Fragment>
          ))}
        </React.Fragment>
      ))}
    </span>
  );
}

/**
 * Filterable, grouped list of every shortcut, rendered from the registry. Used by the overlay
 * and by Settings → Shortcuts.
 */
export function ShortcutReference({ autoFocus, className, columns = 2 }: { autoFocus?: boolean; className?: string; columns?: 1 | 2 }) {
  const os = useKeyboardOS();
  const [query, setQuery] = React.useState('');
  const [config] = useQuickCaptureConfig();
  const desktopApp = isDesktop();
  const globalAccelerator = config?.enabled ? config.shortcut : null;
  const sections = shortcutSections({ query, os, desktop: desktopApp, globalQuickCapture: globalAccelerator });
  const count = sections.reduce((n, s) => n + s.items.length, 0);
  const listId = React.useId();

  return (
    <div className={cn('flex min-h-0 flex-col gap-4', className)}>
      <div className="relative">
        <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-fg-subtle" aria-hidden />
        <input
          type="search"
          autoFocus={autoFocus}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Filter shortcuts…"
          aria-label="Filter shortcuts"
          aria-controls={listId}
          className="h-9 w-full rounded-md border border-border bg-surface-sunken pr-3 pl-9 text-sm outline-none placeholder:text-fg-subtle focus-visible:border-accent focus-visible:ring-2 focus-visible:ring-accent/30"
        />
        <span className="sr-only" aria-live="polite">
          {query ? `${count} shortcut${count === 1 ? '' : 's'} found` : ''}
        </span>
      </div>
      <div id={listId} className={cn('grid gap-x-8 gap-y-6', columns === 2 && 'md:grid-cols-2')}>
        {sections.length === 0 ? <p className="py-6 text-center text-sm text-fg-muted">No shortcuts match “{query}”.</p> : null}
        {sections.map((section) => {
          const headingId = `${listId}-${section.category}`;
          return (
            <section key={section.category} aria-labelledby={headingId} className="min-w-0">
              <h3 id={headingId} className="mb-1.5 text-[11px] font-semibold tracking-wide text-fg-subtle uppercase">
                {section.title}
              </h3>
              <ul className="flex flex-col">
                {section.items.map((d) => (
                  <li key={d.id} className="flex min-h-9 items-center justify-between gap-3 border-b border-border/60 py-1.5 text-sm last:border-b-0">
                    <span className="min-w-0 text-fg-muted">{d.label}</span>
                    <Keys def={d} globalAccelerator={globalAccelerator} />
                  </li>
                ))}
              </ul>
            </section>
          );
        })}
      </div>
      {desktopApp && config && !config.enabled ? <p className="text-xs text-fg-subtle">Global Quick Capture is turned off. Turn it on in Settings → Desktop app.</p> : null}
      {desktopApp && config?.enabled ? <p className="sr-only">Global Quick Capture shortcut: {acceleratorText(config.shortcut, os)}</p> : null}
    </div>
  );
}

/** The keyboard shortcuts overlay. One instance lives in AppShell; open it via useAppCommands(). */
export function ShortcutsDialog({ open, onOpenChange, returnFocus }: { open: boolean; onOpenChange: (open: boolean) => void; returnFocus: React.RefObject<HTMLElement | null> }) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        title="Keyboard shortcuts"
        description={
          <span className="inline-flex flex-wrap items-center gap-1">
            Open this list anytime with <Shortcut keys={SHORTCUTS.help} /> or <Shortcut keys="?" />
          </span>
        }
        size="xl"
        className="max-h-[min(86vh,760px)] sm:top-[7vh]"
        data-testid="shortcuts-dialog"
        onOpenAutoFocus={(e) => {
          // Start in the filter box (Radix would otherwise focus the Close button first).
          const input = (e.currentTarget as HTMLElement | null)?.querySelector<HTMLInputElement>('input[type="search"]');
          if (input) {
            e.preventDefault();
            input.focus();
          }
        }}
        onCloseAutoFocus={(e) => {
          const el = returnFocus.current;
          if (el?.isConnected) {
            e.preventDefault();
            el.focus();
          }
        }}
      >
        <ShortcutReference />
        <div className="mt-5 flex items-center justify-end border-t border-border pt-3">
          <Link href={routes.settings('desktop')} onClick={() => onOpenChange(false)} className="inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-xs text-fg-muted hover:bg-bg-hover hover:text-fg focus-visible:ring-2 focus-visible:ring-accent/40 focus-visible:outline-none">
            <Settings2 className="size-3.5" /> Customize Quick Capture shortcut
          </Link>
        </div>
      </DialogContent>
    </Dialog>
  );
}
