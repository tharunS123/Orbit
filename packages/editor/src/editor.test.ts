import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { appendJsonToDoc, jsonToYUpdate, markdownToContent } from './schema';
import { markdownToBlocks, looksLikeMarkdown } from './markdown-blocks';
import { ydocToMarkdown } from './markdown';
import { docFromState, extractRefs, remapRefs, toPlainText, parseDocName } from './ydoc';

describe('markdown → blocks', () => {
  it('parses headings, lists, quotes, code, tasks and inline marks', () => {
    const blocks = markdownToBlocks('# Plan\nSome **bold** and [link](https://x.y) and [bad](javascript:alert(1))\n- a\n- b\n1. one\n> quote\n```ts\nconst x = 1;\n```\n- [ ] Task A\n  - [x] Sub\n---');
    expect(blocks.map((b) => (b.kind === 'task' ? `task:${b.title}:${b.depth}` : b.node.type))).toEqual([
      'heading', 'paragraph', 'bulletList', 'orderedList', 'blockquote', 'codeBlock', 'task:Task A:0', 'task:Sub:1', 'horizontalRule',
    ]);
    const para = blocks[1] as { kind: 'node'; node: { content: { text: string; marks?: { type: string }[] }[] } };
    expect(para.node.content.some((n) => n.marks?.[0]?.type === 'bold')).toBe(true);
    expect(para.node.content.some((n) => n.text === 'bad' && !n.marks)).toBe(true);
    expect(looksLikeMarkdown('plain sentence')).toBe(false);
    expect(looksLikeMarkdown('- [ ] milk')).toBe(true);
  });
});

describe('yjs documents', () => {
  it('builds doc state with task refs, extracts order, renders markdown, remaps', () => {
    let n = 0;
    const created: { title: string; parentId: string | null }[] = [];
    const content = markdownToContent('## Launch\nIntro text\n- [ ] First\n  - [ ] Nested\n- [ ] Second', (title, { parentId }) => {
      created.push({ title, parentId });
      return `00000000-0000-4000-8000-00000000000${++n}`;
    });
    const state = jsonToYUpdate(content);
    const doc = docFromState(state);
    const refs = extractRefs(doc);
    expect(refs.taskIds).toEqual(['00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000003']);
    expect(created[1]).toEqual({ title: 'Nested', parentId: '00000000-0000-4000-8000-000000000001' });
    expect(toPlainText(doc)).toContain('Intro text');
    const md = ydocToMarkdown(doc, { task: (id) => [`- [ ] task ${id.slice(-1)}`] });
    expect(md).toBe('## Launch\n\nIntro text\n\n- [ ] task 1\n- [ ] task 3\n');

    const remapped = docFromState(remapRefs(state, { '00000000-0000-4000-8000-000000000001': '11111111-1111-4111-8111-111111111111' }));
    expect(extractRefs(remapped).taskIds).toEqual(['11111111-1111-4111-8111-111111111111']);
  });

  it('appends content to an existing document', () => {
    const doc = new Y.Doc();
    Y.applyUpdate(doc, jsonToYUpdate([{ type: 'paragraph', content: [{ type: 'text', text: 'Hello' }] }]));
    appendJsonToDoc(doc, [{ type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'Added' }] }]);
    expect(ydocToMarkdown(doc)).toBe('Hello\n\n## Added\n');
  });

  it('validates document names', () => {
    expect(parseDocName('list:0190f3b4-7c1a-7000-8000-000000000001')).toEqual({ kind: 'list', id: '0190f3b4-7c1a-7000-8000-000000000001' });
    expect(parseDocName('sync:abc')).toBeNull();
    expect(parseDocName('list:../../etc')).toBeNull();
  });
});
