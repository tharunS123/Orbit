import { PRODUCT } from '@orbit/shared';
import { cn } from '@orbit/ui';

/** Original product mark: a tilted orbit ring with a satellite. */
export function LogoMark({ size = 28, className }: { size?: number; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" className={className} aria-hidden>
      <defs>
        <linearGradient id="orbit-g" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="oklch(0.62 0.21 285)" />
          <stop offset="1" stopColor="oklch(0.55 0.2 250)" />
        </linearGradient>
      </defs>
      <rect x="1" y="1" width="30" height="30" rx="9" fill="url(#orbit-g)" />
      <ellipse cx="16" cy="16" rx="10" ry="5.2" fill="none" stroke="white" strokeOpacity="0.9" strokeWidth="2" transform="rotate(-28 16 16)" />
      <circle cx="16" cy="16" r="3.4" fill="white" />
      <circle cx="24.4" cy="11.4" r="2" fill="oklch(0.85 0.14 160)" />
    </svg>
  );
}

export function Logo({ className }: { className?: string }) {
  return (
    <span className={cn('inline-flex items-center gap-2 font-semibold tracking-tight', className)}>
      <LogoMark />
      <span className="text-[17px]">{PRODUCT.name}</span>
    </span>
  );
}
