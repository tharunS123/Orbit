'use client';

import * as React from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { PanelLeftOpen, WifiOff } from 'lucide-react';
import { routes } from '@orbit/shared';
import { Button, Dialog, DialogContent, SheetContent, Spinner, Tooltip, cn } from '@orbit/ui';
import { Dialog as D } from 'radix-ui';
import { CollabProvider } from '@/lib/collab';
import { SHORTCUTS, isTypingTarget, useHotkeys } from '@/lib/hotkeys';
import { useTaskPanel } from '@/lib/nav';
import { useStoreQuery, useSync, useSyncStatus } from '@/lib/sync';
import { useUndo } from '@/lib/undo';
import { useWorkspace } from '@/lib/workspace';
import { UploadsProvider } from '@/features/files/uploads';
import { QuickCaptureForm } from '@/features/tasks/quick-capture';
import { TaskDetail } from '@/features/tasks/task-detail';
import { LogoMark } from '@/components/brand';
import { CommandPalette } from './command-palette';
import { MobileNav } from './mobile-nav';
import { Sidebar } from './sidebar';

const SIDEBAR_KEY = 'orbit.sidebar';

function useSidebarPrefs() {
  const [prefs, setPrefs] = React.useState<{ width: number; collapsed: boolean }>({ width: 264, collapsed: false });
  React.useEffect(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(SIDEBAR_KEY) ?? 'null') as { width: number; collapsed: boolean } | null;
      if (saved) setPrefs({ width: Math.min(420, Math.max(220, saved.width)), collapsed: saved.collapsed });
    } catch {
      /* ignore corrupt prefs */
    }
  }, []);
  const update = React.useCallback((patch: Partial<{ width: number; collapsed: boolean }>) => {
    setPrefs((p) => {
      const next = { ...p, ...patch };
      try {
        localStorage.setItem(SIDEBAR_KEY, JSON.stringify(next));
      } catch {
        /* ignore */
      }
      return next;
    });
  }, []);
  return [prefs, update] as const;
}

