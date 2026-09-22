/**
 * Typed feature flags. Defaults are production-safe; override per environment with
 * `NEXT_PUBLIC_FLAGS` / `FLAGS` as a comma list, e.g. `FLAGS=meetingSystemAudio,-publicLinks`.
 */
export const FLAG_DEFAULTS = {
  /** Capture system/tab audio in web meetings (requires getDisplayMedia audio support). */
  meetingSystemAudio: true,
  /** Live chat with the transcript while a meeting is still recording. */
  meetingLiveChat: true,
  /** Public read-only links for lists and meetings. */
  publicLinks: true,
  /** Microsoft To Do import/sync. */
  microsoftTodo: true,
  /** Show developer test-entitlement controls on the billing page (never enable in prod). */
  devEntitlements: false,
} as const;

export type FlagName = keyof typeof FLAG_DEFAULTS;
export type Flags = Record<FlagName, boolean>;

export function parseFlags(raw: string | undefined | null, base: Flags = FLAG_DEFAULTS): Flags {
  const flags: Flags = { ...base };
  if (!raw) return flags;
  for (const token of raw.split(',').map((t) => t.trim()).filter(Boolean)) {
    const off = token.startsWith('-');
    const name = (off ? token.slice(1) : token) as FlagName;
    if (name in flags) flags[name] = !off;
  }
  return flags;
}
