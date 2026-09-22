'use client';

import * as React from 'react';
import { Download, FileArchive, FileAudio, FileImage, FileText, FileVideo, MoreHorizontal, Paperclip, Pencil, RefreshCw, RotateCcw, Trash2, Upload, X } from 'lucide-react';
import type { Attachment } from '@orbit/shared';
import { formatBytes } from '@orbit/core';
import { Button, ConfirmDialog, Dialog, DialogContent, Input, Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger, Spinner, cn, toast } from '@orbit/ui';
import { apiFetch } from '@/lib/api';
import { useAttachmentUrl } from '@/lib/images';
import { useStoreQuery, useSync } from '@/lib/sync';
import { useUploads, type UploadTarget } from './uploads';

function iconFor(mime: string) {
  if (mime.startsWith('image/')) return FileImage;
  if (mime.startsWith('audio/')) return FileAudio;
  if (mime.startsWith('video/')) return FileVideo;
  if (/zip|tar|gzip|7z/.test(mime)) return FileArchive;
  return FileText;
}

async function download(att: Attachment) {
  try {
    const { url } = await apiFetch<{ url: string }>(`/attachments/${att.id}/url?download=1`);
    const a = document.createElement('a');
    a.href = url;
    a.download = att.name;
    a.rel = 'noopener';
    document.body.appendChild(a);
    a.click();
    a.remove();
  } catch {
    toast.error('Download failed. Please try again.');
  }
}

