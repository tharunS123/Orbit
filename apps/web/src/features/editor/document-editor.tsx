'use client';

import * as React from 'react';
import { EditorContent, useEditor, type Editor } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import { Placeholder } from '@tiptap/extensions';
import Collaboration from '@tiptap/extension-collaboration';
import CollaborationCaret from '@tiptap/extension-collaboration-caret';
import DragHandle from '@tiptap/extension-drag-handle-react';
import { GripVertical } from 'lucide-react';
import {
  AttachmentNode,
  Callout,
  ListRef,
  MarkdownPaste,
  MeetingRef,
  OrbitImage,
  Reconcile,
  SlashCommand,
  TaskBehaviour,
  TaskRef,
  type OpenDocument,
  type SlashItem,
} from '@orbit/editor';
import { comparePositioned } from '@orbit/core';
import { Skeleton, cn } from '@orbit/ui';
import { useCollab } from '@/lib/collab';
import { useStoreQuery, useSync } from '@/lib/sync';
import { useWorkspace } from '@/lib/workspace';
import { useUploads } from '@/features/files/uploads';
import { AttachmentView, DocContext, ImageView, ListRefView, MeetingRefView, TaskRefView, requestTaskFocus } from './node-views';
import { renderSlashMenu } from './slash-menu';

export type DocEditorContext = { kind: 'list'; listId: string } | { kind: 'task'; taskId: string; listId: string | null };

export interface PresenceUser {
  clientId: number;
  name: string;
  color: string;
}

const CARET_COLORS = ['#e8590c', '#7048e8', '#0c8599', '#c2255c', '#2f9e44', '#1971c2', '#e67700', '#9c36b5'];

function colorFor(id: string) {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 33 + id.charCodeAt(i)) >>> 0;
  return CARET_COLORS[h % CARET_COLORS.length]!;
}

export interface DocumentEditorProps {
  docName: `list:${string}` | `task:${string}`;
  workspaceId: string;
  context: DocEditorContext;
  placeholder?: string;
  minimal?: boolean;
  readOnly?: boolean;
  hideCompleted?: boolean;
  onOpenTask: (id: string) => void;
  onPresence?: (users: PresenceUser[]) => void;
  onEditor?: (editor: Editor | null) => void;
  extraSlashItems?: SlashItem[];
  className?: string;
}

export function DocumentEditor(props: DocumentEditorProps) {
  const collab = useCollab();
  const [doc, setDoc] = React.useState<OpenDocument | null>(null);
  React.useEffect(() => {
    if (!collab) return;
    const d = collab.open(props.docName);
    let active = true;
    void d.localReady.then(() => active && setDoc(d));
    return () => {
      active = false;
      d.release();
      setDoc(null);
    };
  }, [collab, props.docName]);
  if (!doc) {
    return (
      <div className="flex flex-col gap-2 py-2" aria-busy>
        <Skeleton className="h-4 w-2/3" />
        <Skeleton className="h-4 w-1/2" />
      </div>
    );
  }
  return <EditorInner key={props.docName} {...props} doc={doc} />;
}

