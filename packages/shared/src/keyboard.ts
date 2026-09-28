/**
 * Keyboard shortcut notation, OS-aware formatting and global-accelerator validation. Pure and
 * DOM-free so the UI kit, the web app and tests share one implementation.
 *
 * Two notations:
 *  - In-app combos (handled by the web app's hotkey listener): lower-case tokens joined by "+",
 *    sequences separated by a space. `mod` is ⌘ on macOS and Ctrl elsewhere.
 *    e.g. "mod+k", "mod+shift+z", "g i", "?", "shift+click".
 *  - Global accelerators (registered with the OS by the desktop shell): Tauri/global-hotkey
 *    syntax, e.g. "Shift+Alt+Space", "Ctrl+Alt+Space", "Super+Shift+K".
 */

export type KeyboardOS = 'mac' | 'windows' | 'linux';

interface NavigatorLike {
  platform?: string;
  userAgent?: string;
  userAgentData?: { platform?: string };
}

/** Detect the keyboard convention from a navigator (defaults to the global one). */
export function detectKeyboardOS(nav?: NavigatorLike | null): KeyboardOS {
  const n = nav ?? (typeof navigator !== 'undefined' ? (navigator as NavigatorLike) : null);
  if (!n) return 'windows';
  const hint = `${n.userAgentData?.platform ?? ''} ${n.platform ?? ''} ${n.userAgent ?? ''}`;
  if (/Mac|iPhone|iPad|iPod/i.test(hint)) return 'mac';
  if (/Win/i.test(hint)) return 'windows';
  if (/Linux|X11|CrOS|Android/i.test(hint)) return 'linux';
  return 'windows';
}

// ───────────── in-app combos ─────────────

const MODIFIER_ORDER = { mac: ['ctrl', 'alt', 'shift', 'mod', 'meta'], windows: ['mod', 'ctrl', 'meta', 'alt', 'shift'], linux: ['mod', 'ctrl', 'meta', 'alt', 'shift'] } as const;

const SYMBOLS: Record<KeyboardOS, Record<string, string>> = {
  mac: { mod: '⌘', meta: '⌘', ctrl: '⌃', alt: '⌥', shift: '⇧', enter: '↵', escape: 'Esc', esc: 'Esc', backspace: '⌫', delete: '⌦', tab: '⇥', space: 'Space', up: '↑', down: '↓', left: '←', right: '→', backslash: '\\', slash: '/', click: 'Click' },
  windows: { mod: 'Ctrl', meta: 'Win', ctrl: 'Ctrl', alt: 'Alt', shift: 'Shift', enter: 'Enter', escape: 'Esc', esc: 'Esc', backspace: 'Backspace', delete: 'Delete', tab: 'Tab', space: 'Space', up: '↑', down: '↓', left: '←', right: '→', backslash: '\\', slash: '/', click: 'Click' },
  linux: { mod: 'Ctrl', meta: 'Super', ctrl: 'Ctrl', alt: 'Alt', shift: 'Shift', enter: 'Enter', escape: 'Esc', esc: 'Esc', backspace: 'Backspace', delete: 'Delete', tab: 'Tab', space: 'Space', up: '↑', down: '↓', left: '←', right: '→', backslash: '\\', slash: '/', click: 'Click' },
};

const SPOKEN: Record<KeyboardOS, Record<string, string>> = {
  mac: { mod: 'Command', meta: 'Command', ctrl: 'Control', alt: 'Option', shift: 'Shift' },
  windows: { mod: 'Control', meta: 'Windows', ctrl: 'Control', alt: 'Alt', shift: 'Shift' },
  linux: { mod: 'Control', meta: 'Super', ctrl: 'Control', alt: 'Alt', shift: 'Shift' },
};

const SPOKEN_KEYS: Record<string, string> = {
  enter: 'Enter', escape: 'Escape', esc: 'Escape', backspace: 'Backspace', delete: 'Delete', tab: 'Tab', space: 'Space',
  up: 'Up Arrow', down: 'Down Arrow', left: 'Left Arrow', right: 'Right Arrow', backslash: 'Backslash', slash: 'Slash',
  '/': 'Slash', '?': 'Question mark', '[': 'Left bracket', ']': 'Right bracket', click: 'Click',
};

