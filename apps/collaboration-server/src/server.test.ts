import { createServer } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import WebSocket from 'ws';
import pino from 'pino';
import { HocuspocusProvider, HocuspocusProviderWebsocket } from '@hocuspocus/provider';
import { asService, type Sql } from '@orbit/database';
import { createTestDatabase, createTestUser, type TestDatabase, type TestUser } from '@orbit/database/testing';
import { jsonToYUpdate } from '@orbit/editor/schema';
import { toPlainText } from '@orbit/editor/ydoc';
import { createCollabServer, documentAccess, storeDocument } from './server';

let db: TestDatabase;
let sql: Sql;
let owner: TestUser;
let viewer: TestUser;
let stranger: TestUser;
let listId: string;
let taskA: string;
let taskB: string;

const svc = <T>(fn: Parameters<typeof asService<T>>[1]) => asService(sql, fn);
const para = (text: string) => ({ type: 'paragraph', content: [{ type: 'text', text }] });
const ref = (taskId: string) => ({ type: 'taskRef', attrs: { taskId } });
const docFrom = (content: unknown[]) => {
  const d = new Y.Doc();
  Y.applyUpdate(d, jsonToYUpdate(content as never));
  return d;
};

beforeAll(async () => {
  db = await createTestDatabase();
  sql = db.sql;
  owner = await createTestUser(sql, 'Owner');
  viewer = await createTestUser(sql, 'Viewer');
  stranger = await createTestUser(sql, 'Stranger');
  await svc(async (tx) => {
    const [list] = await tx<{ id: string }[]>`insert into lists (workspace_id, created_by, title) values (${owner.personalWorkspaceId}, ${owner.id}, 'Plan') returning id`;
    listId = list!.id;
    // A list share makes the person a workspace guest plus a list member (as accepting an invite does).
    await tx`insert into workspace_members (workspace_id, user_id, role) values (${owner.personalWorkspaceId}, ${viewer.id}, 'guest')`;
    await tx`insert into list_members (list_id, workspace_id, user_id, role, added_by) values (${listId}, ${owner.personalWorkspaceId}, ${viewer.id}, 'viewer', ${owner.id})`;
    const rows = await tx<{ id: string }[]>`
      insert into tasks (workspace_id, list_id, created_by, title, position)
      values (${owner.personalWorkspaceId}, ${listId}, ${owner.id}, 'A', 'a0'), (${owner.personalWorkspaceId}, ${listId}, ${owner.id}, 'B', 'a1')
      returning id`;
    [taskA, taskB] = rows.map((r) => r.id) as [string, string];
  });
});
afterAll(async () => {
  await db.close();
});

describe('documentAccess', () => {
  it('maps list roles to connection modes', async () => {
    expect(await documentAccess(sql, owner.id, `list:${listId}`)).toBe('write');
    expect(await documentAccess(sql, viewer.id, `list:${listId}`)).toBe('read');
    expect(await documentAccess(sql, stranger.id, `list:${listId}`)).toBe('none');
    expect(await documentAccess(sql, viewer.id, `task:${taskA}`)).toBe('read');
    expect(await documentAccess(sql, owner.id, `task:${taskA}`)).toBe('write');
  });

  it('only exposes a user their own sync channel and rejects malformed names', async () => {
    expect(await documentAccess(sql, owner.id, `sync:${owner.id}`)).toBe('read');
    expect(await documentAccess(sql, owner.id, `sync:${viewer.id}`)).toBe('none');
    expect(await documentAccess(sql, owner.id, 'list:not-a-uuid')).toBe('none');
    expect(await documentAccess(sql, owner.id, `other:${listId}`)).toBe('none');
  });
});

