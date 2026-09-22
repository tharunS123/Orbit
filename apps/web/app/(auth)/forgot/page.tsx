'use client';

import * as React from 'react';
import Link from 'next/link';
import { Button, Field, Input } from '@orbit/ui';
import { AuthShell, friendlyAuthError } from '@/features/auth/auth-ui';
import { supabase } from '@/lib/supabase';
import { authRedirectUrl } from '@/lib/platform';
import { publicEnv } from '@/lib/env';

export default function ForgotPage() {
  const [email, setEmail] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const [sent, setSent] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const { error: err } = await supabase().auth.resetPasswordForEmail(email.trim(), { redirectTo: `${authRedirectUrl(publicEnv.appUrl)}?next=/reset` });
    setBusy(false);
    // Don't reveal whether the address exists: show the same confirmation either way.
    if (err && !/not found/i.test(err.message)) setError(friendlyAuthError(err.message));
    else setSent(true);
  };
  return (
    <AuthShell
      title={sent ? 'Check your email' : 'Reset your password'}
      subtitle={sent ? <>If an account exists for <b>{email}</b>, a reset link is on its way.</> : 'We’ll email you a link to choose a new password.'}
      footer={
        <Link className="font-medium text-accent hover:underline" href="/login">
          Back to sign in
        </Link>
      }
    >
      {sent ? null : (
        <form onSubmit={submit} className="flex flex-col gap-4">
          <Field label="Email" htmlFor="email">
            <Input id="email" type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
          </Field>
          {error ? (
            <p className="text-sm text-danger" role="alert">
              {error}
            </p>
          ) : null}
          <Button type="submit" variant="primary" size="lg" loading={busy} disabled={!email}>
            Send reset link
          </Button>
        </form>
      )}
    </AuthShell>
  );
}
