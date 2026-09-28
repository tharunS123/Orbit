import { describe, expect, it } from 'vitest';
import {
  acceleratorFromKeyEvent,
  acceleratorText,
  comboText,
  defaultQuickCaptureShortcut,
  describeAccelerator,
  describeCombo,
  detectKeyboardOS,
  formatAccelerator,
  formatCombo,
  inAppComboToAccelerator,
  normalizeAccelerator,
  parseAccelerator,
  validateAccelerator,
  type KeyEventLike,
} from './keyboard';

const key = (e: Partial<KeyEventLike> & Pick<KeyEventLike, 'key' | 'code'>): KeyEventLike => ({ ctrlKey: false, altKey: false, shiftKey: false, metaKey: false, ...e });

describe('platform detection', () => {
  it('detects macOS, Windows and Linux from navigator hints', () => {
    expect(detectKeyboardOS({ platform: 'MacIntel' })).toBe('mac');
    expect(detectKeyboardOS({ userAgentData: { platform: 'macOS' } })).toBe('mac');
    expect(detectKeyboardOS({ platform: 'iPad' })).toBe('mac');
    expect(detectKeyboardOS({ platform: 'Win32' })).toBe('windows');
    expect(detectKeyboardOS({ userAgentData: { platform: 'Windows' } })).toBe('windows');
    expect(detectKeyboardOS({ platform: 'Linux x86_64' })).toBe('linux');
    expect(detectKeyboardOS({ userAgent: 'Mozilla/5.0 (X11; Linux x86_64)' })).toBe('linux');
  });
});

describe('in-app combo formatting', () => {
  it('uses ⌘ ⌥ ⇧ on macOS and Ctrl/Alt/Shift elsewhere', () => {
    expect(formatCombo('mod+shift+z', 'mac')).toEqual([['⇧', '⌘', 'Z']]);
    expect(formatCombo('mod+shift+z', 'windows')).toEqual([['Ctrl', 'Shift', 'Z']]);
    expect(formatCombo('mod+shift+z', 'linux')).toEqual([['Ctrl', 'Shift', 'Z']]);
    expect(formatCombo('alt+up', 'mac')).toEqual([['⌥', '↑']]);
    expect(formatCombo('alt+up', 'windows')).toEqual([['Alt', '↑']]);
    expect(formatCombo('mod+backslash', 'windows')).toEqual([['Ctrl', '\\']]);
    expect(formatCombo('mod+slash', 'mac')).toEqual([['⌘', '/']]);
  });

  it('formats sequences and single keys', () => {
    expect(formatCombo('g i', 'mac')).toEqual([['G'], ['I']]);
    expect(comboText('g i', 'windows')).toBe('G then I');
    expect(formatCombo('?', 'windows')).toEqual([['?']]);
    expect(formatCombo('backspace', 'mac')).toEqual([['⌫']]);
    expect(formatCombo('backspace', 'windows')).toEqual([['Backspace']]);
  });

  it('produces compact text and spoken descriptions', () => {
    expect(comboText('mod+k', 'mac')).toBe('⌘K');
    expect(comboText('mod+k', 'windows')).toBe('Ctrl+K');
    expect(describeCombo('mod+shift+z', 'mac')).toBe('Shift Command Z');
    expect(describeCombo('mod+shift+z', 'windows')).toBe('Control Shift Z');
    expect(describeCombo('g t', 'mac')).toBe('G then T');
    expect(describeCombo('?', 'mac')).toBe('Question mark');
  });
});

