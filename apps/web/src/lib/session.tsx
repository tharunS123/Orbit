'use client';

import * as React from 'react';
import type { Session } from '@supabase/supabase-js';
import { supabase } from './supabase';

interface SessionState {
  session: Session | null;
  loading: boolean;
  userId: string | null;
  email: string | null;
  /** Fresh access token (refreshes when close to expiry). */
  getToken: () => Promise<string | null>;
  signOut: (scope?: 'local' | 'global') => Promise<void>;
}

const Ctx = React.createContext<SessionState | null>(null);

export function SessionProvider({ children }: { children: React.ReactNode }) {
  const [session, setSession] = React.useState<Session | null>(null);
  const [loading, setLoading] = React.useState(true);

  React.useEffect(() => {
    const sb = supabase();
    let active = true;
    sb.auth
      .getSession()
      .then(({ data }) => {
        if (active) setSession(data.session);
      })
      .finally(() => active && setLoading(false));
    const { data: sub } = sb.auth.onAuthStateChange((_event, next) => {
      setSession(next);
      setLoading(false);
    });
    return () => {
      active = false;
      sub.subscription.unsubscribe();
    };
  }, []);

  const value = React.useMemo<SessionState>(
    () => ({
      session,
      loading,
      userId: session?.user.id ?? null,
      email: session?.user.email?.toLowerCase() ?? null,
      getToken: async () => {
        const { data } = await supabase().auth.getSession();
        const s = data.session;
        if (!s) return null;
        if (s.expires_at && s.expires_at * 1000 - Date.now() < 60_000) {
          const refreshed = await supabase().auth.refreshSession();
          return refreshed.data.session?.access_token ?? null;
        }
        return s.access_token;
      },
      signOut: async (scope = 'local') => {
        await supabase().auth.signOut({ scope });
      },
    }),
    [session, loading],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useSession(): SessionState {
  const ctx = React.useContext(Ctx);
  if (!ctx) throw new Error('useSession must be used inside SessionProvider');
  return ctx;
}
