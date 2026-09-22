import type { IncomingMessage, ServerResponse } from 'node:http';
import { Server, type Document as HpDocument } from '@hocuspocus/server';
import { Database } from '@hocuspocus/extension-database';
import * as Y from 'yjs';
import type { Logger } from 'pino';
import { AppError } from '@orbit/shared';
import { safeEqual, type TokenVerifier } from '@orbit/auth';
import { asService, asUser, type Sql } from '@orbit/database';
import { positionsBetween } from '@orbit/core';
import { extractRefs, parseDocName, previewText, toPlainText } from '@orbit/editor/ydoc';
import { appendJsonToDoc } from '@orbit/editor/schema';

/**
 * Real-time collaboration server.
 *  - Documents `list:<id>` / `task:<id>` are Yjs docs persisted to Postgres (`documents`).
 *  - Every connection is authenticated with the user's Supabase JWT and authorised per document
 *    (viewers get read-only connections); access is re-verified periodically.
 *  - `sync:<userId>` pseudo-documents deliver "pokes" when Postgres reports changes, so clients
 *    pull immediately instead of polling.
 *  - Derived data (task order in lists, task note previews, search text) is written back on store.
 */

export interface CollabContext {
  userId: string;
}

export interface CollabOptions {
  sql: Sql;
  verify: TokenVerifier;
  internalSecret: string;
  logger: Logger;
  port: number;
  /** Debounce for persisting documents (ms). */
  debounce?: number;
  accessRecheckMs?: number;
}

type Access = 'none' | 'read' | 'write';

export async function documentAccess(sql: Sql, userId: string, name: string): Promise<Access> {
  if (name === `sync:${userId}`) return 'read';
  const parsed = parseDocName(name);
  if (!parsed) return 'none';
  return asUser(sql, { userId }, async (tx) => {
    if (parsed.kind === 'list') {
      const [row] = await tx<{ level: number; deleted: boolean | null }[]>`
        select app.list_level(${parsed.id}) as level, (select deleted_at is not null from lists where id = ${parsed.id}) as deleted`;
      if (!row || row.level === 0 || row.deleted) return 'none';
      return row.level >= 2 ? 'write' : 'read';
    }
    const [row] = await tx<{ visible: boolean; editable: boolean }[]>`
      select exists (select 1 from tasks where id = ${parsed.id} and deleted_at is null) as visible,
             exists (select 1 from app.editable_task_ids() x where x = ${parsed.id}) as editable`;
    if (!row?.visible) return 'none';
    return row.editable ? 'write' : 'read';
  }, { readOnly: true });
}

/** Persist a document and everything derived from it. Returns false if the owner is gone. */
export async function storeDocument(sql: Sql, name: string, doc: Y.Doc, logger?: Logger): Promise<boolean> {
  const parsed = parseDocName(name);
  if (!parsed) return false;
  const state = Y.encodeStateAsUpdate(doc);
  const plain = toPlainText(doc);
  const refs = extractRefs(doc);
  return asService(sql, async (tx) => {
    let workspaceId: string | undefined;
    if (parsed.kind === 'list') {
      const [l] = await tx<{ workspaceId: string }[]>`select workspace_id from lists where id = ${parsed.id}`;
      workspaceId = l?.workspaceId;
    } else {
      const [t] = await tx<{ workspaceId: string }[]>`select workspace_id from tasks where id = ${parsed.id}`;
      workspaceId = t?.workspaceId;
    }
    if (!workspaceId) {
      logger?.warn({ name }, 'document owner not found; not storing');
      return false;
    }
    await tx`
      insert into documents (name, workspace_id, list_id, task_id, state, plain_text, size_bytes)
      values (${name}, ${workspaceId}, ${parsed.kind === 'list' ? parsed.id : null}, ${parsed.kind === 'task' ? parsed.id : null},
              ${Buffer.from(state)}, ${plain}, ${state.byteLength})
      on conflict (name) do update set state = excluded.state, plain_text = excluded.plain_text,
        size_bytes = excluded.size_bytes, updated_at = now(), deleted_at = null`;

    // Keep tasks.position in document order so non-editor views (MCP, exports, widgets) agree.
    const siblings = await (parsed.kind === 'list'
      ? tx<{ id: string; position: string }[]>`select id, position from tasks where list_id = ${parsed.id} and parent_task_id is null and deleted_at is null`
      : tx<{ id: string; position: string }[]>`select id, position from tasks where parent_task_id = ${parsed.id} and deleted_at is null`);
    const known = new Set(siblings.map((s) => s.id));
    const docOrder = refs.taskIds.filter((id) => known.has(id));
    const byPosition = siblings
      .filter((s) => docOrder.includes(s.id))
      .sort((a, b) => (a.position < b.position ? -1 : a.position > b.position ? 1 : a.id < b.id ? -1 : 1))
      .map((s) => s.id);
    if (docOrder.length > 1 && docOrder.join() !== byPosition.join()) {
      const keys = positionsBetween(null, null, docOrder.length);
      for (let i = 0; i < docOrder.length; i++) await tx`update tasks set position = ${keys[i]!} where id = ${docOrder[i]!}`;
    }

    if (parsed.kind === 'task') {
      const preview = previewText(doc);
      await tx`update tasks set has_details = ${Boolean(preview)}, details_preview = ${preview}
               where id = ${parsed.id} and (has_details is distinct from ${Boolean(preview)} or details_preview is distinct from ${preview})`;
    }

    // Hourly restorable snapshot while a document is being edited.
    await tx`
      insert into document_snapshots (document_id, state, reason)
      select d.id, d.state, 'periodic' from documents d
       where d.name = ${name}
         and not exists (select 1 from document_snapshots s where s.document_id = d.id and s.created_at > now() - interval '1 hour')`;
    return true;
  });
}

