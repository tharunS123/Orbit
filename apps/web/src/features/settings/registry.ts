import type * as React from 'react';
import type { SettingsSection } from '@orbit/shared';

/** Settings sections contributed by feature modules (integrations, AI, MCP, billing). */
export const extraSettings: Partial<Record<SettingsSection, React.ComponentType>> = {};
