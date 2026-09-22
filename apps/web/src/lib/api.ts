'use client';

import { AppError, isAppErrorJSON } from '@orbit/shared';
import { publicEnv } from './env';
import { supabase } from './supabase';

/**
 * Typed fetch for /api. Adds the bearer token, maps failures to AppError (network → 'network'
 * so the UI can say "offline" instead of a raw error), and supports abort/timeouts.
 */

async function token(): Promise<string | null> {
  const { data } = await supabase().auth.getSession();
  const s = data.session;
  if (!s) return null;
  if (s.expires_at && s.expires_at * 1000 - Date.now() < 60_000) {
    const refreshed = await supabase().auth.refreshSession();
    return refreshed.data.session?.access_token ?? null;
  }
  return s.access_token;
}

export interface ApiOptions extends Omit<RequestInit, 'body'> {
  body?: unknown;
  timeoutMs?: number;
  anonymous?: boolean;
  raw?: boolean;
}

export function apiUrl(path: string): string {
  return `${publicEnv.apiUrl}/api${path}`;
}

export async function apiFetch<T = unknown>(path: string, opts: ApiOptions = {}): Promise<T> {
  const { body, timeoutMs = 30_000, anonymous, raw, headers, signal, ...rest } = opts;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  signal?.addEventListener('abort', () => controller.abort());
  const h = new Headers(headers);
  if (body !== undefined && !(body instanceof FormData) && !(body instanceof Blob)) h.set('content-type', 'application/json');
  if (!anonymous) {
    const t = await token();
    if (t) h.set('authorization', `Bearer ${t}`);
  }
  let res: Response;
  try {
    res = await fetch(apiUrl(path), {
      ...rest,
      headers: h,
      signal: controller.signal,
      body: body === undefined ? undefined : body instanceof FormData || body instanceof Blob ? body : JSON.stringify(body),
    });
  } catch (error) {
    if ((error as Error).name === 'AbortError') throw new AppError(signal?.aborted ? 'timeout' : 'timeout', 'The request timed out.');
    throw new AppError('network', "You're offline or the server is unreachable.");
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) {
    let payload: unknown;
    try {
      payload = await res.json();
    } catch {
      /* non-JSON error body */
      payload = null;
    }
    const err = (payload as { error?: unknown } | null)?.error;
    if (isAppErrorJSON(err)) throw new AppError(err.code, err.message, err.details);
    if (res.status >= 500 || res.status === 0) throw new AppError('unavailable', 'The server is having trouble. Please try again.');
    throw new AppError('internal', `Request failed (${res.status}).`);
  }
  if (raw) return res as unknown as T;
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

/** Download a file from the API (exports) and save it with the server-provided name. */
export async function downloadFromApi(path: string, init: ApiOptions = {}): Promise<void> {
  const res = await apiFetch<Response>(path, { ...init, raw: true, timeoutMs: 120_000 });
  const blob = await res.blob();
  const disposition = res.headers.get('content-disposition') ?? '';
  const name = /filename="([^"]+)"/.exec(disposition)?.[1] ?? 'download';
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
