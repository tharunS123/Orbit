import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { secureHeaders } from 'hono/secure-headers';
import type { ApiDeps, ApiEnv } from './context';
import { baseMiddleware, errorResponse, requireAuth } from './middleware';
import { coreRoutes } from './routes/core';
import { invitationRoutes } from './routes/invitations';
import { searchRoutes } from './routes/search';
import { contentRoutes } from './routes/content';

/** Allowed browser origins: the web app plus native shells (Capacitor, Tauri). */
export function allowedOrigins(appUrl: string): string[] {
  return [appUrl, 'capacitor://localhost', 'https://localhost', 'http://localhost', 'tauri://localhost', 'http://tauri.localhost', 'https://tauri.localhost'];
}

export function createApi(deps: ApiDeps): Hono<ApiEnv> {
  const app = new Hono<ApiEnv>().basePath('/api');
  const origins = allowedOrigins(deps.env.APP_URL);

  app.use('*', baseMiddleware(deps));
  app.use('*', secureHeaders({ crossOriginResourcePolicy: false }));
  app.use(
    '*',
    cors({
      origin: (origin) => (origins.includes(origin) || /^http:\/\/localhost:\d+$/.test(origin) ? origin : null),
      allowHeaders: ['authorization', 'content-type', 'x-request-id', 'x-client-id'],
      allowMethods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
      exposeHeaders: ['x-request-id', 'retry-after', 'content-disposition'],
      maxAge: 600,
    }),
  );
  app.onError((error, c) => errorResponse(c, error));
  app.notFound((c) => c.json({ error: { code: 'not_found', message: 'No such endpoint.' } }, 404));

  // Public routes are mounted before the authenticated router so its auth middleware never
  // runs for them.
  const pub = new Hono<ApiEnv>();
  const authed = new Hono<ApiEnv>();
  authed.use('*', requireAuth());
  coreRoutes(pub, authed);
  invitationRoutes(pub, authed);
  searchRoutes(pub, authed);
  contentRoutes(pub, authed);
  for (const register of deps.extensions?.routes ?? []) register(pub, authed, deps);
  app.route('/', pub);
  app.route('/', authed);
  return app;
}
