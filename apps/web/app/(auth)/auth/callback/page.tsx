'use client';

import * as React from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { safeRedirectPath } from '@orbit/shared';
import { Button, Spinner } from '@orbit/ui';
import { AuthShell } from '@/features/auth/auth-ui';
import { supabase } from '@/lib/supabase';

/** Handles OAuth, magic-link, email-confirmation and password-recovery redirects (PKCE). */
function Callback() {
  const router = useRouter();
  const params = useSearchParams();
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    const next = safeRedirectPath(params.get('next'));
    const errDesc = params.get('error_description');
    if (errDesc) {
      setError(errDesc);
      return;
    }
    const code = params.get('code');
    const finish = async () => {
      const sb = supabase();
      if (code) {
        const { error: err } = await sb.auth.exchangeCodeForSession(code);
        if (err && !/already|used/i.test(err.message)) {
          setError(err.message);
          return;
        }
      }
      const { data } = await sb.auth.getSession();
      if (data.session) router.replace(next);
      else setError('This sign-in link is invalid or has expired.');
    };
    void finish();
  }, [params, router]);

  if (error) {
    return (
      <AuthShell title="We couldn’t sign you in" subtitle={error}>
        <Button variant="primary" className="w-full" onClick={() => router.replace('/login')}>
          Back to sign in
        </Button>
      </AuthShell>
    );
  }
  return (
    <main className="grid min-h-dvh place-items-center">
      <div className="flex items-center gap-2 text-sm text-fg-muted">
        <Spinner /> Signing you in…
      </div>
    </main>
  );
}

export default function CallbackPage() {
  return (
    <React.Suspense>
      <Callback />
    </React.Suspense>
  );
}
