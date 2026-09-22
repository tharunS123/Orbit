import { Extension, InputRule, Node, mergeAttributes, type Editor, type Range } from '@tiptap/core';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import type { Node as PMNodeType } from '@tiptap/pm/model';
import { ReactNodeViewRenderer, type ReactNodeViewProps } from '@tiptap/react';
import Image from '@tiptap/extension-image';
import Suggestion, { type SuggestionOptions } from '@tiptap/suggestion';
import type { ComponentType } from 'react';
import { LIST_REF, MEETING_REF, TASK_REF } from './ydoc';
import { looksLikeMarkdown, markdownToBlocks, type PMNode } from './markdown-blocks';

/**
 * Tiptap extensions for Orbit documents. The app supplies React node-view components and
 * callbacks (creating tasks, uploading files) through extension options, keeping the editor
 * package free of app state.
 */

export type NodeViewComponent = ComponentType<ReactNodeViewProps<HTMLElement>>;
type View = NodeViewComponent;

/** Let inputs/buttons inside atom node views handle their own events. */
const stopEventsInsideControls = ({ event }: { event: Event }) => {
  const t = event.target as HTMLElement | null;
  if (!t) return false;
  if (event.type === 'dragstart' || event.type === 'drop') return false;
  return Boolean(t.closest('input, textarea, button, [role="menu"], [data-node-control]'));
};

function refNode(name: string, attr: string, options: { component: View | null }) {
  return Node.create<{ component: View | null }>({
    name,
    group: 'block',
    atom: true,
    selectable: true,
    draggable: true,
    addOptions: () => options,
    addAttributes() {
      return {
        [attr]: {
          default: null,
          parseHTML: (el: HTMLElement) => el.getAttribute(`data-${attr.toLowerCase()}`),
          renderHTML: (attrs: Record<string, unknown>) => ({ [`data-${attr.toLowerCase()}`]: attrs[attr] }),
        },
      };
    },
    parseHTML() {
      return [{ tag: `div[data-type="${name}"]` }];
    },
    renderHTML({ HTMLAttributes }) {
      return ['div', mergeAttributes(HTMLAttributes, { 'data-type': name })];
    },
    addNodeView() {
      if (!this.options.component) return null as never;
      return ReactNodeViewRenderer(this.options.component, { stopEvent: stopEventsInsideControls });
    },
  });
}

export const TaskRef = refNode(TASK_REF, 'taskId', { component: null });
export const ListRef = refNode(LIST_REF, 'listId', { component: null });
export const MeetingRef = refNode(MEETING_REF, 'meetingId', { component: null });

export const AttachmentNode = Node.create<{ component: View | null }>({
  name: 'attachment',
  group: 'block',
  atom: true,
  draggable: true,
  addOptions: () => ({ component: null }),
  addAttributes: () => ({
    attachmentId: { default: null },
    name: { default: 'File' },
    mimeType: { default: 'application/octet-stream' },
  }),
  parseHTML: () => [{ tag: 'div[data-type="attachment"]' }],
  renderHTML: ({ HTMLAttributes }) => ['div', mergeAttributes(HTMLAttributes, { 'data-type': 'attachment' })],
  addNodeView() {
    if (!this.options.component) return null as never;
    return ReactNodeViewRenderer(this.options.component, { stopEvent: stopEventsInsideControls });
  },
});

/** Images stored as private attachments; the node view resolves a signed URL. */
export const OrbitImage = Image.extend<{ component: View | null } & Record<string, unknown>>({
  draggable: true,
  addOptions() {
    return { ...this.parent?.(), component: null, inline: false, allowBase64: false };
  },
  addAttributes() {
    return { ...this.parent?.(), attachmentId: { default: null }, width: { default: null } };
  },
  addNodeView() {
    const component = (this.options as { component: View | null }).component;
    if (!component) return null as never;
    return ReactNodeViewRenderer(component, { stopEvent: stopEventsInsideControls });
  },
});

export const Callout = Node.create({
  name: 'callout',
  group: 'block',
  content: 'inline*',
  defining: true,
  addAttributes: () => ({ emoji: { default: '💡' } }),
  parseHTML: () => [{ tag: 'div[data-type="callout"]' }],
  renderHTML: ({ HTMLAttributes, node }) => [
    'div',
    mergeAttributes(HTMLAttributes, { 'data-type': 'callout', class: 'orbit-callout' }),
    ['span', { class: 'orbit-callout-emoji', contenteditable: 'false' }, String(node.attrs.emoji)],
    ['div', { class: 'orbit-callout-body' }, 0],
  ],
});

