'use client';

import * as React from 'react';
import Link from 'next/link';
import { Bell, Bot, Brush, CreditCard, Database, Keyboard, Monitor, Plug, Settings, Terminal, UserRound, Users } from 'lucide-react';
import { routes, type SettingsSection } from '@orbit/shared';
import { cn } from '@orbit/ui';
import { PageBody, PageHeader } from '@/features/shell/page-header';
import { AccountSettings } from './account';
import { DesktopSettings } from './desktop';
import { AppearanceSettings, DataSettings, NotificationSettings, ShortcutSettings, WorkspaceSettings } from './sections';
import { extraSettings } from './registry';

const NAV: { id: SettingsSection; label: string; icon: React.ComponentType<{ className?: string }> }[] = [
  { id: 'account', label: 'Account', icon: UserRound },
  { id: 'appearance', label: 'Appearance', icon: Brush },
  { id: 'notifications', label: 'Notifications', icon: Bell },
  { id: 'workspace', label: 'Workspace', icon: Users },
  { id: 'integrations', label: 'Integrations', icon: Plug },
  { id: 'ai', label: 'AI & recording', icon: Bot },
  { id: 'mcp', label: 'MCP & API', icon: Terminal },
  { id: 'billing', label: 'Plan & billing', icon: CreditCard },
  { id: 'data', label: 'Data', icon: Database },
  { id: 'shortcuts', label: 'Shortcuts', icon: Keyboard },
  { id: 'desktop', label: 'Desktop app', icon: Monitor },
];

const CORE: Partial<Record<SettingsSection, React.ComponentType>> = {
  account: AccountSettings,
  appearance: AppearanceSettings,
  notifications: NotificationSettings,
  workspace: WorkspaceSettings,
  data: DataSettings,
  shortcuts: ShortcutSettings,
  desktop: DesktopSettings,
};

export function SettingsView({ section }: { section: string }) {
  const Section = CORE[section as SettingsSection] ?? extraSettings[section as SettingsSection] ?? AccountSettings;
  const available = NAV.filter((n) => CORE[n.id] || extraSettings[n.id]);
  return (
    <>
      <PageHeader title="Settings" icon={<Settings />} />
      <PageBody className="max-w-5xl">
        <div className="mt-4 flex flex-col gap-6 md:flex-row">
          <nav aria-label="Settings sections" className="flex shrink-0 gap-1 overflow-x-auto md:w-48 md:flex-col">
            {available.map((n) => (
              <Link
                key={n.id}
                href={routes.settings(n.id)}
                aria-current={n.id === section ? 'page' : undefined}
                className={cn('flex h-9 shrink-0 items-center gap-2 rounded-md px-3 text-sm whitespace-nowrap', n.id === section ? 'bg-bg-active font-medium' : 'text-fg-muted hover:bg-bg-hover')}
              >
                <n.icon className="size-4" /> {n.label}
              </Link>
            ))}
          </nav>
          <div className="min-w-0 flex-1">
            <Section />
          </div>
        </div>
      </PageBody>
    </>
  );
}
