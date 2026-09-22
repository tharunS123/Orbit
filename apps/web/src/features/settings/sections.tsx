'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { useQueryClient } from '@tanstack/react-query';
import { Bell, Download, RotateCcw, Trash2, Upload } from 'lucide-react';
import { AppError, describeError, routes, type LabelColor } from '@orbit/shared';
import { canChangeRole, canRemoveMember, canWorkspace } from '@orbit/core';
import { selectLabels, selectMembers, selectTrash } from '@orbit/sync/client';
import { Avatar, Button, ColorDot, ConfirmDialog, Field, Input, LabelChip, Popover, PopoverContent, PopoverTrigger, Segmented, Select, Shortcut, Switch, Textarea, toast } from '@orbit/ui';
import { LabelColorPicker } from '@/features/tasks/pickers';
import { apiFetch, downloadFromApi } from '@/lib/api';
import { SHORTCUTS } from '@/lib/hotkeys';
import { useMe } from '@/lib/collab';
import { enableWebPush, pushSupported } from '@/lib/push';
import { useNow, useStoreQuery, useSync } from '@/lib/sync';
import { useUndo } from '@/lib/undo';
import { useWorkspace } from '@/lib/workspace';
import { SettingRow, SettingsSection } from './common';
import { importAdapters, writeImport } from './importers';

export function AppearanceSettings() {
  const { client } = useSync();
  const { profile } = useWorkspace();
  const s = profile?.settings;
  const set = (patch: Record<string, unknown>) => client.mutate('profile.update', { settings: patch });
  if (!s) return null;
  return (
    <SettingsSection title="Appearance">
      <SettingRow label="Theme">
        <Segmented ariaLabel="Theme" value={s.theme} onValueChange={(theme) => set({ theme })} options={[{ value: 'system', label: 'System' }, { value: 'light', label: 'Light' }, { value: 'dark', label: 'Dark' }]} />
      </SettingRow>
      <SettingRow label="Motion" description="Reduce animations throughout the app.">
        <Segmented ariaLabel="Motion" value={s.reducedMotion} onValueChange={(reducedMotion) => set({ reducedMotion })} options={[{ value: 'system', label: 'System' }, { value: 'reduce', label: 'Reduced' }, { value: 'full', label: 'Full' }]} />
      </SettingRow>
      <SettingRow label="Completion sounds" description="A soft chime when you complete a task.">
        <Switch checked={s.sounds} onCheckedChange={(sounds) => set({ sounds })} aria-label="Completion sounds" />
      </SettingRow>
      <SettingRow label="Week starts on">
        <Select value={String(s.weekStartsOn)} onValueChange={(v) => set({ weekStartsOn: Number(v) })} options={[{ value: '1', label: 'Monday' }, { value: '0', label: 'Sunday' }, { value: '6', label: 'Saturday' }]} ariaLabel="Week starts on" />
      </SettingRow>
      <SettingRow label="Show calendar events in Today">
        <Switch checked={s.showCalendarInToday} onCheckedChange={(v) => set({ showCalendarInToday: v })} aria-label="Show calendar events in Today" />
      </SettingRow>
    </SettingsSection>
  );
}

export function NotificationSettings() {
  const { client } = useSync();
  const { profile } = useWorkspace();
  const me = useMe();
  const n = profile?.settings.notifications;
  const set = (patch: Record<string, boolean>) => client.mutate('profile.update', { settings: { notifications: { ...n, ...patch } as never } });
  const [permission, setPermission] = React.useState<NotificationPermission | 'unsupported'>('default');
  React.useEffect(() => {
    setPermission(pushSupported() ? Notification.permission : 'unsupported');
  }, []);
  if (!n) return null;
  return (
    <div className="flex flex-col gap-5">
      <SettingsSection title="This device">
        <SettingRow label="Push notifications" description={permission === 'granted' ? 'Enabled on this browser.' : permission === 'denied' ? 'Blocked in your browser settings.' : permission === 'unsupported' ? 'Not supported in this browser.' : 'Get reminders and mentions even when the app is closed.'}>
          <Button
            size="sm"
            variant="secondary"
            disabled={permission === 'unsupported' || permission === 'denied'}
            onClick={() =>
              void enableWebPush(me.data?.vapidPublicKey ?? null)
                .then((p) => {
                  setPermission(p);
                  if (p === 'granted') toast.success('Notifications enabled');
                })
                .catch((e: unknown) => toast.error(describeError(AppError.from(e))))
            }
          >
            <Bell /> {permission === 'granted' ? 'Re-register' : 'Enable'}
          </Button>
        </SettingRow>
      </SettingsSection>
      <SettingsSection title="Channels">
        <SettingRow label="Push">
          <Switch checked={n.push} onCheckedChange={(v) => set({ push: v })} aria-label="Push notifications" />
        </SettingRow>
        <SettingRow label="Email" description="For mentions, assignments and invitations when you’re away.">
          <Switch checked={n.email} onCheckedChange={(v) => set({ email: v })} aria-label="Email notifications" />
        </SettingRow>
      </SettingsSection>
      <SettingsSection title="What to notify me about">
        <SettingRow label="Task reminders">
          <Switch checked={n.reminders} onCheckedChange={(v) => set({ reminders: v })} aria-label="Reminders" />
        </SettingRow>
        <SettingRow label="Mentions">
          <Switch checked={n.mentions} onCheckedChange={(v) => set({ mentions: v })} aria-label="Mentions" />
        </SettingRow>
        <SettingRow label="Assignments">
          <Switch checked={n.assignments} onCheckedChange={(v) => set({ assignments: v })} aria-label="Assignments" />
        </SettingRow>
        <SettingRow label="Comments on my tasks">
          <Switch checked={n.comments} onCheckedChange={(v) => set({ comments: v })} aria-label="Comments" />
        </SettingRow>
      </SettingsSection>
    </div>
  );
}

