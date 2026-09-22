'use client';

import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import { CollabSession } from '@orbit/editor/collab';
import { apiFetch } from './api';
import { useSession } from './session';
import { useSync } from './sync';

/** One collaboration session (shared WebSocket) per signed-in user; also delivers sync pokes. */

interface MeResponse {
  collabUrl: string;
  plan: 'free' | 'plus' | 'ultra';
  planName: string;
  limits: { features: string[]; maxFileBytes: number; storageBytes: number; maxLists: number | null };
  usage: { storageBytes: number; activeLists: number; talkThisMonth: number; meetingsThisMonth: number };
  capabilities: Record<string, boolean>;
  flags: Record<string, boolean>;
  mcpUrl: string;
  vapidPublicKey: string | null;
  inboundEmailDomain: string;
  email: string | null;
  planSource: string;
  planValidUntil: string | null;
}

export function useMe() {
  return useQuery({ queryKey: ['me'], queryFn: () => apiFetch<MeResponse>('/me'), staleTime: 60_000, gcTime: Infinity, networkMode: 'offlineFirst' });
}

const Ctx = React.createContext<CollabSession | null>(null);

function defaultCollabUrl(): string {
  if (typeof window === 'undefined') return 'ws://localhost:4001';
  const env = process.env.NEXT_PUBLIC_COLLAB_URL;
  if (env) return env;
  const { protocol, hostname } = window.location;
  return `${protocol === 'https:' ? 'wss' : 'ws'}://${hostname}:4001`;
}

export function CollabProvider({ children }: { children: React.ReactNode }) {
  const { getToken } = useSession();
  const { userId, client } = useSync();
  const me = useMe();
  const url = me.data?.collabUrl ?? defaultCollabUrl();
  const [session, setSession] = React.useState<CollabSession | null>(null);
  const tokenRef = React.useRef(getToken);
  tokenRef.current = getToken;

  React.useEffect(() => {
    const s = new CollabSession({ url, userId, getToken: () => tokenRef.current(), onPoke: () => client.poke() });
    setSession(s);
    return () => s.destroy();
  }, [url, userId, client]);

  return <Ctx.Provider value={session}>{children}</Ctx.Provider>;
}

export function useCollab(): CollabSession | null {
  return React.useContext(Ctx);
}
