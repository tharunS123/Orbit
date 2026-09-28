/**
 * Canonical in-app routes and shareable deep links. In-app routes use query strings for entity
 * ids so the UI can be statically exported for native shells. Share links use short paths that
 * are claimed as universal/app links on iOS/Android and redirect on the web.
 */
export const routes = {
  inbox: () => '/inbox',
  today: () => '/today',
  upcoming: () => '/upcoming',
  meetings: () => '/meetings',
  meeting: (id: string) => `/meeting?id=${encodeURIComponent(id)}`,
  updates: () => '/updates',
  lists: () => '/lists',
  list: (id: string, taskId?: string) =>
    `/list?id=${encodeURIComponent(id)}${taskId ? `&task=${encodeURIComponent(taskId)}` : ''}`,
  task: (id: string) => `/task?id=${encodeURIComponent(id)}`,
  search: (q?: string) => (q ? `/search?q=${encodeURIComponent(q)}` : '/search'),
  settings: (section: SettingsSection = 'account') => `/settings/${section}`,
  profile: () => '/profile',
  shortcuts: () => '/settings/shortcuts',
  workspace: (id: string) => `/inbox?workspace=${encodeURIComponent(id)}`,
  invite: (token: string) => `/invite?token=${encodeURIComponent(token)}`,
  publicList: (token: string) => `/p?token=${encodeURIComponent(token)}`,
  publicMeeting: (token: string) => `/pm?token=${encodeURIComponent(token)}`,
} as const;

export type SettingsSection =
  | 'account'
  | 'appearance'
  | 'notifications'
  | 'integrations'
  | 'ai'
  | 'mcp'
  | 'billing'
  | 'workspace'
  | 'data'
  | 'shortcuts'
  | 'desktop';

/** Short share paths (web redirects; native apps claim these via universal/app links). */
export const shareLinks = {
  list: (appUrl: string, id: string) => `${appUrl}/l/${id}`,
  task: (appUrl: string, id: string) => `${appUrl}/t/${id}`,
  meeting: (appUrl: string, id: string) => `${appUrl}/m/${id}`,
  invite: (appUrl: string, token: string) => `${appUrl}/i/${token}`,
  workspace: (appUrl: string, id: string) => `${appUrl}/w/${id}`,
};

/**
 * Map a share/deep link (https or custom scheme) to an in-app route. Returns null for unknown or
 * foreign links so callers never navigate to attacker-controlled destinations.
 */
export function resolveDeepLink(url: string, allowedOrigins: string[], scheme: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  let path: string;
  if (parsed.protocol === `${scheme}:`) {
    // orbit://list/<id>  → host = "list", pathname = "/<id>"
    path = `/${parsed.host}${parsed.pathname}`;
  } else if (allowedOrigins.includes(parsed.origin)) {
    path = parsed.pathname;
  } else {
    return null;
  }
  const [, kind, value] = path.split('/');
  const safe = value && /^[A-Za-z0-9_-]{8,128}$/.test(value) ? value : null;
  switch (kind) {
    case 'l':
    case 'list':
      return safe ? routes.list(safe, parsed.searchParams.get('task') ?? undefined) : null;
    case 't':
    case 'task':
      return safe ? routes.task(safe) : null;
    case 'm':
    case 'meeting':
      return safe ? routes.meeting(safe) : null;
    case 'i':
    case 'invite':
      return safe ? routes.invite(safe) : null;
    case 'w':
    case 'workspace':
      return safe ? routes.workspace(safe) : null;
    case 'inbox':
      return routes.inbox();
    case 'today':
      return routes.today();
    case 'upcoming':
      return routes.upcoming();
    case 'capture':
      return `/inbox?capture=1`;
    case 'talk':
      return `/inbox?talk=1`;
    default:
      return null;
  }
}

/** Only allow same-origin relative redirects (prevents open redirects after login). */
export function safeRedirectPath(input: string | null | undefined, fallback = '/inbox'): string {
  if (!input) return fallback;
  if (!input.startsWith('/') || input.startsWith('//') || input.startsWith('/\\')) return fallback;
  if (/[\r\n]/.test(input)) return fallback;
  return input;
}
