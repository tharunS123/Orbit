'use client';

import * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { Slot } from 'radix-ui';
import { Loader2 } from 'lucide-react';
import { cn } from '../cn';

// ───────────── Button ─────────────
export const buttonVariants = cva(
  'inline-flex select-none items-center justify-center gap-2 whitespace-nowrap font-medium transition-[background,color,box-shadow,transform] duration-150 ease-[var(--ease-soft)] disabled:pointer-events-none disabled:opacity-50 active:scale-[0.98] [&_svg]:shrink-0',
  {
    variants: {
      variant: {
        primary: 'bg-accent text-accent-fg shadow-xs hover:bg-accent-hover',
        secondary: 'border border-border bg-surface text-fg shadow-xs hover:bg-bg-hover',
        ghost: 'text-fg-muted hover:bg-bg-hover hover:text-fg',
        subtle: 'bg-accent-subtle text-accent-subtle-fg hover:brightness-95',
        danger: 'bg-danger text-white shadow-xs hover:brightness-110',
        'danger-ghost': 'text-danger hover:bg-danger-subtle',
        link: 'text-accent underline-offset-4 hover:underline',
      },
      size: {
        xs: 'h-7 rounded-sm px-2 text-xs [&_svg]:size-3.5',
        sm: 'h-8 rounded-md px-3 text-[13px] [&_svg]:size-4',
        md: 'h-10 rounded-md px-4 text-sm [&_svg]:size-4',
        lg: 'h-12 rounded-lg px-5 text-[15px] [&_svg]:size-5',
        icon: 'size-9 rounded-md [&_svg]:size-[18px]',
        'icon-sm': 'size-7 rounded-sm [&_svg]:size-4',
      },
    },
    defaultVariants: { variant: 'secondary', size: 'md' },
  },
);

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement>, VariantProps<typeof buttonVariants> {
  asChild?: boolean;
  loading?: boolean;
}

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { className, variant, size, asChild, loading, children, disabled, type, ...props },
  ref,
) {
  if (asChild) {
    // Slot needs exactly one child element.
    return (
      <Slot.Root ref={ref} className={cn(buttonVariants({ variant, size }), className)} aria-busy={loading || undefined} {...props}>
        {children}
      </Slot.Root>
    );
  }
  const Comp = 'button';
  return (
    <Comp ref={ref} type={type ?? 'button'} className={cn(buttonVariants({ variant, size }), className)} disabled={disabled || loading} aria-busy={loading || undefined} {...props}>
      {loading ? <Loader2 className="animate-spin" aria-hidden /> : null}
      {children}
    </Comp>
  );
});

// ───────────── Inputs ─────────────
export const inputClass =
  'w-full rounded-md border border-border bg-surface px-3 text-sm text-fg shadow-xs outline-none transition-[border,box-shadow] placeholder:text-fg-subtle focus:border-accent focus:ring-3 focus:ring-focus/40 disabled:opacity-60 aria-invalid:border-danger aria-invalid:ring-danger/20';

export const Input = React.forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement>>(function Input({ className, ...props }, ref) {
  return <input ref={ref} className={cn(inputClass, 'h-10', className)} {...props} />;
});

export const Textarea = React.forwardRef<HTMLTextAreaElement, React.TextareaHTMLAttributes<HTMLTextAreaElement>>(function Textarea({ className, ...props }, ref) {
  return <textarea ref={ref} className={cn(inputClass, 'min-h-20 resize-y py-2 leading-relaxed', className)} {...props} />;
});

export function Label({ className, ...props }: React.LabelHTMLAttributes<HTMLLabelElement>) {
  return <label className={cn('text-[13px] font-medium text-fg', className)} {...props} />;
}

export function Field({ label, hint, error, children, htmlFor, className }: { label: React.ReactNode; hint?: React.ReactNode; error?: React.ReactNode; children: React.ReactNode; htmlFor?: string; className?: string }) {
  return (
    <div className={cn('flex flex-col gap-1.5', className)}>
      <Label htmlFor={htmlFor}>{label}</Label>
      {children}
      {error ? (
        <p className="text-xs text-danger" role="alert">
          {error}
        </p>
      ) : hint ? (
        <p className="text-xs text-fg-subtle">{hint}</p>
      ) : null}
    </div>
  );
}

