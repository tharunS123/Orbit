/**
 * Central product identity. Change the name here and every surface (UI, emails, MCP server
 * metadata, native shells via their build scripts) follows.
 */
export const PRODUCT = {
  name: 'Orbit',
  tagline: 'Tasks and context, together.',
  /** Custom URL scheme used by desktop and mobile deep links. */
  urlScheme: 'orbit',
  /** Reverse-DNS identifier for native bundles. */
  bundleId: 'app.orbit.client',
  supportEmail: 'support@orbit.example',
} as const;

export type ProductConfig = typeof PRODUCT;
