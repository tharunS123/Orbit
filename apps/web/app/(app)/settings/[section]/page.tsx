import { SettingsView } from '@/features/settings/settings-view';

const SECTIONS = ['account', 'appearance', 'notifications', 'integrations', 'ai', 'mcp', 'billing', 'workspace', 'data', 'shortcuts'] as const;

export function generateStaticParams() {
  return SECTIONS.map((section) => ({ section }));
}

export default async function SettingsPage({ params }: { params: Promise<{ section: string }> }) {
  const { section } = await params;
  return <SettingsView section={section} />;
}
