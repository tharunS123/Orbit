/**
 * Markdown → editor blocks (ProseMirror JSON) with task items separated out. Used when pasting
 * Markdown, importing, and when AI ("Make") produces content. Tasks become real task entities;
 * everything else becomes normal editable blocks.
 */

export interface PMMark {
  type: string;
  attrs?: Record<string, unknown>;
}
export interface PMNode {
  type: string;
  attrs?: Record<string, unknown>;
  content?: PMNode[];
  text?: string;
  marks?: PMMark[];
}

export type Block =
  | { kind: 'node'; node: PMNode }
  | { kind: 'task'; title: string; completed: boolean; depth: number };

const SAFE_URL = /^(https?:|mailto:)/i;

/** Inline Markdown: **bold**, _italic_/*italic*, ~~strike~~, `code`, [text](url). */
export function parseInline(text: string): PMNode[] {
  const out: PMNode[] = [];
  const re = /(\*\*([^*]+)\*\*|__([^_]+)__|\*([^*\s][^*]*)\*|_([^_\s][^_]*)_|~~([^~]+)~~|`([^`]+)`|\[([^\]]+)\]\(([^)\s]+)\))/g;
  let last = 0;
  for (const m of text.matchAll(re)) {
    if (m.index! > last) out.push({ type: 'text', text: text.slice(last, m.index) });
    if (m[2] ?? m[3]) out.push({ type: 'text', text: (m[2] ?? m[3])!, marks: [{ type: 'bold' }] });
    else if (m[4] ?? m[5]) out.push({ type: 'text', text: (m[4] ?? m[5])!, marks: [{ type: 'italic' }] });
    else if (m[6]) out.push({ type: 'text', text: m[6], marks: [{ type: 'strike' }] });
    else if (m[7]) out.push({ type: 'text', text: m[7], marks: [{ type: 'code' }] });
    else if (m[8] && m[9]) {
      out.push(SAFE_URL.test(m[9]) ? { type: 'text', text: m[8], marks: [{ type: 'link', attrs: { href: m[9] } }] } : { type: 'text', text: m[8] });
    }
    last = m.index! + m[0].length;
  }
  if (last < text.length) out.push({ type: 'text', text: text.slice(last) });
  return out.filter((n) => n.text);
}

const para = (text: string): PMNode => ({ type: 'paragraph', content: parseInline(text) });

export function markdownToBlocks(markdown: string): Block[] {
  const lines = markdown.replace(/\r\n?/g, '\n').split('\n');
  const blocks: Block[] = [];
  let i = 0;
  const pushList = (ordered: boolean) => {
    const items: PMNode[] = [];
    const re = ordered ? /^\s*\d+[.)]\s+(.*)$/ : /^\s*[-*+]\s+(?!\[[ xX]\])(.*)$/;
    while (i < lines.length) {
      const m = re.exec(lines[i]!);
      if (!m) break;
      items.push({ type: 'listItem', content: [para(m[1]!)] });
      i++;
    }
    blocks.push({ kind: 'node', node: { type: ordered ? 'orderedList' : 'bulletList', content: items } });
  };
  while (i < lines.length) {
    const line = lines[i]!;
    if (!line.trim()) {
      i++;
      continue;
    }
    const fence = /^```(\w*)\s*$/.exec(line);
    if (fence) {
      const code: string[] = [];
      i++;
      while (i < lines.length && !/^```\s*$/.test(lines[i]!)) code.push(lines[i++]!);
      i++;
      blocks.push({ kind: 'node', node: { type: 'codeBlock', attrs: { language: fence[1] || null }, content: code.length ? [{ type: 'text', text: code.join('\n') }] : [] } });
      continue;
    }
    const task = /^(\s*)(?:[-*+]\s+)?\[( |x|X)\]\s+(.*)$/.exec(line);
    if (task) {
      blocks.push({ kind: 'task', title: task[3]!.trim(), completed: task[2]!.toLowerCase() === 'x', depth: Math.floor(task[1]!.replace(/\t/g, '  ').length / 2) });
      i++;
      continue;
    }
    const heading = /^(#{1,3})\s+(.*)$/.exec(line);
    if (heading) {
      blocks.push({ kind: 'node', node: { type: 'heading', attrs: { level: heading[1]!.length }, content: parseInline(heading[2]!) } });
      i++;
      continue;
    }
    if (/^\s*(---|\*\*\*|___)\s*$/.test(line)) {
      blocks.push({ kind: 'node', node: { type: 'horizontalRule' } });
      i++;
      continue;
    }
    if (/^>\s?/.test(line)) {
      const quote: string[] = [];
      while (i < lines.length && /^>\s?/.test(lines[i]!)) quote.push(lines[i++]!.replace(/^>\s?/, ''));
      blocks.push({ kind: 'node', node: { type: 'blockquote', content: quote.filter(Boolean).map(para) } });
      continue;
    }
    if (/^\s*[-*+]\s+/.test(line)) {
      pushList(false);
      continue;
    }
    if (/^\s*\d+[.)]\s+/.test(line)) {
      pushList(true);
      continue;
    }
    const text: string[] = [line.trim()];
    i++;
    while (i < lines.length && lines[i]!.trim() && !/^(#{1,3}\s|```|>|\s*[-*+]\s|\s*\d+[.)]\s|\s*\[( |x|X)\])/.test(lines[i]!)) text.push(lines[i++]!.trim());
    blocks.push({ kind: 'node', node: para(text.join(' ')) });
  }
  return blocks;
}

/** Heuristic: does pasted plain text look like Markdown worth converting? */
export function looksLikeMarkdown(text: string): boolean {
  return /(^|\n)\s*(#{1,3}\s|[-*+]\s|\d+[.)]\s|>\s|```|\[( |x|X)\]\s)/.test(text) || /\*\*[^*]+\*\*|\[[^\]]+\]\([^)]+\)/.test(text);
}