function LabelsManager({ workspaceId }: { workspaceId: string }) {
  const { client, actions } = useSync();
  const labels = useStoreQuery(['labels'], (s) => selectLabels(s, workspaceId), [workspaceId]);
  const [name, setName] = React.useState('');
  const [confirm, setConfirm] = React.useState<string | null>(null);
  return (
    <SettingsSection title="Labels" description="Labels are shared by everyone in this workspace.">
      <form
        className="flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (name.trim()) actions.createLabel(workspaceId, name.trim());
          setName('');
        }}
      >
        <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="New label" aria-label="New label name" />
        <Button type="submit" variant="secondary" disabled={!name.trim()}>
          Add
        </Button>
      </form>
      <ul className="flex flex-col divide-y divide-border">
        {labels.map((l) => (
          <li key={l.id} className="flex items-center gap-3 py-2">
            <Popover>
              <PopoverTrigger asChild>
                <button type="button" aria-label={`Change color of ${l.name}`} className="grid size-7 place-items-center rounded-full hover:bg-bg-hover">
                  <ColorDot color={l.color} className="size-3.5" />
                </button>
              </PopoverTrigger>
              <PopoverContent className="w-56">
                <LabelColorPicker value={l.color} onChange={(c: LabelColor) => client.mutate('label.update', { id: l.id, color: c })} />
              </PopoverContent>
            </Popover>
            <Input defaultValue={l.name} aria-label={`Rename ${l.name}`} className="h-8 flex-1" onBlur={(e) => e.target.value.trim() && e.target.value !== l.name && client.mutate('label.update', { id: l.id, name: e.target.value.trim() })} />
            <LabelChip name={l.name} color={l.color} />
            <Button variant="ghost" size="icon-sm" aria-label={`Delete ${l.name}`} onClick={() => setConfirm(l.id)}>
              <Trash2 />
            </Button>
          </li>
        ))}
      </ul>
      <ConfirmDialog open={Boolean(confirm)} onOpenChange={(o) => !o && setConfirm(null)} destructive title="Delete label?" description="It will be removed from every task in this workspace." confirmLabel="Delete label" onConfirm={() => {
          if (confirm) client.mutate('label.delete', { id: confirm });
        }} />
    </SettingsSection>
  );
}

