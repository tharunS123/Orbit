'use client';

import * as React from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import { Users } from 'lucide-react';
import { AppError, describeError, routes } from '@orbit/shared';
import { Button, Spinner } from '@orbit/ui';
import { AuthShell } from '@/features/auth/auth-ui';
import { apiFetch } from '@/lib/api';
import { useSession } from '@/lib/session';

interface Preview {
  workspace: string;
  inviter: string;
  listTitle: string | null;
  role: string;
  status: string;
  emailHint: string;
}

function InviteView() {
  const params = useSearchParams();
  const token = params.get('token') ?? '';
  const router = useRouter();
  const { session, loading, email } = useSession();
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const preview = useQuery({ queryKey: ['invite', token], enabled: Boolean(token), retry: false, queryFn: () => apiFetch<Preview>(`/invitations/preview?token=${encodeURIComponent(token)}`, { anonymous: true }) });
  const next = `/invite?token=${encodeURIComponent(token)}`;

  const accept = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await apiFetch<{ workspaceId: string; listId: string | null }>('/invitations/accept', { method: 'POST', body: { token } });
      try {
        localStorage.setItem(`orbit.workspace.${session?.user.id}`, res.workspaceId);
      } catch {
        /* ignore */
      }
      router.replace(res.listId ? routes.list(res.listId) : routes.inbox());
    } catch (e) {
      setError(describeError(AppError.from(e)));
    } finally {
      setBusy(false);
    }
  };

  if (preview.isLoading || loading) {
    return (
      <main className="grid min-h-dvh place-items-center">
        <Spinner />
      </main>
    );
  }
  if (preview.error || !preview.data) {
    return (
      <AuthShell title="Invitation not found" subtitle="This link is invalid or was revoked. Ask the person who invited you to send a new one.">
        <Button asChild variant="secondary" className="w-full">
          <Link href="/">Go home</Link>
        </Button>
      </AuthShell>
    );
  }
  const p = preview.data;
  const target = p.listTitle ? `“${p.listTitle}” in ${p.workspace}` : p.workspace;
  if (p.status !== 'pending') {
    return (
      <AuthShell title={`This invitation was ${p.status}`} subtitle="Ask for a new invitation if you still need access.">
        <Button asChild variant="secondary" className="w-full">
          <Link href={session ? routes.inbox() : '/login'}>Continue</Link>
        </Button>
      </AuthShell>
    );
  }
  return (
    <AuthShell title={`${p.inviter} invited you`} subtitle={<>Join {target} as {p.role}. Sent to {p.emailHint}.</>}>
      <div className="flex flex-col gap-3">
        <div className="flex items-center gap-3 rounded-lg bg-accent-subtle/50 p-3 text-sm">
          <Users className="size-5 text-accent" aria-hidden /> {target}
        </div>
        {error ? (
          <p className="text-sm text-danger" role="alert">
            {error}
          </p>
        ) : null}
        {session ? (
          <>
            <Button variant="primary" size="lg" loading={busy} onClick={() => void accept()}>
              Accept invitation
            </Button>
            <p className="text-center text-xs text-fg-subtle">Signed in as {email}</p>
          </>
        ) : (
          <>
            <Button asChild variant="primary" size="lg">
              <Link href={`/signup?next=${encodeURIComponent(next)}`}>Create an account to join</Link>
            </Button>
            <Button asChild variant="secondary" size="lg">
              <Link href={`/login?next=${encodeURIComponent(next)}`}>I already have an account</Link>
            </Button>
          </>
        )}
      </div>
    </AuthShell>
  );
}

export default function InvitePage() {
  return (
    <React.Suspense>
      <InviteView />
    </React.Suspense>
  );
}
