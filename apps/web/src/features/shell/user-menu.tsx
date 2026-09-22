'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { Keyboard, LogOut, Monitor, Moon, Settings, ShieldOff, Sun, UserRound } from 'lucide-react';
import { routes } from '@orbit/shared';
import { Avatar, Menu, MenuContent, MenuItem, MenuLabel, MenuSeparator, MenuSub, MenuSubContent, MenuSubTrigger, MenuTrigger } from '@orbit/ui';
import { useSession } from '@/lib/session';
import { useSignedImage } from '@/lib/images';
import { useSync } from '@/lib/sync';
import { useWorkspace } from '@/lib/workspace';
import { SHORTCUTS } from '@/lib/hotkeys';

export function UserMenu({ compact }: { compact?: boolean }) {
  const router = useRouter();
  const { signOut, email } = useSession();
  const { client } = useSync();
  const { profile } = useWorkspace();
  const avatar = useSignedImage(profile?.avatarPath);
  const setTheme = (theme: 'system' | 'light' | 'dark') => client.mutate('profile.update', { settings: { theme } });
  const out = async (scope: 'local' | 'global') => {
    await client.flush();
    await signOut(scope);
    router.replace('/login');
  };
  const name = profile?.displayName || email || 'You';
  return (
    <Menu>
      <MenuTrigger asChild>
        <button type="button" className="flex h-8 min-w-0 items-center gap-2 rounded-md px-1.5 hover:bg-bg-hover" aria-label="Account menu">
          <Avatar name={name} src={avatar} seed={profile?.id} size={22} />
          {compact ? null : <span className="truncate text-[13px] font-medium">{name}</span>}
        </button>
      </MenuTrigger>
      <MenuContent align="start" className="w-60">
        <MenuLabel>{email}</MenuLabel>
        <MenuItem onSelect={() => router.push(routes.profile())}>
          <UserRound /> Profile & activity
        </MenuItem>
        <MenuItem onSelect={() => router.push(routes.settings('account'))} shortcut={SHORTCUTS.settings}>
          <Settings /> Settings
        </MenuItem>
        <MenuSub>
          <MenuSubTrigger>
            <Sun /> Appearance
          </MenuSubTrigger>
          <MenuSubContent>
            <MenuItem onSelect={() => setTheme('system')}>
              <Monitor /> System
            </MenuItem>
            <MenuItem onSelect={() => setTheme('light')}>
              <Sun /> Light
            </MenuItem>
            <MenuItem onSelect={() => setTheme('dark')}>
              <Moon /> Dark
            </MenuItem>
          </MenuSubContent>
        </MenuSub>
        <MenuItem onSelect={() => router.push(routes.shortcuts())} shortcut={SHORTCUTS.help}>
          <Keyboard /> Keyboard shortcuts
        </MenuItem>
        <MenuSeparator />
        <MenuItem onSelect={() => void out('local')}>
          <LogOut /> Sign out
        </MenuItem>
        <MenuItem onSelect={() => void out('global')}>
          <ShieldOff /> Sign out of all devices
        </MenuItem>
      </MenuContent>
    </Menu>
  );
}
