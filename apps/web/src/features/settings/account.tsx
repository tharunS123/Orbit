'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Laptop, LogOut, Smartphone, Upload } from 'lucide-react';
import { AppError, describeError } from '@orbit/shared';
import { Avatar, Button, ConfirmDialog, Field, Input, Select, toast } from '@orbit/ui';
import { friendlyAuthError } from '@/features/auth/auth-ui';
import { apiFetch } from '@/lib/api';
import { useSignedImage } from '@/lib/images';
import { useSession } from '@/lib/session';
import { supabase } from '@/lib/supabase';
import { useSync } from '@/lib/sync';
import { useWorkspace } from '@/lib/workspace';
import { SettingRow, SettingsSection } from './common';

interface SessionRow {
  id: string;
  createdAt: string;
  updatedAt: string | null;
  userAgent: string | null;
  ip: string | null;
  current: boolean;
}
interface DeviceRow {
  id: string;
  platform: string;
  name: string;
  lastSeenAt: string;
  revokedAt: string | null;
}

function describeAgent(ua: string | null) {
  if (!ua) return 'Unknown device';
  const browser = /Edg\//.test(ua) ? 'Edge' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : /Firefox\//.test(ua) ? 'Firefox' : 'App';
  const os = /Mac OS X/.test(ua) ? 'macOS' : /Windows/.test(ua) ? 'Windows' : /iPhone|iPad/.test(ua) ? 'iOS' : /Android/.test(ua) ? 'Android' : /Linux/.test(ua) ? 'Linux' : '';
  return `${browser}${os ? ` on ${os}` : ''}`;
}