function EditorInner({ doc, docName, workspaceId, context, placeholder, minimal, readOnly: forcedReadOnly, hideCompleted, onOpenTask, onPresence, onEditor, extraSlashItems, className }: DocumentEditorProps & { doc: OpenDocument }) {
  const { actions, userId } = useSync();
  const { profile } = useWorkspace();
  const uploads = useUploads();
  const [synced, setSynced] = React.useState(doc.isSynced());
  React.useEffect(() => doc.onSynced(() => setSynced(true)), [doc]);
  const readOnly = Boolean(forcedReadOnly) || doc.readOnly();

  const ctxRef = React.useRef({ context, workspaceId });
  ctxRef.current = { context, workspaceId };

  const createTask = React.useCallback(
    (title: string, opts?: { completed?: boolean }) => {
      const { context: c, workspaceId: ws } = ctxRef.current;
      const res = actions.createTask({
        workspaceId: ws,
        text: title,
        parse: false,
        listId: c.kind === 'list' ? c.listId : null,
        parentTaskId: c.kind === 'task' ? c.taskId : null,
        inInbox: false,
      });
      if (opts?.completed) actions.setCompleted([res.id], true);
      return res.id;
    },
    [actions],
  );

  const insertFiles = React.useCallback(
    async (editor: Editor, files: File[], pos?: number) => {
      const { context: c, workspaceId: ws } = ctxRef.current;
      const target = c.kind === 'list' ? { workspaceId: ws, listId: c.listId } : { workspaceId: ws, taskId: c.taskId };
      const ids = await uploads.upload(files, target);
      const nodes = files.map((f, i) =>
        f.type.startsWith('image/') ? { type: 'image', attrs: { attachmentId: ids[i], alt: f.name } } : { type: 'attachment', attrs: { attachmentId: ids[i], name: f.name, mimeType: f.type } },
      );
      const chain = editor.chain().focus();
      if (pos !== undefined) chain.insertContentAt(pos, nodes).run();
      else chain.insertContent(nodes).run();
    },
    [uploads],
  );

  const pickFiles = (editor: Editor, accept: string) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = accept;
    input.multiple = true;
    input.onchange = () => input.files && void insertFiles(editor, Array.from(input.files));
    input.click();
  };

  const slashItems = React.useCallback(
    (query: string): SlashItem[] => {
      const q = query.toLowerCase();
      const all: SlashItem[] = [
        { id: 'task', title: 'Task', description: 'A checkbox you can schedule and assign', keywords: ['todo', 'check', '[]'], group: 'Basic', run: (e, r) => e.chain().focus().deleteRange(r).insertTask().run() },
        { id: 'h1', title: 'Heading 1', keywords: ['title', 'h1'], group: 'Basic', run: (e, r) => e.chain().focus().deleteRange(r).setNode('heading', { level: 1 }).run() },
        { id: 'h2', title: 'Heading 2', keywords: ['subtitle', 'h2'], group: 'Basic', run: (e, r) => e.chain().focus().deleteRange(r).setNode('heading', { level: 2 }).run() },
        { id: 'h3', title: 'Heading 3', keywords: ['h3'], group: 'Basic', run: (e, r) => e.chain().focus().deleteRange(r).setNode('heading', { level: 3 }).run() },
        { id: 'text', title: 'Text', keywords: ['paragraph', 'p'], group: 'Basic', run: (e, r) => e.chain().focus().deleteRange(r).setParagraph().run() },
        { id: 'bullet', title: 'Bulleted list', keywords: ['ul', 'list', '-'], group: 'Basic', run: (e, r) => e.chain().focus().deleteRange(r).toggleBulletList().run() },
        { id: 'numbered', title: 'Numbered list', keywords: ['ol', '1.'], group: 'Basic', run: (e, r) => e.chain().focus().deleteRange(r).toggleOrderedList().run() },
        { id: 'quote', title: 'Quote', keywords: ['blockquote', '>'], group: 'Basic', run: (e, r) => e.chain().focus().deleteRange(r).toggleBlockquote().run() },
        { id: 'divider', title: 'Divider', keywords: ['hr', 'line', '---'], group: 'Basic', run: (e, r) => e.chain().focus().deleteRange(r).setHorizontalRule().run() },
        { id: 'callout', title: 'Callout', description: 'Highlight something important', keywords: ['note', 'info'], group: 'Basic', run: (e, r) => e.chain().focus().deleteRange(r).setNode('callout').run() },
        { id: 'code', title: 'Code block', keywords: ['code', '```'], group: 'Basic', run: (e, r) => e.chain().focus().deleteRange(r).toggleCodeBlock().run() },
        { id: 'image', title: 'Image', description: 'Upload an image', keywords: ['photo', 'picture'], group: 'Media', run: (e, r) => (e.chain().focus().deleteRange(r).run(), pickFiles(e, 'image/*')) },
        { id: 'file', title: 'File', description: 'Attach a file', keywords: ['attachment', 'upload', 'pdf'], group: 'Media', run: (e, r) => (e.chain().focus().deleteRange(r).run(), pickFiles(e, '*/*')) },
        ...(context.kind === 'list'
          ? [
              {
                id: 'sublist',
                title: 'Sublist',
                description: 'A nested list inside this one',
                keywords: ['page', 'nested', 'list'],
                group: 'Structure',
                run: (e: Editor, r: { from: number; to: number }) => {
                  const res = actions.createList({ workspaceId: ctxRef.current.workspaceId, parentListId: (context as { listId: string }).listId, title: 'Untitled sublist', star: false });
                  e.chain().focus().deleteRange(r).insertContent({ type: 'listRef', attrs: { listId: res.id } }).run();
                },
              } satisfies SlashItem,
            ]
          : []),
        ...(extraSlashItems ?? []),
      ];
      return all.filter((i) => !q || i.title.toLowerCase().includes(q) || i.keywords?.some((k) => k.includes(q)) || i.id.includes(q)).slice(0, 20);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [context.kind, actions, extraSlashItems],
  );

  const editor = useEditor(
    {
      immediatelyRender: false,
      editable: !readOnly,
      extensions: [
        StarterKit.configure({ undoRedo: false, heading: { levels: [1, 2, 3] }, link: { openOnClick: false, autolink: true, protocols: ['http', 'https', 'mailto'] } }),
        Placeholder.configure({ placeholder: placeholder ?? 'Type / for blocks, [] for a task', showOnlyCurrent: true, includeChildren: false }),
        Collaboration.configure({ document: doc.ydoc, field: 'default' }),
        CollaborationCaret.configure({ provider: doc.provider, user: { name: profile?.displayName ?? 'Someone', color: colorFor(userId) } }),
        TaskRef.configure({ component: TaskRefView }),
        ListRef.configure({ component: ListRefView }),
        MeetingRef.configure({ component: MeetingRefView }),
        AttachmentNode.configure({ component: AttachmentView }),
        OrbitImage.configure({ component: ImageView }),
        Callout,
        TaskBehaviour.configure({ createTask, focusTask: requestTaskFocus }),
        MarkdownPaste.configure({ createTask }),
        Reconcile,
        SlashCommand.configure({ items: slashItems, render: renderSlashMenu }),
      ],
      editorProps: {
        attributes: {
          class: cn('orbit-prose outline-none', minimal ? 'min-h-10' : 'min-h-[40vh] pb-32'),
          'aria-label': context.kind === 'list' ? 'List content' : 'Task notes',
          role: 'textbox',
          'aria-multiline': 'true',
        },
        handleDrop: (view, event) => {
          const files = Array.from(event.dataTransfer?.files ?? []);
          if (!files.length) return false;
          event.preventDefault();
          const pos = view.posAtCoords({ left: event.clientX, top: event.clientY })?.pos;
          if (editorRef.current) void insertFiles(editorRef.current, files, pos);
          return true;
        },
        handlePaste: (_view, event) => {
          const files = Array.from(event.clipboardData?.files ?? []);
          if (!files.length) return false;
          if (editorRef.current) void insertFiles(editorRef.current, files);
          return true;
        },
      },
    },
    [doc, readOnly],
  );
  const editorRef = React.useRef<Editor | null>(null);
  editorRef.current = editor;
  React.useEffect(() => {
    onEditor?.(editor);
  }, [editor, onEditor]);

  // What should be referenced in this document, per the task store.
  const expected = useStoreQuery(
    ['tasks', 'lists'],
    (s) => {
      if (context.kind === 'list') {
        const taskIds = s
          .all('tasks')
          .filter((t) => t.listId === context.listId && t.parentTaskId === null && !t.deletedAt)
          .sort(comparePositioned)
          .map((t) => t.id);
        const listIds = s
          .all('lists')
          .filter((l) => l.parentListId === context.listId && !l.deletedAt)
          .sort(comparePositioned)
          .map((l) => l.id);
        return { taskIds, listIds, key: `${taskIds.join()}|${listIds.join()}` };
      }
      const taskIds = s
        .all('tasks')
        .filter((t) => t.parentTaskId === context.taskId && !t.deletedAt)
        .sort(comparePositioned)
        .map((t) => t.id);
      return { taskIds, listIds: [] as string[], key: taskIds.join() };
    },
    [context.kind, context.kind === 'list' ? context.listId : context.taskId],
  );

  const offline = typeof navigator !== 'undefined' && !navigator.onLine;
  React.useEffect(() => {
    if (!editor || readOnly || editor.isDestroyed) return;
    // Wait for the server copy so we never append into a not-yet-loaded document.
    if (!synced && !offline) return;
    const t = setTimeout(() => editor.commands.reconcileRefs({ taskIds: expected.taskIds, listIds: expected.listIds }), 50);
    return () => clearTimeout(t);
  }, [editor, expected.key, synced, offline, readOnly]); // eslint-disable-line react-hooks/exhaustive-deps

  // Presence (who else is here).
  React.useEffect(() => {
    if (!onPresence) return;
    const awareness = doc.provider.awareness;
    if (!awareness) return;
    const update = () => {
      const users: PresenceUser[] = [];
      awareness.getStates().forEach((state, clientId) => {
        const u = (state as { user?: { name: string; color: string } }).user;
        if (u && clientId !== awareness.clientID) users.push({ clientId, name: u.name, color: u.color });
      });
      onPresence(users);
    };
    awareness.on('change', update);
    update();
    return () => awareness.off('change', update);
  }, [doc, onPresence]);

  const docContext = React.useMemo(() => ({ onOpenTask, readOnly }), [onOpenTask, readOnly]);

  return (
    <DocContext.Provider value={docContext}>
      <div className={cn('orbit-editor relative', hideCompleted && 'hide-completed', className)} data-doc={docName}>
        {editor && !readOnly ? (
          <DragHandle editor={editor}>
            <div className="grid h-6 w-5 cursor-grab place-items-center rounded-xs text-fg-subtle hover:bg-bg-hover active:cursor-grabbing" aria-label="Drag block" title="Drag to move">
              <GripVertical className="size-4" />
            </div>
          </DragHandle>
        ) : null}
        <EditorContent editor={editor} />
      </div>
    </DocContext.Provider>
  );
}
