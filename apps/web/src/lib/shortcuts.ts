/**
 * The one registry of keyboard shortcuts. Hotkey bindings (app shell, task views), menus,
 * tooltips, the command palette, Settings → Shortcuts and the shortcuts overlay all read from
 * here, so a key and its label can never drift apart.
 *
 * Keys use the in-app combo notation from `@orbit/shared/keyboard` ("mod+k", "g i", "?").
 * Platform labels (⌘ vs Ctrl) are derived at render time — never hard-code them.
 */

import { comboText, detectKeyboardOS, type KeyboardOS } from '@orbit/shared';

export type ShortcutCategory = 'navigation' | 'creation' | 'editing' | 'selection' | 'application' | 'documents';

/**
 * Where a shortcut is handled:
 *  - app: global in-app listener (AppShell)
 *  - tasks: task list views (TaskKeyboard) when a row is focused/selected
 *  - editor: document editor (Tiptap) — display only here
 *  - dialog: inside dialogs/inputs — display only
 *  - desktop: registered with the OS by the desktop app — display only (configurable)
 */
export type ShortcutScope = 'app' | 'tasks' | 'editor' | 'dialog' | 'desktop';

/** Features that are not built yet; their shortcuts stay hidden and unbound until they ship. */
export type FeatureGate = 'meetings' | 'talk';
export const AVAILABLE_FEATURES: Record<FeatureGate, boolean> = { meetings: false, talk: false };

export interface ShortcutDefinition {
  id: string;
  label: string;
  category: ShortcutCategory;
  scope: ShortcutScope;
  /** Primary combo. */
  keys: string;
  /** Extra combos that trigger the same action (bound and listed). */
  alt?: readonly string[];
  /** Platform overrides of `keys` when the conventions differ. */
  mac?: string;
  windows?: string;
  /** Literal typed text (Markdown triggers like "[ ]"), shown as code rather than keycaps. */
  literal?: boolean;
  requires?: FeatureGate;
  /** Shown on the row of another definition (pairs like ↓ / ↑) instead of its own row. */
  displayIn?: string;
  /** Extra words for filtering the reference ("find", "palette"…). */
  keywords?: string;
}

export const CATEGORY_LABELS: Record<ShortcutCategory, string> = {
  navigation: 'Navigation',
  creation: 'Creation',
  editing: 'Editing',
  selection: 'Selection',
  application: 'Application',
  documents: 'Documents',
};

export const CATEGORY_ORDER: ShortcutCategory[] = ['navigation', 'creation', 'editing', 'selection', 'application', 'documents'];

