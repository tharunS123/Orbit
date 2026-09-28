import { describe, expect, it } from 'vitest';
import { formatCombo, validateAccelerator } from '@orbit/shared';
import { CATEGORY_ORDER, SHORTCUTS, SHORTCUT_DEFINITIONS, bindingsFor, displayGroups, inAppCombos, keysFor, shortcutById, shortcutSections, type ShortcutDefinition } from './shortcuts';

const defs = SHORTCUT_DEFINITIONS as readonly ShortcutDefinition[];

describe('shortcut registry', () => {
  it('has unique ids and every definition in a known category', () => {
    const ids = defs.map((d) => d.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const d of defs) expect(CATEGORY_ORDER).toContain(d.category);
  });

  it('covers the required sections', () => {
    const labels = (category: string) => defs.filter((d) => d.category === category).map((d) => d.label.toLowerCase());
    expect(labels('navigation').join()).toMatch(/command palette.*inbox.*today.*upcoming.*all lists.*meetings.*updates/s);
    expect(labels('creation').join()).toMatch(/new task.*new list.*quick capture.*talk/s);
    expect(labels('editing').join()).toMatch(/complete.*open selected.*duplicate.*delete.*undo.*redo.*close/s);
    expect(labels('editing').join()).toContain('move');
    expect(labels('selection').join()).toMatch(/next \/ previous.*extend.*range.*add to selection.*select all/s);
    expect(labels('application').join()).toMatch(/toggle sidebar.*keyboard shortcuts/s);
  });

  it('never binds the same combo twice in one scope (per platform)', () => {
    for (const os of ['mac', 'windows'] as const) {
      for (const scope of ['app', 'tasks'] as const) {
        const seen = new Map<string, string>();
        for (const d of defs.filter((x) => x.scope === scope && !x.literal)) {
          for (const combo of [keysFor(d, os), ...(d.alt ?? [])]) {
            const prev = seen.get(combo);
            if (prev && prev !== d.id) throw new Error(`${os}/${scope}: ${combo} bound to ${prev} and ${d.id}`);
            seen.set(combo, d.id);
          }
        }
      }
    }
  });

  it('every combo is formattable', () => {
    for (const d of defs) {
      if (d.literal) continue;
      for (const os of ['mac', 'windows', 'linux'] as const) {
        const keys = formatCombo(keysFor(d, os), os).flat();
        expect(keys.length).toBeGreaterThan(0);
        expect(keys.every((k) => k.length > 0)).toBe(true);
      }
    }
  });

  it('exposes stable ids to existing callers', () => {
    expect(SHORTCUTS.palette).toBe('mod+k');
    expect(SHORTCUTS.help).toBe('mod+slash');
    expect(SHORTCUTS.newList).toBe('mod+shift+l');
    expect(shortcutById('help').alt).toContain('?');
  });

  it('uses platform conventions where they differ', () => {
    expect(keysFor(shortcutById('redo'), 'mac')).toBe('mod+shift+z');
    expect(keysFor(shortcutById('redo'), 'windows')).toBe('mod+y');
    expect(keysFor(shortcutById('globalQuickCapture'), 'windows')).toBe('ctrl+alt+space');
  });
});

describe('bindings from the registry', () => {
  it('binds every combo of a definition to its handler, only for the scope', () => {
    const help = () => undefined;
    const undo = () => undefined;
    const b = bindingsFor('app', { help, undo }, 'mac');
    expect(b['mod+slash']).toBe(help);
    expect(b['?']).toBe(help);
    expect(b['mod+z']).toBe(undo);
    expect(Object.keys(b)).toHaveLength(3);
    expect(bindingsFor('tasks', { help }, 'mac')).toEqual({});
  });

  it('keeps paired directions on separate handlers', () => {
    const next = () => 1;
    const prev = () => -1;
    const b = bindingsFor('tasks', { focusNext: next, focusPrev: prev }, 'windows');
    expect(b.down).toBe(next);
    expect(b.j).toBe(next);
    expect(b.up).toBe(prev);
    expect(b.k).toBe(prev);
  });

  it('does not bind features that do not exist yet', () => {
    expect(bindingsFor('app', { talk: () => undefined, meetings: () => undefined }, 'mac')).toEqual({});
    expect(bindingsFor('app', { talk: () => undefined }, 'mac', { talk: true, meetings: false })).toHaveProperty(['mod+shift+t']);
  });
});

describe('reference sections', () => {
  it('groups by category and hides unavailable features and paired rows', () => {
    const sections = shortcutSections({ os: 'mac' });
    expect(sections.map((s) => s.category)).toEqual(CATEGORY_ORDER);
    const ids = sections.flatMap((s) => s.items.map((i) => i.id));
    expect(ids).not.toContain('talk');
    expect(ids).not.toContain('meetings');
    expect(ids).not.toContain('focusPrev');
    expect(ids).not.toContain('globalQuickCapture'); // browser
    expect(shortcutSections({ os: 'mac', desktop: true, globalQuickCapture: 'Shift+Alt+Space' }).flatMap((s) => s.items.map((i) => i.id))).toContain('globalQuickCapture');
  });

  it('shows pairs on one row', () => {
    expect(displayGroups(shortcutById('focusNext'), 'mac')).toEqual([
      ['down', 'up'],
      ['j', 'k'],
    ]);
    expect(displayGroups(shortcutById('moveUp'), 'windows')).toEqual([['alt+up', 'alt+down']]);
  });

  it('filters by label, keyword and displayed keys', () => {
    const ids = (q: string, os: 'mac' | 'windows' = 'mac') => shortcutSections({ query: q, os }).flatMap((s) => s.items.map((i) => i.id));
    expect(ids('sidebar')).toEqual(['toggleSidebar']);
    expect(ids('trash')).toEqual(['delete']);
    expect(ids('⌘K')).toContain('palette');
    expect(ids('ctrl+k', 'windows')).toContain('palette');
    expect(ids('zzzz')).toEqual([]);
  });
});

describe('global shortcut conflicts with in-app shortcuts', () => {
  it('rejects a global shortcut that Orbit uses inside the app', () => {
    const combos = inAppCombos('mac');
    expect(validateAccelerator('Super+Shift+L', 'mac', { inAppCombos: combos })).toMatchObject({ ok: false, problem: 'app-conflict', message: expect.stringContaining('New list') });
    expect(validateAccelerator('Shift+Alt+Space', 'mac', { inAppCombos: combos }).ok).toBe(true);
    expect(validateAccelerator('Ctrl+Alt+Space', 'windows', { inAppCombos: inAppCombos('windows') }).ok).toBe(true);
  });
});
