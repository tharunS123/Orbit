'use client';

import * as React from 'react';
import { Check, CornerDownLeft, LogIn, WifiOff } from 'lucide-react';
import { PRODUCT } from '@orbit/shared';
import { Button, Kbd, Shortcut, Spinner, cn } from '@orbit/ui';
import { LogoMark } from '@/components/brand';
import { DESKTOP_EVENTS, desktop, useDesktopEvent } from '@/lib/desktop';
import { announceOutboxChanged } from '@/lib/outbox-channel';
import { useSession } from '@/lib/session';
import { SHORTCUTS } from '@/lib/shortcuts';
import { SyncProvider, useSync } from '@/lib/sync';
import { UndoProvider } from '@/lib/undo';
import { WorkspaceProvider, useWorkspace } from '@/lib/workspace';
import { CaptureChips, CaptureControls, useCaptureDraft } from '@/features/tasks/capture-fields';

/** An unfinished draft survives closing the window for this long, then starts fresh. */
export const DRAFT_TTL_MS = 5 * 60_000;
/** Tall enough for an open picker (search + ~6 rows) below the input. */
const PICKER_HEIGHT = 460;
const DRAFT_KEY = 'orbit.quickCapture.draft';

/** Hide the window (desktop) — in a browser tab this page just stays put. */
function closeWindow() {
  void desktop.hideQuickCapture().catch(() => undefined);
}

/** Report the content height so the native window hugs it (160–460px). */
function useFitWindow(ref: React.RefObject<HTMLElement | null>, pickerOpen: boolean) {
  React.useEffect(() => {
    const el = ref.current;
    if (!el) return;
    let last = 0;
    const report = () => {
      const h = Math.ceil(Math.max(el.getBoundingClientRect().height, pickerOpen ? PICKER_HEIGHT : 0));
      if (h !== last) {
        last = h;
        void desktop.resizeQuickCapture(h).catch(() => undefined);
      }
    };
    report();
    const ro = new ResizeObserver(report);
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref, pickerOpen]);
}

/** Escape closes the window unless a picker/menu (which handles Escape itself) is open. */
function useEscapeToClose(onClose: () => void) {
  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return;
      if (document.querySelector('[data-radix-popper-content-wrapper], [role="dialog"][data-state="open"]:not([data-capture-root])')) return;
      e.preventDefault();
      onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
}

function useOnline() {
  return React.useSyncExternalStore(
    (cb) => {
      window.addEventListener('online', cb);
      window.addEventListener('offline', cb);
      return () => {
        window.removeEventListener('online', cb);
        window.removeEventListener('offline', cb);
      };
    },
    () => navigator.onLine,
    () => true,
  );
}

function Panel({ children, className, panelRef }: { children: React.ReactNode; className?: string; panelRef?: React.Ref<HTMLDivElement> }) {
  return (
    <div ref={panelRef} data-capture-root className={cn('flex flex-col bg-surface', className)}>
      {children}
    </div>
  );
}

function Header({ right }: { right?: React.ReactNode }) {
  return (
    // Dragging the header moves the frameless window.
    <div data-tauri-drag-region className="flex h-10 shrink-0 items-center gap-2 px-4 select-none">
      <LogoMark size={16} />
      <h1 data-tauri-drag-region className="text-[13px] font-semibold text-fg">
        New task
      </h1>
      <div className="ml-auto flex items-center gap-2 text-[11px] text-fg-subtle">{right}</div>
    </div>
  );
}

function Message({ title, body, action }: { title: string; body?: string; action?: React.ReactNode }) {
  const ref = React.useRef<HTMLDivElement>(null);
  useFitWindow(ref, false);
  useEscapeToClose(closeWindow);
  return (
    <Panel panelRef={ref}>
      <Header />
      <div className="flex items-center gap-4 px-4 pt-1 pb-4">
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium text-fg">{title}</p>
          {body ? <p className="mt-0.5 text-xs text-fg-muted">{body}</p> : null}
        </div>
        {action}
      </div>
    </Panel>
  );
}

