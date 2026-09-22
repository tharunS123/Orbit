'use client';

import { useQuery } from '@tanstack/react-query';
import { apiFetch } from './api';

/** Short-lived signed URL for a private avatar/cover image path (cached by React Query). */
export function useSignedImage(path: string | null | undefined): string | null {
  const { data } = useQuery({
    queryKey: ['image', path],
    enabled: Boolean(path),
    staleTime: 25 * 60_000,
    gcTime: 60 * 60_000,
    queryFn: () => apiFetch<{ url: string }>(`/uploads/image?path=${encodeURIComponent(path!)}`).then((r) => r.url),
  });
  return data ?? null;
}

export function useAttachmentUrl(id: string | null | undefined, enabled = true): { url: string | null; loading: boolean; error: unknown } {
  const q = useQuery({
    queryKey: ['attachment-url', id],
    enabled: Boolean(id) && enabled,
    staleTime: 8 * 60_000,
    queryFn: () => apiFetch<{ url: string }>(`/attachments/${id}/url`).then((r) => r.url),
  });
  return { url: q.data ?? null, loading: q.isLoading, error: q.error };
}