export function createCollabServer(opts: CollabOptions) {
  const { sql, verify, logger } = opts;
  const membersCache = new Map<string, { at: number; users: string[] }>();

  const server = new Server<CollabContext>({
    port: opts.port,
    name: 'orbit-collab',
    quiet: true,
    debounce: opts.debounce ?? 2000,
    maxDebounce: 10_000,
    async onAuthenticate({ token, documentName, connectionConfig }) {
      let userId: string;
      try {
        userId = (await verify(token)).userId;
      } catch {
        throw new Error('unauthorized');
      }
      const access = await documentAccess(sql, userId, documentName);
      if (access === 'none') throw new Error('forbidden');
      if (access === 'read') connectionConfig.readOnly = true;
      return { userId };
    },
    extensions: [
      new Database({
        fetch: async ({ documentName }) => {
          if (!parseDocName(documentName)) return null;
          const [row] = await asService(sql, (tx) => tx<{ state: Buffer | null }[]>`select state from documents where name = ${documentName} and deleted_at is null`);
          return row?.state ? new Uint8Array(row.state) : null;
        },
        store: async ({ documentName, document }) => {
          try {
            await storeDocument(sql, documentName, document as unknown as Y.Doc, logger);
          } catch (error) {
            logger.error({ err: String(error), documentName }, 'document store failed');
            throw error;
          }
        },
      }),
    ],
    async onRequest({ request, response }: { request: IncomingMessage; response: ServerResponse }) {
      const url = new URL(request.url ?? '/', 'http://internal');
      if (url.pathname === '/health') {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ ok: true, documents: server.hocuspocus.getDocumentsCount() }));
        throw null; // handled — stop default processing
      }
      if (url.pathname === '/internal/documents/append' && request.method === 'POST') {
        const secret = String(request.headers['x-internal-secret'] ?? '');
        if (!secret || !safeEqual(secret, opts.internalSecret)) {
          response.writeHead(401).end();
          throw null;
        }
        const chunks: Buffer[] = [];
        for await (const chunk of request) chunks.push(chunk as Buffer);
        try {
          const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { name: string; content: unknown[] };
          if (!parseDocName(body.name) || !Array.isArray(body.content)) throw new AppError('validation', 'bad request');
          const conn = await server.hocuspocus.openDirectConnection(body.name, { userId: 'system' });
          await conn.transact((doc) => appendJsonToDoc(doc as unknown as Y.Doc, body.content as never));
          await conn.disconnect();
          response.writeHead(200, { 'content-type': 'application/json' }).end('{"ok":true}');
        } catch (error) {
          logger.error({ err: String(error) }, 'internal append failed');
          response.writeHead(400, { 'content-type': 'application/json' }).end('{"ok":false}');
        }
        throw null;
      }
    },
  });

  async function usersOfWorkspace(ws: string): Promise<string[]> {
    const cached = membersCache.get(ws);
    if (cached && Date.now() - cached.at < 30_000) return cached.users;
    const rows = await asService(sql, (tx) => tx<{ userId: string }[]>`select user_id from workspace_members where workspace_id = ${ws}`);
    const users = rows.map((r) => r.userId);
    membersCache.set(ws, { at: Date.now(), users });
    return users;
  }

  function pokeUser(userId: string) {
    const doc = server.hocuspocus.documents.get(`sync:${userId}`) as HpDocument | undefined;
    doc?.broadcastStateless('poke');
  }

  let unlisten: (() => Promise<void>) | null = null;
  let recheck: ReturnType<typeof setInterval> | null = null;

  async function start() {
    await server.listen();
    const listener = await sql.listen('orbit_poke', (payload) => {
      const [kind, id] = payload.split(':');
      if (!id) return;
      if (kind === 'u') pokeUser(id);
      else if (kind === 'w') {
        membersCache.delete(id); // membership may be what changed
        void usersOfWorkspace(id)
          .then((users) => users.forEach(pokeUser))
          .catch((e) => logger.error({ err: String(e) }, 'poke routing failed'));
      }
    });
    unlisten = () => listener.unlisten();
    // Close connections whose access was revoked since they connected.
    recheck = setInterval(() => void recheckAccess(), opts.accessRecheckMs ?? 60_000);
    logger.info({ port: opts.port }, 'collaboration server listening');
  }

  async function recheckAccess() {
    for (const [name, document] of server.hocuspocus.documents) {
      if (name.startsWith('sync:')) continue;
      for (const connection of (document as HpDocument).getConnections()) {
        const ctx = (connection as unknown as { context?: CollabContext }).context;
        if (!ctx?.userId || ctx.userId === 'system') continue;
        try {
          const access = await documentAccess(sql, ctx.userId, name);
          if (access === 'none') connection.close({ code: 4403, reason: 'Access revoked' });
          else if (access === 'read' && !connection.readOnly) connection.readOnly = true;
        } catch (error) {
          logger.warn({ err: String(error), name }, 'access recheck failed');
        }
      }
    }
  }

  async function stop() {
    if (recheck) clearInterval(recheck);
    await unlisten?.();
    await server.destroy();
  }

  return { server, start, stop, recheckAccess };
}
