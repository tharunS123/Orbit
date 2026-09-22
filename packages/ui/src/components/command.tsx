'use client';

import * as React from 'react';
import { Command as Cmdk } from 'cmdk';
import { Search } from 'lucide-react';
import { cn } from '../cn';
import { Shortcut } from './primitives';

/** Thin, styled wrapper over cmdk for the command palette and pickers. */
export function Command({ className, ...props }: React.ComponentProps<typeof Cmdk>) {
  return <Cmdk className={cn('flex h-full w-full flex-col overflow-hidden text-fg', className)} {...props} />;
}

export function CommandInput({ className, ...props }: React.ComponentProps<typeof Cmdk.Input>) {
  return (
    <div className="flex items-center gap-2 border-b border-border px-3">
      <Search className="size-4 shrink-0 text-fg-subtle" aria-hidden />
      <Cmdk.Input className={cn('h-11 w-full bg-transparent text-[15px] outline-none placeholder:text-fg-subtle', className)} {...props} />
    </div>
  );
}

export function CommandList({ className, ...props }: React.ComponentProps<typeof Cmdk.List>) {
  return <Cmdk.List className={cn('max-h-[min(60vh,420px)] overflow-y-auto overscroll-contain p-1.5', className)} {...props} />;
}

export function CommandEmpty(props: React.ComponentProps<typeof Cmdk.Empty>) {
  return <Cmdk.Empty className="py-8 text-center text-sm text-fg-subtle" {...props} />;
}

export function CommandGroup({ className, ...props }: React.ComponentProps<typeof Cmdk.Group>) {
  return (
    <Cmdk.Group
      className={cn('[&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:pt-2 [&_[cmdk-group-heading]]:pb-1 [&_[cmdk-group-heading]]:text-[11px] [&_[cmdk-group-heading]]:font-semibold [&_[cmdk-group-heading]]:uppercase [&_[cmdk-group-heading]]:tracking-wide [&_[cmdk-group-heading]]:text-fg-subtle', className)}
      {...props}
    />
  );
}

export function CommandItem({ className, shortcut, children, ...props }: React.ComponentProps<typeof Cmdk.Item> & { shortcut?: string }) {
  return (
    <Cmdk.Item
      className={cn('flex h-9 cursor-default select-none items-center gap-2.5 rounded-md px-2 text-[13.5px] outline-none data-[disabled=true]:opacity-50 data-[selected=true]:bg-bg-hover [&_svg]:size-4 [&_svg]:shrink-0 [&_svg]:text-fg-muted', className)}
      {...props}
    >
      {children}
      {shortcut ? <Shortcut keys={shortcut} className="ml-auto" /> : null}
    </Cmdk.Item>
  );
}

export const CommandSeparator = Cmdk.Separator;
