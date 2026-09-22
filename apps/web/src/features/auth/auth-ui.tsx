'use client';

import * as React from 'react';
import Link from 'next/link';
import { Button, Separator } from '@orbit/ui';
import { Logo } from '@/components/brand';
import { supabase } from '@/lib/supabase';
import { authRedirectUrl } from '@/lib/platform';
import { publicEnv } from '@/lib/env';

export function AuthShell({ title, subtitle, children, footer }: { title: string; subtitle?: React.ReactNode; children: React.ReactNode; footer?: React.ReactNode }) {
  return (
    <main className="flex min-h-dvh flex-col items-center justify-center bg-bg px-4 py-10">
      <Link href="/" className="mb-8" aria-label="Home">
        <Logo />
      </Link>
      <div className="w-full max-w-[400px] rounded-xl border border-border bg-surface p-6 shadow-sm sm:p-8">
        <h1 className="text-xl font-semibold tracking-tight">{title}</h1>
        {subtitle ? <p className="mt-1.5 text-sm text-fg-muted">{subtitle}</p> : null}
        <div className="mt-6">{children}</div>
      </div>
      {footer ? <div className="mt-6 text-sm text-fg-muted">{footer}</div> : null}
    </main>
  );
}

function GoogleIcon() {
  return (
    <svg viewBox="0 0 24 24" className="size-4" aria-hidden>
      <path fill="#EA4335" d="M12 10.2v3.9h5.5c-.2 1.3-1.6 3.9-5.5 3.9-3.3 0-6-2.7-6-6.1s2.7-6.1 6-6.1c1.9 0 3.1.8 3.8 1.5l2.6-2.5C16.8 3.3 14.6 2.4 12 2.4 6.8 2.4 2.6 6.6 2.6 11.9S6.8 21.4 12 21.4c6.9 0 9.2-4.8 9.2-7.3 0-.5-.1-.9-.1-1.3H12z" />
    </svg>
  );
}

function AppleIcon() {
  return (
    <svg viewBox="0 0 24 24" className="size-4 fill-current" aria-hidden>
      <path d="M16.4 12.6c0-2.6 2.1-3.8 2.2-3.9-1.2-1.8-3.1-2-3.7-2-1.6-.2-3.1.9-3.9.9-.8 0-2-.9-3.4-.9-1.7 0-3.3 1-4.2 2.6-1.8 3.1-.5 7.7 1.3 10.2.9 1.2 1.9 2.6 3.2 2.6 1.3-.1 1.8-.8 3.3-.8s2 .8 3.4.8c1.4 0 2.3-1.3 3.1-2.5 1-1.4 1.4-2.8 1.4-2.9-.1 0-2.7-1-2.7-4.1zM13.9 4.9c.7-.8 1.2-2 1-3.1-1 0-2.2.7-2.9 1.5-.6.7-1.2 1.9-1 3 1.1.1 2.2-.6 2.9-1.4z" />
    </svg>
  );
}

export function OAuthButtons({ next }: { next?: string }) {
  const [busy, setBusy] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const go = async (provider: 'google' | 'apple') => {
    setBusy(provider);
    setError(null);
    const redirectTo = `${authRedirectUrl(publicEnv.appUrl)}${next ? `?next=${encodeURIComponent(next)}` : ''}`;
    const { error: err } = await supabase().auth.signInWithOAuth({ provider, options: { redirectTo } });
    if (err) {
      setError(err.message.includes('not enabled') ? `${provider === 'google' ? 'Google' : 'Apple'} sign-in isn't configured on this server yet.` : err.message);
      setBusy(null);
    }
  };
  return (
    <div className="flex flex-col gap-2">
      <Button variant="secondary" size="lg" className="w-full" onClick={() => go('google')} loading={busy === 'google'}>
        {busy === 'google' ? null : <GoogleIcon />} Continue with Google
      </Button>
      <Button variant="secondary" size="lg" className="w-full" onClick={() => go('apple')} loading={busy === 'apple'}>
        {busy === 'apple' ? null : <AppleIcon />} Continue with Apple
      </Button>
      {error ? (
        <p className="text-center text-xs text-danger" role="alert">
          {error}
        </p>
      ) : null}
      <div className="my-3 flex items-center gap-3 text-xs text-fg-subtle">
        <Separator className="flex-1" /> or <Separator className="flex-1" />
      </div>
    </div>
  );
}

/** Map Supabase auth error messages to friendly copy. */
export function friendlyAuthError(message: string): string {
  if (/invalid login credentials/i.test(message)) return 'That email and password don’t match. Try again or reset your password.';
  if (/email not confirmed/i.test(message)) return 'Please confirm your email first — check your inbox for the link.';
  if (/already registered|already exists/i.test(message)) return 'An account with this email already exists. Try signing in.';
  if (/rate limit|too many/i.test(message)) return 'Too many attempts. Please wait a minute and try again.';
  if (/password should be/i.test(message)) return 'Please choose a longer password (at least 8 characters).';
  if (/network|fetch/i.test(message)) return 'Can’t reach the server. Check your connection and try again.';
  return message;
}
