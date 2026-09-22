'use client';

import * as React from 'react';
import { cn } from '@orbit/ui';

export function SettingsSection({ title, description, children, danger }: { title: string; description?: React.ReactNode; children: React.ReactNode; danger?: boolean }) {
  return (
    <section className={cn('rounded-xl border bg-surface p-5', danger ? 'border-danger/40' : 'border-border')}>
      <h2 className={cn('text-[15px] font-semibold', danger && 'text-danger')}>{title}</h2>
      {description ? <p className="mt-1 text-sm text-fg-muted">{description}</p> : null}
      <div className="mt-4 flex flex-col gap-4">{children}</div>
    </section>
  );
}

export function SettingRow({ label, description, children }: { label: string; description?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4">
      <div className="min-w-0">
        <p className="text-sm font-medium">{label}</p>
        {description ? <p className="text-xs text-fg-muted">{description}</p> : null}
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  );
}
