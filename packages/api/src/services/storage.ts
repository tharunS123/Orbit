import { AppError } from '@orbit/shared';

/**
 * Private object storage (Supabase Storage REST, service credentials, server-only). Clients never
 * get bucket access: the API authorizes each request and returns short-lived signed URLs.
 */
export interface StorageAdapter {
  signUpload(path: string): Promise<{ url: string; token: string }>;
  signDownload(path: string, expiresIn?: number, downloadName?: string): Promise<string>;
  remove(paths: string[]): Promise<void>;
  copy(from: string, to: string): Promise<void>;
  exists(path: string): Promise<{ size: number; mimeType: string } | null>;
  upload(path: string, body: Uint8Array | Blob, contentType: string): Promise<void>;
  download(path: string): Promise<Uint8Array>;
}

export function createSupabaseStorage(opts: { supabaseUrl: string; serviceKey: string; bucket: string; publicUrl?: string }): StorageAdapter {
  const base = `${opts.supabaseUrl.replace(/\/$/, '')}/storage/v1`;
  const publicBase = `${(opts.publicUrl ?? opts.supabaseUrl).replace(/\/$/, '')}/storage/v1`;
  const headers = { authorization: `Bearer ${opts.serviceKey}`, apikey: opts.serviceKey };
  const enc = (p: string) => p.split('/').map(encodeURIComponent).join('/');

  async function call(path: string, init: RequestInit): Promise<Response> {
    let res: Response;
    try {
      res = await fetch(`${base}${path}`, { ...init, headers: { ...headers, ...(init.headers ?? {}) } });
    } catch {
      throw new AppError('unavailable', 'File storage is unreachable. Please try again.');
    }
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      if (res.status === 404 || /not.?found/i.test(text)) throw new AppError('not_found', 'File not found.');
      if (res.status === 413) throw new AppError('quota_exceeded', 'This file is too large.');
      throw new AppError('unavailable', `Storage error (${res.status}).`);
    }
    return res;
  }

  return {
    async signUpload(path) {
      const res = await call(`/object/upload/sign/${opts.bucket}/${enc(path)}`, { method: 'POST' });
      const data = (await res.json()) as { url: string; token?: string };
      const token = data.token ?? new URL(`http://x${data.url}`).searchParams.get('token') ?? '';
      return { url: `${publicBase}${data.url}`, token };
    },
    async signDownload(path, expiresIn = 300, downloadName) {
      const res = await call(`/object/sign/${opts.bucket}/${enc(path)}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ expiresIn }),
      });
      const data = (await res.json()) as { signedURL: string };
      const url = new URL(`${publicBase}${data.signedURL}`);
      if (downloadName) url.searchParams.set('download', downloadName);
      return url.toString();
    },
    async remove(paths) {
      if (!paths.length) return;
      await call(`/object/${opts.bucket}`, {
        method: 'DELETE',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ prefixes: paths }),
      });
    },
    async copy(from, to) {
      await call('/object/copy', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ bucketId: opts.bucket, sourceKey: from, destinationKey: to }),
      });
    },
    async exists(path) {
      try {
        const res = await call(`/object/info/${opts.bucket}/${enc(path)}`, { method: 'GET' });
        const info = (await res.json()) as { size?: number; content_type?: string; metadata?: { size?: number; mimetype?: string } };
        return { size: info.size ?? info.metadata?.size ?? 0, mimeType: info.content_type ?? info.metadata?.mimetype ?? 'application/octet-stream' };
      } catch (error) {
        if (error instanceof AppError && error.code === 'not_found') return null;
        throw error;
      }
    },
    async upload(path, body, contentType) {
      await call(`/object/${opts.bucket}/${enc(path)}`, {
        method: 'POST',
        headers: { 'content-type': contentType, 'x-upsert': 'true' },
        body: body as Blob,
      });
    },
    async download(path) {
      const res = await call(`/object/${opts.bucket}/${enc(path)}`, { method: 'GET' });
      return new Uint8Array(await res.arrayBuffer());
    },
  };
}

/** In-memory storage for tests. */
export function createMemoryStorage(): StorageAdapter & { objects: Map<string, { data: Uint8Array; type: string }> } {
  const objects = new Map<string, { data: Uint8Array; type: string }>();
  return {
    objects,
    async signUpload(path) {
      return { url: `memory://upload/${path}`, token: 't' };
    },
    async signDownload(path) {
      if (!objects.has(path)) throw new AppError('not_found', 'File not found.');
      return `memory://download/${path}`;
    },
    async remove(paths) {
      paths.forEach((p) => objects.delete(p));
    },
    async copy(from, to) {
      const o = objects.get(from);
      if (!o) throw new AppError('not_found', 'File not found.');
      objects.set(to, o);
    },
    async exists(path) {
      const o = objects.get(path);
      return o ? { size: o.data.byteLength, mimeType: o.type } : null;
    },
    async upload(path, body, type) {
      const data = body instanceof Uint8Array ? body : new Uint8Array(await body.arrayBuffer());
      objects.set(path, { data, type });
    },
    async download(path) {
      const o = objects.get(path);
      if (!o) throw new AppError('not_found', 'File not found.');
      return o.data;
    },
  };
}
