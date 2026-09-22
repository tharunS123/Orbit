'use client';

import * as React from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import {
  Archive,
  ArchiveRestore,
  ChevronRight,
  CopyPlus,
  Download,
  Eye,
  EyeOff,
  FileText,
  ImagePlus,
  Link2,
  MoreHorizontal,
  Share2,
  Star,
  Trash2,
} from 'lucide-react';
import { routes, shareLinks } from '@orbit/shared';
import { canList, listAccess } from '@orbit/core';
import { isStarred, listPath, roleIn } from '@orbit/sync/client';
import {
  AvatarStack,
  Button,
  Checkbox,
  ConfirmDialog,
  Dialog,
  DialogContent,
  EmptyState,
  Field,
  Input,
  Menu,
  MenuContent,
  MenuItem,
  MenuSeparator,
  MenuSub,
  MenuSubContent,
  MenuSubTrigger,
  MenuTrigger,
  Tooltip,
  cn,
  toast,
} from '@orbit/ui';
import { DocumentEditor, type PresenceUser } from '@/features/editor/document-editor';
import { EmojiPicker } from '@/features/lists/emoji-picker';
import { ShareDialog } from '@/features/lists/share-dialog';
import { useShell } from '@/features/shell/app-shell';
import { AttachmentsSection } from '@/features/files/attachments';
import { apiFetch, downloadFromApi } from '@/lib/api';
import { publicEnv } from '@/lib/env';
import { useSignedImage } from '@/lib/images';
import { useTaskPanel } from '@/lib/nav';
import { useStoreQuery, useSync } from '@/lib/sync';
import { useUndo } from '@/lib/undo';
import { useWorkspace } from '@/lib/workspace';

