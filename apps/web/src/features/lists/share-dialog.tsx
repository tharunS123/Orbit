'use client';

import * as React from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, Copy, Globe, Link2, Lock, Mail, Users, X } from 'lucide-react';
import { AppError, describeError, shareLinks, uuidv7, type List } from '@orbit/shared';
import { canList, listAccess } from '@orbit/core';
import { roleIn, selectMembers } from '@orbit/sync/client';
import { Avatar, Button, Dialog, DialogContent, Input, Select, Separator, Switch, toast } from '@orbit/ui';
import { apiFetch } from '@/lib/api';
import { publicEnv } from '@/lib/env';
import { useStoreQuery, useSync } from '@/lib/sync';

export function ShareDialog({ list, open, onOpenChange }: { list: List; open: boolean; onOpenChange: (o: boolean) => void }) {
  const { client, userId, store } = useSync();
  const qc = useQueryClient();
  const role = useStoreQuery(['workspaceMembers'], (s) => roleIn(s, userId, list.workspaceId), [list.workspaceId, userId]);
  const membership = useStoreQuery(['listMembers'], (s) => s.all('listMembers').find((m) => m.listId === list.id && m.userId === userId && !m.deletedAt) ?? null, [list.id]);
  const access = listAccess({ userId, role, list, membership });
  const canShare = canList(access, role, 'share');
  const members = useStoreQuery(['workspaceMembers', 'profiles'], (s) => selectMembers(s, list.workspaceId), [list.workspaceId]);
  const collaborators = useStoreQuery(['listMembers', 'profiles'], (s) => s.all('listMembers').filter((m) => m.listId === list.id && !m.deletedAt).map((m) => ({ m, p: s.get('profiles', m.userId) })), [list.id]);
  const creator = useStoreQuery(['profiles'], (s) => s.get('profiles', list.createdBy), [list.createdBy]);
  const workspace = store.get('workspaces', list.workspaceId);
  const [email, setEmail] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const publicLink = useQuery({ queryKey: ['public-link', list.id], enabled: open && canShare, queryFn: () => apiFetch<{ active: boolean }>(`/lists/${list.id}/public-link`) });
  const [publicUrl, setPublicUrl] = React.useState<string | null>(null);

  const invite = async () => {
    const value = email.trim().toLowerCase();
    if (!value) return;
    const existing = members.find((m) => m.profile?.email?.toLowerCase() === value);
    setBusy(true);
    try {
      if (existing && workspace?.kind === 'team') {
        client.mutate('list.share', { listId: list.id, userId: existing.member.userId, role: 'editor', memberId: uuidv7() });
        toast.success(`Shared with ${existing.profile?.displayName ?? value}`);
      } else {
        await apiFetch('/invitations', { method: 'POST', body: { workspaceId: list.workspaceId, listId: list.id, emails: [value], role: 'guest' } });
        toast.success(`Invitation sent to ${value}`);
      }
      setEmail('');
    } catch (error) {
      toast.error(describeError(AppError.from(error)));
    } finally {
      setBusy(false);
    }
  };

  const togglePublic = async (on: boolean) => {
    try {
      if (on) {
        const res = await apiFetch<{ url: string }>(`/lists/${list.id}/public-link`, { method: 'POST' });
        setPublicUrl(res.url);
        await navigator.clipboard.writeText(res.url).catch(() => undefined);
        toast.success('Public link created and copied');
      } else {
        await apiFetch(`/lists/${list.id}/public-link`, { method: 'DELETE' });
        setPublicUrl(null);
        toast('Public link turned off');
      }
      await qc.invalidateQueries({ queryKey: ['public-link', list.id] });
    } catch (error) {
      toast.error(describeError(AppError.from(error)));
    }
  };

  const visibilityOptions = [
    { value: 'private', label: 'Only people added' },
    ...(workspace?.kind === 'team' ? [{ value: 'workspace', label: `Everyone in ${workspace.name}` }] : []),
  ] as { value: 'private' | 'workspace'; label: string }[];
  const visibility = list.visibility === 'workspace' ? 'workspace' : 'private';

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent title={`Share “${list.title || 'Untitled list'}”`} description="Collaborators can edit tasks and notes in real time." size="md">
        <div className="flex flex-col gap-4">
          {canShare ? (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                void invite();
              }}
              className="flex gap-2"
            >
              <Input type="email" placeholder="Invite by email" value={email} onChange={(e) => setEmail(e.target.value)} aria-label="Email address to invite" list="share-member-emails" />
              <datalist id="share-member-emails">
                {members.map((m) => (m.profile?.email ? <option key={m.member.id} value={m.profile.email}>{m.profile.displayName}</option> : null))}
              </datalist>
              <Button type="submit" variant="primary" loading={busy} disabled={!email.trim()}>
                <Mail /> Invite
              </Button>
            </form>
          ) : (
            <p className="rounded-md bg-surface-sunken px-3 py-2 text-sm text-fg-muted">Only the list owner or workspace members with edit access can share this list.</p>
          )}

          <div>
            <p className="mb-1 text-xs font-semibold text-fg-muted">General access</p>
            <div className="flex items-center gap-3">
              <span className="grid size-8 place-items-center rounded-full bg-bg-hover">{visibility === 'workspace' ? <Users className="size-4" /> : <Lock className="size-4" />}</span>
              {canShare ? (
                <Select value={visibility} onValueChange={(v) => client.mutate('list.update', { id: list.id, patch: { visibility: v === 'workspace' ? 'workspace' : collaborators.length ? 'shared' : 'private' } })} options={visibilityOptions} ariaLabel="Who can access" className="flex-1" />
              ) : (
                <span className="text-sm">{visibilityOptions.find((o) => o.value === visibility)?.label}</span>
              )}
            </div>
          </div>

          <div>
            <p className="mb-1 text-xs font-semibold text-fg-muted">People with access</p>
            <ul className="flex flex-col">
              <li className="flex items-center gap-3 py-1.5">
                <Avatar name={creator?.displayName ?? 'Owner'} seed={list.createdBy} size={28} />
                <span className="min-w-0 flex-1 truncate text-sm">
                  {creator?.displayName ?? 'Owner'} {list.createdBy === userId ? <span className="text-fg-subtle">(you)</span> : null}
                </span>
                <span className="text-xs text-fg-subtle">Owner</span>
              </li>
              {collaborators.map(({ m, p }) => (
                <li key={m.id} className="flex items-center gap-3 py-1.5">
                  <Avatar name={p?.displayName ?? 'Member'} seed={m.userId} size={28} />
                  <span className="min-w-0 flex-1 truncate text-sm">
                    {p?.displayName ?? 'Member'} {m.userId === userId ? <span className="text-fg-subtle">(you)</span> : null}
                  </span>
                  {canShare ? (
                    <>
                      <Select value={m.role} onValueChange={(r) => client.mutate('list.share', { listId: list.id, userId: m.userId, role: r, memberId: m.id })} options={[{ value: 'editor', label: 'Can edit' }, { value: 'viewer', label: 'Can view' }]} ariaLabel={`Access for ${p?.displayName ?? 'member'}`} className="h-8" />
                      <Button variant="ghost" size="icon-sm" aria-label={`Remove ${p?.displayName ?? 'member'}`} onClick={() => client.mutate('list.unshare', { listId: list.id, userId: m.userId })}>
                        <X />
                      </Button>
                    </>
                  ) : (
                    <span className="text-xs text-fg-subtle">{m.role === 'viewer' ? 'Can view' : 'Can edit'}</span>
                  )}
                </li>
              ))}
            </ul>
          </div>

          <Separator />
          <div className="flex items-center gap-2">
            <Button
              variant="secondary"
              size="sm"
              onClick={() => {
                void navigator.clipboard.writeText(shareLinks.list(publicEnv.appUrl || window.location.origin, list.id));
                toast.success('Link copied — only people with access can open it');
              }}
            >
              <Link2 /> Copy link
            </Button>
            {canShare && publicEnv.flags.publicLinks ? (
              <label className="ml-auto flex items-center gap-2 text-sm">
                <Globe className="size-4 text-fg-muted" /> Public read-only link
                <Switch checked={Boolean(publicLink.data?.active || publicUrl)} onCheckedChange={(on) => void togglePublic(on)} aria-label="Public read-only link" />
              </label>
            ) : null}
          </div>
          {publicUrl ? (
            <div className="flex items-center gap-2 rounded-md bg-surface-sunken px-3 py-2 text-xs">
              <span className="min-w-0 flex-1 truncate">{publicUrl}</span>
              <Button variant="ghost" size="icon-sm" aria-label="Copy public link" onClick={() => void navigator.clipboard.writeText(publicUrl).then(() => toast.success('Copied'))}>
                <Copy />
              </Button>
            </div>
          ) : publicLink.data?.active ? (
            <p className="flex items-center gap-1 text-xs text-fg-muted">
              <Check className="size-3.5 text-success" /> Anyone with the public link can view this list. Turn it off and on to get a new link.
            </p>
          ) : null}
        </div>
      </DialogContent>
    </Dialog>
  );
}