const isModifier = (t: string) => ['mod', 'meta', 'ctrl', 'alt', 'shift'].includes(t);

/** Split an in-app combo into steps (sequence) of tokens, modifiers first in the OS order. */
function steps(combo: string, os: KeyboardOS): string[][] {
  const order = MODIFIER_ORDER[os] as readonly string[];
  return combo.split(' ').map((step) => {
    const tokens = step.toLowerCase().split('+');
    const mods = tokens.filter(isModifier).sort((a, b) => order.indexOf(a) - order.indexOf(b));
    return [...mods, ...tokens.filter((t) => !isModifier(t))];
  });
}

function label(token: string, os: KeyboardOS): string {
  const sym = SYMBOLS[os][token];
  if (sym) return sym;
  if (/^f\d{1,2}$/.test(token)) return token.toUpperCase();
  return token.length === 1 ? token.toUpperCase() : token;
}

/** Keycap labels per sequence step, e.g. "mod+shift+z" → [["⌘","⇧","Z"]] on macOS. */
export function formatCombo(combo: string, os: KeyboardOS): string[][] {
  return steps(combo, os).map((s) => s.map((t) => label(t, os)));
}

/** Compact text form: "⌘⇧Z" on macOS, "Ctrl+Shift+Z" elsewhere, "G then I" for sequences. */
export function comboText(combo: string, os: KeyboardOS): string {
  return formatCombo(combo, os)
    .map((keys) => (os === 'mac' && keys.length > 1 && keys.slice(0, -1).every((k) => '⌘⌃⌥⇧'.includes(k)) ? keys.join('') : keys.join('+')))
    .join(' then ');
}

/** Screen-reader text: "Command Shift Z", "G then I". */
export function describeCombo(combo: string, os: KeyboardOS): string {
  return steps(combo, os)
    .map((s) => s.map((t) => SPOKEN[os][t] ?? SPOKEN_KEYS[t] ?? (t.length === 1 ? t.toUpperCase() : t)).join(' '))
    .join(' then ');
}

/** Whether a combo is a two-key sequence like "g i". */
export const isSequence = (combo: string) => steps(combo, 'mac').length > 1;

// ───────────── global accelerators (desktop) ─────────────

export type AcceleratorModifier = 'ctrl' | 'alt' | 'shift' | 'super';
export interface ParsedAccelerator {
  modifiers: AcceleratorModifier[];
  /** Canonical key name, e.g. "Space", "K", "1", "F5", "Up", "Slash". */
  key: string;
}

/** Default global Quick Capture shortcut. Mirrored in apps/desktop/src-tauri/src/shortcut.rs. */
export function defaultQuickCaptureShortcut(os: KeyboardOS): string {
  return os === 'mac' ? 'Shift+Alt+Space' : 'Ctrl+Alt+Space';
}

const MOD_ALIASES: Record<string, AcceleratorModifier | 'cmdorctrl'> = {
  ctrl: 'ctrl', control: 'ctrl',
  alt: 'alt', option: 'alt',
  shift: 'shift',
  super: 'super', cmd: 'super', command: 'super', meta: 'super', win: 'super',
  commandorcontrol: 'cmdorctrl', cmdorctrl: 'cmdorctrl', cmdorcontrol: 'cmdorctrl', commandorctrl: 'cmdorctrl',
};

const NAMED_KEYS: Record<string, string> = {
  space: 'Space', enter: 'Enter', return: 'Enter', tab: 'Tab', backspace: 'Backspace', delete: 'Delete', escape: 'Escape', esc: 'Escape',
  up: 'Up', arrowup: 'Up', down: 'Down', arrowdown: 'Down', left: 'Left', arrowleft: 'Left', right: 'Right', arrowright: 'Right',
  home: 'Home', end: 'End', pageup: 'PageUp', pagedown: 'PageDown', insert: 'Insert',
  slash: 'Slash', '/': 'Slash', backslash: 'Backslash', '\\': 'Backslash', comma: 'Comma', ',': 'Comma', period: 'Period', '.': 'Period',
  semicolon: 'Semicolon', ';': 'Semicolon', quote: 'Quote', "'": 'Quote', backquote: 'Backquote', '`': 'Backquote',
  minus: 'Minus', '-': 'Minus', equal: 'Equal', '=': 'Equal', bracketleft: 'BracketLeft', '[': 'BracketLeft', bracketright: 'BracketRight', ']': 'BracketRight',
};

