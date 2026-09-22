import { getSchema, Node, type AnyExtension } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import Image from '@tiptap/extension-image';
import { prosemirrorJSONToYDoc, yDocToProsemirrorJSON } from '@tiptap/y-tiptap';
import * as Y from 'yjs';
import { markdownToBlocks, type PMNode } from './markdown-blocks';
import { DOC_FRAGMENT, LIST_REF, MEETING_REF, TASK_REF } from './ydoc';

/**
 * Headless document schema (no React, no DOM) matching the editor's. Used to build Yjs document
 * state from JSON/Markdown on the client (templates) and the server (MCP, AI, meeting notes).
 */

const atom = (name: string, attr: string) =>
  Node.create({ name, group: 'block', atom: true, addAttributes: () => ({ [attr]: { default: null } }), parseHTML: () => [{ tag: `div[data-type="${name}"]` }], renderHTML: () => ['div', { 'data-type': name }] });

const headlessExtensions: AnyExtension[] = [
  StarterKit.configure({ undoRedo: false }),
  Image.extend({ addAttributes() { return { ...this.parent?.(), attachmentId: { default: null }, width: { default: null } }; } }),
  atom(TASK_REF, 'taskId'),
  atom(LIST_REF, 'listId'),
  atom(MEETING_REF, 'meetingId'),
  Node.create({ name: 'attachment', group: 'block', atom: true, addAttributes: () => ({ attachmentId: { default: null }, name: { default: 'File' }, mimeType: { default: null } }), renderHTML: () => ['div'] }),
  Node.create({ name: 'callout', group: 'block', content: 'inline*', addAttributes: () => ({ emoji: { default: '💡' } }), renderHTML: () => ['div', 0] }),
];

let cached: ReturnType<typeof getSchema> | null = null;
export function documentSchema() {
  cached ??= getSchema(headlessExtensions);
  return cached;
}

/** Encode a ProseMirror JSON document as a Yjs update for the editor's fragment. */
export function jsonToYUpdate(content: PMNode[]): Uint8Array {
  const doc = prosemirrorJSONToYDoc(documentSchema(), { type: 'doc', content: content.length ? content : [{ type: 'paragraph' }] }, DOC_FRAGMENT);
  return Y.encodeStateAsUpdate(doc);
}

/** Append JSON blocks to an existing Yjs doc (merging through a temporary doc keeps CRDT semantics). */
export function appendJsonToDoc(target: Y.Doc, content: PMNode[]): void {
  const current = yDocToProsemirrorJSON(target, DOC_FRAGMENT) as { content?: PMNode[] };
  const existing = (current.content ?? []).filter((n) => !(n.type === 'paragraph' && !n.content?.length));
  const fragment = target.getXmlFragment(DOC_FRAGMENT);
  const fresh = prosemirrorJSONToYDoc(documentSchema(), { type: 'doc', content: [...existing, ...content] }, DOC_FRAGMENT);
  target.transact(() => {
    fragment.delete(0, fragment.length);
    const src = fresh.getXmlFragment(DOC_FRAGMENT);
    fragment.insert(0, src.toArray().map((n) => (n as Y.XmlElement).clone()));
  });
}

/**
 * Markdown → JSON nodes, creating tasks through `createTask` (which returns the new task id).
 * Nested task items become subtasks of the preceding top-level task.
 */
export function markdownToContent(markdown: string, createTask: (title: string, opts: { completed: boolean; parentId: string | null }) => string | null): PMNode[] {
  const nodes: PMNode[] = [];
  let lastTop: string | null = null;
  for (const b of markdownToBlocks(markdown)) {
    if (b.kind === 'node') {
      nodes.push(b.node);
      continue;
    }
    if (b.depth > 0 && lastTop) {
      createTask(b.title, { completed: b.completed, parentId: lastTop });
      continue;
    }
    const id = createTask(b.title, { completed: b.completed, parentId: null });
    if (id) {
      lastTop = id;
      nodes.push({ type: TASK_REF, attrs: { taskId: id } });
    }
  }
  return nodes;
}