describe('global accelerators', () => {
  it('has a platform default', () => {
    expect(defaultQuickCaptureShortcut('mac')).toBe('Shift+Alt+Space');
    expect(defaultQuickCaptureShortcut('windows')).toBe('Ctrl+Alt+Space');
  });

  it('parses aliases into a canonical form', () => {
    expect(parseAccelerator('Shift+Option+Space', 'mac')).toEqual({ modifiers: ['alt', 'shift'], key: 'Space' });
    expect(normalizeAccelerator('shift+alt+space', 'mac')).toBe('Alt+Shift+Space');
    expect(normalizeAccelerator('CommandOrControl+K', 'mac')).toBe('Super+K');
    expect(normalizeAccelerator('CommandOrControl+K', 'windows')).toBe('Ctrl+K');
    expect(normalizeAccelerator('Ctrl+Digit1', 'windows')).toBe('Ctrl+1');
    expect(parseAccelerator('Ctrl+K+J', 'windows')).toBeNull();
    expect(parseAccelerator('Ctrl+', 'windows')).toBeNull();
    expect(parseAccelerator('Ctrl+Wat', 'windows')).toBeNull();
  });

  it('formats for each platform', () => {
    expect(formatAccelerator('Shift+Alt+Space', 'mac')).toEqual(['⌥', '⇧', 'Space']);
    expect(acceleratorText('Shift+Alt+Space', 'mac')).toBe('⌥⇧Space');
    expect(formatAccelerator('Ctrl+Alt+Space', 'windows')).toEqual(['Ctrl', 'Alt', 'Space']);
    expect(acceleratorText('Ctrl+Alt+Space', 'windows')).toBe('Ctrl+Alt+Space');
    expect(formatAccelerator('Super+Slash', 'linux')).toEqual(['Super', '/']);
    expect(describeAccelerator('Shift+Alt+Space', 'mac')).toBe('Option Shift Space');
    expect(describeAccelerator('Ctrl+Alt+Space', 'windows')).toBe('Control Alt Space');
  });

  it('records key events by physical key', () => {
    // ⌥⇧Space on a Mac produces a non-breaking space as `key`; `code` is what matters.
    expect(acceleratorFromKeyEvent(key({ key: ' ', code: 'Space', altKey: true, shiftKey: true }))).toEqual({ state: 'complete', accelerator: 'Alt+Shift+Space' });
    expect(acceleratorFromKeyEvent(key({ key: 'Ω', code: 'KeyZ', altKey: true, metaKey: true }))).toEqual({ state: 'complete', accelerator: 'Alt+Super+Z' });
    expect(acceleratorFromKeyEvent(key({ key: 'Shift', code: 'ShiftLeft', shiftKey: true }))).toEqual({ state: 'modifiers-only', modifiers: ['shift'] });
    expect(acceleratorFromKeyEvent(key({ key: 'F5', code: 'F5' }))).toEqual({ state: 'complete', accelerator: 'F5' });
    expect(acceleratorFromKeyEvent(key({ key: 'MediaPlayPause', code: 'MediaPlayPause' })).state).toBe('unsupported');
  });

  it('maps in-app combos to accelerators for conflict checks', () => {
    expect(inAppComboToAccelerator('mod+k', 'mac')).toBe('Super+K');
    expect(inAppComboToAccelerator('mod+shift+l', 'windows')).toBe('Ctrl+Shift+L');
    expect(inAppComboToAccelerator('g i', 'mac')).toBeNull();
  });
});

describe('shortcut conflict validation', () => {
  const inApp = [{ combo: 'mod+k', label: 'Search / command palette' }];

  it('accepts sensible global shortcuts', () => {
    expect(validateAccelerator('Shift+Alt+Space', 'mac')).toEqual({ ok: true, accelerator: 'Alt+Shift+Space' });
    expect(validateAccelerator('Ctrl+Alt+Space', 'windows')).toEqual({ ok: true, accelerator: 'Ctrl+Alt+Space' });
    expect(validateAccelerator('Ctrl+Shift+Super+K', 'mac').ok).toBe(true);
    expect(validateAccelerator('F13', 'windows').ok).toBe(true);
  });

  it('requires a modifier that doesn’t type characters', () => {
    const r = validateAccelerator('Shift+K', 'mac');
    expect(r).toMatchObject({ ok: false, problem: 'needs-modifier' });
    expect(validateAccelerator('K', 'windows')).toMatchObject({ ok: false, problem: 'needs-modifier' });
  });

  it('refuses OS-reserved shortcuts with the reason', () => {
    expect(validateAccelerator('Cmd+Space', 'mac')).toMatchObject({ ok: false, problem: 'reserved', message: expect.stringContaining('Spotlight') });
    expect(validateAccelerator('Cmd+Tab', 'mac')).toMatchObject({ ok: false, problem: 'reserved' });
    expect(validateAccelerator('Alt+F4', 'windows')).toMatchObject({ ok: false, problem: 'reserved' });
    expect(validateAccelerator('Alt+Space', 'windows')).toMatchObject({ ok: false, problem: 'reserved' });
    expect(validateAccelerator('Super+Shift+K', 'windows')).toMatchObject({ ok: false, problem: 'reserved' });
    expect(validateAccelerator('Ctrl+Alt+T', 'linux')).toMatchObject({ ok: false, problem: 'reserved' });
  });

  it('refuses universal editing shortcuts', () => {
    expect(validateAccelerator('Cmd+C', 'mac')).toMatchObject({ ok: false, problem: 'common', message: expect.stringContaining('Copy') });
    expect(validateAccelerator('Ctrl+V', 'windows')).toMatchObject({ ok: false, problem: 'common' });
    // With an extra modifier it's fine.
    expect(validateAccelerator('Ctrl+Alt+V', 'windows').ok).toBe(true);
  });

  it('refuses Orbit’s own in-app shortcuts', () => {
    expect(validateAccelerator('Cmd+K', 'mac', { inAppCombos: inApp })).toMatchObject({ ok: false, problem: 'app-conflict', message: expect.stringContaining('command palette') });
    expect(validateAccelerator('Ctrl+K', 'windows', { inAppCombos: inApp })).toMatchObject({ ok: false, problem: 'app-conflict' });
    expect(validateAccelerator('Ctrl+K', 'mac', { inAppCombos: inApp }).ok).toBe(true);
  });

  it('rejects garbage', () => {
    expect(validateAccelerator('Hyper+Q', 'mac')).toMatchObject({ ok: false, problem: 'invalid' });
  });
});