// ───────────── Kbd, Badge, Spinner, Skeleton ─────────────
export function Kbd({ className, children }: { className?: string; children: React.ReactNode }) {
  return <kbd className={cn('inline-flex h-5 min-w-5 items-center justify-center rounded-xs border border-border bg-surface-sunken px-1 font-sans text-[11px] font-medium text-fg-muted', className)}>{children}</kbd>;
}

/** Render a shortcut like "mod+shift+k" as keycaps, using ⌘ on Apple platforms. */
export function Shortcut({ keys, className }: { keys: string; className?: string }) {
  const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);
  const map: Record<string, string> = { mod: isMac ? '⌘' : 'Ctrl', shift: '⇧', alt: isMac ? '⌥' : 'Alt', enter: '↵', escape: 'Esc', backspace: '⌫', up: '↑', down: '↓', left: '←', right: '→', space: 'Space' };
  return (
    <span className={cn('inline-flex items-center gap-0.5', className)} aria-label={keys.replace(/\+/g, ' ')}>
      {keys.split('+').map((k) => (
        <Kbd key={k}>{map[k.toLowerCase()] ?? k.toUpperCase()}</Kbd>
      ))}
    </span>
  );
}

export function Badge({ className, tone = 'neutral', children }: { className?: string; tone?: 'neutral' | 'accent' | 'success' | 'warning' | 'danger'; children: React.ReactNode }) {
  const tones = {
    neutral: 'bg-bg-hover text-fg-muted',
    accent: 'bg-accent-subtle text-accent-subtle-fg',
    success: 'bg-success-subtle text-success',
    warning: 'bg-warning-subtle text-fg',
    danger: 'bg-danger-subtle text-danger',
  };
  return <span className={cn('inline-flex h-5 items-center gap-1 rounded-full px-2 text-[11px] font-medium', tones[tone], className)}>{children}</span>;
}

export function Spinner({ className, label = 'Loading' }: { className?: string; label?: string }) {
  return <Loader2 className={cn('size-4 animate-spin text-fg-subtle', className)} aria-label={label} role="status" />;
}

export function Skeleton({ className }: { className?: string }) {
  return <div className={cn('skeleton h-4', className)} aria-hidden />;
}

export function Separator({ className, vertical }: { className?: string; vertical?: boolean }) {
  return <div role="separator" aria-orientation={vertical ? 'vertical' : 'horizontal'} className={cn(vertical ? 'mx-1 h-5 w-px' : 'my-1 h-px w-full', 'bg-border', className)} />;
}

// ───────────── Empty state ─────────────
export function EmptyState({ icon, title, description, action, className }: { icon?: React.ReactNode; title: string; description?: React.ReactNode; action?: React.ReactNode; className?: string }) {
  return (
    <div className={cn('mx-auto flex max-w-sm flex-col items-center gap-3 px-6 py-16 text-center animate-fade-in', className)}>
      {icon ? <div className="grid size-14 place-items-center rounded-2xl bg-accent-subtle text-accent-subtle-fg [&_svg]:size-7">{icon}</div> : null}
      <h2 className="text-base font-semibold text-fg">{title}</h2>
      {description ? <p className="text-sm leading-relaxed text-fg-muted">{description}</p> : null}
      {action ? <div className="mt-2">{action}</div> : null}
    </div>
  );
}

// ───────────── Progress ring (subtask progress) ─────────────
export function ProgressRing({ value, total, size = 16, className }: { value: number; total: number; size?: number; className?: string }) {
  const r = (size - 3) / 2;
  const c = 2 * Math.PI * r;
  const pct = total ? Math.min(1, value / total) : 0;
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className={cn('shrink-0 -rotate-90', className)} aria-hidden>
      <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="var(--border-strong)" strokeWidth="2" />
      <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke={pct === 1 ? 'var(--success)' : 'var(--accent)'} strokeWidth="2" strokeLinecap="round" strokeDasharray={c} strokeDashoffset={c * (1 - pct)} className="transition-[stroke-dashoffset] duration-300" />
    </svg>
  );
}

// ───────────── Visually hidden ─────────────
export function VisuallyHidden({ children }: { children: React.ReactNode }) {
  return <span className="sr-only">{children}</span>;
}