function DuplicateDialog({ listId, title, open, onOpenChange }: { listId: string; title: string; open: boolean; onOpenChange: (o: boolean) => void }) {
  const { actions } = useSync();
  const { run } = useUndo();
  const router = useRouter();
  const [name, setName] = React.useState(`${title || 'Untitled list'} (copy)`);
  const [clearDates, setClearDates] = React.useState(false);
  const [clearAssignees, setClearAssignees] = React.useState(true);
  const [copyAttachments, setCopyAttachments] = React.useState(false);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent title="Duplicate list" description="Copies the list, its notes, tasks and sublists. Completed tasks start fresh." size="sm">
        <div className="flex flex-col gap-4">
          <Field label="Name" htmlFor="dup-name">
            <Input id="dup-name" value={name} onChange={(e) => setName(e.target.value)} />
          </Field>
          <label className="flex items-center gap-2 text-sm">
            <Checkbox checked={clearDates} onCheckedChange={(v) => setClearDates(v === true)} /> Clear due dates and repeats
          </label>
          <label className="flex items-center gap-2 text-sm">
            <Checkbox checked={clearAssignees} onCheckedChange={(v) => setClearAssignees(v === true)} /> Clear assignees
          </label>
          <label className="flex items-center gap-2 text-sm">
            <Checkbox checked={copyAttachments} onCheckedChange={(v) => setCopyAttachments(v === true)} /> Copy attachments (uses storage)
          </label>
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button
              variant="primary"
              onClick={() => {
                const res = run(null, () => actions.duplicateList(listId, { title: name, clearDates, clearAssignees, copyAttachments })) as { id: string } | undefined;
                onOpenChange(false);
                if (res?.id) router.push(routes.list(res.id));
              }}
            >
              Duplicate
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function Cover({ path, onRemove, editable }: { path: string; onRemove: () => void; editable: boolean }) {
  const url = useSignedImage(path);
  return (
    <div className="group/cover relative h-40 w-full overflow-hidden bg-surface-sunken sm:h-52">
      {url ? (
        <img src={url} alt="" className="size-full object-cover" />
      ) : null}
      {editable ? (
        <Button size="xs" variant="secondary" className="absolute right-4 bottom-3 opacity-0 group-hover/cover:opacity-100" onClick={onRemove}>
          Remove cover
        </Button>
      ) : null}
    </div>
  );
}

function ListView() {
  const params = useSearchParams();
  const router = useRouter();
  const listId = params.get('id') ?? '';
  const isNew = params.get('new') === '1';
  const { client, actions, userId } = useSync();
  const { run } = useUndo();
  const { setWorkspace, workspaceId } = useWorkspace();
  const { openSidebar, desktop, sidebarCollapsed } = useShell();
  const panel = useTaskPanel();
  const list = useStoreQuery(['lists'], (s) => s.get('lists', listId), [listId]);
  const path = useStoreQuery(['lists'], (s) => listPath(s, listId), [listId]);
  const starred = useStoreQuery(['sectionItems'], (s) => isStarred(s, userId, listId), [listId, userId]);
  const role = useStoreQuery(['workspaceMembers'], (s) => (list ? roleIn(s, userId, list.workspaceId) : null), [list?.workspaceId, userId]);
  const membership = useStoreQuery(['listMembers'], (s) => s.all('listMembers').find((m) => m.listId === listId && m.userId === userId && !m.deletedAt) ?? null, [listId]);
  const counts = useStoreQuery(['tasks'], (s) => {
    const tasks = s.all('tasks').filter((t) => t.listId === listId && !t.deletedAt);
    return { open: tasks.filter((t) => !t.completedAt).length, done: tasks.filter((t) => t.completedAt).length };
  }, [listId]);
  const [title, setTitle] = React.useState(list?.title ?? '');
  const [share, setShare] = React.useState(false);
  const [dup, setDup] = React.useState(false);
  const [confirmDelete, setConfirmDelete] = React.useState(false);
  const [presence, setPresence] = React.useState<PresenceUser[]>([]);
  const [hideCompleted, setHideCompleted] = React.useState(false);
  const coverInput = React.useRef<HTMLInputElement>(null);

  React.useEffect(() => {
    try {
      setHideCompleted(localStorage.getItem(`orbit.hideCompleted.${listId}`) === '1');
    } catch {
      /* ignore */
    }
  }, [listId]);
  React.useEffect(() => {
    if (list && document.activeElement?.id !== 'list-title') setTitle(list.title);
  }, [list?.title]); // eslint-disable-line react-hooks/exhaustive-deps
  React.useEffect(() => {
    if (list && list.workspaceId !== workspaceId) setWorkspace(list.workspaceId);
  }, [list?.workspaceId]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!list || list.deletedAt) {
    return (
      <EmptyState
        className="mt-24"
        icon={<FileText />}
        title={list?.deletedAt ? 'This list was deleted' : 'List not found'}
        description={list?.deletedAt ? 'Restore it from Settings → Data → Trash within 30 days.' : 'It may have been deleted, or you no longer have access.'}
        action={
          list?.deletedAt ? (
            <Button variant="primary" onClick={() => client.mutate('list.restore', { id: list.id })}>
              Restore list
            </Button>
          ) : (
            <Button asChild variant="secondary">
              <Link href={routes.inbox()}>Go to Inbox</Link>
            </Button>
          )
        }
      />
    );
  }

  const access = listAccess({ userId, role, list, membership });
  const canEdit = canList(access, role, 'edit');
  const canDelete = canList(access, role, 'delete');
  const saveTitle = () => title.trim() !== list.title && client.mutate('list.update', { id: list.id, patch: { title: title.trim() } });
  const toggleHide = () => {
    const next = !hideCompleted;
    setHideCompleted(next);
    try {
      localStorage.setItem(`orbit.hideCompleted.${listId}`, next ? '1' : '0');
    } catch {
      /* ignore */
    }
  };
  const uploadCover = async (file: File) => {
    try {
      const { uploadUrl, path: p } = await apiFetch<{ uploadUrl: string; path: string }>('/uploads/image-url', { method: 'POST', body: { kind: 'cover', listId: list.id, mimeType: file.type, sizeBytes: file.size } });
      const res = await fetch(uploadUrl, { method: 'PUT', body: file, headers: { 'content-type': file.type } });
      if (!res.ok) throw new Error('upload failed');
      client.mutate('list.update', { id: list.id, patch: { coverPath: p } });
    } catch {
      toast.error('Couldn’t upload the cover image.');
    }
  };

  return (
    <div className="min-h-full">
      {list.coverPath ? <Cover path={list.coverPath} editable={canEdit} onRemove={() => client.mutate('list.update', { id: list.id, patch: { coverPath: null } })} /> : null}
      <div className={cn('sticky top-0 z-20 flex h-12 items-center gap-1 bg-bg/90 px-3 backdrop-blur-md sm:px-6', desktop && sidebarCollapsed && 'pl-12')}>
        {!desktop ? (
          <Button variant="ghost" size="sm" onClick={openSidebar} aria-label="Open navigation">
            Lists
          </Button>
        ) : null}
        <nav aria-label="Breadcrumb" className="flex min-w-0 flex-1 items-center gap-1 text-[13px] text-fg-muted">
          {path.slice(0, -1).map((p) => (
            <React.Fragment key={p.id}>
              <Link href={routes.list(p.id)} className="truncate hover:text-fg">
                {p.emoji ? `${p.emoji} ` : ''}
                {p.title || 'Untitled list'}
              </Link>
              <ChevronRight className="size-3 shrink-0" aria-hidden />
            </React.Fragment>
          ))}
          <span className="truncate text-fg">{list.title || 'Untitled list'}</span>
          {list.archivedAt ? <span className="ml-2 rounded-full bg-warning-subtle px-2 py-0.5 text-[11px]">Archived</span> : null}
        </nav>
        {presence.length ? (
          <Tooltip content={`${presence.map((p) => p.name).join(', ')} ${presence.length > 1 ? 'are' : 'is'} here`}>
            <span>
              <AvatarStack people={presence.map((p) => ({ id: String(p.clientId), name: p.name }))} size={24} />
            </span>
          </Tooltip>
        ) : null}
        <Tooltip content={starred ? 'Unstar' : 'Star — pin to sidebar'}>
          <Button variant="ghost" size="icon-sm" aria-pressed={starred} aria-label={starred ? 'Unstar list' : 'Star list'} onClick={() => run(null, () => (starred ? actions.unstar(list.id) : actions.star(list.id)), { toast: false })}>
            <Star className={cn(starred && 'fill-warning text-warning')} />
          </Button>
        </Tooltip>
        <Button variant="ghost" size="sm" onClick={() => setShare(true)}>
          <Share2 /> Share
        </Button>
        <Menu>
          <MenuTrigger asChild>
            <Button variant="ghost" size="icon-sm" aria-label="List options">
              <MoreHorizontal />
            </Button>
          </MenuTrigger>
          <MenuContent align="end">
            <MenuItem onSelect={toggleHide}>
              {hideCompleted ? <Eye /> : <EyeOff />} {hideCompleted ? 'Show completed tasks' : 'Hide completed tasks'}
            </MenuItem>
            {canEdit ? (
              <MenuItem onSelect={() => coverInput.current?.click()}>
                <ImagePlus /> {list.coverPath ? 'Change cover' : 'Add cover'}
              </MenuItem>
            ) : null}
            <MenuItem onSelect={() => setDup(true)}>
              <CopyPlus /> Duplicate…
            </MenuItem>
            <MenuItem onSelect={() => void navigator.clipboard.writeText(shareLinks.list(publicEnv.appUrl || window.location.origin, list.id)).then(() => toast.success('Link copied'))}>
              <Link2 /> Copy link
            </MenuItem>
            <MenuSub>
              <MenuSubTrigger>
                <Download /> Export
              </MenuSubTrigger>
              <MenuSubContent>
                {(['md', 'txt', 'csv', 'json'] as const).map((f) => (
                  <MenuItem key={f} onSelect={() => void downloadFromApi(`/lists/${list.id}/export?format=${f}`).catch(() => toast.error('Export needs a connection.'))}>
                    {f === 'md' ? 'Markdown' : f === 'txt' ? 'Plain text' : f.toUpperCase()}
                  </MenuItem>
                ))}
              </MenuSubContent>
            </MenuSub>
            {canDelete ? (
              <>
                <MenuSeparator />
                <MenuItem onSelect={() => run(null, () => actions.archiveList(list.id, !list.archivedAt))}>
                  {list.archivedAt ? <ArchiveRestore /> : <Archive />} {list.archivedAt ? 'Unarchive' : 'Archive'}
                </MenuItem>
                <MenuItem danger onSelect={() => setConfirmDelete(true)}>
                  <Trash2 /> Delete list
                </MenuItem>
              </>
            ) : null}
          </MenuContent>
        </Menu>
        <input ref={coverInput} type="file" accept="image/png,image/jpeg,image/webp,image/gif" className="hidden" onChange={(e) => e.target.files?.[0] && void uploadCover(e.target.files[0])} />
      </div>

      <div className="mx-auto max-w-3xl px-6 pb-24 sm:px-12">
        <div className={cn('flex items-start gap-3', list.coverPath ? 'mt-2' : 'mt-8')}>
          <EmojiPicker value={list.emoji} onChange={(emoji) => canEdit && client.mutate('list.update', { id: list.id, patch: { emoji } })}>
            <button type="button" disabled={!canEdit} aria-label={list.emoji ? `Icon ${list.emoji}. Change icon` : 'Add icon'} className="mt-0.5 grid size-11 shrink-0 place-items-center rounded-lg text-3xl hover:bg-bg-hover">
              {list.emoji ?? <FileText className="size-7 text-fg-subtle" />}
            </button>
          </EmojiPicker>
          <input
            id="list-title"
            value={title}
            autoFocus={isNew}
            readOnly={!canEdit}
            placeholder="Untitled list"
            aria-label="List title"
            onChange={(e) => setTitle(e.target.value)}
            onBlur={saveTitle}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                saveTitle();
                (document.querySelector('.orbit-editor .ProseMirror') as HTMLElement | null)?.focus();
                if (isNew) router.replace(routes.list(list.id));
              }
            }}
            className="min-w-0 flex-1 bg-transparent text-3xl font-bold tracking-tight outline-none placeholder:text-fg-subtle sm:text-4xl"
          />
        </div>
        <p className="mt-2 mb-4 pl-14 text-xs text-fg-subtle">
          {counts.open} open · {counts.done} done
          {!canEdit ? ' · View only' : ''}
        </p>
        <DocumentEditor
          docName={`list:${list.id}`}
          workspaceId={list.workspaceId}
          context={{ kind: 'list', listId: list.id }}
          readOnly={!canEdit}
          hideCompleted={hideCompleted}
          onOpenTask={panel.open}
          onPresence={setPresence}
          placeholder="Write notes, or type [] to add a task. Type / for headings, images, sublists…"
        />
        <div className="mt-10">
          <AttachmentsSection target={{ workspaceId: list.workspaceId, listId: list.id }} title="List files" />
        </div>
      </div>
      <ShareDialog list={list} open={share} onOpenChange={setShare} />
      <DuplicateDialog listId={list.id} title={list.title} open={dup} onOpenChange={setDup} />
      <ConfirmDialog
        open={confirmDelete}
        onOpenChange={setConfirmDelete}
        destructive
        title={`Delete “${list.title || 'Untitled list'}”?`}
        description="The list, its sublists and tasks move to Trash for 30 days, then are permanently deleted. Collaborators lose access immediately."
        confirmLabel="Delete list"
        onConfirm={() => {
          run(null, () => actions.deleteList(list.id));
          router.push(routes.inbox());
        }}
      />
    </div>
  );
}

export default function ListPage() {
  return (
    <React.Suspense>
      <ListView />
    </React.Suspense>
  );
}
