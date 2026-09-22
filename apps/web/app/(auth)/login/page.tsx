'use client';

import * as React from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Mail } from 'lucide-react';
import { safeRedirectPath } from '@orbit/shared';
import { Button, Field, Input } from '@orbit/ui';
import { AuthShell, OAuthButtons, friendlyAuthError } from '@/features/auth/auth-ui';
import { supabase } from '@/lib/supabase';
import { authRedirectUrl } from '@/lib/platform';
import { publicEnv } from '@/lib/env';
import { useSession } from '@/lib/session';

function LoginForm() {
  const router = useRouter();
  const params = useSearchParams();
  const next = safeRedirectPath(params.get('next'));
  const { session } = useSession();
  const [mode, setMode] = React.useState<'password' | 'magic'>('password');
  const [email, setEmail] = React.useState('');
  const [password, setPassword] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [sent, setSent] = React.useState(false);

  React.useEffect(() => {
    if (session) router.replace(next);
  }, [session, next, router]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    if (mode === 'password') {
      const { error: err } = await supabase().auth.signInWithPassword({ email: email.trim(), password });
      if (err) setError(friendlyAuthError(err.message));
      else router.replace(next);
    } else {
      const { error: err } = await supabase().auth.signInWithOtp({
        email: email.trim(),
        options: { emailRedirectTo: `${authRedirectUrl(publicEnv.appUrl)}?next=${encodeURIComponent(next)}`, shouldCreateUser: false },
      });
      if (err) setError(friendlyAuthError(err.message));
      else setSent(true);
    }
    setBusy(false);
  };

  if (sent) {
    return (
      <AuthShell title="Check your email" subtitle={<>We sent a sign-in link to <b>{email}</b>. It expires in one hour.</>}>
        <Button variant="secondary" className="w-full" onClick={() => setSent(false)}>
          Use a different email
        </Button>
      </AuthShell>
    );
  }

  return (
    <AuthShell
      title="Welcome back"
      subtitle="Sign in to pick up where you left off."
      footer={
        <>
          New here?{' '}
          <Link className="font-medium text-accent hover:underline" href={`/signup${next !== '/inbox' ? `?next=${encodeURIComponent(next)}` : ''}`}>
            Create an account
          </Link>
        </>
      }
    >
      <OAuthButtons next={next} />
      <form onSubmit={submit} className="flex flex-col gap-4" noValidate>
        <Field label="Email" htmlFor="email">
          <Input id="email" type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@example.com" />
        </Field>
        {mode === 'password' ? (
          <Field
            label={
              <span className="flex w-full items-center justify-between">
                Password
                <Link href="/forgot" className="text-xs font-normal text-accent hover:underline">
                  Forgot password?
                </Link>
              </span>
            }
            htmlFor="password"
          >
            <Input id="password" type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} />
          </Field>
        ) : null}
        {error ? (
          <p className="text-sm text-danger" role="alert">
            {error}
          </p>
        ) : null}
        <Button type="submit" variant="primary" size="lg" loading={busy} disabled={!email || (mode === 'password' && !password)}>
          {mode === 'password' ? 'Sign in' : 'Email me a sign-in link'}
        </Button>
        <Button type="button" variant="ghost" size="sm" onClick={() => setMode(mode === 'password' ? 'magic' : 'password')}>
          {mode === 'password' ? (
            <>
              <Mail /> Sign in with an email link instead
            </>
          ) : (
            'Use a password instead'
          )}
        </Button>
      </form>
    </AuthShell>
  );
}

export default function LoginPage() {
  return (
    <React.Suspense>
      <LoginForm />
    </React.Suspense>
  );
}
