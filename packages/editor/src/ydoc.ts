import * as Y from 'yjs';

/**
 * Server-safe helpers for the Yjs documents behind lists and task details. The Tiptap editor
 * stores ProseMirror content in the XmlFragment named `default`. Task rows are `taskRef` atom
 * nodes (attr `taskId`), sublists are `listRef` nodes (attr `listId`).
 */

export const DOC_FRAGMENT = 'default';
export const TASK_REF = 'taskRef';
export const LIST_REF = 'listRef';
export const MEETING_REF = 'meetingRef';

export type DocName = `list:${string}` | `task:${string}`;

export function parseDocName(name: string): { kind: 'list' | 'task'; id: string } | null {
  const m = /^(list|task):([0-9a-f-]{36})$/.exec(name);
  return m ? { kind: m[1] as 'list' | 'task', id: m[2]! } : null;
}

function walk(node: Y.XmlFragment | Y.XmlElement, fn: (el: Y.XmlElement, parent: Y.XmlFragment | Y.XmlElement, index: number) => void) {
  const children = node.toArray();
  children.forEach((child, index) => {
    if (child instanceof Y.XmlElement) {
      fn(child, node, index);
      walk(child, fn);
    }
  });
}

export function docFromState(state: Uint8Array | null | undefined): Y.Doc {
  const doc = new Y.Doc();
  if (state && state.length) Y.applyUpdate(doc, state);
  return doc;
}

/** Ordered task/list references in a document. */
export function extractRefs(doc: Y.Doc): { taskIds: string[]; listIds: string[] } {
  const taskIds: string[] = [];
  const listIds: string[] = [];
  walk(doc.getXmlFragment(DOC_FRAGMENT), (el) => {
    if (el.nodeName === TASK_REF) {
      const id = el.getAttribute('taskId');
      if (typeof id === 'string' && !taskIds.includes(id)) taskIds.push(id);
    } else if (el.nodeName === LIST_REF) {
      const id = el.getAttribute('listId');
      if (typeof id === 'string' && !listIds.includes(id)) listIds.push(id);
    }
  });
  return { taskIds, listIds };
}

const BLOCK_NODES = new Set([
  'paragraph',
  'heading',
  'blockquote',
  'codeBlock',
  'listItem',
  'callout',
]);

/** Plain text of prose blocks (refs excluded — their text lives in entities). For search/previews. */
export function toPlainText(doc: Y.Doc, maxLength = 200_000): string {
  const parts: string[] = [];
  let length = 0;
  const visit = (node: Y.XmlFragment | Y.XmlElement) => {
    for (const child of node.toArray()) {
      if (length > maxLength) return;
      if (child instanceof Y.XmlText) {
        const s = child.toString().replace(/<[^>]+>/g, '');
        parts.push(s);
        length += s.length;
      } else if (child instanceof Y.XmlElement) {
        if (child.nodeName === TASK_REF || child.nodeName === LIST_REF || child.nodeName === MEETING_REF) continue;
        visit(child);
        if (BLOCK_NODES.has(child.nodeName)) parts.push('\n');
      }
    }
  };
  visit(doc.getXmlFragment(DOC_FRAGMENT));
  return parts.join('').replace(/\n{3,}/g, '\n\n').trim().slice(0, maxLength);
}

/** Short preview (first non-empty lines) used on task rows ("has notes"). */
export function previewText(doc: Y.Doc, max = 280): string | null {
  const text = toPlainText(doc, 4000).replace(/\s+/g, ' ').trim();
  return text ? text.slice(0, max) : null;
}

/**
 * Rewrite ref ids using the maps (for duplication). Refs whose target was not copied are
 * removed. Returns the new encoded state.
 */
export function remapRefs(state: Uint8Array, taskIdMap: Record<string, string>, listIdMap: Record<string, string> = {}): Uint8Array {
  const doc = docFromState(state);
  const removals: { parent: Y.XmlFragment | Y.XmlElement; index: number }[] = [];
  doc.transact(() => {
    walk(doc.getXmlFragment(DOC_FRAGMENT), (el, parent, index) => {
      if (el.nodeName === TASK_REF) {
        const id = el.getAttribute('taskId');
        const mapped = typeof id === 'string' ? taskIdMap[id] : undefined;
        if (mapped) el.setAttribute('taskId', mapped);
        else removals.push({ parent, index });
      } else if (el.nodeName === LIST_REF) {
        const id = el.getAttribute('listId');
        const mapped = typeof id === 'string' ? listIdMap[id] : undefined;
        if (mapped) el.setAttribute('listId', mapped);
        else removals.push({ parent, index });
      }
    });
    // Delete from the end so indices stay valid.
    for (const r of removals.reverse()) r.parent.delete(r.index, 1);
  });
  return Y.encodeStateAsUpdate(doc);
}

/** Append plain blocks to a document (server-side content insertion: MCP, AI, meetings). */
export type SimpleBlock =
  | { type: 'paragraph'; text: string }
  | { type: 'heading'; level: 1 | 2 | 3; text: string }
  | { type: 'bullet'; items: string[] }
  | { type: 'taskRef'; taskId: string }
  | { type: 'listRef'; listId: string }
  | { type: 'divider' };

function textElement(name: string, text: string, attrs: Record<string, string | number> = {}): Y.XmlElement {
  const el = new Y.XmlElement(name);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v as never);
  const t = new Y.XmlText();
  t.insert(0, text);
  el.insert(0, [t]);
  return el;
}

export function appendBlocks(doc: Y.Doc, blocks: SimpleBlock[]): void {
  const fragment = doc.getXmlFragment(DOC_FRAGMENT);
  const nodes: Y.XmlElement[] = [];
  for (const b of blocks) {
    switch (b.type) {
      case 'paragraph':
        nodes.push(textElement('paragraph', b.text));
        break;
      case 'heading':
        nodes.push(textElement('heading', b.text, { level: b.level }));
        break;
      case 'bullet': {
        const list = new Y.XmlElement('bulletList');
        list.insert(0, b.items.map((item) => {
          const li = new Y.XmlElement('listItem');
          li.insert(0, [textElement('paragraph', item)]);
          return li;
        }));
        nodes.push(list);
        break;
      }
      case 'taskRef': {
        const el = new Y.XmlElement(TASK_REF);
        el.setAttribute('taskId', b.taskId);
        nodes.push(el);
        break;
      }
      case 'listRef': {
        const el = new Y.XmlElement(LIST_REF);
        el.setAttribute('listId', b.listId);
        nodes.push(el);
        break;
      }
      case 'divider':
        nodes.push(new Y.XmlElement('horizontalRule'));
        break;
    }
  }
  doc.transact(() => fragment.insert(fragment.length, nodes));
}