const KEY_SYMBOLS: Record<string, string> = { Slash: '/', Backslash: '\\', Comma: ',', Period: '.', Semicolon: ';', Quote: "'", Backquote: '`', Minus: '-', Equal: '=', BracketLeft: '[', BracketRight: ']', Up: '↑', Down: '↓', Left: '←', Right: '→', Escape: 'Esc' };

function canonicalKey(raw: string): string | null {
  const k = raw.trim();
  if (!k) return null;
  const lower = k.toLowerCase();
  if (NAMED_KEYS[lower]) return NAMED_KEYS[lower];
  if (/^key[a-z]$/.test(lower)) return lower.slice(3).toUpperCase();
  if (/^digit\d$/.test(lower)) return lower.slice(5);
  if (/^[a-z0-9]$/.test(lower)) return lower.toUpperCase();
  if (/^f([1-9]|1\d|2[0-4])$/.test(lower)) return lower.toUpperCase();
  return null;
}

/** Parse "Shift+Alt+Space" / "CommandOrControl+K" (case-insensitive). Null when invalid. */
export function parseAccelerator(accelerator: string, os: KeyboardOS): ParsedAccelerator | null {
  const tokens = accelerator.split('+').map((t) => t.trim());
  // "Ctrl++" style (plus key) is not supported.
  if (tokens.length === 0 || tokens.some((t) => !t)) return null;
  const mods = new Set<AcceleratorModifier>();
  let key: string | null = null;
  for (const token of tokens) {
    const mod = MOD_ALIASES[token.toLowerCase()];
    if (mod) {
      mods.add(mod === 'cmdorctrl' ? (os === 'mac' ? 'super' : 'ctrl') : mod);
      continue;
    }
    if (key) return null; // two non-modifier keys
    key = canonicalKey(token);
    if (!key) return null;
  }
  if (!key) return null;
  const order: AcceleratorModifier[] = ['ctrl', 'alt', 'shift', 'super'];
  return { modifiers: order.filter((m) => mods.has(m)), key };
}

const MOD_NAMES: Record<AcceleratorModifier, string> = { ctrl: 'Ctrl', alt: 'Alt', shift: 'Shift', super: 'Super' };

/** Canonical accelerator string (stable for storage and comparison). */
export function formatAcceleratorString(p: ParsedAccelerator): string {
  // Shift+Alt reads naturally on macOS ("⇧⌥Space") but ordering is irrelevant to the OS; keep a
  // single canonical order so comparisons are string equality.
  return [...p.modifiers.map((m) => MOD_NAMES[m]), p.key].join('+');
}

export function normalizeAccelerator(accelerator: string, os: KeyboardOS): string | null {
  const p = parseAccelerator(accelerator, os);
  return p ? formatAcceleratorString(p) : null;
}

/** Keycap labels for an accelerator, e.g. ["⇧","⌥","Space"] on macOS, ["Ctrl","Alt","Space"] on Windows. */
export function formatAccelerator(accelerator: string, os: KeyboardOS): string[] {
  const p = parseAccelerator(accelerator, os);
  if (!p) return [accelerator];
  // Canonical modifier order (⌃⌥⇧⌘) is also Apple's display order.
  const modLabel = (m: AcceleratorModifier) => (m === 'super' ? SYMBOLS[os].meta! : SYMBOLS[os][m]!);
  return [...p.modifiers.map(modLabel), KEY_SYMBOLS[p.key] ?? p.key];
}

export function acceleratorText(accelerator: string, os: KeyboardOS): string {
  const keys = formatAccelerator(accelerator, os);
  return os === 'mac' ? keys.join('') : keys.join('+');
}

