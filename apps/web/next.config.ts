import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEnvConfig } from '@next/env';
import type { NextConfig } from 'next';

const here = path.dirname(fileURLToPath(import.meta.url));
// Single root .env for every app in the monorepo.
// forceReload: Next already loaded (and cached) env for apps/web itself.
loadEnvConfig(path.resolve(here, '../..'), process.env.NODE_ENV !== 'production', { info: () => {}, error: console.error }, true);

/**
 * NATIVE_EXPORT=1 builds a static bundle for Tauri/Capacitor: only `.tsx` pages are included
 * (API route handlers are `.ts` and live on the hosted server), and the app talks to
 * NEXT_PUBLIC_API_URL.
 */
const native = process.env.NATIVE_EXPORT === '1';

const csp = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline'" + (process.env.NODE_ENV === 'development' ? " 'unsafe-eval'" : ''),
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: https:" + (process.env.NODE_ENV === 'development' ? ' http://127.0.0.1:54321 http://localhost:54321' : ''),
  "media-src 'self' blob: https:",
  "font-src 'self' data:",
  "connect-src 'self' https: wss: ws: http://127.0.0.1:* http://localhost:*",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "worker-src 'self' blob:",
].join('; ');

const config: NextConfig = {
  reactStrictMode: true,
  pageExtensions: native ? ['tsx'] : ['tsx', 'ts'],
  output: native ? 'export' : undefined,
  trailingSlash: native,
  images: { unoptimized: true },
  transpilePackages: ['@orbit/ui', '@orbit/shared', '@orbit/core', '@orbit/sync', '@orbit/editor'],
  serverExternalPackages: ['postgres', 'pg-boss', 'pino', 'web-push', 'nodemailer', 'yjs'],
  poweredByHeader: false,
  // The root .env is loaded above, after Next snapshots public variables — forward them so they
  // are inlined into the client bundle.
  env: {
    ...Object.fromEntries(Object.entries(process.env).filter(([k, v]) => k.startsWith('NEXT_PUBLIC_') && v !== undefined) as [string, string][]),
    NEXT_PUBLIC_NATIVE: native ? '1' : '0',
  },
  ...(native
    ? {}
    : {
        async headers() {
          return [
            {
              source: '/:path*',
              headers: [
                { key: 'Content-Security-Policy', value: csp },
                { key: 'X-Content-Type-Options', value: 'nosniff' },
                { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
                { key: 'Permissions-Policy', value: 'camera=(), microphone=(self), geolocation=(), display-capture=(self)' },
                { key: 'Strict-Transport-Security', value: 'max-age=31536000; includeSubDomains' },
              ],
            },
          ];
        },
      }),
};

export default config;
