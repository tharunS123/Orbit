'use client';

import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { publicEnv } from './env';

/**
 * Browser Supabase client — used for authentication only. All data flows through our API and the
 * sync engine. PKCE flow for OAuth/magic links; sessions persist in localStorage (native shells
 * swap in secure storage in apps/mobile).
 */
let client: SupabaseClient | null = null;

export function supabase(): SupabaseClient {
  client ??= createClient(publicEnv.supabaseUrl, publicEnv.supabaseAnonKey, {
    auth: {
      flowType: 'pkce',
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: true,
      storageKey: 'orbit.auth',
    },
  });
  return client;
}