export function AccountSettings() {
  const router = useRouter();
  const qc = useQueryClient();
  const { client } = useSync();
  const { profile } = useWorkspace();
  const { email, signOut } = useSession();
  const avatar = useSignedImage(profile?.avatarPath);
  const [name, setName] = React.useState(profile?.displayName ?? '');
  const [newEmail, setNewEmail] = React.useState('');
  const [password, setPassword] = React.useState('');
  const [deleteOpen, setDeleteOpen] = React.useState(false);
  const [confirmPassword, setConfirmPassword] = React.useState('');
  const fileRef = React.useRef<HTMLInputElement>(null);
  const zones = React.useMemo(() => {
    try {
      return (Intl as unknown as { supportedValuesOf(k: string): string[] }).supportedValuesOf('timeZone');
    } catch {
      return ['UTC'];
    }
  }, []);
  const sessions = useQuery({ queryKey: ['sessions'], queryFn: () => apiFetch<{ sessions: SessionRow[] }>('/account/sessions').then((r) => r.sessions) });
  const devices = useQuery({ queryKey: ['devices'], queryFn: () => apiFetch<{ devices: DeviceRow[] }>('/devices').then((r) => r.devices) });

  const uploadAvatar = async (file: File) => {
    try {
      const { uploadUrl, path } = await apiFetch<{ uploadUrl: string; path: string }>('/uploads/image-url', { method: 'POST', body: { kind: 'avatar', mimeType: file.type, sizeBytes: file.size } });
      const res = await fetch(uploadUrl, { method: 'PUT', body: file, headers: { 'content-type': file.type } });
      if (!res.ok) throw new Error('upload');
      client.mutate('profile.update', { avatarPath: path });
      toast.success('Photo updated');
    } catch {
      toast.error('Couldn’t upload that image.');
    }
  };

  const deleteAccount = async () => {
    // Re-authenticate: sensitive actions require a fresh sign-in.
    if (email && confirmPassword) {
      const { error } = await supabase().auth.signInWithPassword({ email, password: confirmPassword });
      if (error) throw new Error(friendlyAuthError(error.message));
    }
    try {
      await apiFetch('/account/delete', { method: 'POST', body: { confirm: 'DELETE' } });
    } catch (e) {
      const err = AppError.from(e);
      toast.error(err.details?.reauth ? 'Please enter your password to confirm.' : describeError(err));
      throw e;
    }
    toast.success('Your account is being deleted.');
    await signOut('global');
    router.replace('/');
  };

  return (
    <div className="flex flex-col gap-5">
      <SettingsSection title="Profile">
        <div className="flex items-center gap-4">
          <Avatar name={profile?.displayName ?? 'You'} src={avatar} seed={profile?.id} size={56} />
          <Button variant="secondary" size="sm" onClick={() => fileRef.current?.click()}>
            <Upload /> Change photo
          </Button>
          {profile?.avatarPath ? (
            <Button variant="ghost" size="sm" onClick={() => client.mutate('profile.update', { avatarPath: null })}>
              Remove
            </Button>
          ) : null}
          <input ref={fileRef} type="file" accept="image/png,image/jpeg,image/webp" className="hidden" onChange={(e) => e.target.files?.[0] && void uploadAvatar(e.target.files[0])} />
        </div>
        <form
          className="flex items-end gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (name.trim()) client.mutate('profile.update', { displayName: name.trim() });
            toast.success('Saved');
          }}
        >
          <Field label="Display name" htmlFor="set-name" className="flex-1">
            <Input id="set-name" value={name} onChange={(e) => setName(e.target.value)} />
          </Field>
          <Button type="submit" variant="secondary" disabled={!name.trim() || name === profile?.displayName}>
            Save
          </Button>
        </form>
        <SettingRow label="Time zone" description="Used for due dates, reminders and Today.">
          <Select value={profile?.timezone ?? 'UTC'} onValueChange={(tz) => client.mutate('profile.update', { timezone: tz })} options={zones.map((z) => ({ value: z, label: z.replace(/_/g, ' ') }))} ariaLabel="Time zone" className="w-56" />
        </SettingRow>
      </SettingsSection>

      <SettingsSection title="Email & password">
        <form
          className="flex items-end gap-2"
          onSubmit={async (e) => {
            e.preventDefault();
            const { error } = await supabase().auth.updateUser({ email: newEmail.trim() });
            if (error) toast.error(friendlyAuthError(error.message));
            else toast.success('Check both inboxes to confirm the change.');
            setNewEmail('');
          }}
        >
          <Field label={`Email (${email ?? ''})`} htmlFor="set-email" className="flex-1">
            <Input id="set-email" type="email" placeholder="New email address" value={newEmail} onChange={(e) => setNewEmail(e.target.value)} />
          </Field>
          <Button type="submit" variant="secondary" disabled={!newEmail.includes('@')}>
            Change
          </Button>
        </form>
        <form
          className="flex items-end gap-2"
          onSubmit={async (e) => {
            e.preventDefault();
            if (password.length < 8) return toast.error('Use at least 8 characters.');
            const { error } = await supabase().auth.updateUser({ password });
            if (error) toast.error(friendlyAuthError(error.message));
            else {
              await supabase().auth.signOut({ scope: 'others' });
              toast.success('Password updated. Other devices were signed out.');
            }
            setPassword('');
          }}
        >
          <Field label="New password" htmlFor="set-pw" className="flex-1">
            <Input id="set-pw" type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} />
          </Field>
          <Button type="submit" variant="secondary" disabled={!password}>
            Update
          </Button>
        </form>
      </SettingsSection>

      <SettingsSection title="Where you’re signed in" description="Revoke any session you don’t recognise.">
        {sessions.data?.length ? (
          <ul className="flex flex-col divide-y divide-border">
            {sessions.data.map((s) => (
              <li key={s.id} className="flex items-center gap-3 py-2.5">
                {/iPhone|Android/.test(s.userAgent ?? '') ? <Smartphone className="size-4 text-fg-muted" /> : <Laptop className="size-4 text-fg-muted" />}
                <div className="min-w-0 flex-1">
                  <p className="text-sm">
                    {describeAgent(s.userAgent)} {s.current ? <span className="text-xs text-success">· this device</span> : null}
                  </p>
                  <p className="text-xs text-fg-subtle">Last active {new Date(s.updatedAt ?? s.createdAt).toLocaleString()}</p>
                </div>
                {!s.current ? (
                  <Button
                    size="xs"
                    variant="ghost"
                    onClick={() =>
                      void apiFetch(`/account/sessions/${s.id}`, { method: 'DELETE' })
                        .then(() => qc.invalidateQueries({ queryKey: ['sessions'] }))
                        .catch(() => toast.error('Couldn’t revoke the session.'))
                    }
                  >
                    Revoke
                  </Button>
                ) : null}
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-fg-subtle">{sessions.isLoading ? 'Loading…' : 'Session list is available when online.'}</p>
        )}
        {devices.data?.filter((d) => !d.revokedAt).length ? (
          <div>
            <p className="mb-1 text-xs font-semibold text-fg-muted">Devices receiving notifications</p>
            <ul className="flex flex-col">
              {devices.data
                .filter((d) => !d.revokedAt)
                .map((d) => (
                  <li key={d.id} className="flex items-center gap-3 py-1.5 text-sm">
                    <span className="min-w-0 flex-1 truncate">
                      {d.platform} · {describeAgent(d.name)}
                    </span>
                    <Button size="xs" variant="ghost" onClick={() => void apiFetch(`/devices/${d.id}`, { method: 'DELETE' }).then(() => qc.invalidateQueries({ queryKey: ['devices'] }))}>
                      Remove
                    </Button>
                  </li>
                ))}
            </ul>
          </div>
        ) : null}
        <div>
          <Button variant="secondary" size="sm" onClick={() => void signOut('global').then(() => router.replace('/login'))}>
            <LogOut /> Sign out of all devices
          </Button>
        </div>
      </SettingsSection>

      <SettingsSection title="Delete account" danger description="Permanently deletes your account, personal workspace, private lists, recordings and files. Shared content in team workspaces stays with the team. Subscriptions are cancelled and integrations disconnected.">
        <div>
          <Button variant="danger" onClick={() => setDeleteOpen(true)}>
            Delete my account…
          </Button>
        </div>
      </SettingsSection>
      <ConfirmDialog open={deleteOpen} onOpenChange={setDeleteOpen} destructive title="Delete your account?" description="This can’t be undone. Export your data first from Settings → Data if you want a copy." confirmLabel="Delete account" onConfirm={deleteAccount}>
        <Field label="Confirm with your password" htmlFor="del-pw" className="mt-4" hint="Signed in with Google or Apple? Sign out and back in, then delete within 15 minutes.">
          <Input id="del-pw" type="password" autoComplete="current-password" value={confirmPassword} onChange={(e) => setConfirmPassword(e.target.value)} />
        </Field>
      </ConfirmDialog>
    </div>
  );
}
