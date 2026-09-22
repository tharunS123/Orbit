'use client';

import * as React from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { PRODUCT, safeRedirectPath } from '@orbit/shared';
import { Button, Field, Input } from '@orbit/ui';
import { AuthShell, OAuthButtons, friendlyAuthError } from '@/features/auth/auth-ui';
import { supabase } from '@/lib/supabase';
import { authRedirectUrl } from '@/lib/platform';
import { publicEnv } from '@/lib/env';
import { detectTimeZone } from '@/lib/sync';

function SignupForm() {
  const router = useRouter();
  const params = useSearchParams();
  const next = safeRedirectPath(params.get('next'), '/onboarding');
  const [name, setName] = React.useState('');
  const [email, setEmail] = React.useState(params.get('email') ?? '');
  const [password, setPassword] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [confirmSent, setConfirmSent] = React.useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (password.length < 8) {
      setError('Use at least 8 characters for your password.');
      return;
    }
    setBusy(true);
    setError(null);
    const { data, error: err } = await supabase().auth.signUp({
      email: email.trim(),
      password,
      options: {
        data: { display_name: name.trim(), timezone: detectTimeZone() },
        emailRedirectTo: `${authRedirectUrl(publicEnv.appUrl)}?next=${encodeURIComponent(next)}`,
      },
    });
    setBusy(false);
    if (err) return setError(friendlyAuthError(err.message));
    if (data.session) router.replace(next);
    else setConfirmSent(true);
  };

  if (confirmSent) {
    return (
      <AuthShell title="Confirm your email" subtitle={<>We sent a confirmation link to <b>{email}</b>. Open it on this device to finish setting up.</>}>
        <Button asChild variant="secondary" className="w-full">
          <Link href="/login">Back to sign in</Link>
        </Button>
      </AuthShell>
    );
  }

  return (
    <AuthShell
      title={`Create your ${PRODUCT.name} account`}
      subtitle="Free forever for personal use. No credit card needed."
      footer={
        <>
          Already have an account?{' '}
          <Link className="font-medium text-accent hover:underline" href="/login">
            Sign in
          </Link>
        </>
      }
    >
      <OAuthButtons next={next} />
      <form onSubmit={submit} className="flex flex-col gap-4" noValidate>
        <Field label="Your name" htmlFor="name">
          <Input id="name" autoComplete="name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Alex Kim" />
        </Field>
        <Field label="Email" htmlFor="email">
          <Input id="email" type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@example.com" />
        </Field>
        <Field label="Password" htmlFor="password" hint="At least 8 characters.">
          <Input id="password" type="password" autoComplete="new-password" required minLength={8} value={password} onChange={(e) => setPassword(e.target.value)} />
        </Field>
        {error ? (
          <p className="text-sm text-danger" role="alert">
            {error}
          </p>
        ) : null}
        <Button type="submit" variant="primary" size="lg" loading={busy} disabled={!email || !password}>
          Create account
        </Button>
        <p className="text-center text-xs leading-relaxed text-fg-subtle">By continuing you agree to the Terms and acknowledge the Privacy Policy.</p>
      </form>
    </AuthShell>
  );
}

export default function SignupPage() {
  return (
    <React.Suspense>
      <SignupForm />
    </React.Suspense>
  );
}