export function describeAccelerator(accelerator: string, os: KeyboardOS): string {
  const p = parseAccelerator(accelerator, os);
  if (!p) return accelerator;
  const spoken: Record<AcceleratorModifier, string> = { ctrl: 'Control', alt: os === 'mac' ? 'Option' : 'Alt', shift: 'Shift', super: os === 'mac' ? 'Command' : os === 'windows' ? 'Windows' : 'Super' };
  return [...p.modifiers.map((m) => spoken[m]), SPOKEN_KEYS[p.key.toLowerCase()] ?? p.key].join(' ');
}

/** Minimal KeyboardEvent shape (so this stays DOM-free and testable). */
export interface KeyEventLike {
  key: string;
  code: string;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  metaKey: boolean;
}

export type RecordedKeys = { state: 'modifiers-only'; modifiers: AcceleratorModifier[] } | { state: 'complete'; accelerator: string } | { state: 'unsupported'; key: string };

/**
 * Turn a keydown into an accelerator. Uses the physical key (`code`) so the result doesn't
 * depend on the keyboard layout or on Option/Shift producing a different character.
 */
export function acceleratorFromKeyEvent(e: KeyEventLike): RecordedKeys {
  const modifiers: AcceleratorModifier[] = [];
  if (e.ctrlKey) modifiers.push('ctrl');
  if (e.altKey) modifiers.push('alt');
  if (e.shiftKey) modifiers.push('shift');
  if (e.metaKey) modifiers.push('super');
  if (['Control', 'Alt', 'Shift', 'Meta', 'OS', 'AltGraph', 'CapsLock', 'Fn'].includes(e.key) || /^(Control|Alt|Shift|Meta|OS)(Left|Right)$/.test(e.code)) {
    return { state: 'modifiers-only', modifiers };
  }
  const key = canonicalKey(e.code) ?? canonicalKey(e.key);
  if (!key) return { state: 'unsupported', key: e.key || e.code };
  return { state: 'complete', accelerator: formatAcceleratorString({ modifiers, key }) };
}

export type AcceleratorProblem = 'invalid' | 'needs-modifier' | 'reserved' | 'common' | 'app-conflict';
export type AcceleratorValidation = { ok: true; accelerator: string } | { ok: false; problem: AcceleratorProblem; message: string };

const RESERVED: Record<KeyboardOS, [string, string][]> = {
  mac: [
    ['Super+Space', 'Spotlight'], ['Super+Alt+Space', 'Finder search'], ['Ctrl+Space', 'switching input sources'], ['Ctrl+Alt+Space', 'switching input sources'],
    ['Super+Tab', 'the app switcher'], ['Super+Shift+Tab', 'the app switcher'], ['Super+Backquote', 'switching windows'],
    ['Super+Q', 'quitting apps'], ['Super+W', 'closing windows'], ['Super+H', 'hiding apps'], ['Super+Alt+H', 'hiding other apps'], ['Super+M', 'minimizing windows'],
    ['Alt+Super+Escape', 'Force Quit'], ['Ctrl+Super+Q', 'locking the screen'], ['Ctrl+Super+F', 'full screen'], ['Ctrl+Super+Space', 'the emoji picker'],
    ['Shift+Super+3', 'screenshots'], ['Shift+Super+4', 'screenshots'], ['Shift+Super+5', 'screenshots'], ['Ctrl+Shift+Super+3', 'screenshots'], ['Ctrl+Shift+Super+4', 'screenshots'],
    ['Ctrl+Up', 'Mission Control'], ['Ctrl+Down', 'App Exposé'], ['Ctrl+Left', 'switching Spaces'], ['Ctrl+Right', 'switching Spaces'],
  ],
  windows: [
    ['Alt+Tab', 'the app switcher'], ['Alt+Shift+Tab', 'the app switcher'], ['Alt+F4', 'closing windows'], ['Alt+Space', 'the window menu'], ['Alt+Escape', 'switching windows'],
    ['Ctrl+Escape', 'the Start menu'], ['Ctrl+Shift+Escape', 'Task Manager'], ['Ctrl+Alt+Delete', 'the security screen'], ['Ctrl+Alt+Tab', 'the app switcher'],
  ],
  linux: [
    ['Alt+Tab', 'the app switcher'], ['Alt+Shift+Tab', 'the app switcher'], ['Alt+F4', 'closing windows'], ['Alt+F2', 'the run dialog'], ['Ctrl+Alt+Delete', 'the session menu'],
    ['Ctrl+Alt+T', 'opening a terminal'], ['Ctrl+Alt+Left', 'switching workspaces'], ['Ctrl+Alt+Right', 'switching workspaces'], ['Ctrl+Alt+Up', 'switching workspaces'], ['Ctrl+Alt+Down', 'switching workspaces'],
  ],
};

