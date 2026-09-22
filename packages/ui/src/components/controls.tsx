'use client';

import * as React from 'react';
import { Avatar as A, Checkbox as C, RadioGroup as RG, Select as S, Switch as SW, Tabs as TB } from 'radix-ui';
import { Check, ChevronDown, Minus } from 'lucide-react';
import type { LabelColor } from '@orbit/shared';
import { cn } from '../cn';

// ───────────── Task checkbox (the most-touched control in the app) ─────────────
export function TaskCheckbox({
  checked,
  onCheckedChange,
  label,
  size = 'md',
  tone = 'default',
  className,
  disabled,
}: {
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  label: string;
  size?: 'sm' | 'md';
  tone?: 'default' | 'danger' | 'accent';
  className?: string;
  disabled?: boolean;
}) {
  const dims = size === 'sm' ? 'size-[16px]' : 'size-[20px]';
  return (
    <C.Root
      checked={checked}
      onCheckedChange={(v) => onCheckedChange(v === true)}
      aria-label={label}
      disabled={disabled}
      onClick={(e) => e.stopPropagation()}
      className={cn(
        'group relative grid shrink-0 place-items-center rounded-full border-[1.5px] transition-[background,border-color,transform] duration-200 ease-[var(--ease-soft)] hover:scale-105 focus-visible:outline-2 focus-visible:outline-offset-2 active:scale-95 before:absolute before:-inset-2.5 before:content-[""]',
        dims,
        checked
          ? 'border-success bg-success text-white'
          : tone === 'danger'
            ? 'border-danger/70 hover:bg-danger-subtle'
            : tone === 'accent'
              ? 'border-accent/70 hover:bg-accent-subtle'
              : 'border-border-strong hover:border-fg-subtle hover:bg-bg-hover',
        className,
      )}
    >
      <C.Indicator className="animate-check-pop">
        <Check className={size === 'sm' ? 'size-2.5' : 'size-3'} strokeWidth={3.5} />
      </C.Indicator>
      {!checked ? <Check className={cn('absolute text-fg-subtle opacity-0 transition-opacity group-hover:opacity-60', size === 'sm' ? 'size-2.5' : 'size-3')} strokeWidth={3} aria-hidden /> : null}
    </C.Root>
  );
}

export function Checkbox({ className, indeterminate, ...props }: React.ComponentProps<typeof C.Root> & { indeterminate?: boolean }) {
  return (
    <C.Root
      className={cn('grid size-4 shrink-0 place-items-center rounded-xs border border-border-strong bg-surface data-[state=checked]:border-accent data-[state=checked]:bg-accent data-[state=checked]:text-accent-fg', className)}
      checked={indeterminate ? 'indeterminate' : props.checked}
      {...props}
    >
      <C.Indicator>{indeterminate ? <Minus className="size-3" strokeWidth={3} /> : <Check className="size-3" strokeWidth={3} />}</C.Indicator>
    </C.Root>
  );
}

// ───────────── Switch ─────────────
export function Switch({ className, ...props }: React.ComponentProps<typeof SW.Root>) {
  return (
    <SW.Root
      className={cn('relative inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full bg-border-strong transition-colors data-[state=checked]:bg-accent disabled:opacity-50', className)}
      {...props}
    >
      <SW.Thumb className="block size-4 translate-x-0.5 rounded-full bg-white shadow-sm transition-transform duration-200 data-[state=checked]:translate-x-[18px]" />
    </SW.Root>
  );
}

// ───────────── Select ─────────────
export function Select<T extends string>({
  value,
  onValueChange,
  options,
  className,
  placeholder,
  ariaLabel,
}: {
  value: T;
  onValueChange: (v: T) => void;
  options: { value: T; label: React.ReactNode }[];
  className?: string;
  placeholder?: string;
  ariaLabel?: string;
}) {
  return (
    <S.Root value={value} onValueChange={(v) => onValueChange(v as T)}>
      <S.Trigger aria-label={ariaLabel} className={cn('inline-flex h-9 items-center justify-between gap-2 rounded-md border border-border bg-surface px-3 text-sm shadow-xs outline-none focus-visible:ring-3 focus-visible:ring-focus/40', className)}>
        <S.Value placeholder={placeholder} />
        <S.Icon>
          <ChevronDown className="size-4 text-fg-subtle" />
        </S.Icon>
      </S.Trigger>
      <S.Portal>
        <S.Content position="popper" sideOffset={6} className="z-50 max-h-80 min-w-[var(--radix-select-trigger-width)] overflow-hidden rounded-lg border border-border bg-surface-raised p-1 shadow-md">
          <S.Viewport>
            {options.map((o) => (
              <S.Item key={o.value} value={o.value} className="relative flex h-8 cursor-default select-none items-center rounded-sm pr-8 pl-2 text-[13px] outline-none data-[highlighted]:bg-bg-hover">
                <S.ItemText>{o.label}</S.ItemText>
                <S.ItemIndicator className="absolute right-2">
                  <Check className="size-4" />
                </S.ItemIndicator>
              </S.Item>
            ))}
          </S.Viewport>
        </S.Content>
      </S.Portal>
    </S.Root>
  );
}