function CaptureForm() {
  const { client, userId } = useSync();
  const { workspaceId, workspaces } = useWorkspace();
  const online = useOnline();
  const draft = useCaptureDraft({ workspaceId, defaultListId: null });
  const [saved, setSaved] = React.useState<string | null>(null);
  const [pickerOpen, setPickerOpen] = React.useState(false);
  const input = React.useRef<HTMLTextAreaElement>(null);
  const root = React.useRef<HTMLDivElement>(null);
  const hiddenAt = React.useRef<number | null>(null);
  useFitWindow(root, pickerOpen);

  const { text, setText, reset } = draft;

  // Restore an unfinished draft after a reload of this window.
  React.useEffect(() => {
    try {
      const saved = JSON.parse(sessionStorage.getItem(DRAFT_KEY) ?? 'null') as { text: string; at: number } | null;
      if (saved && Date.now() - saved.at < DRAFT_TTL_MS) setText(saved.text);
    } catch {
      /* ignore */
    }
  }, [setText]);
  React.useEffect(() => {
    try {
      if (text) sessionStorage.setItem(DRAFT_KEY, JSON.stringify({ text, at: Date.now() }));
      else sessionStorage.removeItem(DRAFT_KEY);
    } catch {
      /* ignore */
    }
  }, [text]);

  const focusInput = React.useCallback(() => {
    const el = input.current;
    if (!el) return;
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
  }, []);

  const close = React.useCallback(() => {
    hiddenAt.current = Date.now();
    setPickerOpen(false);
    closeWindow();
  }, []);
  useEscapeToClose(close);

  // Shown again by the global shortcut: refresh lists/labels from the shared cache, drop a stale
  // draft, and put the caret in the input.
  const onShown = React.useCallback(() => {
    setSaved(null);
    if (hiddenAt.current && Date.now() - hiddenAt.current > DRAFT_TTL_MS) reset();
    hiddenAt.current = null;
    focusInput();
    void client.reload().catch(() => undefined);
  }, [client, reset, focusInput]);
  useDesktopEvent(DESKTOP_EVENTS.quickCaptureShown, onShown);
  React.useEffect(() => {
    focusInput();
    const onFocus = () => !document.querySelector('[data-radix-popper-content-wrapper]') && focusInput();
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [focusInput]);

  const submit = () => {
    if (saved) return;
    const res = draft.save({ toast: false });
    if (!res) return;
    setSaved(res.destination);
    // Make it durable, tell the main window, then get out of the way.
    void client
      .flush()
      .then(() => announceOutboxChanged(userId))
      .finally(() =>
        setTimeout(() => {
          hiddenAt.current = Date.now();
          closeWindow();
          setSaved(null);
        }, 450),
      );
  };

  if (!workspaces.length) {
    return (
      <Message
        title={`Finish setting up ${PRODUCT.name}`}
        body="Open the app once while online to download your workspace."
        action={
          <Button size="sm" variant="primary" onClick={() => void desktop.showMainWindow('/inbox').then(closeWindow)}>
            Open {PRODUCT.name}
          </Button>
        }
      />
    );
  }

  return (
    <Panel panelRef={root}>
      <Header
        right={
          !online ? (
            <span className="inline-flex items-center gap-1 text-warning" role="status">
              <WifiOff className="size-3" aria-hidden /> Offline — saves now, syncs later
            </span>
          ) : null
        }
      />
      <form
        className="flex flex-col gap-2 px-4 pb-3"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <textarea
          ref={input}
          autoFocus
          rows={1}
          value={text}
          disabled={Boolean(saved)}
          onChange={(e) => setText(e.target.value.replace(/\n/g, ' '))}
          onKeyDown={(e) => {
            // Enter (and ⌘/Ctrl+Enter) save; titles are single-line.
            if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
              e.preventDefault();
              submit();
            }
          }}
          placeholder="Finish project proposal tomorrow at 4pm #work"
          aria-label="Task"
          aria-describedby="capture-help"
          className="field-sizing-content max-h-28 min-h-8 w-full resize-none bg-transparent text-[17px] leading-snug text-fg outline-none placeholder:text-fg-subtle disabled:opacity-60"
        />
        <CaptureChips draft={draft} showDestination />
        <div className="-mx-2 flex items-center justify-between gap-2 border-t border-border pt-2">
          <CaptureControls draft={draft} onPickerOpenChange={setPickerOpen} />
          <Button type="submit" variant="primary" size="sm" disabled={!text.trim() || Boolean(saved)} className="mr-2 shrink-0">
            {saved ? (
              <>
                <Check /> Added
              </>
            ) : (
              <>
                Add <CornerDownLeft />
              </>
            )}
          </Button>
        </div>
        <p id="capture-help" className="sr-only">
          Type a task in plain language — dates, times, repeats, #labels and @people are recognised. Enter saves, Escape closes, Tab moves to destination, due date, labels and assignee.
        </p>
      </form>
      <div role="status" aria-live="assertive" className="sr-only">
        {saved ? `Added to ${saved}` : ''}
      </div>
      <div className="flex h-7 shrink-0 items-center gap-3 border-t border-border bg-bg-subtle px-4 text-[11px] text-fg-subtle" aria-hidden>
        <span className="inline-flex items-center gap-1">
          <Kbd>↵</Kbd> save
        </span>
        <span className="inline-flex items-center gap-1">
          <Kbd>Esc</Kbd> close
        </span>
        <span className="inline-flex items-center gap-1">
          <Kbd>Tab</Kbd> details
        </span>
        <span className="ml-auto inline-flex items-center gap-1">
          <Shortcut keys={SHORTCUTS.palette} /> in {PRODUCT.name}
        </span>
      </div>
    </Panel>
  );
}

/**
 * The desktop Quick Capture window (`/capture`). It never syncs itself: it reads the local cache
 * the main window maintains and queues the task in the shared outbox, which the main window
 * adopts and pushes (offline too).
 */
export function QuickCaptureWindow() {
  const { session, loading, userId } = useSession();
  React.useEffect(() => {
    document.documentElement.dataset.window = 'quick-capture';
  }, []);

  if (loading) {
    return (
      <Panel className="h-40 items-center justify-center">
        <Spinner />
      </Panel>
    );
  }
  if (!session || !userId) {
    return (
      <Message
        title="Sign in to Orbit to use Quick Capture"
        action={
          <Button size="sm" variant="primary" onClick={() => void desktop.showMainWindow('/login').then(closeWindow)}>
            <LogIn /> Open {PRODUCT.name}
          </Button>
        }
      />
    );
  }
  return (
    <SyncProvider
      key={userId}
      userId={userId}
      mode="satellite"
      onUnauthorized={() => undefined}
      fallback={
        <Panel className="h-40 items-center justify-center">
          <Spinner label="Opening" />
        </Panel>
      }
    >
      <WorkspaceProvider>
        <UndoProvider>
          <CaptureForm />
        </UndoProvider>
      </WorkspaceProvider>
    </SyncProvider>
  );
}
