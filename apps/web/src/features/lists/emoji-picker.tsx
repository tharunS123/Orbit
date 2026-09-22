'use client';

import * as React from 'react';
import { Popover, PopoverContent, PopoverTrigger, Input, Button } from '@orbit/ui';

const EMOJI: { group: string; items: string[] }[] = [
  { group: 'Work', items: ['📋', '✅', '🗂️', '📌', '📎', '📊', '📈', '🧾', '💼', '🗓️', '📝', '💡', '🎯', '🚀', '🛠️', '🧪', '🧩', '🔍', '📣', '🤝'] },
  { group: 'Life', items: ['🏠', '🛒', '🍳', '🥗', '🏋️', '🧘', '🩺', '💊', '💰', '🎁', '🎉', '✈️', '🧳', '🏖️', '🚗', '🐶', '🌱', '📚', '🎵', '🎮'] },
  { group: 'Symbols', items: ['⭐', '❤️', '🔥', '⚡', '🌈', '☀️', '🌙', '❄️', '🌊', '🍀', '🔔', '🔒', '🧠', '🎨', '📷', '🎬', '✍️', '🧭', '🏁', '💎'] },
];

export function EmojiPicker({ value, onChange, children }: { value: string | null; onChange: (emoji: string | null) => void; children: React.ReactElement }) {
  const [open, setOpen] = React.useState(false);
  const [custom, setCustom] = React.useState('');
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>{children}</PopoverTrigger>
      <PopoverContent className="w-[292px]">
        {EMOJI.map((g) => (
          <div key={g.group} className="mb-2">
            <p className="px-1 pb-1 text-[11px] font-semibold uppercase tracking-wide text-fg-subtle">{g.group}</p>
            <div className="grid grid-cols-10 gap-0.5">
              {g.items.map((e) => (
                <button key={e} type="button" aria-label={`Use ${e}`} aria-pressed={e === value} onClick={() => (onChange(e), setOpen(false))} className="grid size-7 place-items-center rounded-md text-lg hover:bg-bg-hover">
                  {e}
                </button>
              ))}
            </div>
          </div>
        ))}
        <div className="flex gap-1 border-t border-border pt-2">
          <Input className="h-8" placeholder="Paste any emoji" value={custom} maxLength={8} onChange={(e) => setCustom(e.target.value)} aria-label="Custom emoji" />
          <Button size="sm" variant="secondary" disabled={!custom.trim()} onClick={() => (onChange(custom.trim()), setOpen(false), setCustom(''))}>
            Use
          </Button>
          {value ? (
            <Button size="sm" variant="ghost" onClick={() => (onChange(null), setOpen(false))}>
              Remove
            </Button>
          ) : null}
        </div>
      </PopoverContent>
    </Popover>
  );
}