// ───────────── Segmented control (radio group) ─────────────
export function Segmented<T extends string>({ value, onValueChange, options, ariaLabel, className }: { value: T; onValueChange: (v: T) => void; options: { value: T; label: React.ReactNode }[]; ariaLabel: string; className?: string }) {
  return (
    <RG.Root value={value} onValueChange={(v) => onValueChange(v as T)} aria-label={ariaLabel} className={cn('inline-flex rounded-md bg-bg-hover p-0.5', className)}>
      {options.map((o) => (
        <RG.Item key={o.value} value={o.value} className="h-7 rounded-sm px-3 text-[13px] font-medium text-fg-muted transition-colors data-[state=checked]:bg-surface data-[state=checked]:text-fg data-[state=checked]:shadow-xs">
          {o.label}
        </RG.Item>
      ))}
    </RG.Root>
  );
}

// ───────────── Tabs ─────────────
export const Tabs = TB.Root;
export function TabsList({ className, ...props }: React.ComponentProps<typeof TB.List>) {
  return <TB.List className={cn('flex gap-1 border-b border-border', className)} {...props} />;
}
export function TabsTrigger({ className, ...props }: React.ComponentProps<typeof TB.Trigger>) {
  return (
    <TB.Trigger
      className={cn('-mb-px border-b-2 border-transparent px-2.5 py-2 text-[13px] font-medium text-fg-muted transition-colors hover:text-fg data-[state=active]:border-accent data-[state=active]:text-fg', className)}
      {...props}
    />
  );
}
export const TabsContent = TB.Content;

// ───────────── Avatar ─────────────
const AVATAR_TONES = ['#6d5ef0', '#e0679a', '#2f9e8f', '#e28a2b', '#3b82c4', '#9b59d0', '#c24f4f', '#4a9b3f'];

export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return '?';
  return ((parts[0]![0] ?? '') + (parts.length > 1 ? (parts.at(-1)![0] ?? '') : '')).toUpperCase();
}

function toneFor(seed: string) {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  return AVATAR_TONES[h % AVATAR_TONES.length]!;
}

export function Avatar({ name, src, seed, size = 24, className, ring }: { name: string; src?: string | null; seed?: string; size?: number; className?: string; ring?: boolean }) {
  return (
    <A.Root
      className={cn('relative inline-flex shrink-0 select-none items-center justify-center overflow-hidden rounded-full align-middle', ring && 'ring-2 ring-bg', className)}
      style={{ width: size, height: size, background: toneFor(seed ?? name) }}
      title={name}
    >
      {src ? <A.Image src={src} alt={name} className="size-full object-cover" /> : null}
      <A.Fallback className="font-semibold text-white" style={{ fontSize: Math.max(9, size * 0.4) }} delayMs={src ? 300 : 0}>
        {initials(name)}
      </A.Fallback>
    </A.Root>
  );
}

export function AvatarStack({ people, max = 4, size = 22 }: { people: { id: string; name: string; src?: string | null }[]; max?: number; size?: number }) {
  const shown = people.slice(0, max);
  const extra = people.length - shown.length;
  return (
    <div className="flex -space-x-1.5" aria-label={people.map((p) => p.name).join(', ')}>
      {shown.map((p) => (
        <Avatar key={p.id} name={p.name} src={p.src} seed={p.id} size={size} ring />
      ))}
      {extra > 0 ? (
        <span className="grid place-items-center rounded-full bg-bg-active text-[10px] font-semibold text-fg-muted ring-2 ring-bg" style={{ width: size, height: size }}>
          +{extra}
        </span>
      ) : null}
    </div>
  );
}

// ───────────── Labels ─────────────
export function LabelChip({ name, color, onRemove, className, size = 'sm' }: { name: string; color: LabelColor; onRemove?: () => void; className?: string; size?: 'xs' | 'sm' }) {
  return (
    <span
      className={cn('inline-flex max-w-40 items-center gap-1 rounded-full font-medium', size === 'xs' ? 'h-[18px] px-1.5 text-[11px]' : 'h-5 px-2 text-xs', className)}
      style={{ background: `var(--label-${color}-bg)`, color: `var(--label-${color}-fg)` }}
    >
      <span className="truncate">{name}</span>
      {onRemove ? (
        <button type="button" onClick={onRemove} aria-label={`Remove label ${name}`} className="-mr-1 rounded-full px-0.5 opacity-70 hover:opacity-100">
          ×
        </button>
      ) : null}
    </span>
  );
}

export function ColorDot({ color, className }: { color: LabelColor; className?: string }) {
  return <span className={cn('inline-block size-2.5 rounded-full', className)} style={{ background: `var(--label-${color}-fg)` }} aria-hidden />;
}
