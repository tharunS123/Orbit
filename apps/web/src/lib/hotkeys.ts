'use client';

import * as React from 'react';
import { detectKeyboardOS } from '@orbit/shared';

export { SHORTCUTS } from './shortcuts';

/**
 * Keyboard shortcuts. Keys like "mod+k", "shift+alt+n", "?" and two-key sequences like "g i".
 * Plain-key shortcuts are ignored while typing in inputs/editors; "mod+" combos always fire
 * unless `allowInInputs` is false.
 */

export type HotkeyHandler = (e: KeyboardEvent) => void;
export interface HotkeyOptions {
  allowInInputs?: boolean;
  enabled?: boolean;
  preventDefault?: boolean;
}

const isMac = () => typeof navigator !== 'undefined' && detectKeyboardOS() === 'mac';

export function isTypingTarget(el: EventTarget | null): boolean {
  if (!(el instanceof HTMLElement)) return false;
  if (el.isContentEditable) return true;
  const tag = el.tagName;
  if (tag === 'TEXTAREA' || tag === 'SELECT') return true;
  if (tag === 'INPUT') {
    const type = (el as HTMLInputElement).type;
    return !['checkbox', 'radio', 'button', 'submit', 'range', 'color'].includes(type);
  }
  return false;
}

function matches(combo: string, e: KeyboardEvent): boolean {
  const parts = combo.toLowerCase().split('+');
  const key = parts.pop()!;
  const want = { mod: parts.includes('mod'), shift: parts.includes('shift'), alt: parts.includes('alt'), ctrl: parts.includes('ctrl') };
  const mod = isMac() ? e.metaKey : e.ctrlKey;
  if (want.mod !== mod) return false;
  if (want.alt !== e.altKey) return false;
  if (!isMac() && want.ctrl !== (e.ctrlKey && !want.mod)) return false;
  const eventKey = e.key.toLowerCase();
  const code = e.code.toLowerCase();
  const named: Record<string, string[]> = {
    enter: ['enter'],
    escape: ['escape'],
    esc: ['escape'],
    space: [' ', 'space'],
    up: ['arrowup'],
    down: ['arrowdown'],
    left: ['arrowleft'],
    right: ['arrowright'],
    backspace: ['backspace'],
    delete: ['delete'],
    slash: ['/'],
    backslash: ['\\'],
    tab: ['tab'],
  };
  const keyOk = named[key] ? named[key]!.includes(eventKey) || code === key : eventKey === key || code === `key${key}` || code === `digit${key}`;
  if (!keyOk) return false;
  // Shift is implied for symbols like "?" — only enforce when explicitly requested for letters.
  if (want.shift !== e.shiftKey && /^[a-z0-9]$|^(enter|up|down|left|right|space|backspace|delete)$/.test(key)) return false;
  return true;
}

export function useHotkeys(bindings: Record<string, HotkeyHandler>, deps: React.DependencyList = [], opts: HotkeyOptions = {}) {
  const ref = React.useRef(bindings);
  ref.current = bindings;
  const { enabled = true, allowInInputs = false, preventDefault = true } = opts;

  React.useEffect(() => {
    if (!enabled) return;
    let pending: string | null = null;
    let pendingTimer: ReturnType<typeof setTimeout> | null = null;
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.isComposing) return;
      const typing = isTypingTarget(e.target);
      for (const [combo, handler] of Object.entries(ref.current)) {
        const hasMod = combo.includes('mod+');
        if (typing && !(allowInInputs || (hasMod && combo !== 'mod+a'))) continue;
        if (combo.includes(' ')) {
          const [first, second] = combo.split(' ') as [string, string];
          if (pending === first && matches(second, e)) {
            pending = null;
            if (preventDefault) e.preventDefault();
            handler(e);
            return;
          }
          continue;
        }
        if (matches(combo, e)) {
          if (preventDefault) e.preventDefault();
          handler(e);
          return;
        }
      }
      // Track sequence prefixes ("g").
      if (!typing && !e.metaKey && !e.ctrlKey && !e.altKey && e.key.length === 1) {
        pending = e.key.toLowerCase();
        if (pendingTimer) clearTimeout(pendingTimer);
        pendingTimer = setTimeout(() => (pending = null), 900);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      if (pendingTimer) clearTimeout(pendingTimer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, allowInInputs, preventDefault, ...deps]);
}
