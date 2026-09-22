'use client';

import * as React from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';

/** Open a task in the detail panel on top of the current view (?task=<id>). */
export function useTaskPanel() {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const taskId = params.get('task');
  const open = React.useCallback(
    (id: string) => {
      const next = new URLSearchParams(params.toString());
      next.set('task', id);
      router.push(`${pathname}?${next.toString()}`, { scroll: false });
    },
    [params, pathname, router],
  );
  const close = React.useCallback(() => {
    const next = new URLSearchParams(params.toString());
    next.delete('task');
    const qs = next.toString();
    router.push(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
  }, [params, pathname, router]);
  return { taskId, open, close };
}