// ───────────── Tasks inside documents ─────────────
export interface TaskBehaviourOptions {
  /** Create a task entity for this document context; returns its id. */
  createTask: (title: string, opts?: { completed?: boolean }) => string | null;
  /** Called after a taskRef was inserted so the node view can focus its title. */
  focusTask: (taskId: string) => void;
}


export const TaskBehaviour = Extension.create<TaskBehaviourOptions>({
  name: 'taskBehaviour',
  addOptions: () => ({ createTask: () => null, focusTask: () => undefined }),
  addInputRules() {
    const opts = this.options;
    return [
      // "[] " or "[ ] " or "- [ ] " at the start of an empty block creates a task.
      new InputRule({
        find: /^\s*(?:[-*]\s)?\[\s?\]\s$/,
        // Must modify the rule's own transaction (via `chain`), not dispatch a separate one.
        handler: ({ state, range, chain }) => {
          const $from = state.doc.resolve(range.from);
          if ($from.parent.type.name !== 'paragraph') return null;
          const id = opts.createTask('');
          if (!id) return null;
          chain()
            .insertContentAt({ from: $from.before(), to: $from.after() }, { type: TASK_REF, attrs: { taskId: id } })
            .run();
          opts.focusTask(id);
        },
      }),
    ];
  },
  addCommands() {
    return {
      /** Turn the current paragraph (with its text) into a task. */
      // Commands only modify the provided `tr`; Tiptap dispatches it.
      convertToTask:
        () =>
        ({ tr, dispatch }) => {
          const { $from } = tr.selection;
          const parent = $from.parent;
          if (parent.type.name !== 'paragraph' && parent.type.name !== 'heading') return false;
          if (!dispatch) return true;
          const id = this.options.createTask(parent.textContent.trim());
          if (!id) return false;
          tr.replaceWith($from.before(), $from.after(), tr.doc.type.schema.nodes[TASK_REF]!.create({ taskId: id }));
          this.options.focusTask(id);
          return true;
        },
      insertTask:
        () =>
        ({ tr, dispatch }) => {
          if (!dispatch) return true;
          const id = this.options.createTask('');
          if (!id) return false;
          const { $from } = tr.selection;
          const node = tr.doc.type.schema.nodes[TASK_REF]!.create({ taskId: id });
          // Replace an empty paragraph (typical for /task on a blank line), otherwise insert after the block.
          if ($from.depth >= 1 && $from.parent.type.name === 'paragraph' && $from.parent.content.size === 0) tr.replaceWith($from.before(), $from.after(), node);
          else tr.insert($from.depth ? $from.after(1) : $from.pos, node);
          this.options.focusTask(id);
          return true;
        },
      insertTaskAfter:
        (pos: number) =>
        ({ tr, dispatch }) => {
          if (!dispatch) return true;
          const id = this.options.createTask('');
          if (!id) return false;
          tr.insert(pos, tr.doc.type.schema.nodes[TASK_REF]!.create({ taskId: id }));
          this.options.focusTask(id);
          return true;
        },
    };
  },
  addKeyboardShortcuts() {
    return { 'Mod-Shift-9': () => this.editor.commands.convertToTask() };
  },
});

// ───────────── Reconciliation ─────────────
export interface RefExpectation {
  /** Tasks that belong in this document, in their canonical order. */
  taskIds: string[];
  /** Sublists that belong in this document. */
  listIds?: string[];
}

/**
 * Deterministic convergence between the document and the task store: refs to tasks that no
 * longer belong here are removed, duplicate refs keep the first occurrence, and tasks missing
 * from the document (created elsewhere — Inbox, MCP, integrations) are appended. Every client
 * applies the same rules, so concurrent reconciliations converge.
 */
