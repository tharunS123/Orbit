'use client';

import * as React from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { AppError } from '@orbit/shared';
import { Toaster, TooltipProvider } from '@orbit/ui';
import { SessionProvider } from '@/lib/session';

export function Providers({ children }: { children: React.ReactNode }) {
  const [queryClient] = React.useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            staleTime: 30_000,
            retry: (count, error) => {
              const code = AppError.from(error).code;
              return count < 2 && !['unauthorized', 'forbidden', 'not_found', 'validation', 'plan_required', 'quota_exceeded'].includes(code);
            },
            refetchOnWindowFocus: true,
          },
        },
      }),
  );
  return (
    <QueryClientProvider client={queryClient}>
      <SessionProvider>
        <TooltipProvider delayDuration={400}>
          {children}
          <Toaster position="bottom-center" richColors={false} closeButton toastOptions={{ className: 'font-sans' }} />
        </TooltipProvider>
      </SessionProvider>
    </QueryClientProvider>
  );
}
