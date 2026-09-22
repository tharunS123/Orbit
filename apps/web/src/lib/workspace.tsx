'use client';

import * as React from 'react';
import type { Profile, WorkspaceRole } from '@orbit/shared';
import { selectWorkspaces, type WorkspaceWithRole } from '@orbit/sync/client';
import { useStoreQuery, useSync } from './sync';
import { setSoundsEnabled } from './sound';

/** Current workspace (persisted per user) + current profile + appearance side effects. */

interface WorkspaceCtx {
  workspaces: WorkspaceWithRole[];
  current: WorkspaceWithRole | null;
  workspaceId: string | null;
  role: WorkspaceRole | null;
  setWorkspace: (id: string) => void;
  profile: Profile | undefined;
}

const Ctx = React.createContext<WorkspaceCtx | null>(null);

const storageKey = (userId: string) => `orbit.workspace.${userId}`;

export function WorkspaceProvider({ children }: { children: React.ReactNode }) {
  const { userId } = useSync();
  const workspaces = useStoreQuery(['workspaces', 'workspaceMembers'], (s) => selectWorkspaces(s, userId), [userId]);
  const profile = useStoreQuery(['profiles'], (s) => s.get('profiles', userId), [userId]);
  const [selected, setSelected] = React.useState<string | null>(() => {
    try {
      return localStorage.getItem(storageKey(userId));
    } catch {
      return null;
    }
  });

  const current = workspaces.find((w) => w.id === selected) ?? workspaces.find((w) => w.kind === 'personal') ?? workspaces[0] ?? null;

  const setWorkspace = React.useCallback(
    (id: string) => {
      setSelected(id);
      try {
        localStorage.setItem(storageKey(userId), id);
      } catch {
        /* storage unavailable (private mode): selection just won't persist */
      }
    },
    [userId],
  );

  // Appearance settings follow the profile (synced across devices).
  const theme = profile?.settings.theme ?? 'system';
  const motion = profile?.settings.reducedMotion ?? 'system';
  const sounds = profile?.settings.sounds ?? true;
  React.useEffect(() => {
    applyTheme(theme);
    try {
      localStorage.setItem('orbit.theme', theme);
    } catch {
      /* ignore */
    }
    if (theme !== 'system') return;
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const on = () => applyTheme('system');
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, [theme]);
  React.useEffect(() => {
    document.documentElement.dataset.motion = motion === 'reduce' ? 'reduce' : 'full';
  }, [motion]);
  React.useEffect(() => {
    setSoundsEnabled(sounds);
  }, [sounds]);

  const value = React.useMemo<WorkspaceCtx>(
    () => ({ workspaces, current, workspaceId: current?.id ?? null, role: current?.role ?? null, setWorkspace, profile }),
    [workspaces, current, setWorkspace, profile],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function applyTheme(theme: 'system' | 'light' | 'dark') {
  const dark = theme === 'dark' || (theme === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
}

export function useWorkspace(): WorkspaceCtx {
  const ctx = React.useContext(Ctx);
  if (!ctx) throw new Error('useWorkspace must be used inside WorkspaceProvider');
  return ctx;
}
