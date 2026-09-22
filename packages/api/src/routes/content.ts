import type { Hono } from 'hono';
import { z } from 'zod';
import { strToU8, zipSync } from 'fflate';
import { AppError, PRODUCT, uuidv7, type Task } from '@orbit/shared';
import { buildTaskTree, formatBytes, planLimits, taskLine, taskTreeToMarkdown, taskTreeToText, tasksToCsv, type PlanId, type TaskTreeNode } from '@orbit/core';
import { issueSecret, requireRecentAuth, sha256 } from '@orbit/auth';
import { asAnon, asService, asUser, type Tx } from '@orbit/database';
import { docFromState } from '@orbit/editor/ydoc';
import { ydocToMarkdown } from '@orbit/editor/markdown';
import type { ApiEnv } from '../context';
import { clientIp } from '../context';
import { body, rateLimit, query } from '../middleware';

/** Attachments, uploads, public links, exports and account lifecycle. */

const ALLOWED_MIME = /^(image\/(png|jpe?g|gif|webp|heic|heif|avif|svg\+xml)|application\/pdf|text\/[\w.+-]+|audio\/[\w.+-]+|video\/[\w.+-]+|application\/(zip|x-zip-compressed|x-7z-compressed|x-tar|gzip|json|msword|rtf|vnd\.[\w.+-]+|octet-stream))$/;