describe('storeDocument', () => {
  it('persists state and text, and reorders tasks to match the document', async () => {
    const doc = docFrom([para('Intro'), ref(taskB), ref(taskA)]);
    expect(await storeDocument(sql, `list:${listId}`, doc)).toBe(true);
    const [row] = await svc((tx) => tx<{ plainText: string; sizeBytes: number }[]>`select plain_text, size_bytes from documents where name = ${`list:${listId}`}`);
    expect(row!.plainText).toContain('Intro');
    expect(row!.sizeBytes).toBeGreaterThan(0);
    const order = await svc((tx) => tx<{ id: string }[]>`select id from tasks where list_id = ${listId} order by position`);
    expect(order.map((r) => r.id)).toEqual([taskB, taskA]);
    // One periodic snapshot per hour, however often it is stored.
    await storeDocument(sql, `list:${listId}`, doc);
    const snaps = await svc((tx) => tx`select 1 from document_snapshots s join documents d on d.id = s.document_id where d.name = ${`list:${listId}`}`);
    expect(snaps).toHaveLength(1);
  });

  it('writes task note previews and refuses documents without an owner', async () => {
    await storeDocument(sql, `task:${taskA}`, docFrom([para('Call the venue before noon')]));
    const [t] = await svc((tx) => tx<{ hasDetails: boolean; detailsPreview: string }[]>`select has_details, details_preview from tasks where id = ${taskA}`);
    expect(t).toEqual({ hasDetails: true, detailsPreview: 'Call the venue before noon' });
    expect(await storeDocument(sql, 'list:00000000-0000-4000-8000-000000000000', docFrom([para('x')]))).toBe(false);
  });
});

async function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const s = createServer().listen(0, () => {
      const port = (s.address() as { port: number }).port;
      s.close(() => resolve(port));
    });
  });
}

describe('live collaboration', () => {
  it('authenticates, enforces read-only viewers and persists edits', async () => {
    const port = await freePort();
    const tokens: Record<string, string> = { 'owner-token': owner.id, 'viewer-token': viewer.id, 'stranger-token': stranger.id };
    const collab = createCollabServer({
      sql,
      port,
      debounce: 50,
      internalSecret: 'x'.repeat(32),
      logger: pino({ level: 'silent' }),
      verify: async (token) => {
        const userId = tokens[token];
        if (!userId) throw new Error('bad token');
        return { userId } as never;
      },
    });
    await collab.server.listen();

    const connect = (token: string) => {
      const socket = new HocuspocusProviderWebsocket({ url: `ws://127.0.0.1:${port}`, WebSocketPolyfill: WebSocket });
      const doc = new Y.Doc();
      const outcome = new Promise<'synced' | 'denied'>((resolve) => {
        const provider = new HocuspocusProvider({
          websocketProvider: socket,
          name: `list:${listId}`,
          document: doc,
          token,
          onSynced: () => resolve('synced'),
          onAuthenticationFailed: () => resolve('denied'),
        });
        provider.attach(); // shared sockets need explicit attachment
        closers.push(() => {
          provider.destroy();
          socket.destroy();
        });
      });
      return { doc, outcome };
    };
    const closers: (() => void)[] = [];

    try {
      expect(await connect('stranger-token').outcome).toBe('denied');
      expect(await connect('nope').outcome).toBe('denied');

      const writer = connect('owner-token');
      expect(await writer.outcome).toBe('synced');
      expect(toPlainText(writer.doc)).toContain('Intro'); // loaded from Postgres

      const reader = connect('viewer-token');
      expect(await reader.outcome).toBe('synced');

      // Owner edit reaches the viewer and is persisted.
      const edit = new Y.XmlElement('paragraph');
      edit.insert(0, [new Y.XmlText('Live edit')]);
      writer.doc.getXmlFragment('default').insert(0, [edit]);
      await expect.poll(() => toPlainText(reader.doc), { timeout: 5000 }).toContain('Live edit');
      await expect
        .poll(async () => (await svc((tx) => tx<{ plainText: string }[]>`select plain_text from documents where name = ${`list:${listId}`}`))[0]!.plainText, { timeout: 5000 })
        .toContain('Live edit');

      // A read-only connection's edits are dropped by the server.
      const frag = reader.doc.getXmlFragment('default');
      const el = new Y.XmlElement('paragraph');
      el.insert(0, [new Y.XmlText('Sneaky viewer edit')]);
      frag.insert(0, [el]);
      await new Promise((r) => setTimeout(r, 400));
      expect(toPlainText(writer.doc)).not.toContain('Sneaky');
      const [stored] = await svc((tx) => tx<{ plainText: string }[]>`select plain_text from documents where name = ${`list:${listId}`}`);
      expect(stored!.plainText).not.toContain('Sneaky');

      // Revoking access closes the viewer's connection on the next recheck.
      await svc((tx) => tx`update list_members set deleted_at = now() where list_id = ${listId} and user_id = ${viewer.id}`);
      await collab.recheckAccess();
      const doc = collab.server.hocuspocus.documents.get(`list:${listId}`)!;
      await expect.poll(() => doc.getConnectionsCount(), { timeout: 5000 }).toBe(1);
    } finally {
      closers.forEach((c) => c());
      await collab.server.destroy();
    }
  });
});