export function FilePreview({ attachment, open, onOpenChange }: { attachment: Attachment; open: boolean; onOpenChange: (o: boolean) => void }) {
  const { url, loading } = useAttachmentUrl(attachment.id, open);
  const mime = attachment.mimeType;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent title={attachment.name} description={formatBytes(attachment.sizeBytes)} size="xl">
        <div className="grid min-h-[50vh] place-items-center rounded-lg bg-surface-sunken">
          {loading || !url ? (
            <Spinner />
          ) : mime.startsWith('image/') ? (
            <img src={url} alt={attachment.name} className="max-h-[70vh] max-w-full rounded-md object-contain" />
          ) : mime === 'application/pdf' ? (
            <iframe src={url} title={attachment.name} className="h-[70vh] w-full rounded-md border-0" sandbox="allow-scripts allow-same-origin allow-downloads" />
          ) : mime.startsWith('audio/') ? (
            <audio src={url} controls className="w-full max-w-md" />
          ) : mime.startsWith('video/') ? (
            <video src={url} controls className="max-h-[70vh] max-w-full rounded-md" />
          ) : (
            <div className="flex flex-col items-center gap-3 text-sm text-fg-muted">
              <FileText className="size-10" aria-hidden />
              No preview for this file type.
            </div>
          )}
        </div>
        <div className="mt-4 flex justify-end">
          <Button variant="secondary" onClick={() => void download(attachment)}>
            <Download /> Download
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function AttachmentRow({ attachment }: { attachment: Attachment }) {
  const { client } = useSync();
  const { url } = useAttachmentUrl(attachment.id, attachment.mimeType.startsWith('image/'));
  const [preview, setPreview] = React.useState(false);
  const [confirmDelete, setConfirmDelete] = React.useState(false);
  const [renaming, setRenaming] = React.useState(false);
  const [name, setName] = React.useState(attachment.name);
  const replaceRef = React.useRef<HTMLInputElement>(null);
  const Icon = iconFor(attachment.mimeType);

  const replace = async (file: File) => {
    try {
      const { uploadUrl, storagePath } = await apiFetch<{ uploadUrl: string; storagePath: string }>(`/attachments/${attachment.id}/replace-url`, {
        method: 'POST',
        body: { name: file.name, mimeType: file.type || 'application/octet-stream', sizeBytes: file.size },
      });
      const res = await fetch(uploadUrl, { method: 'PUT', body: file, headers: { 'content-type': file.type || 'application/octet-stream' } });
      if (!res.ok) throw new Error(`Upload failed (${res.status})`);
      await apiFetch(`/attachments/${attachment.id}/replace-complete`, { method: 'POST', body: { storagePath, name: file.name, mimeType: file.type || 'application/octet-stream' } });
      toast.success('File replaced');
    } catch {
      toast.error('Couldn’t replace the file. Please try again.');
    }
  };

  return (
    <li className="group/file flex items-center gap-3 rounded-md px-2 py-1.5 hover:bg-bg-hover">
      <button type="button" onClick={() => setPreview(true)} className="grid size-10 shrink-0 place-items-center overflow-hidden rounded-md bg-surface-sunken" aria-label={`Preview ${attachment.name}`}>
        {url ? (
          <img src={url} alt="" className="size-full object-cover" />
        ) : (
          <Icon className="size-5 text-fg-muted" aria-hidden />
        )}
      </button>
      <div className="min-w-0 flex-1">
        {renaming ? (
          <Input
            autoFocus
            value={name}
            className="h-7"
            aria-label="File name"
            onChange={(e) => setName(e.target.value)}
            onBlur={() => {
              setRenaming(false);
              if (name.trim() && name !== attachment.name) client.mutate('attachment.rename', { id: attachment.id, name: name.trim() });
            }}
            onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
          />
        ) : (
          <button type="button" onClick={() => setPreview(true)} className="block max-w-full truncate text-left text-[13.5px] font-medium hover:underline">
            {attachment.name}
          </button>
        )}
        <p className="text-xs text-fg-subtle">{attachment.status === 'pending' ? 'Uploading…' : formatBytes(attachment.sizeBytes)}</p>
      </div>
      <Menu>
        <MenuTrigger asChild>
          <Button variant="ghost" size="icon-sm" aria-label={`Options for ${attachment.name}`} className="opacity-0 group-hover/file:opacity-100 focus-visible:opacity-100 max-sm:opacity-100">
            <MoreHorizontal />
          </Button>
        </MenuTrigger>
        <MenuContent align="end">
          <MenuItem onSelect={() => void download(attachment)}>
            <Download /> Download
          </MenuItem>
          <MenuItem onSelect={() => setRenaming(true)}>
            <Pencil /> Rename
          </MenuItem>
          <MenuItem onSelect={() => replaceRef.current?.click()}>
            <RefreshCw /> Replace…
          </MenuItem>
          <MenuSeparator />
          <MenuItem danger onSelect={() => setConfirmDelete(true)}>
            <Trash2 /> Delete
          </MenuItem>
        </MenuContent>
      </Menu>
      <input ref={replaceRef} type="file" className="hidden" onChange={(e) => e.target.files?.[0] && void replace(e.target.files[0])} />
      <FilePreview attachment={attachment} open={preview} onOpenChange={setPreview} />
      <ConfirmDialog
        open={confirmDelete}
        onOpenChange={setConfirmDelete}
        title={`Delete “${attachment.name}”?`}
        description="The file is removed for everyone with access. It is permanently purged after 30 days."
        confirmLabel="Delete file"
        destructive
        onConfirm={() => {
          client.mutate('attachment.delete', { ids: [attachment.id] });
          toast('File deleted');
        }}
      />
    </li>
  );
}

export function AttachmentsSection({ target, title = 'Files' }: { target: UploadTarget; title?: string }) {
  const uploads = useUploads();
  const inputRef = React.useRef<HTMLInputElement>(null);
  const [dragOver, setDragOver] = React.useState(false);
  const attachments = useStoreQuery(
    ['attachments'],
    (s) =>
      s
        .all('attachments')
        .filter((a) => !a.deletedAt && a.status === 'ready' && (target.taskId ? a.taskId === target.taskId : a.listId === target.listId && !a.taskId))
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
    [target.taskId, target.listId],
  );
  const pending = uploads.items.filter((i) => (target.taskId ? i.target.taskId === target.taskId : i.target.listId === target.listId) && i.status !== 'done');
  return (
    <section
      aria-label={title}
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes('Files')) {
          e.preventDefault();
          setDragOver(true);
        }
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDragOver(false);
        if (e.dataTransfer.files.length) void uploads.upload(e.dataTransfer.files, target);
      }}
      className={cn('rounded-lg transition-colors', dragOver && 'bg-accent-subtle/50 ring-2 ring-accent/40')}
    >
      <div className="flex items-center justify-between">
        <h3 className="flex items-center gap-1.5 text-[13px] font-semibold text-fg-muted">
          <Paperclip className="size-3.5" aria-hidden /> {title}
          {attachments.length ? <span className="font-normal text-fg-subtle">{attachments.length}</span> : null}
        </h3>
        <Button variant="ghost" size="xs" onClick={() => inputRef.current?.click()}>
          <Upload /> Add files
        </Button>
        <input ref={inputRef} type="file" multiple className="hidden" onChange={(e) => e.target.files && (void uploads.upload(e.target.files, target), (e.target.value = ''))} />
      </div>
      {attachments.length || pending.length ? (
        <ul className="mt-1 flex flex-col">
          {attachments.map((a) => (
            <AttachmentRow key={a.id} attachment={a} />
          ))}
          {pending.map((p) => (
            <li key={p.id} className="flex items-center gap-3 px-2 py-1.5">
              <div className="grid size-10 place-items-center rounded-md bg-surface-sunken">
                {p.status === 'error' ? <X className="size-4 text-danger" /> : <Spinner />}
              </div>
              <div className="min-w-0 flex-1">
                <p className="truncate text-[13.5px]">{p.file.name}</p>
                {p.status === 'error' ? (
                  <p className="text-xs text-danger">{p.error}</p>
                ) : p.status === 'cancelled' ? (
                  <p className="text-xs text-fg-subtle">Cancelled</p>
                ) : (
                  <div className="mt-1 h-1 overflow-hidden rounded-full bg-bg-active" role="progressbar" aria-valuenow={Math.round(p.progress * 100)} aria-valuemin={0} aria-valuemax={100} aria-label={`Uploading ${p.file.name}`}>
                    <div className="h-full bg-accent transition-[width]" style={{ width: `${Math.round(p.progress * 100)}%` }} />
                  </div>
                )}
              </div>
              {p.status === 'uploading' ? (
                <Button variant="ghost" size="icon-sm" aria-label="Cancel upload" onClick={() => uploads.cancel(p.id)}>
                  <X />
                </Button>
              ) : p.status === 'error' || p.status === 'cancelled' ? (
                <>
                  <Button variant="ghost" size="icon-sm" aria-label="Retry upload" onClick={() => uploads.retry(p.id)}>
                    <RotateCcw />
                  </Button>
                  <Button variant="ghost" size="icon-sm" aria-label="Dismiss" onClick={() => uploads.dismiss(p.id)}>
                    <X />
                  </Button>
                </>
              ) : null}
            </li>
          ))}
        </ul>
      ) : (
        <button type="button" onClick={() => inputRef.current?.click()} className="mt-1 w-full rounded-md border border-dashed border-border px-3 py-3 text-left text-xs text-fg-subtle hover:border-border-strong hover:text-fg-muted">
          Drop files here or click to upload
        </button>
      )}
    </section>
  );
}
