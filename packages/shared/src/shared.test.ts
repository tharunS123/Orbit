import { describe, expect, it } from 'vitest';
import { uuidv7, isUuid, randomToken } from './ids';
import { resolveDeepLink, safeRedirectPath } from './routes';
import { parseFlags, FLAG_DEFAULTS } from './flags';
import { AppError, describeError } from './errors';
import { profileSettingsSchema } from './entities';

describe('uuidv7', () => {
  it('produces valid, time-sortable ids', () => {
    const ids = Array.from({ length: 2000 }, () => uuidv7());
    for (const id of ids) expect(isUuid(id)).toBe(true);
    expect([...ids].sort()).toEqual(ids);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids[0]![14]).toBe('7');
  });
  it('encodes the timestamp', () => {
    const id = uuidv7(Date.UTC(2026, 0, 1));
    const ms = parseInt(id.replace(/-/g, '').slice(0, 12), 16);
    expect(ms).toBe(Date.UTC(2026, 0, 1));
  });
  it('random tokens are url safe', () => {
    expect(randomToken(24)).toMatch(/^[A-Za-z0-9_-]{32}$/);
  });
});

describe('deep links', () => {
  const origins = ['https://app.orbit.example'];
  const id = '0190f3b4-7c1a-7000-8000-000000000001';
  it('maps share links and custom schemes', () => {
    expect(resolveDeepLink(`https://app.orbit.example/l/${id}`, origins, 'orbit')).toBe(
      `/list?id=${id}`,
    );
    expect(resolveDeepLink(`orbit://task/${id}`, origins, 'orbit')).toBe(`/task?id=${id}`);
    expect(resolveDeepLink('orbit://today', origins, 'orbit')).toBe('/today');
  });
  it('rejects foreign origins and malformed ids', () => {
    expect(resolveDeepLink(`https://evil.example/l/${id}`, origins, 'orbit')).toBeNull();
    expect(resolveDeepLink('https://app.orbit.example/l/../../x', origins, 'orbit')).toBeNull();
    expect(resolveDeepLink('not a url', origins, 'orbit')).toBeNull();
  });
  it('only allows safe relative redirects', () => {
    expect(safeRedirectPath('/today')).toBe('/today');
    expect(safeRedirectPath('//evil.com')).toBe('/inbox');
    expect(safeRedirectPath('https://evil.com')).toBe('/inbox');
    expect(safeRedirectPath('/\\evil.com')).toBe('/inbox');
    expect(safeRedirectPath(null)).toBe('/inbox');
  });
});

describe('flags', () => {
  it('parses overrides', () => {
    const flags = parseFlags('-publicLinks,devEntitlements,unknown');
    expect(flags.publicLinks).toBe(false);
    expect(flags.devEntitlements).toBe(true);
    expect(flags.meetingLiveChat).toBe(FLAG_DEFAULTS.meetingLiveChat);
  });
});

describe('errors', () => {
  it('round-trips through JSON', () => {
    const err = new AppError('quota_exceeded', 'Upgrade to add more lists', { limit: 20 });
    const back = AppError.from(JSON.parse(JSON.stringify(err)));
    expect(back.code).toBe('quota_exceeded');
    expect(back.status).toBe(402);
    expect(describeError(back)).toBe('Upgrade to add more lists');
  });
  it('wraps unknown errors as internal', () => {
    expect(AppError.from(new Error('boom')).code).toBe('internal');
  });
});

describe('profile settings', () => {
  it('fills defaults', () => {
    const s = profileSettingsSchema.parse({});
    expect(s.theme).toBe('system');
    expect(s.notifications.mentions).toBe(true);
    expect(s.ai.keepMeetingAudioDays).toBe(30);
  });
});
