'use client';

import * as React from 'react';
import * as Y from 'yjs';
import { TEMPLATES, type Template } from '@orbit/core';
import { markdownToContent, jsonToYUpdate } from '@orbit/editor/schema';
import type { CollabSession } from '@orbit/editor/collab';
import type { Actions } from '@orbit/sync/client';
import { Button, Dialog, DialogContent, cn } from '@orbit/ui';

/**
 * Create a list from a Markdown template: tasks become real task entities (with natural-language
 * dates parsed) and the headings/notes/task order are written into the list's document.
 */
export async function createListFromTemplate(actions: Actions, collab: CollabSession | null, workspaceId: string, template: Pick<Template, 'title' | 'emoji' | 'markdown'>): Promise<string> {
  const { id: listId } = actions.createList({ workspaceId, title: template.title, emoji: template.emoji });
  const content = markdownToContent(template.markdown, (title, { completed, parentId }) => {
    const { id } = actions.createTask({ workspaceId, text: title, listId: parentId ? null : listId, parentTaskId: parentId, inInbox: false });
    if (completed) actions.setCompleted([id], true);
    return id;
  });
  if (collab) {
    const doc = collab.open(`list:${listId}`);
    await doc.localReady;
    Y.applyUpdate(doc.ydoc, jsonToYUpdate(content));
    // Keep the provider alive long enough to push the update.
    setTimeout(() => doc.release(), 5000);
  }
  return listId;
}

export function TemplateGallery({ open, onOpenChange, onPick }: { open: boolean; onOpenChange: (o: boolean) => void; onPick: (t: Template) => void }) {
  const [category, setCategory] = React.useState<'all' | Template['category']>('all');
  const shown = TEMPLATES.filter((t) => category === 'all' || t.category === category);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent title="Start from a template" description="Templates are ordinary lists — edit anything after creating. Duplicate your own lists to reuse them too." size="lg">
        <div className="mb-3 flex gap-1">
          {(['all', 'personal', 'work', 'team'] as const).map((c) => (
            <Button key={c} size="xs" variant={category === c ? 'subtle' : 'ghost'} onClick={() => setCategory(c)} className="capitalize">
              {c}
            </Button>
          ))}
        </div>
        <div className="grid gap-2 sm:grid-cols-2">
          {shown.map((t) => (
            <button key={t.id} type="button" onClick={() => onPick(t)} className={cn('flex items-start gap-3 rounded-lg border border-border bg-surface p-3 text-left transition-colors hover:border-accent/40 hover:bg-accent-subtle/30')}>
              <span className="text-2xl" aria-hidden>
                {t.emoji}
              </span>
              <span>
                <span className="block text-sm font-semibold">{t.title}</span>
                <span className="text-xs leading-relaxed text-fg-muted">{t.description}</span>
              </span>
            </button>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  );
}
