import * as Y from 'yjs';
import { DOC_FRAGMENT, LIST_REF, MEETING_REF, TASK_REF } from './ydoc';

/**
 * Render a list/task Yjs document to Markdown without a DOM or ProseMirror instance (works on
 * the server for export, MCP and AI context). Task/list refs are resolved through callbacks so
 * the caller controls access and formatting.
 */

export interface MarkdownResolvers {
  /** Markdown lines for a task (including its subtasks), already indented relative to 0. */
  task?: (taskId: string) => string[] | null;
  list?: (listId: string) => string | null;
  meeting?: (meetingId: string) => string | null;
  attachment?: (attachmentId: string) => { name: string; url: string } | null;
}

interface DeltaOp {
  insert?: string | object;
  attributes?: Record<string, unknown>;
}

function escapeMd(text: string): string {
  return text.replace(/([\\`*_[\]#<>])/g, '\\$1');
}

function inlineMarkdown(text: Y.XmlText): string {
  const delta = text.toDelta() as DeltaOp[];
  return delta
    .map((op) => {
      if (typeof op.insert !== 'string') return '';
      let s = escapeMd(op.insert);
      const a = op.attributes ?? {};
      if (a.code) s = `\`${op.insert.replace(/`/g, '\\`')}\``;
      if (a.bold) s = `**${s}**`;
      if (a.italic) s = `_${s}_`;
      if (a.strike) s = `~~${s}~~`;
      const link = a.link as { href?: string } | undefined;
      if (link?.href && /^(https?:|mailto:)/i.test(link.href)) s = `[${s}](${link.href})`;
      return s;
    })
    .join('');
}

function inlineOf(el: Y.XmlElement | Y.XmlFragment): string {
  return el
    .toArray()
    .map((c) => (c instanceof Y.XmlText ? inlineMarkdown(c) : c instanceof Y.XmlElement && c.nodeName === 'hardBreak' ? '  \n' : ''))
    .join('');
}

function renderBlocks(nodes: (Y.XmlElement | Y.XmlText | Y.XmlHook)[], r: MarkdownResolvers, indent: string): string[] {
  const out: string[] = [];
  for (const node of nodes) {
    if (!(node instanceof Y.XmlElement)) continue;
    const name = node.nodeName;
    switch (name) {
      case 'paragraph': {
        const text = inlineOf(node);
        out.push(indent + text);
        break;
      }
      case 'heading': {
        const level = Math.min(6, Math.max(1, Number(node.getAttribute('level') ?? 1)));
        out.push(`${indent}${'#'.repeat(level)} ${inlineOf(node)}`);
        break;
      }
      case 'blockquote':
        for (const line of renderBlocks(node.toArray(), r, '')) out.push(`${indent}> ${line}`);
        break;
      case 'callout': {
        const emoji = String(node.getAttribute('emoji') ?? '💡');
        const lines = renderBlocks(node.toArray(), r, '');
        out.push(`${indent}> ${emoji} ${lines[0] ?? ''}`, ...lines.slice(1).map((l) => `${indent}> ${l}`));
        break;
      }
      case 'codeBlock': {
        const lang = String(node.getAttribute('language') ?? '');
        const code = node.toArray().map((c) => (c instanceof Y.XmlText ? c.toString().replace(/<[^>]+>/g, '') : '')).join('');
        out.push(`${indent}\`\`\`${lang}`, ...code.split('\n').map((l) => indent + l), `${indent}\`\`\``);
        break;
      }
      case 'bulletList':
      case 'orderedList': {
        let n = Number(node.getAttribute('start') ?? 1);
        for (const item of node.toArray()) {
          if (!(item instanceof Y.XmlElement)) continue;
          const marker = name === 'orderedList' ? `${n++}. ` : '- ';
          const lines = renderBlocks(item.toArray(), r, '');
          out.push(`${indent}${marker}${lines[0] ?? ''}`, ...lines.slice(1).map((l) => `${indent}${' '.repeat(marker.length)}${l}`));
        }
        break;
      }
      case 'horizontalRule':
        out.push(`${indent}---`);
        break;
      case 'image': {
        const alt = String(node.getAttribute('alt') ?? '');
        const id = node.getAttribute('attachmentId') as string | undefined;
        const resolved = id ? r.attachment?.(id) : null;
        const src = resolved?.url ?? String(node.getAttribute('src') ?? '');
        if (src) out.push(`${indent}![${escapeMd(alt || resolved?.name || 'image')}](${src})`);
        break;
      }
      case 'attachment': {
        const id = String(node.getAttribute('attachmentId') ?? '');
        const resolved = r.attachment?.(id);
        const label = resolved?.name ?? String(node.getAttribute('name') ?? 'Attachment');
        out.push(`${indent}📎 [${escapeMd(label)}](${resolved?.url ?? `attachment:${id}`})`);
        break;
      }
      case TASK_REF: {
        const id = String(node.getAttribute('taskId') ?? '');
        const lines = r.task?.(id);
        if (lines) out.push(...lines.map((l) => indent + l));
        break;
      }
      case LIST_REF: {
        const id = String(node.getAttribute('listId') ?? '');
        const line = r.list?.(id);
        if (line) out.push(indent + line);
        break;
      }
      case MEETING_REF: {
        const id = String(node.getAttribute('meetingId') ?? '');
        const line = r.meeting?.(id);
        if (line) out.push(indent + line);
        break;
      }
      default: {
        const text = inlineOf(node);
        if (text) out.push(indent + text);
      }
    }
  }
  return out;
}

export function ydocToMarkdown(doc: Y.Doc, resolvers: MarkdownResolvers = {}): string {
  const lines = renderBlocks(doc.getXmlFragment(DOC_FRAGMENT).toArray(), resolvers, '');
  // Blank line between blocks except consecutive list/task lines.
  const out: string[] = [];
  for (const line of lines) {
    const prev = out.at(-1);
    const isItem = /^\s*(- |\d+\. |> )/.test(line);
    const prevItem = prev !== undefined && /^\s*(- |\d+\. |> )/.test(prev);
    if (prev !== undefined && !(isItem && prevItem) && prev !== '') out.push('');
    out.push(line);
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim() + '\n';
}
