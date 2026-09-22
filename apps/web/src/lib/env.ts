import { parseFlags } from '@orbit/shared';

/** Public (browser) configuration. Only NEXT_PUBLIC_* values are available here. */
export const publicEnv = {
  supabaseUrl: process.env.NEXT_PUBLIC_SUPABASE_URL ?? '',
  supabaseAnonKey: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? '',
  appUrl: process.env.NEXT_PUBLIC_APP_URL ?? 'http://localhost:3000',
  apiUrl: (process.env.NEXT_PUBLIC_API_URL ?? '').replace(/\/$/, ''),
  native: process.env.NEXT_PUBLIC_NATIVE === '1',
  flags: parseFlags(process.env.NEXT_PUBLIC_FLAGS),
  analyticsProvider: process.env.NEXT_PUBLIC_ANALYTICS_PROVIDER ?? 'none',
  posthogKey: process.env.NEXT_PUBLIC_POSTHOG_KEY ?? '',
  posthogHost: process.env.NEXT_PUBLIC_POSTHOG_HOST ?? '',
};

export function assertPublicEnv(): string[] {
  const missing: string[] = [];
  if (!publicEnv.supabaseUrl) missing.push('NEXT_PUBLIC_SUPABASE_URL');
  if (!publicEnv.supabaseAnonKey) missing.push('NEXT_PUBLIC_SUPABASE_ANON_KEY');
  return missing;
}
