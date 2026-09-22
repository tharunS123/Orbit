'use client';

import * as React from 'react';
import { AppError, describeError, uuidv7 } from '@orbit/shared';
import { toast } from '@orbit/ui';
import { apiFetch } from '@/lib/api';

/**
 * Upload manager: signed-URL uploads with progress, cancel and retry. The attachment row is
 * created (pending) by the API before the upload starts and marked ready afterwards, so a failed
 * upload never shows up as a broken file for collaborators.
 */

export interface UploadTarget {
  workspaceId: string;
  taskId?: string | null;
  listId?: string | null;
  messageId?: string | null;
}

export interface UploadItem {
  id: string;
  file: File;
  target: UploadTarget;
  progress: number;
  status: 'uploading' | 'processing' | 'done' | 'error' | 'cancelled';
  error?: string;
  xhr?: XMLHttpRequest;
}

interface UploadsApi {
  items: UploadItem[];
  upload: (files: File[] | FileList, target: UploadTarget) => Promise<string[]>;
  cancel: (id: string) => void;
  retry: (id: string) => void;
  dismiss: (id: string) => void;
}

const Ctx = React.createContext<UploadsApi | null>(null);

async function imageSize(file: File): Promise<{ width: number | null; height: number | null }> {
  if (!file.type.startsWith('image/') || file.type === 'image/svg+xml') return { width: null, height: null };
  try {
    const bmp = await createImageBitmap(file);
    const out = { width: bmp.width, height: bmp.height };
    bmp.close();
    return out;
  } catch {
    return { width: null, height: null };
  }
}

function put(url: string, file: File, onProgress: (p: number) => void, register: (xhr: XMLHttpRequest) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    register(xhr);
    xhr.open('PUT', url);
    xhr.setRequestHeader('content-type', file.type || 'application/octet-stream');
    xhr.setRequestHeader('x-upsert', 'false');
    xhr.upload.onprogress = (e) => e.lengthComputable && onProgress(e.loaded / e.total);
    xhr.onload = () => (xhr.status >= 200 && xhr.status < 300 ? resolve() : reject(new AppError('unavailable', `Upload failed (${xhr.status}).`)));
    xhr.onerror = () => reject(new AppError('network', 'Upload interrupted. Check your connection and retry.'));
    xhr.onabort = () => reject(new AppError('timeout', 'Upload cancelled.'));
    xhr.send(file);
  });
}

export function UploadsProvider({ children }: { children: React.ReactNode }) {
  const [items, setItems] = React.useState<UploadItem[]>([]);
  const update = (id: string, patch: Partial<UploadItem>) => setItems((prev) => prev.map((i) => (i.id === id ? { ...i, ...patch } : i)));

  const runOne = React.useCallback(async (item: UploadItem) => {
    try {
      update(item.id, { status: 'uploading', progress: 0, error: undefined });
      const { uploadUrl } = await apiFetch<{ uploadUrl: string }>('/attachments/upload-url', {
        method: 'POST',
        body: {
          id: item.id,
          workspaceId: item.target.workspaceId,
          taskId: item.target.taskId ?? null,
          listId: item.target.listId ?? null,
          messageId: item.target.messageId ?? null,
          name: item.file.name,
          mimeType: item.file.type || 'application/octet-stream',
          sizeBytes: item.file.size,
        },
      });
      await put(uploadUrl, item.file, (p) => update(item.id, { progress: p }), (xhr) => update(item.id, { xhr }));
      update(item.id, { status: 'processing', progress: 1 });
      await apiFetch(`/attachments/${item.id}/complete`, { method: 'POST', body: await imageSize(item.file) });
      update(item.id, { status: 'done' });
      setTimeout(() => setItems((prev) => prev.filter((i) => i.id !== item.id)), 1500);
    } catch (error) {
      const err = AppError.from(error);
      if (err.message === 'Upload cancelled.') return update(item.id, { status: 'cancelled' });
      update(item.id, { status: 'error', error: describeError(err) });
      toast.error(`Couldn’t upload ${item.file.name}`, { description: describeError(err) });
    }
  }, []);

  const api = React.useMemo<UploadsApi>(
    () => ({
      items,
      upload: async (files, target) => {
        const list = Array.from(files).map<UploadItem>((file) => ({ id: uuidv7(), file, target, progress: 0, status: 'uploading' }));
        setItems((prev) => [...prev, ...list]);
        await Promise.all(list.map(runOne));
        return list.map((i) => i.id);
      },
      cancel: (id) => {
        const item = items.find((i) => i.id === id);
        item?.xhr?.abort();
        update(id, { status: 'cancelled' });
      },
      retry: (id) => {
        const item = items.find((i) => i.id === id);
        if (item) void runOne({ ...item, id: uuidv7() }).then(() => setItems((prev) => prev.filter((i) => i.id !== id)));
      },
      dismiss: (id) => setItems((prev) => prev.filter((i) => i.id !== id)),
    }),
    [items, runOne],
  );
  return <Ctx.Provider value={api}>{children}</Ctx.Provider>;
}

export function useUploads(): UploadsApi {
  const ctx = React.useContext(Ctx);
  if (!ctx) throw new Error('useUploads must be used inside UploadsProvider');
  return ctx;
}
