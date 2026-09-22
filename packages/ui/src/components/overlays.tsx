'use client';

import * as React from 'react';
import { AlertDialog as AD, ContextMenu as CM, Dialog as D, DropdownMenu as DM, Popover as P, Tooltip as T } from 'radix-ui';
import { Check, ChevronRight, X } from 'lucide-react';
import { cn } from '../cn';
import { Button, Shortcut } from './primitives';

const overlayClass = 'fixed inset-0 z-50 bg-overlay data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=closed]:animate-out data-[state=closed]:fade-out-0';
const popoverSurface = 'z-50 rounded-lg border border-border bg-surface-raised text-fg shadow-md outline-none data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-[0.97] data-[state=closed]:animate-out data-[state=closed]:fade-out-0';

// ───────────── Dialog ─────────────
export const Dialog = D.Root;
export const DialogTrigger = D.Trigger;
export const DialogClose = D.Close;

export function DialogContent({
  className,
  children,
  title,
  description,
  hideClose,
  size = 'md',
  ...props
}: React.ComponentProps<typeof D.Content> & { title: React.ReactNode; description?: React.ReactNode; hideClose?: boolean; size?: 'sm' | 'md' | 'lg' | 'xl' }) {
  const widths = { sm: 'max-w-sm', md: 'max-w-lg', lg: 'max-w-2xl', xl: 'max-w-4xl' };
  return (
    <D.Portal>
      <D.Overlay className={overlayClass} />
      <D.Content
        className={cn(
          'fixed left-1/2 top-[10vh] z-50 flex max-h-[80vh] w-[calc(100vw-2rem)] -translate-x-1/2 flex-col overflow-hidden rounded-xl border border-border bg-surface shadow-lg outline-none data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:slide-in-from-top-2 data-[state=closed]:animate-out data-[state=closed]:fade-out-0',
          widths[size],
          className,
        )}
        {...props}
      >
        <div className="flex items-start justify-between gap-4 px-5 pt-5 pb-3">
          <div className="min-w-0">
            <D.Title className="text-base font-semibold text-fg">{title}</D.Title>
            {description ? <D.Description className="mt-1 text-sm text-fg-muted">{description}</D.Description> : <D.Description className="sr-only">{typeof title === 'string' ? title : 'Dialog'}</D.Description>}
          </div>
          {hideClose ? null : (
            <D.Close asChild>
              <Button variant="ghost" size="icon-sm" aria-label="Close">
                <X />
              </Button>
            </D.Close>
          )}
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-5">{children}</div>
      </D.Content>
    </D.Portal>
  );
}

/** Bottom sheet on phones, right-side panel on larger screens. */
export function SheetContent({
  className,
  children,
  title,
  side = 'right',
  ...props
}: React.ComponentProps<typeof D.Content> & { title: string; side?: 'right' | 'bottom' }) {
  return (
    <D.Portal>
      <D.Overlay className={overlayClass} />
      <D.Content
        className={cn(
          'fixed z-50 flex flex-col bg-surface shadow-lg outline-none data-[state=open]:animate-in data-[state=closed]:animate-out',
          side === 'right'
            ? 'inset-y-0 right-0 w-full max-w-md border-l border-border data-[state=open]:slide-in-from-right data-[state=closed]:slide-out-to-right'
            : 'inset-x-0 bottom-0 max-h-[90dvh] rounded-t-xl border-t border-border safe-bottom data-[state=open]:slide-in-from-bottom data-[state=closed]:slide-out-to-bottom',
          className,
        )}
        {...props}
      >
        <D.Title className="sr-only">{title}</D.Title>
        <D.Description className="sr-only">{title}</D.Description>
        {side === 'bottom' ? <div className="mx-auto mt-2 h-1 w-10 rounded-full bg-border-strong" aria-hidden /> : null}
        {children}
      </D.Content>
    </D.Portal>
  );
}

// ───────────── Confirm (alert dialog) ─────────────
export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel = 'Confirm',
  destructive,
  onConfirm,
  children,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: React.ReactNode;
  confirmLabel?: string;
  destructive?: boolean;
  onConfirm: () => void | Promise<void>;
  children?: React.ReactNode;
}) {
  const [busy, setBusy] = React.useState(false);
  return (
    <AD.Root open={open} onOpenChange={onOpenChange}>
      <AD.Portal>
        <AD.Overlay className={overlayClass} />
        <AD.Content className="fixed left-1/2 top-1/2 z-50 w-[calc(100vw-2rem)] max-w-md -translate-x-1/2 -translate-y-1/2 rounded-xl border border-border bg-surface p-5 shadow-lg outline-none data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95">
          <AD.Title className="text-base font-semibold">{title}</AD.Title>
          {description ? <AD.Description className="mt-2 text-sm leading-relaxed text-fg-muted">{description}</AD.Description> : <AD.Description className="sr-only">{title}</AD.Description>}
          {children}
          <div className="mt-5 flex justify-end gap-2">
            <AD.Cancel asChild>
              <Button variant="ghost">Cancel</Button>
            </AD.Cancel>
            <Button
              variant={destructive ? 'danger' : 'primary'}
              loading={busy}
              onClick={async () => {
                setBusy(true);
                try {
                  await onConfirm();
                  onOpenChange(false);
                } finally {
                  setBusy(false);
                }
              }}
            >
              {confirmLabel}
            </Button>
          </div>
        </AD.Content>
      </AD.Portal>
    </AD.Root>
  );
}

