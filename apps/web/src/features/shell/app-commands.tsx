'use client';

import * as React from 'react';

/**
 * App-level actions shared by hotkeys, the command palette, menus and buttons. AppShell provides
 * the implementation; callers never re-implement what a command does.
 */
export interface AppCommands {
  openPalette: () => void;
  /** In-app "New task" dialog. */
  newTask: () => void;
  newList: () => void;
  /** Desktop: the floating Quick Capture window. Web: the in-app capture dialog. */
  quickCapture: () => void;
  /** Keyboard shortcuts overlay; focus returns to `from` (or the initiating element) on close. */
  openShortcuts: (from?: HTMLElement | null) => void;
  toggleSidebar: () => void;
  talk: () => void;
}

const noop = () => undefined;
const Ctx = React.createContext<AppCommands>({ openPalette: noop, newTask: noop, newList: noop, quickCapture: noop, openShortcuts: noop, toggleSidebar: noop, talk: noop });

export const AppCommandsProvider = Ctx.Provider;
export const useAppCommands = () => React.useContext(Ctx);

const OVERLAY = '[role="dialog"],[role="menu"],[role="listbox"],[data-radix-popper-content-wrapper]';

/**
 * Tracks the last element focused outside overlays, so a dialog opened from a menu item or the
 * command palette (both of which unmount) can hand focus back to something that still exists.
 */
export function useFocusReturn() {
  const last = React.useRef<HTMLElement | null>(null);
  React.useEffect(() => {
    const onFocus = (e: FocusEvent) => {
      const el = e.target;
      if (el instanceof HTMLElement && !el.closest(OVERLAY)) last.current = el;
    };
    document.addEventListener('focusin', onFocus);
    return () => document.removeEventListener('focusin', onFocus);
  }, []);
  /** Best element to return focus to, given what is focused right now. */
  return React.useCallback((from?: HTMLElement | null): HTMLElement | null => {
    if (from) return from;
    const active = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    if (active && active !== document.body && !active.closest(OVERLAY)) return active;
    // Opened from a dropdown: return to the button that opened it.
    const menuTrigger = document.querySelector<HTMLElement>('[aria-haspopup="menu"][aria-expanded="true"]');
    return menuTrigger ?? (last.current?.isConnected ? last.current : null);
  }, []);
}
