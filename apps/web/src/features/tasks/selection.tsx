'use client';

import * as React from 'react';

/**
 * Multi-selection + keyboard focus for a task view. Desktop: click / ⌘-click / ⇧-click and
 * arrow keys. Mobile: long-press enters selection mode, taps toggle.
 */

export interface SelectionApi {
  selected: ReadonlySet<string>;
  focused: string | null;
  selectionMode: boolean;
  order: readonly string[];
  isSelected(id: string): boolean;
  setOrder(ids: readonly string[]): void;
  focus(id: string | null): void;
  click(id: string, mods: { shift?: boolean; toggle?: boolean }): void;
  toggle(id: string): void;
  set(ids: string[]): void;
  clear(): void;
  selectAll(): void;
  move(delta: number, extend?: boolean): string | null;
  enterSelectionMode(id: string): void;
  /** Ids actions should apply to: the selection, else the focused row. */
  targets(): string[];
}

const Ctx = React.createContext<SelectionApi | null>(null);

export function SelectionProvider({ children }: { children: React.ReactNode }) {
  const [selected, setSelected] = React.useState<ReadonlySet<string>>(new Set());
  const [focused, setFocused] = React.useState<string | null>(null);
  const [selectionMode, setSelectionMode] = React.useState(false);
  const anchor = React.useRef<string | null>(null);
  const orderRef = React.useRef<readonly string[]>([]);
  const [order, setOrderState] = React.useState<readonly string[]>([]);

  const api = React.useMemo<SelectionApi>(
    () => ({
      selected,
      focused,
      selectionMode,
      order,
      isSelected: (id) => selected.has(id),
      setOrder: (ids) => {
        orderRef.current = ids;
        setOrderState(ids);
        // Drop selections that disappeared from the view.
        setSelected((prev) => {
          const next = new Set([...prev].filter((id) => ids.includes(id)));
          return next.size === prev.size ? prev : next;
        });
      },
      focus: (id) => {
        setFocused(id);
        anchor.current = id;
      },
      click: (id, mods) => {
        const ids = orderRef.current;
        if (mods.shift && anchor.current) {
          const a = ids.indexOf(anchor.current);
          const b = ids.indexOf(id);
          if (a >= 0 && b >= 0) {
            const [lo, hi] = a < b ? [a, b] : [b, a];
            setSelected(new Set(ids.slice(lo, hi + 1)));
            setFocused(id);
            return;
          }
        }
        if (mods.toggle || selectionMode) {
          setSelected((prev) => {
            const next = new Set(prev);
            if (next.has(id)) next.delete(id);
            else next.add(id);
            if (!next.size) setSelectionMode(false);
            return next;
          });
          anchor.current = id;
          setFocused(id);
          return;
        }
        setSelected(new Set());
        anchor.current = id;
        setFocused(id);
      },
      toggle: (id) =>
        setSelected((prev) => {
          const next = new Set(prev);
          if (next.has(id)) next.delete(id);
          else next.add(id);
          return next;
        }),
      set: (ids) => setSelected(new Set(ids)),
      clear: () => {
        setSelected(new Set());
        setSelectionMode(false);
      },
      selectAll: () => setSelected(new Set(orderRef.current)),
      move: (delta, extend) => {
        const ids = orderRef.current;
        if (!ids.length) return null;
        const cur = focused ? ids.indexOf(focused) : -1;
        const nextIdx = cur < 0 ? (delta > 0 ? 0 : ids.length - 1) : Math.max(0, Math.min(ids.length - 1, cur + delta));
        const next = ids[nextIdx]!;
        if (extend) {
          const a = ids.indexOf(anchor.current ?? next);
          const [lo, hi] = a < nextIdx ? [a, nextIdx] : [nextIdx, a];
          setSelected(new Set(ids.slice(Math.max(0, lo), hi + 1)));
        } else {
          anchor.current = next;
          if (!selectionMode) setSelected(new Set());
        }
        setFocused(next);
        return next;
      },
      enterSelectionMode: (id) => {
        setSelectionMode(true);
        setSelected(new Set([id]));
        anchor.current = id;
        if (typeof navigator !== 'undefined' && 'vibrate' in navigator) navigator.vibrate?.(10);
      },
      targets: () => (selected.size ? [...selected] : focused ? [focused] : []),
    }),
    [selected, focused, selectionMode, order],
  );

  return <Ctx.Provider value={api}>{children}</Ctx.Provider>;
}

export function useSelection(): SelectionApi {
  const ctx = React.useContext(Ctx);
  if (!ctx) throw new Error('useSelection must be used inside SelectionProvider');
  return ctx;
}

export function useOptionalSelection(): SelectionApi | null {
  return React.useContext(Ctx);
}

/** Long-press detection for touch (enters selection mode). */
export function useLongPress(onLongPress: () => void, ms = 450) {
  const timer = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const fired = React.useRef(false);
  const start = React.useRef<{ x: number; y: number } | null>(null);
  const clear = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
  };
  return {
    onPointerDown: (e: React.PointerEvent) => {
      if (e.pointerType !== 'touch') return;
      fired.current = false;
      start.current = { x: e.clientX, y: e.clientY };
      clear();
      timer.current = setTimeout(() => {
        fired.current = true;
        onLongPress();
      }, ms);
    },
    onPointerMove: (e: React.PointerEvent) => {
      if (start.current && Math.hypot(e.clientX - start.current.x, e.clientY - start.current.y) > 10) clear();
    },
    onPointerUp: clear,
    onPointerCancel: clear,
    /** True if the last press became a long-press (suppress the following click). */
    consumed: () => {
      const f = fired.current;
      fired.current = false;
      return f;
    },
  };
}
