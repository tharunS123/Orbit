'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { Button, Field, Input } from '@orbit/ui';
import { AuthShell, friendlyAuthError } from '@/features/auth/auth-ui';
import { supabase } from '@/lib/supabase';
import { useSession } from '@/lib/session';

export default function ResetPage() {
  const router = useRouter();
  const { session, loading } = useSession();
  const [password, setPassword] = React.useState('');
  const [confirm, setConfirm] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (password.length < 8) return setError('Use at least 8 characters.');
    if (password !== confirm) return setError('Passwords don’t match.');
    setBusy(true);
    const { error: err } = await supabase().auth.updateUser({ password });
    setBusy(false);
    if (err) return setError(friendlyAuthError(err.message));
    // Sign out other devices after a password change.
    await supabase().auth.signOut({ scope: 'others' });
    router.replace('/inbox');
  };

  if (!loading && !session) {
    return (
      <AuthShell title="Link expired" subtitle="This reset link is invalid or has expired. Request a new one.">
        <Button variant="primary" className="w-full" onClick={() => router.push('/forgot')}>
          Request a new link
        </Button>
      </AuthShell>
    );
  }

  return (
    <AuthShell title="Choose a new password">
      <form onSubmit={submit} className="flex flex-col gap-4">
        <Field label="New password" htmlFor="password" hint="At least 8 characters.">
          <Input id="password" type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} />
        </Field>
        <Field label="Confirm password" htmlFor="confirm">
          <Input id="confirm" type="password" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} />
        </Field>
        {error ? (
          <p className="text-sm text-danger" role="alert">
            {error}
          </p>
        ) : null}
        <Button type="submit" variant="primary" size="lg" loading={busy}>
          Update password
        </Button>
      </form>
    </AuthShell>
  );
}
