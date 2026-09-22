import type { ApiExtensions } from '@orbit/api';

/**
 * Feature route modules mounted into the API (AI, meetings, integrations, billing, MCP tokens,
 * webhooks). Loaded lazily so the core API starts even if an optional module fails to import.
 */
export async function apiExtensions(): Promise<ApiExtensions> {
  const modules = await Promise.all([]);
  return { routes: modules.flat() };
}