export const SHORTCUT_DEFINITIONS = [
  // Navigation
  { id: 'palette', label: 'Search / command palette', category: 'navigation', scope: 'app', keys: 'mod+k', keywords: 'find go to run command' },
  { id: 'search', label: 'Search', category: 'navigation', scope: 'app', keys: '/', keywords: 'find' },
  { id: 'inbox', label: 'Go to Inbox', category: 'navigation', scope: 'app', keys: 'g i' },
  { id: 'today', label: 'Go to Today', category: 'navigation', scope: 'app', keys: 'g t' },
  { id: 'upcoming', label: 'Go to Upcoming', category: 'navigation', scope: 'app', keys: 'g u' },
  { id: 'lists', label: 'Go to All lists', category: 'navigation', scope: 'app', keys: 'g l' },
  { id: 'meetings', label: 'Go to Meetings', category: 'navigation', scope: 'app', keys: 'g m', requires: 'meetings' },
  { id: 'updates', label: 'Go to Updates', category: 'navigation', scope: 'app', keys: 'g n', keywords: 'notifications' },
  { id: 'settings', label: 'Go to Settings', category: 'navigation', scope: 'app', keys: 'g s', keywords: 'preferences' },

  // Creation
  { id: 'newTask', label: 'New task', category: 'creation', scope: 'app', keys: 'n', keywords: 'add create' },
  { id: 'newList', label: 'New list', category: 'creation', scope: 'app', keys: 'mod+shift+l', keywords: 'add create document' },
  { id: 'quickCapture', label: 'Quick capture', category: 'creation', scope: 'app', keys: 'q', keywords: 'add task' },
  { id: 'globalQuickCapture', label: 'Quick capture from any app (desktop)', category: 'creation', scope: 'desktop', keys: 'shift+alt+space', windows: 'ctrl+alt+space', keywords: 'global system' },
  { id: 'talk', label: 'Talk — add tasks by voice', category: 'creation', scope: 'app', keys: 'mod+shift+t', requires: 'talk', keywords: 'voice ai' },
  { id: 'saveAnother', label: 'Save and add another (in New task)', category: 'creation', scope: 'dialog', keys: 'mod+enter' },

  // Editing
  { id: 'complete', label: 'Complete task', category: 'editing', scope: 'tasks', keys: 'mod+enter', keywords: 'done check' },
  { id: 'open', label: 'Open selected task', category: 'editing', scope: 'tasks', keys: 'enter', keywords: 'details' },
  { id: 'edit', label: 'Rename task', category: 'editing', scope: 'tasks', keys: 'e', keywords: 'edit title' },
  { id: 'schedule', label: 'Set due date', category: 'editing', scope: 'tasks', keys: 'd', keywords: 'date schedule' },
  { id: 'scheduleToday', label: 'Schedule for today', category: 'editing', scope: 'tasks', keys: 't' },
  { id: 'label', label: 'Labels', category: 'editing', scope: 'tasks', keys: 'l', keywords: 'tag' },
  { id: 'assign', label: 'Assign', category: 'editing', scope: 'tasks', keys: 'a', keywords: 'person owner' },
  { id: 'move', label: 'Move to list', category: 'editing', scope: 'tasks', keys: 'm' },
  { id: 'moveUp', label: 'Move up / down', category: 'editing', scope: 'tasks', keys: 'alt+up', keywords: 'reorder' },
  { id: 'moveDown', label: 'Move down', category: 'editing', scope: 'tasks', keys: 'alt+down', displayIn: 'moveUp' },
  { id: 'duplicate', label: 'Duplicate', category: 'editing', scope: 'tasks', keys: 'mod+d', keywords: 'copy' },
  { id: 'delete', label: 'Delete', category: 'editing', scope: 'tasks', keys: 'backspace', alt: ['delete'], keywords: 'remove trash' },
  { id: 'undo', label: 'Undo', category: 'editing', scope: 'app', keys: 'mod+z' },
  { id: 'redo', label: 'Redo', category: 'editing', scope: 'app', keys: 'mod+shift+z', windows: 'mod+y', alt: ['mod+shift+z'] },
  { id: 'close', label: 'Close / cancel', category: 'editing', scope: 'app', keys: 'escape', keywords: 'dismiss' },

  // Selection
  { id: 'focusNext', label: 'Next / previous task', category: 'selection', scope: 'tasks', keys: 'down', alt: ['j'], keywords: 'arrow navigate' },
  { id: 'focusPrev', label: 'Previous task', category: 'selection', scope: 'tasks', keys: 'up', alt: ['k'], displayIn: 'focusNext' },
  { id: 'extendDown', label: 'Extend selection', category: 'selection', scope: 'tasks', keys: 'shift+down', keywords: 'range' },
  { id: 'extendUp', label: 'Extend selection up', category: 'selection', scope: 'tasks', keys: 'shift+up', displayIn: 'extendDown' },
  { id: 'rangeSelect', label: 'Select a range', category: 'selection', scope: 'tasks', keys: 'shift+click' },
  { id: 'multiSelect', label: 'Add to selection', category: 'selection', scope: 'tasks', keys: 'mod+click', keywords: 'multi' },
  { id: 'toggleSelect', label: 'Toggle selected', category: 'selection', scope: 'tasks', keys: 'x' },
  { id: 'selectAll', label: 'Select all', category: 'selection', scope: 'tasks', keys: 'mod+a' },
  { id: 'clearSelection', label: 'Clear selection', category: 'selection', scope: 'tasks', keys: 'escape' },

  // Application
  { id: 'toggleSidebar', label: 'Toggle sidebar', category: 'application', scope: 'app', keys: 'mod+backslash' },
  { id: 'help', label: 'Keyboard shortcuts', category: 'application', scope: 'app', keys: 'mod+slash', alt: ['?'], keywords: 'help reference keys' },

  // Documents (Tiptap)
  { id: 'blockMenu', label: 'Block menu', category: 'documents', scope: 'editor', keys: '/', literal: true },
  { id: 'taskLine', label: 'New task line', category: 'documents', scope: 'editor', keys: '[ ]', literal: true },
  { id: 'convertToTask', label: 'Turn line into task', category: 'documents', scope: 'editor', keys: 'mod+shift+9' },
  { id: 'heading', label: 'Heading', category: 'documents', scope: 'editor', keys: '#', literal: true },
  { id: 'bullets', label: 'Bulleted list', category: 'documents', scope: 'editor', keys: '-', literal: true },
  { id: 'numbers', label: 'Numbered list', category: 'documents', scope: 'editor', keys: '1.', literal: true },
  { id: 'quote', label: 'Quote', category: 'documents', scope: 'editor', keys: '>', literal: true },
  { id: 'divider', label: 'Divider', category: 'documents', scope: 'editor', keys: '---', literal: true },
  { id: 'nextTask', label: 'Next task (in a task line)', category: 'documents', scope: 'editor', keys: 'enter' },
  { id: 'subtask', label: 'Make subtask', category: 'documents', scope: 'editor', keys: 'tab' },
] as const satisfies readonly ShortcutDefinition[];

export type ShortcutId = (typeof SHORTCUT_DEFINITIONS)[number]['id'];

const BY_ID = new Map<string, ShortcutDefinition>(SHORTCUT_DEFINITIONS.map((d) => [d.id, d]));

