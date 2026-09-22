'use client';

import * as React from 'react';
import { ReactRenderer } from '@tiptap/react';
import type { SuggestionOptions, SuggestionProps, SuggestionKeyDownProps } from '@tiptap/suggestion';
import type { SlashItem } from '@orbit/editor';
import { cn } from '@orbit/ui';

interface MenuHandle {
  onKeyDown: (props: SuggestionKeyDownProps) => boolean;
}

const SlashList = React.forwardRef<MenuHandle, SuggestionProps<SlashItem>>(function SlashList({ items, command }, ref) {
  const [index, setIndex] = React.useState(0);
  React.useEffect(() => {
    setIndex(0);
  }, [items]);
  const listRef = React.useRef<HTMLDivElement>(null);
  React.useEffect(() => {
    listRef.current?.querySelector(`[data-index="${index}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [index]);
  React.useImperativeHandle(ref, () => ({
    onKeyDown: ({ event }) => {
      if (event.key === 'ArrowDown') {
        setIndex((i) => (i + 1) % Math.max(1, items.length));
        return true;
      }
      if (event.key === 'ArrowUp') {
        setIndex((i) => (i - 1 + items.length) % Math.max(1, items.length));
        return true;
      }
      if (event.key === 'Enter' || event.key === 'Tab') {
        const item = items[index];
        if (item) command(item);
        return true;
      }
      return false;
    },
  }));
  if (!items.length) {
    return <div className="w-64 rounded-lg border border-border bg-surface-raised p-3 text-sm text-fg-subtle shadow-md">No matching blocks</div>;
  }
  let lastGroup = '';
  return (
    <div ref={listRef} role="listbox" aria-label="Insert block" className="max-h-80 w-72 overflow-y-auto rounded-lg border border-border bg-surface-raised p-1 shadow-md">
      {items.map((item, i) => {
        const header = item.group !== lastGroup ? item.group : null;
        lastGroup = item.group;
        return (
          <React.Fragment key={item.id}>
            {header ? <div className="px-2 pt-2 pb-1 text-[11px] font-semibold uppercase tracking-wide text-fg-subtle">{header}</div> : null}
            <button
              type="button"
              role="option"
              aria-selected={i === index}
              data-index={i}
              onMouseEnter={() => setIndex(i)}
              onMouseDown={(e) => {
                e.preventDefault();
                command(item);
              }}
              className={cn('flex w-full flex-col rounded-md px-2 py-1.5 text-left', i === index && 'bg-bg-hover')}
            >
              <span className="text-[13.5px] font-medium">{item.title}</span>
              {item.description ? <span className="text-xs text-fg-subtle">{item.description}</span> : null}
            </button>
          </React.Fragment>
        );
      })}
    </div>
  );
});

/** Suggestion renderer: mounts the menu in a fixed-position container near the caret. */
export const renderSlashMenu: SuggestionOptions<SlashItem>['render'] = () => {
  let renderer: ReactRenderer<MenuHandle, SuggestionProps<SlashItem>> | null = null;
  let container: HTMLDivElement | null = null;
  const place = (props: SuggestionProps<SlashItem>) => {
    const rect = props.clientRect?.();
    if (!rect || !container) return;
    const below = window.innerHeight - rect.bottom > 340;
    container.style.left = `${Math.min(rect.left, window.innerWidth - 300)}px`;
    container.style.top = below ? `${rect.bottom + 6}px` : `${Math.max(8, rect.top - 330)}px`;
  };
  return {
    onStart: (props) => {
      renderer = new ReactRenderer(SlashList, { props, editor: props.editor });
      container = document.createElement('div');
      container.style.position = 'fixed';
      container.style.zIndex = '60';
      container.appendChild(renderer.element);
      document.body.appendChild(container);
      place(props);
    },
    onUpdate: (props) => {
      renderer?.updateProps(props);
      place(props);
    },
    onKeyDown: (props) => {
      if (props.event.key === 'Escape') {
        container?.remove();
        return true;
      }
      return renderer?.ref?.onKeyDown(props) ?? false;
    },
    onExit: () => {
      renderer?.destroy();
      container?.remove();
      renderer = null;
      container = null;
    },
  };
};