/** Shortcuts nearly every app uses; stealing them globally would break typing everywhere. */
const COMMON_KEYS: Record<string, string> = { C: 'Copy', V: 'Paste', X: 'Cut', Z: 'Undo', A: 'Select All', S: 'Save', F: 'Find', P: 'Print', N: 'New', T: 'New Tab', O: 'Open', Y: 'Redo' };

/**
 * Validate a user-chosen global shortcut before asking the OS to register it. Catches what we can
 * know up front (missing modifiers, OS-reserved combos, universal editing shortcuts, clashes with
 * Orbit's own shortcuts); the OS registration itself reports clashes with other applications.
 */
export function validateAccelerator(accelerator: string, os: KeyboardOS, opts: { inAppCombos?: { combo: string; label: string }[] } = {}): AcceleratorValidation {
  const p = parseAccelerator(accelerator, os);
  if (!p) return { ok: false, problem: 'invalid', message: 'That key combination isn’t supported. Try a letter, number, Space or F-key with modifiers.' };
  const normalized = formatAcceleratorString(p);
  const fKey = /^F\d+$/.test(p.key);
  const strong = p.modifiers.filter((m) => m !== 'shift');
  if (!fKey && strong.length === 0) {
    return { ok: false, problem: 'needs-modifier', message: os === 'mac' ? 'Include ⌘, ⌥ or ⌃ so the shortcut doesn’t trigger while you type.' : 'Include Ctrl or Alt so the shortcut doesn’t trigger while you type.' };
  }
  if (os === 'windows' && p.modifiers.includes('super')) {
    return { ok: false, problem: 'reserved', message: 'Windows reserves most shortcuts that use the Windows key. Try Ctrl or Alt instead.' };
  }
  const reserved = RESERVED[os].find(([combo]) => normalizeAccelerator(combo, os) === normalized);
  if (reserved) return { ok: false, problem: 'reserved', message: `${acceleratorText(normalized, os)} is reserved by the system for ${reserved[1]}.` };
  const primary: AcceleratorModifier = os === 'mac' ? 'super' : 'ctrl';
  if (p.modifiers.length === 1 && p.modifiers[0] === primary && COMMON_KEYS[p.key]) {
    return { ok: false, problem: 'common', message: `${acceleratorText(normalized, os)} is used by almost every app for ${COMMON_KEYS[p.key]}.` };
  }
  for (const { combo, label: name } of opts.inAppCombos ?? []) {
    const asAccel = inAppComboToAccelerator(combo, os);
    if (asAccel && asAccel === normalized) {
      return { ok: false, problem: 'app-conflict', message: `${acceleratorText(normalized, os)} is already Orbit’s shortcut for ${name}.` };
    }
  }
  return { ok: true, accelerator: normalized };
}

/** Convert a single-step in-app combo ("mod+shift+l") to a canonical accelerator, if possible. */
export function inAppComboToAccelerator(combo: string, os: KeyboardOS): string | null {
  if (combo.includes(' ')) return null;
  const tokens = combo.toLowerCase().split('+');
  const key = tokens.pop();
  if (!key) return null;
  const mods = tokens.map((t) => (t === 'mod' ? (os === 'mac' ? 'Super' : 'Ctrl') : t === 'meta' ? 'Super' : t));
  const p = parseAccelerator([...mods, key].join('+'), os);
  return p ? formatAcceleratorString(p) : null;
}