export const Reconcile = Extension.create({
  name: 'reconcile',
  addCommands() {
    return {
      reconcileRefs:
        (expected: RefExpectation) =>
        ({ state, dispatch }) => {
          const tasks = new Set(expected.taskIds);
          const lists = new Set(expected.listIds ?? []);
          const seen = new Set<string>();
          const removals: { from: number; to: number }[] = [];
          state.doc.descendants((node: PMNodeType, pos: number) => {
            if (node.type.name === TASK_REF || node.type.name === LIST_REF) {
              const isTask = node.type.name === TASK_REF;
              const id = String(node.attrs[isTask ? 'taskId' : 'listId'] ?? '');
              const key = `${node.type.name}:${id}`;
              const valid = isTask ? tasks.has(id) : lists.has(id);
              if (!valid || seen.has(key)) removals.push({ from: pos, to: pos + node.nodeSize });
              seen.add(key);
              return false;
            }
            return true;
          });
          const missingTasks = expected.taskIds.filter((id) => !seen.has(`${TASK_REF}:${id}`));
          const missingLists = (expected.listIds ?? []).filter((id) => !seen.has(`${LIST_REF}:${id}`));
          if (!removals.length && !missingTasks.length && !missingLists.length) return false;
          if (dispatch) {
            const tr = state.tr;
            for (const r of removals.reverse()) tr.delete(r.from, r.to);
            const nodes = [
              ...missingLists.map((id) => state.schema.nodes[LIST_REF]!.create({ listId: id })),
              ...missingTasks.map((id) => state.schema.nodes[TASK_REF]!.create({ taskId: id })),
            ];
            if (nodes.length) {
              // Replace a lone empty paragraph instead of appending after it.
              const only = tr.doc.childCount === 1 ? tr.doc.firstChild : null;
              if (only && only.type.name === 'paragraph' && only.content.size === 0) tr.replaceWith(0, tr.doc.content.size, nodes);
              else tr.insert(tr.doc.content.size, nodes);
            }
            tr.setMeta('addToHistory', false).setMeta('orbit:reconcile', true);
            dispatch(tr);
          }
          return true;
        },
    };
  },
});

// ───────────── Markdown paste ─────────────
export const MarkdownPaste = Extension.create<{ createTask: TaskBehaviourOptions['createTask'] }>({
  name: 'markdownPaste',
  addOptions: () => ({ createTask: () => null }),
  addProseMirrorPlugins() {
    const editor = this.editor;
    const createTask = this.options.createTask;
    return [
      new Plugin({
        key: new PluginKey('markdownPaste'),
        props: {
          handlePaste(_view, event) {
            const text = event.clipboardData?.getData('text/plain') ?? '';
            const html = event.clipboardData?.getData('text/html') ?? '';
            if (!text || (html && !/^\s*<(pre|code)/i.test(html) && !looksLikeMarkdown(text)) || !looksLikeMarkdown(text)) return false;
            const blocks = markdownToBlocks(text);
            const nodes: PMNode[] = [];
            for (const b of blocks) {
              if (b.kind === 'node') nodes.push(b.node);
              else {
                const id = createTask(b.title, { completed: b.completed });
                if (id) nodes.push({ type: TASK_REF, attrs: { taskId: id } });
              }
            }
            if (!nodes.length) return false;
            editor.chain().focus().insertContent(nodes).run();
            return true;
          },
        },
      }),
    ];
  },
});

// ───────────── Slash commands ─────────────
export interface SlashItem {
  id: string;
  title: string;
  description?: string;
  keywords?: string[];
  group: string;
  run: (editor: Editor, range: Range) => void;
}

export const SlashCommand = Extension.create<{ items: (query: string) => SlashItem[]; render: SuggestionOptions<SlashItem>['render'] }>({
  name: 'slashCommand',
  addOptions: () => ({ items: () => [], render: undefined }),
  addProseMirrorPlugins() {
    return [
      Suggestion<SlashItem>({
        editor: this.editor,
        char: '/',
        startOfLine: false,
        allowSpaces: false,
        items: ({ query }) => this.options.items(query),
        command: ({ editor, range, props }) => props.run(editor, range),
        render: this.options.render,
      }),
    ];
  },
});

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    taskBehaviour: {
      convertToTask: () => ReturnType;
      insertTask: () => ReturnType;
      insertTaskAfter: (pos: number) => ReturnType;
    };
    reconcile: {
      reconcileRefs: (expected: RefExpectation) => ReturnType;
    };
  }
}