// ───────────── Popover ─────────────
export const Popover = P.Root;
export const PopoverTrigger = P.Trigger;
export const PopoverAnchor = P.Anchor;
export const PopoverClose = P.Close;
export function PopoverContent({ className, align = 'start', sideOffset = 6, ...props }: React.ComponentProps<typeof P.Content>) {
  return (
    <P.Portal>
      <P.Content align={align} sideOffset={sideOffset} collisionPadding={12} className={cn(popoverSurface, 'p-2', className)} {...props} />
    </P.Portal>
  );
}

// ───────────── Tooltip ─────────────
export const TooltipProvider = T.Provider;
export function Tooltip({ content, shortcut, children, side = 'bottom' }: { content: React.ReactNode; shortcut?: string; children: React.ReactElement; side?: 'top' | 'bottom' | 'left' | 'right' }) {
  return (
    <T.Root delayDuration={400}>
      <T.Trigger asChild>{children}</T.Trigger>
      <T.Portal>
        <T.Content side={side} sideOffset={6} className="z-[60] flex items-center gap-2 rounded-md bg-fg px-2 py-1 text-xs font-medium text-fg-inverted shadow-md data-[state=delayed-open]:animate-in data-[state=delayed-open]:fade-in-0">
          {content}
          {shortcut ? <Shortcut keys={shortcut} className="[&_kbd]:border-transparent [&_kbd]:bg-white/15 [&_kbd]:text-fg-inverted" /> : null}
        </T.Content>
      </T.Portal>
    </T.Root>
  );
}

// ───────────── Menus ─────────────
const itemClass =
  'relative flex h-8 cursor-default select-none items-center gap-2 rounded-sm px-2 text-[13px] text-fg outline-none data-[disabled]:opacity-50 data-[highlighted]:bg-bg-hover [&_svg]:size-4 [&_svg]:text-fg-muted';

export const Menu = DM.Root;
export const MenuTrigger = DM.Trigger;
export const MenuSub = DM.Sub;
export function MenuContent({ className, align = 'start', ...props }: React.ComponentProps<typeof DM.Content>) {
  return (
    <DM.Portal>
      <DM.Content align={align} sideOffset={6} collisionPadding={12} className={cn(popoverSurface, 'min-w-48 p-1', className)} {...props} />
    </DM.Portal>
  );
}
export function MenuItem({ className, shortcut, danger, children, ...props }: React.ComponentProps<typeof DM.Item> & { shortcut?: string; danger?: boolean }) {
  return (
    <DM.Item className={cn(itemClass, danger && 'text-danger [&_svg]:text-danger', className)} {...props}>
      {children}
      {shortcut ? <Shortcut keys={shortcut} className="ml-auto" /> : null}
    </DM.Item>
  );
}
export function MenuCheckboxItem({ className, children, ...props }: React.ComponentProps<typeof DM.CheckboxItem>) {
  return (
    <DM.CheckboxItem className={cn(itemClass, 'pr-8', className)} {...props}>
      {children}
      <DM.ItemIndicator className="absolute right-2">
        <Check />
      </DM.ItemIndicator>
    </DM.CheckboxItem>
  );
}
export function MenuSubTrigger({ className, children, ...props }: React.ComponentProps<typeof DM.SubTrigger>) {
  return (
    <DM.SubTrigger className={cn(itemClass, 'data-[state=open]:bg-bg-hover', className)} {...props}>
      {children}
      <ChevronRight className="ml-auto" />
    </DM.SubTrigger>
  );
}
export function MenuSubContent({ className, ...props }: React.ComponentProps<typeof DM.SubContent>) {
  return (
    <DM.Portal>
      <DM.SubContent sideOffset={4} collisionPadding={12} className={cn(popoverSurface, 'max-h-80 min-w-48 overflow-y-auto p-1', className)} {...props} />
    </DM.Portal>
  );
}
export function MenuSeparator() {
  return <DM.Separator className="-mx-1 my-1 h-px bg-border" />;
}
export function MenuLabel({ children }: { children: React.ReactNode }) {
  return <DM.Label className="px-2 pt-1.5 pb-1 text-[11px] font-semibold uppercase tracking-wide text-fg-subtle">{children}</DM.Label>;
}

export const ContextMenu = CM.Root;
export const ContextMenuTrigger = CM.Trigger;
export function ContextMenuContent({ className, ...props }: React.ComponentProps<typeof CM.Content>) {
  return (
    <CM.Portal>
      <CM.Content collisionPadding={12} className={cn(popoverSurface, 'min-w-52 p-1', className)} {...props} />
    </CM.Portal>
  );
}
export function ContextMenuItem({ className, shortcut, danger, children, ...props }: React.ComponentProps<typeof CM.Item> & { shortcut?: string; danger?: boolean }) {
  return (
    <CM.Item className={cn(itemClass, danger && 'text-danger [&_svg]:text-danger', className)} {...props}>
      {children}
      {shortcut ? <Shortcut keys={shortcut} className="ml-auto" /> : null}
    </CM.Item>
  );
}
export function ContextMenuSeparator() {
  return <CM.Separator className="-mx-1 my-1 h-px bg-border" />;
}
export const ContextMenuSub = CM.Sub;
export function ContextMenuSubTrigger({ className, children, ...props }: React.ComponentProps<typeof CM.SubTrigger>) {
  return (
    <CM.SubTrigger className={cn(itemClass, 'data-[state=open]:bg-bg-hover', className)} {...props}>
      {children}
      <ChevronRight className="ml-auto" />
    </CM.SubTrigger>
  );
}
export function ContextMenuSubContent({ className, ...props }: React.ComponentProps<typeof CM.SubContent>) {
  return (
    <CM.Portal>
      <CM.SubContent sideOffset={4} className={cn(popoverSurface, 'max-h-80 min-w-48 overflow-y-auto p-1', className)} {...props} />
    </CM.Portal>
  );
}