function useIsDesktop() {
  const [desktop, setDesktop] = React.useState(true);
  React.useEffect(() => {
    const mq = window.matchMedia('(min-width: 768px)');
    const on = () => setDesktop(mq.matches);
    on();
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, []);
  return desktop;
}

/** First run: wait for the initial pull so onboarding decisions use real data. */
function useFirstSyncGate() {
  const { userId } = useSync();
  const status = useSyncStatus();
  const profile = useStoreQuery(['profiles'], (s) => s.get('profiles', userId), [userId]);
  return { ready: Boolean(profile) || Boolean(status.lastSyncedAt), profile, status };
}

export function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const { actions } = useSync();
  const { workspaceId } = useWorkspace();
  const undo = useUndo();
  const panel = useTaskPanel();
  const desktop = useIsDesktop();
  const [prefs, setPrefs] = useSidebarPrefs();
  const [paletteOpen, setPaletteOpen] = React.useState(false);
  const [captureOpen, setCaptureOpen] = React.useState(false);
  const [mobileSidebar, setMobileSidebar] = React.useState(false);
  const gate = useFirstSyncGate();

  React.useEffect(() => {
    if (gate.profile && !gate.profile.onboardedAt && pathname !== '/onboarding') router.replace('/onboarding');
  }, [gate.profile, pathname, router]);

  React.useEffect(() => {
    const open = () => setPaletteOpen(true);
    const capture = () => setCaptureOpen(true);
    const talk = () => router.push(`${pathname}?talk=1`);
    window.addEventListener('orbit:palette', open);
    window.addEventListener('orbit:capture', capture);
    window.addEventListener('orbit:talk', talk);
    return () => {
      window.removeEventListener('orbit:palette', open);
      window.removeEventListener('orbit:capture', capture);
      window.removeEventListener('orbit:talk', talk);
    };
  }, [pathname, router]);

  const newList = React.useCallback(() => {
    if (!workspaceId) return;
    const res = undo.run(null, () => actions.createList({ workspaceId, title: '' }), { toast: false }) as { id: string } | undefined;
    if (res?.id) router.push(`${routes.list(res.id)}&new=1`);
  }, [workspaceId, actions, router, undo]);

  const startTalk = React.useCallback(() => window.dispatchEvent(new CustomEvent('orbit:talk-open')), []);
  const recordMeeting = React.useCallback(() => router.push(`${routes.meetings()}?record=1`), [router]);

  useHotkeys(
    {
      [SHORTCUTS.palette]: () => setPaletteOpen((o) => !o),
      [SHORTCUTS.search]: () => setPaletteOpen(true),
      [SHORTCUTS.newTask]: () => setCaptureOpen(true),
      [SHORTCUTS.quickCapture]: () => setCaptureOpen(true),
      [SHORTCUTS.newList]: newList,
      [SHORTCUTS.talk]: startTalk,
      [SHORTCUTS.inbox]: () => router.push(routes.inbox()),
      [SHORTCUTS.today]: () => router.push(routes.today()),
      [SHORTCUTS.upcoming]: () => router.push(routes.upcoming()),
      [SHORTCUTS.meetings]: () => router.push(routes.meetings()),
      [SHORTCUTS.updates]: () => router.push(routes.updates()),
      [SHORTCUTS.settings]: () => router.push(routes.settings()),
      [SHORTCUTS.help]: () => router.push(routes.shortcuts()),
      [SHORTCUTS.toggleSidebar]: () => setPrefs({ collapsed: !prefs.collapsed }),
      [SHORTCUTS.undo]: (e) => !isTypingTarget(e.target) && undo.undo(),
      [SHORTCUTS.redo]: (e) => !isTypingTarget(e.target) && undo.redo(),
    },
    [prefs.collapsed, newList, startTalk],
    { preventDefault: false },
  );

  // Escape closes the task panel when nothing else handles it.
  useHotkeys({ escape: () => panel.taskId && panel.close() }, [panel.taskId], { preventDefault: false });

  if (pathname === '/onboarding') return <CollabProvider><UploadsProvider>{children}</UploadsProvider></CollabProvider>;

  if (!gate.ready) {
    const offline = gate.status.state === 'offline';
    return (
      <main className="grid min-h-dvh place-items-center bg-bg px-6 text-center">
        <div className="flex flex-col items-center gap-4">
          <LogoMark size={40} />
          {offline ? (
            <>
              <WifiOff className="size-5 text-warning" />
              <p className="max-w-xs text-sm text-fg-muted">You’re offline and this device hasn’t synced yet. Connect once to download your workspace — after that it works offline.</p>
            </>
          ) : (
            <p className="flex items-center gap-2 text-sm text-fg-muted">
              <Spinner /> Setting up your workspace…
            </p>
          )}
        </div>
      </main>
    );
  }

  const sidebar = <Sidebar onCollapse={() => (desktop ? setPrefs({ collapsed: true }) : setMobileSidebar(false))} onNewTask={() => setCaptureOpen(true)} onTalk={startTalk} />;

  return (
    <CollabProvider>
      <UploadsProvider>
        <div className="flex h-dvh overflow-hidden bg-bg">
          {desktop && !prefs.collapsed ? (
            <aside className="relative hidden shrink-0 border-r border-border md:block" style={{ width: prefs.width }}>
              {sidebar}
              <div
                role="separator"
                aria-orientation="vertical"
                aria-label="Resize sidebar"
                tabIndex={0}
                onKeyDown={(e) => {
                  if (e.key === 'ArrowLeft') setPrefs({ width: Math.max(220, prefs.width - 16) });
                  if (e.key === 'ArrowRight') setPrefs({ width: Math.min(420, prefs.width + 16) });
                }}
                onPointerDown={(e) => {
                  const startX = e.clientX;
                  const startW = prefs.width;
                  const move = (ev: PointerEvent) => setPrefs({ width: Math.min(420, Math.max(220, startW + ev.clientX - startX)) });
                  const up = () => {
                    window.removeEventListener('pointermove', move);
                    window.removeEventListener('pointerup', up);
                  };
                  window.addEventListener('pointermove', move);
                  window.addEventListener('pointerup', up);
                }}
                className="absolute top-0 -right-1 z-10 h-full w-2 cursor-col-resize hover:bg-accent/20 focus-visible:bg-accent/30"
              />
            </aside>
          ) : null}
          {!desktop ? (
            <D.Root open={mobileSidebar} onOpenChange={setMobileSidebar}>
              <D.Portal>
                <D.Overlay className="fixed inset-0 z-40 bg-overlay" />
                <D.Content className="fixed inset-y-0 left-0 z-50 w-[85vw] max-w-xs bg-bg-subtle shadow-lg outline-none data-[state=open]:animate-in data-[state=open]:slide-in-from-left" onClick={(e) => (e.target as HTMLElement).closest('a') && setMobileSidebar(false)}>
                  <D.Title className="sr-only">Navigation</D.Title>
                  <D.Description className="sr-only">Lists and sections</D.Description>
                  {sidebar}
                </D.Content>
              </D.Portal>
            </D.Root>
          ) : null}
          <div className="relative flex min-w-0 flex-1">
            {desktop && prefs.collapsed ? (
              <Tooltip content="Show sidebar" shortcut={SHORTCUTS.toggleSidebar} side="right">
                <Button variant="ghost" size="icon-sm" className="absolute top-2.5 left-2 z-20" aria-label="Show sidebar" onClick={() => setPrefs({ collapsed: false })}>
                  <PanelLeftOpen />
                </Button>
              </Tooltip>
            ) : null}
            <main id="main" className={cn('min-w-0 flex-1 overflow-y-auto', !desktop && 'pb-24')} data-sidebar-collapsed={prefs.collapsed}>
              <ShellContext.Provider value={{ openSidebar: () => setMobileSidebar(true), desktop, sidebarCollapsed: prefs.collapsed }}>{children}</ShellContext.Provider>
            </main>
            {panel.taskId && desktop ? (
              <aside aria-label="Task details" className="w-[min(560px,48vw)] shrink-0 border-l border-border shadow-[-8px_0_24px_-16px_rgb(0_0_0/0.15)] animate-in slide-in-from-right-4 fade-in-0">
                <TaskDetail key={panel.taskId} taskId={panel.taskId} onClose={panel.close} onOpenTask={panel.open} />
              </aside>
            ) : null}
          </div>
        </div>
        {!desktop ? (
          <>
            <MobileNav onCreate={() => setCaptureOpen(true)} onTalk={startTalk} />
            <D.Root open={Boolean(panel.taskId)} onOpenChange={(o) => !o && panel.close()}>
              <SheetContent title="Task details" side="bottom" className="h-[92dvh]">
                {panel.taskId ? <TaskDetail key={panel.taskId} taskId={panel.taskId} onClose={panel.close} onOpenTask={panel.open} /> : null}
              </SheetContent>
            </D.Root>
          </>
        ) : null}
        <CommandPalette open={paletteOpen} onOpenChange={setPaletteOpen} onNewTask={() => setCaptureOpen(true)} onNewList={newList} onTalk={startTalk} onRecordMeeting={recordMeeting} />
        <Dialog open={captureOpen} onOpenChange={setCaptureOpen}>
          <DialogContent title="New task" size="md">
            <QuickCaptureForm defaultListId={pathname === '/list' ? new URLSearchParams(window.location.search).get('id') : null} onDone={() => setCaptureOpen(false)} />
          </DialogContent>
        </Dialog>
      </UploadsProvider>
    </CollabProvider>
  );
}

export interface ShellContextValue {
  openSidebar: () => void;
  desktop: boolean;
  sidebarCollapsed: boolean;
}
export const ShellContext = React.createContext<ShellContextValue>({ openSidebar: () => undefined, desktop: true, sidebarCollapsed: false });
export const useShell = () => React.useContext(ShellContext);