export function shortcutById(id: ShortcutId): ShortcutDefinition {
  return BY_ID.get(id)!;
}

/** Whether the shortcut's feature exists yet. */
export const isAvailable = (d: ShortcutDefinition, features: Record<FeatureGate, boolean> = AVAILABLE_FEATURES) => !d.requires || features[d.requires];

/** Definitions displayed on this definition's row (the "/ ↑" half of "↓ / ↑"). */
export function pairedWith(d: ShortcutDefinition): ShortcutDefinition[] {
  return (SHORTCUT_DEFINITIONS as readonly ShortcutDefinition[]).filter((x) => x.displayIn === d.id);
}

/**
 * Combos to display for a row, grouped as alternatives: each group is one way to press the
 * shortcut, with paired directions side by side — e.g. [["down","up"], ["j","k"]].
 */
export function displayGroups(d: ShortcutDefinition, os: KeyboardOS): string[][] {
  const columns = [combosFor(d, os), ...pairedWith(d).map((p) => combosFor(p, os))];
  const rows = Math.max(...columns.map((c) => c.length));
  return Array.from({ length: rows }, (_, i) => columns.map((c) => c[i]).filter((c): c is string => Boolean(c)));
}

/** Primary combo for this platform. */
export function keysFor(d: ShortcutDefinition, os: KeyboardOS): string {
  if (os === 'mac' && d.mac) return d.mac;
  if (os !== 'mac' && d.windows) return d.windows;
  return d.keys;
}

/** Every combo that triggers the definition on this platform (primary first). */
export function combosFor(d: ShortcutDefinition, os: KeyboardOS): string[] {
  return [...new Set([keysFor(d, os), ...(d.alt ?? [])])];
}

/**
 * Primary combo by id, for menus/tooltips (`<MenuItem shortcut={SHORTCUTS.newList}>`).
 * Resolved for the current device when this module loads in the browser.
 */
export const SHORTCUTS = Object.fromEntries(SHORTCUT_DEFINITIONS.map((d) => [d.id, keysFor(d, typeof navigator === 'undefined' ? 'mac' : detectKeyboardOS())])) as Record<ShortcutId, string>;

export interface ShortcutSection {
  category: ShortcutCategory;
  title: string;
  items: ShortcutDefinition[];
}

/** Grouped, filtered view for the reference overlay and Settings → Shortcuts. */
export function shortcutSections(opts: { query?: string; os: KeyboardOS; features?: Record<FeatureGate, boolean>; desktop?: boolean; globalQuickCapture?: string | null }): ShortcutSection[] {
  const q = (opts.query ?? '').trim().toLowerCase();
  const matches = (d: ShortcutDefinition) => {
    if (!q) return true;
    const combos = displayGroups(d, opts.os).flat();
    const haystack = `${d.label} ${d.keywords ?? ''} ${CATEGORY_LABELS[d.category]} ${combos.map((c) => (d.literal ? c : comboText(c, opts.os))).join(' ')}`.toLowerCase();
    return q.split(/\s+/).every((word) => haystack.includes(word));
  };
  return CATEGORY_ORDER.map((category) => ({
    category,
    title: CATEGORY_LABELS[category],
    items: SHORTCUT_DEFINITIONS.filter((d: ShortcutDefinition) => {
      if (d.category !== category || !isAvailable(d, opts.features) || d.displayIn) return false;
      // The OS-level Quick Capture shortcut is only listed in the desktop app, where it exists.
      if (d.scope === 'desktop' && (!opts.desktop || opts.globalQuickCapture === null)) return false;
      return matches(d);
    }),
  })).filter((s) => s.items.length > 0);
}

/**
 * Bindings for a scope: `{ combo: handler }` for `useHotkeys`, built from the registry so a
 * shortcut is bound exactly where it is documented.
 */
export function bindingsFor<H>(scope: ShortcutScope, handlers: Partial<Record<ShortcutId, H>>, os: KeyboardOS, features: Record<FeatureGate, boolean> = AVAILABLE_FEATURES): Record<string, H> {
  const out: Record<string, H> = {};
  for (const d of SHORTCUT_DEFINITIONS as readonly ShortcutDefinition[]) {
    if (d.scope !== scope || !isAvailable(d, features) || d.literal) continue;
    const handler = handlers[d.id as ShortcutId];
    if (!handler) continue;
    for (const combo of combosFor(d, os)) if (!(combo in out)) out[combo] = handler;
  }
  return out;
}

/** In-app combos a global (desktop) shortcut must not steal, with their labels. */
export function inAppCombos(os: KeyboardOS): { combo: string; label: string }[] {
  return (SHORTCUT_DEFINITIONS as readonly ShortcutDefinition[])
    .filter((d) => d.scope !== 'desktop' && !d.literal && isAvailable(d))
    .flatMap((d) => combosFor(d, os).map((combo) => ({ combo, label: d.label })));
}