function safeName(name: string): string {
  // Control characters are exactly what we want to strip from file names.
  // eslint-disable-next-line no-control-regex
  return name.replace(/[\u0000-\u001f\\/:*?"<>|]+/g, '_').slice(0, 200) || 'file';
}

async function loadDocMarkdown(tx: Tx, name: string, tasks: Task[], labels: Map<string, string>, people: Map<string, string>, lists: Map<string, string>): Promise<string | null> {
  const [doc] = await tx<{ state: Buffer | null }[]>`select state from documents where name = ${name} and deleted_at is null`;
  if (!doc?.state) return null;
  const byParent = new Map<string | null, Task[]>();
  for (const t of tasks) {
    const arr = byParent.get(t.parentTaskId) ?? [];
    arr.push(t);
    byParent.set(t.parentTaskId, arr);
  }
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const render = (task: Task, depth: number): string[] => {
    const line = `${'  '.repeat(depth)}- ${taskLine(task, { labels, people })}`;
    const kids = (byParent.get(task.id) ?? []).sort((a, b) => (a.position < b.position ? -1 : 1));
    return [line, ...kids.flatMap((k) => render(k, depth + 1))];
  };
  return ydocToMarkdown(docFromState(new Uint8Array(doc.state)), {
    task: (id) => {
      const t = byId.get(id);
      return t && !t.deletedAt ? render(t, 0) : null;
    },
    list: (id) => (lists.get(id) ? `- 📄 ${lists.get(id)}` : null),
  });
}

export function contentRoutes(app: Hono<ApiEnv>, authed: Hono<ApiEnv>) {
  // ───────────── public (anonymous) ─────────────
  app.get('/public/list', rateLimit('public-list', 120, 60, (c) => clientIp(c)), async (c) => {
    const token = z.string().min(20).max(200).parse(c.req.query('token'));
    const [row] = await asAnon(c.get('deps').sql, (tx) => tx<{ data: unknown }[]>`select app.public_list_by_token(${sha256(token)}) as data`);
    if (!row?.data) throw new AppError('not_found', 'This link is no longer available.');
    c.header('cache-control', 'private, max-age=30');
    c.header('x-robots-tag', 'noindex');
    return c.json(row.data);
  });


  // ───────────── attachments ─────────────
  authed.post('/attachments/upload-url', rateLimit('upload', 120, 60), async (c) => {
    const deps = c.get('deps');
    const user = c.get('user');
    const input = await body(
      c,
      z.object({
        id: z.uuid(),
        workspaceId: z.uuid(),
        taskId: z.uuid().nullable().default(null),
        listId: z.uuid().nullable().default(null),
        messageId: z.uuid().nullable().default(null),
        name: z.string().trim().min(1).max(255),
        mimeType: z.string().max(120),
        sizeBytes: z.number().int().positive(),
      }),
    );
    const mime = input.mimeType || 'application/octet-stream';
    if (!ALLOWED_MIME.test(mime)) throw new AppError('validation', 'This file type is not supported.');
    const storagePath = `attachments/${input.workspaceId}/${input.id}/${safeName(input.name)}`;
    await asUser(deps.sql, { userId: user.userId }, async (tx) => {
      const [plan] = await tx<{ plan: PlanId }[]>`select app.user_plan(${user.userId}) as plan`;
      const limits = planLimits(plan?.plan ?? 'free');
      if (input.sizeBytes > limits.maxFileBytes)
        throw new AppError('quota_exceeded', `Files can be up to ${formatBytes(limits.maxFileBytes)} on your plan.`, { feature: 'file_size' });
      const [used] = await tx<{ bytes: number }[]>`select app.storage_bytes(${user.userId}) as bytes`;
      if ((used?.bytes ?? 0) + input.sizeBytes > limits.storageBytes)
        throw new AppError('quota_exceeded', `You've used your ${formatBytes(limits.storageBytes)} of storage. Delete files or upgrade.`, { feature: 'storage' });
      // Inserting the pending row as the user is the authorization check (RLS).
      await tx`insert into attachments (id, workspace_id, task_id, list_id, message_id, uploaded_by, name, mime_type, size_bytes, storage_path, status)
               values (${input.id}, ${input.workspaceId}, ${input.taskId}, ${input.listId}, ${input.messageId}, ${user.userId},
                       ${input.name}, ${mime}, ${input.sizeBytes}, ${storagePath}, 'pending')`;
    });
    const signed = await deps.storage.signUpload(storagePath);
    return c.json({ uploadUrl: signed.url, token: signed.token, storagePath });
  });

  authed.post('/attachments/:id/complete', async (c) => {
    const deps = c.get('deps');
    const id = z.uuid().parse(c.req.param('id'));
    const dims = await body(c, z.object({ width: z.number().int().positive().max(40000).nullable().default(null), height: z.number().int().positive().max(40000).nullable().default(null) }));
    const [att] = await asUser(deps.sql, { userId: c.get('user').userId }, (tx) =>
      tx<{ storagePath: string; sizeBytes: number; status: string; taskId: string | null; listId: string | null; workspaceId: string; name: string }[]>`
        select storage_path, size_bytes, status, task_id, list_id, workspace_id, name from attachments where id = ${id} and uploaded_by = ${c.get('user').userId}`);
    if (!att) throw new AppError('not_found', 'Upload not found.');
    const info = await deps.storage.exists(att.storagePath);
    if (!info) throw new AppError('validation', 'The upload did not finish. Please retry.');
    // Trust the stored object's real size for quotas, not the client's claim.
    await asUser(deps.sql, { userId: c.get('user').userId }, async (tx) => {
      await tx`update attachments set status = 'ready', size_bytes = ${info.size || att.sizeBytes}, width = ${dims.width}, height = ${dims.height} where id = ${id}`;
      await tx`insert into activity_events (workspace_id, task_id, list_id, actor_id, type, data)
               values (${att.workspaceId}, ${att.taskId}, ${att.listId}, ${c.get('user').userId}, 'attachment_added', ${tx.json({ name: att.name })})`;
    });
    return c.json({ ok: true });
  });

  authed.post('/attachments/:id/replace-url', async (c) => {
    const deps = c.get('deps');
    const id = z.uuid().parse(c.req.param('id'));
    const input = await body(c, z.object({ name: z.string().trim().min(1).max(255), mimeType: z.string().max(120), sizeBytes: z.number().int().positive() }));
    if (!ALLOWED_MIME.test(input.mimeType)) throw new AppError('validation', 'This file type is not supported.');
    const [att] = await asUser(deps.sql, { userId: c.get('user').userId }, (tx) => tx<{ workspaceId: string }[]>`select workspace_id from attachments where id = ${id} and deleted_at is null`);
    if (!att) throw new AppError('not_found', 'File not found.');
    const storagePath = `attachments/${att.workspaceId}/${id}/${uuidv7().slice(-8)}-${safeName(input.name)}`;
    const signed = await deps.storage.signUpload(storagePath);
    return c.json({ uploadUrl: signed.url, token: signed.token, storagePath });
  });

  authed.post('/attachments/:id/replace-complete', async (c) => {
    const deps = c.get('deps');
    const id = z.uuid().parse(c.req.param('id'));
    const input = await body(c, z.object({ storagePath: z.string().max(500), name: z.string().trim().min(1).max(255), mimeType: z.string().max(120) }));
    const old = await asUser(deps.sql, { userId: c.get('user').userId }, async (tx) => {
      const [row] = await tx<{ storagePath: string; workspaceId: string }[]>`select storage_path, workspace_id from attachments where id = ${id} and deleted_at is null`;
      if (!row) throw new AppError('not_found', 'File not found.');
      if (!input.storagePath.startsWith(`attachments/${row.workspaceId}/${id}/`)) throw new AppError('validation', 'Invalid upload path.');
      const info = await deps.storage.exists(input.storagePath);
      if (!info) throw new AppError('validation', 'The upload did not finish. Please retry.');
      const res = await tx`update attachments set storage_path = ${input.storagePath}, name = ${input.name}, mime_type = ${input.mimeType}, size_bytes = ${info.size}, status = 'ready'
                           where id = ${id} returning id`;
      if (!res.length) throw new AppError('forbidden', 'You cannot replace this file.');
      return row.storagePath;
    });
    await deps.storage.remove([old]).catch(() => undefined);
    return c.json({ ok: true });
  });

  authed.get('/attachments/:id/url', async (c) => {
    const deps = c.get('deps');
    const id = z.uuid().parse(c.req.param('id'));
    const download = c.req.query('download') === '1';
    const [att] = await asUser(deps.sql, { userId: c.get('user').userId }, (tx) => tx<{ storagePath: string; name: string; status: string }[]>`
      select storage_path, name, status from attachments where id = ${id} and deleted_at is null`);
    if (!att || att.status !== 'ready') throw new AppError('not_found', 'File not found.');
    const url = await deps.storage.signDownload(att.storagePath, 600, download ? att.name : undefined);
    return c.json({ url, expiresIn: 600 });
  });

  // Avatars and list covers live under per-owner prefixes and are signed on request.
  authed.post('/uploads/image-url', rateLimit('image-upload', 60, 60), async (c) => {
    const deps = c.get('deps');
    const user = c.get('user');
    const input = await body(c, z.object({ kind: z.enum(['avatar', 'cover']), listId: z.uuid().optional(), mimeType: z.string().regex(/^image\/(png|jpe?g|webp|gif)$/), sizeBytes: z.number().int().positive().max(10 * 1024 * 1024) }));
    let path: string;
    if (input.kind === 'avatar') path = `avatars/${user.userId}/${uuidv7()}`;
    else {
      if (!input.listId) throw new AppError('validation', 'listId is required for covers.');
      const [ok] = await asUser(deps.sql, { userId: user.userId }, (tx) => tx<{ level: number }[]>`select app.list_level(${input.listId!}) as level`);
      if ((ok?.level ?? 0) < 2) throw new AppError('forbidden', 'You cannot edit this list.');
      path = `covers/${input.listId}/${uuidv7()}`;
    }
    const signed = await deps.storage.signUpload(path);
    return c.json({ uploadUrl: signed.url, token: signed.token, path });
  });

  authed.get('/uploads/image', async (c) => {
    const deps = c.get('deps');
    const path = z.string().regex(/^(avatars\/[0-9a-f-]{36}|covers\/[0-9a-f-]{36})\/[0-9a-f-]{36}$/).parse(c.req.query('path'));
    if (path.startsWith('covers/')) {
      const listId = path.split('/')[1]!;
      const [ok] = await asUser(deps.sql, { userId: c.get('user').userId }, (tx) => tx<{ level: number }[]>`select app.list_level(${listId}) as level`);
      if ((ok?.level ?? 0) < 1) throw new AppError('not_found', 'Image not found.');
    }
    const url = await deps.storage.signDownload(path, 3600);
    c.header('cache-control', 'private, max-age=1800');
    return c.json({ url });
  });

  // ───────────── public links ─────────────
  authed.get('/lists/:id/public-link', async (c) => {
    const id = z.uuid().parse(c.req.param('id'));
    const rows = await asUser(c.get('deps').sql, { userId: c.get('user').userId }, (tx) => tx`select id, created_at from list_public_links where list_id = ${id} and revoked_at is null`);
    return c.json({ active: rows.length > 0, createdAt: rows[0]?.createdAt ?? null });
  });

  authed.post('/lists/:id/public-link', async (c) => {
    const deps = c.get('deps');
    if (!deps.flags.publicLinks) throw new AppError('unavailable', 'Public links are disabled.');
    const id = z.uuid().parse(c.req.param('id'));
    const secret = issueSecret('', 24);
    await asUser(deps.sql, { userId: c.get('user').userId }, async (tx) => {
      const [list] = await tx<{ workspaceId: string }[]>`select workspace_id from lists where id = ${id} and deleted_at is null`;
      if (!list) throw new AppError('not_found', 'List not found.');
      await tx`update list_public_links set revoked_at = now() where list_id = ${id} and revoked_at is null`;
      await tx`insert into list_public_links (list_id, workspace_id, token_hash, created_by) values (${id}, ${list.workspaceId}, ${secret.hash}, ${c.get('user').userId})`;
      await tx`insert into activity_events (workspace_id, list_id, actor_id, type) values (${list.workspaceId}, ${id}, ${c.get('user').userId}, 'public_link_created')`;
    });
    return c.json({ url: `${deps.env.APP_URL}/p?token=${secret.token}` });
  });

  authed.delete('/lists/:id/public-link', async (c) => {
    const id = z.uuid().parse(c.req.param('id'));
    await asUser(c.get('deps').sql, { userId: c.get('user').userId }, (tx) => tx`update list_public_links set revoked_at = now() where list_id = ${id} and revoked_at is null`);
    return c.json({ ok: true });
  });

  // ───────────── exports ─────────────
  authed.get('/lists/:id/export', async (c) => {
    const deps = c.get('deps');
    const id = z.uuid().parse(c.req.param('id'));
    const { format } = query(c, z.object({ format: z.enum(['md', 'json', 'txt', 'csv']).default('md') }));
    const result = await asUser(deps.sql, { userId: c.get('user').userId }, async (tx) => {
      const [list] = await tx<{ id: string; title: string; emoji: string | null; workspaceId: string }[]>`select id, title, emoji, workspace_id from lists where id = ${id} and deleted_at is null`;
      if (!list) throw new AppError('not_found', 'List not found.');
      const tasks = await tx<Task[]>`select * from tasks where list_id = ${id} and deleted_at is null order by position, id`;
      const labels = new Map((await tx<{ id: string; name: string }[]>`select id, name from labels where workspace_id = ${list.workspaceId}`).map((l) => [l.id, l.name]));
      const people = new Map((await tx<{ id: string; displayName: string }[]>`select id, display_name from profiles`).map((p) => [p.id, p.displayName]));
      const sublists = new Map((await tx<{ id: string; title: string }[]>`select id, title from lists where parent_list_id = ${id} and deleted_at is null`).map((l) => [l.id, l.title]));
      const docMd = await loadDocMarkdown(tx, `list:${id}`, tasks, labels, people, sublists);
      return { list, tasks, labels, people, docMd };
    });
    const title = `${result.list.emoji ? `${result.list.emoji} ` : ''}${result.list.title || 'Untitled list'}`;
    const fileBase = safeName(result.list.title || 'list');
    const tree: TaskTreeNode[] = buildTaskTree(result.tasks);
    let content: string;
    let type: string;
    let ext: string;
    switch (format) {
      case 'json':
        content = JSON.stringify({ exportedAt: new Date().toISOString(), product: PRODUCT.name, list: result.list, tasks: result.tasks, markdown: result.docMd }, null, 2);
        type = 'application/json';
        ext = 'json';
        break;
      case 'txt':
        content = `${title}\n\n${taskTreeToText(tree)}\n`;
        type = 'text/plain';
        ext = 'txt';
        break;
      case 'csv':
        content = tasksToCsv(result.tasks, { labels: result.labels, people: result.people });
        type = 'text/csv';
        ext = 'csv';
        break;
      default:
        content = `# ${title}\n\n${result.docMd ?? taskTreeToMarkdown(tree, { labels: result.labels, people: result.people })}\n`;
        type = 'text/markdown';
        ext = 'md';
    }
    return new Response(content, {
      headers: { 'content-type': `${type}; charset=utf-8`, 'content-disposition': `attachment; filename="${fileBase}.${ext}"` },
    });
  });

  // Full account export: JSON backup + Markdown per list + attachment manifest, zipped.
  authed.post('/account/export', rateLimit('account-export', 5, 3600), async (c) => {
    const deps = c.get('deps');
    const userId = c.get('user').userId;
    const files: Record<string, Uint8Array> = {};
    await asUser(deps.sql, { userId }, async (tx) => {
      const profile = await tx`select id, email, display_name, timezone, locale, settings, created_at from profiles where id = ${userId}`;
      const workspaces = await tx`select * from workspaces where id in (select app.my_workspace_ids())`;
      const lists = await tx<{ id: string; title: string; workspaceId: string }[]>`select id, workspace_id, parent_list_id, title, emoji, description, visibility, created_at, updated_at, archived_at from lists where deleted_at is null`;
      const tasks = await tx<Task[]>`select * from tasks where deleted_at is null`;
      const messages = await tx`select id, task_id, author_id, body, kind, created_at, edited_at from task_messages where deleted_at is null`;
      const labels = await tx<{ id: string; name: string }[]>`select id, workspace_id, name, color from labels where deleted_at is null`;
      const attachments = await tx`select id, task_id, list_id, name, mime_type, size_bytes, created_at from attachments where deleted_at is null and status = 'ready'`;
      const meetings = await tx`select id, title, started_at, ended_at, duration_ms from meeting_sessions where deleted_at is null`;
      const completions = await tx`select task_id, occurrence_date, completed_at from task_completions where user_id = ${userId} and undone_at is null`;
      files['backup.json'] = strToU8(JSON.stringify({ exportedAt: new Date().toISOString(), profile: profile[0], workspaces, lists, tasks, labels, messages, meetings, completions }, null, 2));
      files['attachments-manifest.json'] = strToU8(JSON.stringify(attachments, null, 2));
      const labelMap = new Map(labels.map((l) => [l.id, l.name]));
      const people = new Map((await tx<{ id: string; displayName: string }[]>`select id, display_name from profiles`).map((p) => [p.id, p.displayName]));
      const listTitles = new Map(lists.map((l) => [l.id, l.title]));
      for (const l of lists) {
        const lt = tasks.filter((t) => t.listId === l.id);
        const md = (await loadDocMarkdown(tx, `list:${l.id}`, lt, labelMap, people, listTitles)) ?? taskTreeToMarkdown(buildTaskTree(lt), { labels: labelMap, people });
        files[`lists/${safeName(l.title || 'Untitled')}-${l.id.slice(0, 8)}.md`] = strToU8(`# ${l.title || 'Untitled list'}\n\n${md}`);
      }
      const inbox = tasks.filter((t) => !t.listId);
      files['inbox.md'] = strToU8(`# Inbox\n\n${taskTreeToMarkdown(buildTaskTree(inbox), { labels: labelMap, people })}\n`);
    }, { readOnly: true, isolation: 'repeatable read' });
    await asService(deps.sql, (tx) => tx`insert into audit_log (user_id, action, ip) values (${userId}, 'account.export', ${clientIp(c)})`);
    const zip = zipSync(files, { level: 6 });
    return new Response(zip, {
      headers: { 'content-type': 'application/zip', 'content-disposition': `attachment; filename="${PRODUCT.name.toLowerCase()}-export-${new Date().toISOString().slice(0, 10)}.zip"` },
    });
  });

  // Account deletion: requires a fresh sign-in; blocked while the user owns team workspaces.
  authed.post('/account/delete', rateLimit('account-delete', 5, 3600), async (c) => {
    const deps = c.get('deps');
    const user = c.get('user');
    requireRecentAuth(user, 900);
    const { confirm } = await body(c, z.object({ confirm: z.literal('DELETE') }));
    void confirm;
    const owned = await asUser(deps.sql, { userId: user.userId }, (tx) => tx<{ name: string; members: number }[]>`
      select w.name, (select count(*)::int from workspace_members m where m.workspace_id = w.id and m.deleted_at is null) as members
        from workspaces w where w.owner_id = ${user.userId} and w.kind = 'team' and w.deleted_at is null`);
    const blocking = owned.filter((w) => w.members > 1);
    if (blocking.length) {
      throw new AppError('validation', `Transfer ownership or delete these workspaces first: ${blocking.map((w) => w.name).join(', ')}.`, { workspaces: blocking.map((w) => w.name) });
    }
    await asService(deps.sql, async (tx) => {
      await tx`insert into account_deletions (user_id) values (${user.userId}) on conflict (user_id) do nothing`;
      await tx`insert into audit_log (user_id, action, ip) values (${user.userId}, 'account.delete_requested', ${clientIp(c)})`;
    });
    await deps.queue.send([{ name: 'account.delete', data: { userId: user.userId }, opts: { singletonKey: user.userId } }]);
    return c.json({ ok: true });
  });

}