export function WorkspaceSettings() {
  const { client, userId } = useSync();
  const { current, role, workspaces, setWorkspace } = useWorkspace();
  const router = useRouter();
  const members = useStoreQuery(['workspaceMembers', 'profiles'], (s) => (current ? selectMembers(s, current.id) : []), [current?.id]);
  const invites = useStoreQuery(['workspaceInvitations'], (s) => s.all('workspaceInvitations').filter((i) => i.workspaceId === current?.id && i.status === 'pending'), [current?.id]);
  const [name, setName] = React.useState(current?.name ?? '');
  const [emails, setEmails] = React.useState('');
  const [inviteRole, setInviteRole] = React.useState<'member' | 'admin' | 'guest'>('member');
  const [danger, setDanger] = React.useState<null | 'leave' | 'delete' | { transfer: string }>(null);
  React.useEffect(() => {
    setName(current?.name ?? '');
  }, [current?.name]);
  if (!current) return null;
  const isTeam = current.kind === 'team';
  const sendInvites = async () => {
    const list = emails.split(/[\s,;]+/).filter((e) => /.+@.+\..+/.test(e));
    if (!list.length) return;
    try {
      const res = await apiFetch<{ results: { email: string; status: string }[] }>('/invitations', { method: 'POST', body: { workspaceId: current.id, emails: list, role: inviteRole } });
      const sent = res.results.filter((r) => r.status === 'invited').length;
      toast.success(sent ? `Sent ${sent} invitation${sent > 1 ? 's' : ''}` : 'Already members or invited');
      setEmails('');
      void client.sync();
    } catch (e) {
      toast.error(describeError(AppError.from(e)));
    }
  };
  return (
    <div className="flex flex-col gap-5">
      <SettingsSection title={isTeam ? 'Workspace' : 'Personal workspace'} description={isTeam ? undefined : 'Your private space. Create a team workspace to collaborate with others.'}>
        {isTeam ? (
          <form
            className="flex items-end gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              client.mutate('workspace.update', { id: current.id, name: name.trim() });
              toast.success('Saved');
            }}
          >
            <Field label="Name" htmlFor="ws-name" className="flex-1">
              <Input id="ws-name" value={name} disabled={!canWorkspace(role, 'workspace.rename')} onChange={(e) => setName(e.target.value)} />
            </Field>
            <Button type="submit" variant="secondary" disabled={!name.trim() || name === current.name || !canWorkspace(role, 'workspace.rename')}>
              Save
            </Button>
          </form>
        ) : null}
      </SettingsSection>
      {isTeam ? (
        <SettingsSection title={`Members (${members.length})`}>
          {canWorkspace(role, 'members.invite') ? (
            <div className="flex flex-col gap-2">
              <Textarea value={emails} onChange={(e) => setEmails(e.target.value)} placeholder="Invite by email — separate with commas" aria-label="Emails to invite" className="min-h-14" />
              <div className="flex justify-end gap-2">
                <Select value={inviteRole} onValueChange={setInviteRole} options={[{ value: 'member', label: 'Member' }, ...(role === 'owner' ? [{ value: 'admin' as const, label: 'Admin' }] : []), { value: 'guest', label: 'Guest' }]} ariaLabel="Role" />
                <Button variant="primary" onClick={() => void sendInvites()} disabled={!emails.trim()}>
                  Send invitations
                </Button>
              </div>
            </div>
          ) : null}
          <ul className="flex flex-col divide-y divide-border">
            {members.map(({ member, profile }) => (
              <li key={member.id} className="flex items-center gap-3 py-2">
                <Avatar name={profile?.displayName ?? 'Member'} seed={member.userId} size={28} />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm">
                    {profile?.displayName ?? 'Member'} {member.userId === userId ? <span className="text-fg-subtle">(you)</span> : null}
                  </p>
                  <p className="truncate text-xs text-fg-subtle">{profile?.email}</p>
                </div>
                {member.role === 'owner' ? (
                  <span className="text-xs text-fg-muted">Owner</span>
                ) : (
                  <Select
                    value={member.role}
                    onValueChange={(r) => client.mutate('member.setRole', { workspaceId: current.id, userId: member.userId, role: r })}
                    options={(['admin', 'member', 'guest'] as const).filter((r) => r === member.role || canChangeRole(role, member.role, r)).map((r) => ({ value: r, label: r[0]!.toUpperCase() + r.slice(1) }))}
                    ariaLabel={`Role for ${profile?.displayName ?? 'member'}`}
                    className="h-8"
                  />
                )}
                {member.userId !== userId && canRemoveMember(role, member.role, false) ? (
                  <Button variant="ghost" size="xs" onClick={() => client.mutate('member.remove', { workspaceId: current.id, userId: member.userId })}>
                    Remove
                  </Button>
                ) : null}
                {role === 'owner' && member.userId !== userId && (member.role === 'admin' || member.role === 'member') ? (
                  <Button variant="ghost" size="xs" onClick={() => setDanger({ transfer: member.userId })}>
                    Make owner
                  </Button>
                ) : null}
              </li>
            ))}
          </ul>
          {invites.length ? (
            <div>
              <p className="mb-1 text-xs font-semibold text-fg-muted">Pending invitations</p>
              <ul className="flex flex-col">
                {invites.map((i) => (
                  <li key={i.id} className="flex items-center gap-3 py-1.5 text-sm">
                    <span className="min-w-0 flex-1 truncate">
                      {i.email} · {i.role}
                    </span>
                    <Button size="xs" variant="ghost" onClick={() => void apiFetch(`/invitations/${i.id}/resend`, { method: 'POST' }).then(() => toast.success('Resent'))}>
                      Resend
                    </Button>
                    <Button size="xs" variant="ghost" onClick={() => void apiFetch(`/invitations/${i.id}/revoke`, { method: 'POST' }).then(() => client.sync())}>
                      Revoke
                    </Button>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </SettingsSection>
      ) : null}
      <LabelsManager workspaceId={current.id} />
      {isTeam ? (
        <SettingsSection title="Leave or delete" danger>
          <div className="flex gap-2">
            {role !== 'owner' ? (
              <Button variant="danger-ghost" onClick={() => setDanger('leave')}>
                Leave workspace
              </Button>
            ) : (
              <Button variant="danger" onClick={() => setDanger('delete')}>
                Delete workspace
              </Button>
            )}
          </div>
          {role === 'owner' ? <p className="text-xs text-fg-muted">To leave, first make someone else the owner.</p> : null}
        </SettingsSection>
      ) : null}
      <ConfirmDialog
        open={Boolean(danger)}
        onOpenChange={(o) => !o && setDanger(null)}
        destructive
        title={danger === 'leave' ? `Leave ${current.name}?` : danger === 'delete' ? `Delete ${current.name}?` : 'Transfer ownership?'}
        description={danger === 'leave' ? 'You lose access to its lists immediately.' : danger === 'delete' ? 'All lists and tasks in this workspace become inaccessible to everyone.' : 'You will become an admin. This can only be undone by the new owner.'}
        confirmLabel={danger === 'leave' ? 'Leave' : danger === 'delete' ? 'Delete workspace' : 'Transfer'}
        onConfirm={() => {
          if (danger === 'leave') client.mutate('workspace.leave', { workspaceId: current.id });
          else if (danger === 'delete') client.mutate('workspace.delete', { id: current.id });
          else if (danger && typeof danger === 'object') client.mutate('workspace.transfer', { workspaceId: current.id, toUserId: danger.transfer });
          if (danger === 'leave' || danger === 'delete') {
            const personal = workspaces.find((w) => w.kind === 'personal');
            if (personal) setWorkspace(personal.id);
            router.push(routes.inbox());
          }
        }}
      />
    </div>
  );
}

export function DataSettings() {
  const { actions, client, userId, timeZone, store } = useSync();
  const { workspaceId } = useWorkspace();
  const { run } = useUndo();
  const qc = useQueryClient();
  const now = useNow();
  const trash = useStoreQuery(['tasks', 'lists'], (s) => selectTrash(s, { userId, timeZone, now, workspaceId: null }), [userId]);
  const [adapter, setAdapter] = React.useState(importAdapters[0]!.id);
  const fileRef = React.useRef<HTMLInputElement>(null);
  const importFile = async (file: File) => {
    if (!workspaceId) return;
    const a = importAdapters.find((x) => x.id === adapter)!;
    try {
      const lists = a.parse(await file.text(), file.name);
      const labelIds = new Map(selectLabels(store, workspaceId).map((l) => [l.name.toLowerCase(), l.id]));
      const res = writeImport(actions, workspaceId, lists, (name) => {
        const key = name.toLowerCase();
        if (!labelIds.has(key)) labelIds.set(key, actions.createLabel(workspaceId, name).id);
        return labelIds.get(key)!;
      });
      toast.success(`Imported ${res.tasks} tasks into ${res.lists} list${res.lists === 1 ? '' : 's'}`);
      await qc.invalidateQueries();
    } catch (e) {
      toast.error(`Import failed: ${(e as Error).message}`);
    }
  };
  return (
    <div className="flex flex-col gap-5">
      <SettingsSection title="Export" description="Download everything: a JSON backup, Markdown for every list and a manifest of your files.">
        <div>
          <Button variant="secondary" onClick={() => void downloadFromApi('/account/export', { method: 'POST' }).catch((e: unknown) => toast.error(describeError(AppError.from(e))))}>
            <Download /> Export all data (.zip)
          </Button>
        </div>
      </SettingsSection>
      <SettingsSection title="Import" description="Bring tasks from a Markdown checklist, a CSV export or a JSON backup. Imports are added to the current workspace.">
        <div className="flex gap-2">
          <Select value={adapter} onValueChange={setAdapter} options={importAdapters.map((a) => ({ value: a.id, label: a.label }))} ariaLabel="Import format" className="flex-1" />
          <Button variant="secondary" onClick={() => fileRef.current?.click()}>
            <Upload /> Choose file
          </Button>
          <input ref={fileRef} type="file" accept={importAdapters.find((a) => a.id === adapter)!.accept} className="hidden" onChange={(e) => e.target.files?.[0] && (void importFile(e.target.files[0]), (e.target.value = ''))} />
        </div>
      </SettingsSection>
      <SettingsSection title="Trash" description="Deleted tasks and lists are kept for 30 days.">
        {trash.tasks.length || trash.lists.length ? (
          <ul className="flex flex-col divide-y divide-border">
            {trash.lists.map((l) => (
              <li key={l.id} className="flex items-center gap-3 py-2 text-sm">
                <span className="min-w-0 flex-1 truncate">
                  {l.emoji ?? '📄'} {l.title || 'Untitled list'} <span className="text-xs text-fg-subtle">· list</span>
                </span>
                <Button size="xs" variant="ghost" onClick={() => client.mutate('list.restore', { id: l.id })}>
                  <RotateCcw /> Restore
                </Button>
              </li>
            ))}
            {trash.tasks.map((t) => (
              <li key={t.id} className="flex items-center gap-3 py-2 text-sm">
                <span className="min-w-0 flex-1 truncate">{t.title || 'Untitled task'}</span>
                <span className="text-xs text-fg-subtle">{new Date(t.deletedAt!).toLocaleDateString()}</span>
                <Button size="xs" variant="ghost" onClick={() => run('Restored', () => { client.mutate('task.restore', { ids: [t.id] }); return {}; })}>
                  <RotateCcw /> Restore
                </Button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-fg-subtle">Trash is empty.</p>
        )}
      </SettingsSection>
      <SettingsSection title="This device" description="If something looks out of date, rebuild the local copy from the server. Unsynced changes are kept.">
        <div>
          <Button variant="secondary" onClick={() => void client.rebuildCache().then(() => toast.success('Local data rebuilt'))}>
            Rebuild local data
          </Button>
        </div>
      </SettingsSection>
    </div>
  );
}

const SHORTCUT_GROUPS: { title: string; items: [string, string][] }[] = [
  { title: 'General', items: [['Command palette', SHORTCUTS.palette], ['Search', SHORTCUTS.search], ['New task', SHORTCUTS.newTask], ['New list', SHORTCUTS.newList], ['Talk (voice)', SHORTCUTS.talk], ['Undo', SHORTCUTS.undo], ['Redo', SHORTCUTS.redo], ['Toggle sidebar', SHORTCUTS.toggleSidebar], ['Shortcuts', SHORTCUTS.help]] },
  { title: 'Navigate', items: [['Inbox', SHORTCUTS.inbox], ['Today', SHORTCUTS.today], ['Upcoming', SHORTCUTS.upcoming], ['Meetings', SHORTCUTS.meetings], ['Updates', SHORTCUTS.updates], ['Settings', SHORTCUTS.settings]] },
  { title: 'Tasks', items: [['Move focus', 'up'], ['Extend selection', 'shift+down'], ['Select all', SHORTCUTS.selectAll], ['Toggle selected', 'x'], ['Open', SHORTCUTS.open], ['Complete', SHORTCUTS.complete], ['Rename', SHORTCUTS.edit], ['Schedule', SHORTCUTS.schedule], ['Schedule for today', SHORTCUTS.scheduleToday], ['Labels', SHORTCUTS.label], ['Assign', SHORTCUTS.assign], ['Move to list', 'm'], ['Move up / down', SHORTCUTS.moveUp], ['Duplicate', SHORTCUTS.duplicate], ['Delete', SHORTCUTS.delete], ['Clear selection', 'escape']] },
  { title: 'Documents', items: [['Block menu', '/'], ['New task line', '[ ]'], ['Turn line into task', 'mod+shift+9'], ['Heading', '#'], ['Bulleted list', '-'], ['Numbered list', '1.'], ['Quote', '>'], ['Divider', '---'], ['Next task (in a task)', 'enter'], ['Make subtask', 'tab']] },
];

export function ShortcutSettings() {
  return (
    <div className="grid gap-5 sm:grid-cols-2">
      {SHORTCUT_GROUPS.map((g) => (
        <SettingsSection key={g.title} title={g.title}>
          <dl className="flex flex-col gap-2">
            {g.items.map(([label, keys]) => (
              <div key={label} className="flex items-center justify-between gap-2 text-sm">
                <dt className="text-fg-muted">{label}</dt>
                <dd>{/^[\w+]+$/.test(keys) || keys.includes('+') || keys.includes(' ') ? <Shortcut keys={keys.replace(' ', '+')} /> : <code className="rounded-xs bg-bg-hover px-1.5 text-xs">{keys}</code>}</dd>
              </div>
            ))}
          </dl>
        </SettingsSection>
      ))}
    </div>
  );
}
