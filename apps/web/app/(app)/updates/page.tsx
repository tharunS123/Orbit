'use client';

import * as React from 'react';
import Link from 'next/link';
import { useQueryClient } from '@tanstack/react-query';
import { Bell, CheckCheck, Mail } from 'lucide-react';
import { AppError, describeError, type Notification } from '@orbit/shared';
import { notificationCopy } from '@orbit/notifications/copy';
import { selectNotifications, selectPendingInvitations } from '@orbit/sync/client';
import { Avatar, Button, EmptyState, Segmented, cn, toast } from '@orbit/ui';
import { PageBody, PageHeader, SectionTitle } from '@/features/shell/page-header';
import { apiFetch } from '@/lib/api';
import { useSession } from '@/lib/session';
import { useStoreQuery, useSync } from '@/lib/sync';
import { useWorkspace } from '@/lib/workspace';

function relTime(iso: string) {
  const diff = (Date.now() - Date.parse(iso)) / 1000;
  if (diff < 60) return 'now';
  if (diff < 3600) return `${Math.floor(diff / 60)}m`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h`;
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function NotificationRow({ n }: { n: Notification }) {
  const { client } = useSync();
  const actor = useStoreQuery(['profiles'], (s) => (n.actorId ? s.get('profiles', n.actorId) : undefined), [n.actorId]);
  const copy = notificationCopy({ type: n.type, actorName: actor?.displayName ?? null, data: n.data, taskId: n.taskId, listId: n.listId, meetingId: n.meetingId });
  return (
    <li>
      <Link
        href={copy.path}
        onClick={() => !n.readAt && client.mutate('notification.markRead', { ids: [n.id] })}
        className={cn('flex items-start gap-3 rounded-lg px-2 py-2.5 hover:bg-bg-hover', !n.readAt && 'bg-accent-subtle/30')}
      >
        <Avatar name={actor?.displayName ?? 'System'} seed={n.actorId ?? 'system'} size={30} />
        <div className="min-w-0 flex-1">
          <p className={cn('text-sm leading-snug', !n.readAt && 'font-medium')}>{copy.headline}</p>
          {copy.detail ? <p className="text-xs text-fg-muted">{copy.detail}</p> : null}
        </div>
        <span className="shrink-0 text-xs text-fg-subtle">{relTime(n.createdAt)}</span>
        {!n.readAt ? <span className="mt-1.5 size-2 shrink-0 rounded-full bg-accent" aria-label="Unread" /> : null}
      </Link>
    </li>
  );
}

function UpdatesView() {
  const { userId, client } = useSync();
  const { email } = useSession();
  const { setWorkspace } = useWorkspace();
  const qc = useQueryClient();
  const [filter, setFilter] = React.useState<'all' | 'unread'>('all');
  const { items, unread } = useStoreQuery(['notifications'], (s) => selectNotifications(s, userId), [userId]);
  const invites = useStoreQuery(['workspaceInvitations'], (s) => selectPendingInvitations(s, email), [email]);
  const shown = filter === 'unread' ? items.filter((n) => !n.readAt) : items;

  const respond = async (id: string, accept: boolean) => {
    try {
      if (accept) {
        const res = await apiFetch<{ workspaceId: string }>(`/invitations/${id}/accept`, { method: 'POST' });
        await client.sync();
        setWorkspace(res.workspaceId);
        toast.success('Invitation accepted');
      } else {
        await apiFetch(`/invitations/${id}/decline`, { method: 'POST' });
        await client.sync();
        toast('Invitation declined');
      }
      await qc.invalidateQueries();
    } catch (error) {
      toast.error(describeError(AppError.from(error)));
    }
  };

  return (
    <>
      <PageHeader
        title="Updates"
        icon={<Bell />}
        subtitle={unread ? `${unread} unread` : 'You’re all caught up'}
        actions={
          <>
            <Segmented ariaLabel="Filter" value={filter} onValueChange={setFilter} options={[{ value: 'all', label: 'All' }, { value: 'unread', label: 'Unread' }]} />
            <Button variant="ghost" size="sm" disabled={!unread} onClick={() => client.mutate('notification.markRead', { all: true })}>
              <CheckCheck /> Mark all read
            </Button>
          </>
        }
      />
      <PageBody>
        {invites.length ? (
          <>
            <SectionTitle count={invites.length}>Invitations</SectionTitle>
            <ul className="flex flex-col gap-2">
              {invites.map((i) => (
                <li key={i.id} className="flex items-center gap-3 rounded-lg border border-border bg-surface p-3">
                  <Mail className="size-5 text-accent" aria-hidden />
                  <p className="min-w-0 flex-1 text-sm">You’re invited to join a {i.listId ? 'shared list' : 'workspace'} as {i.role}.</p>
                  <Button size="sm" variant="ghost" onClick={() => void respond(i.id, false)}>
                    Decline
                  </Button>
                  <Button size="sm" variant="primary" onClick={() => void respond(i.id, true)}>
                    Accept
                  </Button>
                </li>
              ))}
            </ul>
          </>
        ) : null}
        {shown.length ? (
          <ul className="mt-3 flex flex-col gap-0.5">
            {shown.map((n) => (
              <NotificationRow key={n.id} n={n} />
            ))}
          </ul>
        ) : !invites.length ? (
          <EmptyState icon={<Bell />} title={filter === 'unread' ? 'No unread updates' : 'No updates yet'} description="When someone assigns you a task, mentions you or shares a list, it shows up here." />
        ) : null}
      </PageBody>
    </>
  );
}

export default function UpdatesPage() {
  return (
    <React.Suspense>
      <UpdatesView />
    </React.Suspense>
  );
}
