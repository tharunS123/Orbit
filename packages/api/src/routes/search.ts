import type { Hono } from 'hono';
import { z } from 'zod';
import { asUser, type Tx } from '@orbit/database';
import type { ApiEnv } from '../context';
import { query, rateLimit } from '../middleware';

/**
 * Global search: Postgres full-text (simple config, prefix matching) combined with trigram
 * similarity for typos and partial words. Everything runs as the user, so RLS filters results
 * — search can never surface something the user can't open.
 */

export const SEARCH_TYPES = ['task', 'list', 'note', 'comment', 'meeting', 'transcript', 'file', 'person', 'label'] as const;
export type SearchType = (typeof SEARCH_TYPES)[number];

export const searchQuerySchema = z.object({
  q: z.string().trim().min(1).max(200),
  types: z
    .string()
    .optional()
    .transform((v) => (v ? v.split(',').filter((t): t is SearchType => (SEARCH_TYPES as readonly string[]).includes(t)) : [...SEARCH_TYPES])),
  workspaceId: z.uuid().optional(),
  listId: z.uuid().optional(),
  assigneeId: z.uuid().optional(),
  labelId: z.uuid().optional(),
  creatorId: z.uuid().optional(),
  completed: z.enum(['any', 'open', 'done']).default('any'),
  due: z.enum(['any', 'overdue', 'today', 'week', 'none', 'scheduled']).default('any'),
  source: z.string().max(40).optional(),
  tz: z.string().max(64).default('UTC'),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});
export type SearchQuery = z.infer<typeof searchQuerySchema>;

export interface SearchResult {
  type: SearchType;
  id: string;
  title: string;
  snippet: string | null;
  score: number;
  workspaceId: string | null;
  listId: string | null;
  taskId: string | null;
  meetingId: string | null;
  meta: Record<string, unknown>;
}

/** "launch pla" → "launch & pla:*" (prefix match on the last word). */
export function toTsQuery(q: string): string {
  const words = q
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 8);
  if (!words.length) return '';
  return words.map((w, i) => (i === words.length - 1 ? `${w.replace(/-/g, '')}:*` : w.replace(/-/g, ''))).join(' & ');
}

export async function runSearch(tx: Tx, userId: string, q: SearchQuery): Promise<SearchResult[]> {
  const ts = toTsQuery(q.q);
  const like = `%${q.q.replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
  const want = new Set(q.types);
  const out: SearchResult[] = [];
  const ws = q.workspaceId ?? null;
  const list = q.listId ?? null;
  const hl = `StartSel=«,StopSel=»,MaxWords=18,MinWords=6,ShortWord=2,MaxFragments=1`;

  if (want.has('task') && ts) {
    const dueFilter =
      q.due === 'overdue' ? tx`and t.due_date < (now() at time zone app.valid_timezone(${q.tz}))::date and t.completed_at is null`
      : q.due === 'today' ? tx`and t.due_date = (now() at time zone app.valid_timezone(${q.tz}))::date`
      : q.due === 'week' ? tx`and t.due_date between (now() at time zone app.valid_timezone(${q.tz}))::date and (now() at time zone app.valid_timezone(${q.tz}))::date + 7`
      : q.due === 'none' ? tx`and t.due_date is null`
      : q.due === 'scheduled' ? tx`and t.due_date is not null`
      : tx``;
    const rows = await tx<{ id: string; title: string; snippet: string | null; score: number; workspaceId: string; listId: string | null; completedAt: string | null; dueDate: string | null; assigneeId: string | null }[]>`
      select t.id, t.title, t.workspace_id, t.list_id, t.completed_at, t.due_date, t.assignee_id,
             ts_headline('simple', coalesce(t.details_preview, ''), to_tsquery('simple', ${ts}), ${hl}) as snippet,
             ts_rank(t.search, to_tsquery('simple', ${ts})) * 2 + similarity(t.title, ${q.q}) as score
        from tasks t
       where t.deleted_at is null
         and (t.search @@ to_tsquery('simple', ${ts}) or t.title % ${q.q} or t.title ilike ${like})
         ${ws ? tx`and t.workspace_id = ${ws}` : tx``}
         ${list ? tx`and t.list_id = ${list}` : tx``}
         ${q.assigneeId ? tx`and t.assignee_id = ${q.assigneeId}` : tx``}
         ${q.labelId ? tx`and ${q.labelId}::uuid = any(t.label_ids)` : tx``}
         ${q.creatorId ? tx`and t.created_by = ${q.creatorId}` : tx``}
         ${q.completed === 'open' ? tx`and t.completed_at is null` : q.completed === 'done' ? tx`and t.completed_at is not null` : tx``}
         ${q.source ? tx`and t.source->>'provider' = ${q.source}` : tx``}
         ${dueFilter}
       order by (t.completed_at is null) desc, score desc
       limit ${q.limit}`;
    for (const r of rows)
      out.push({ type: 'task', id: r.id, title: r.title, snippet: r.snippet?.includes('«') ? r.snippet : null, score: r.score + (r.completedAt ? 0 : 0.2), workspaceId: r.workspaceId, listId: r.listId, taskId: r.id, meetingId: null, meta: { completed: Boolean(r.completedAt), dueDate: r.dueDate, assigneeId: r.assigneeId } });
  }

  const taskScopedFilter = Boolean(q.assigneeId || q.labelId || q.completed !== 'any' || q.due !== 'any' || q.source);

  if (want.has('list') && !taskScopedFilter) {
    const rows = await tx<{ id: string; title: string; emoji: string | null; workspaceId: string; score: number }[]>`
      select l.id, l.title, l.emoji, l.workspace_id, similarity(l.title, ${q.q}) + case when l.title ilike ${like} then 0.5 else 0 end as score
        from lists l
       where l.deleted_at is null and (l.title % ${q.q} or l.title ilike ${like})
         ${ws ? tx`and l.workspace_id = ${ws}` : tx``}
         ${q.creatorId ? tx`and l.created_by = ${q.creatorId}` : tx``}
       order by score desc limit ${q.limit}`;
    for (const r of rows) out.push({ type: 'list', id: r.id, title: r.title || 'Untitled list', snippet: null, score: r.score + 0.3, workspaceId: r.workspaceId, listId: r.id, taskId: null, meetingId: null, meta: { emoji: r.emoji } });
  }

  if (want.has('note') && ts && !taskScopedFilter) {
    const rows = await tx<{ id: string; listId: string | null; taskId: string | null; workspaceId: string; title: string | null; snippet: string; score: number }[]>`
      select d.id, d.list_id, d.task_id, d.workspace_id, coalesce(l.title, t.title) as title,
             ts_headline('simple', left(d.plain_text, 20000), to_tsquery('simple', ${ts}), ${hl}) as snippet,
             ts_rank(d.search, to_tsquery('simple', ${ts})) as score
        from documents d
        left join lists l on l.id = d.list_id
        left join tasks t on t.id = d.task_id
       where d.deleted_at is null and d.search @@ to_tsquery('simple', ${ts})
         ${ws ? tx`and d.workspace_id = ${ws}` : tx``}
         ${list ? tx`and (d.list_id = ${list} or t.list_id = ${list})` : tx``}
       order by score desc limit ${q.limit}`;
    for (const r of rows) out.push({ type: 'note', id: r.id, title: r.title || 'Untitled', snippet: r.snippet, score: r.score, workspaceId: r.workspaceId, listId: r.listId, taskId: r.taskId, meetingId: null, meta: {} });
  }

  if (want.has('comment') && ts && !taskScopedFilter) {
    const rows = await tx<{ id: string; taskId: string; workspaceId: string; title: string; snippet: string; authorId: string; score: number; createdAt: string }[]>`
      select m.id, m.task_id, m.workspace_id, t.title, m.author_id, m.created_at,
             ts_headline('simple', m.body, to_tsquery('simple', ${ts}), ${hl}) as snippet,
             ts_rank(m.search, to_tsquery('simple', ${ts})) as score
        from task_messages m join tasks t on t.id = m.task_id
       where m.deleted_at is null and m.search @@ to_tsquery('simple', ${ts})
         ${ws ? tx`and m.workspace_id = ${ws}` : tx``}
       order by score desc limit ${q.limit}`;
    for (const r of rows) out.push({ type: 'comment', id: r.id, title: r.title, snippet: r.snippet, score: r.score, workspaceId: r.workspaceId, listId: null, taskId: r.taskId, meetingId: null, meta: { authorId: r.authorId, createdAt: r.createdAt } });
  }

  if (want.has('meeting') && !taskScopedFilter) {
    const rows = await tx<{ id: string; title: string; workspaceId: string; startedAt: string; score: number }[]>`
      select m.id, m.title, m.workspace_id, m.started_at, similarity(m.title, ${q.q}) + case when m.title ilike ${like} then 0.5 else 0 end as score
        from meeting_sessions m
       where m.deleted_at is null and (m.title % ${q.q} or m.title ilike ${like})
         ${ws ? tx`and m.workspace_id = ${ws}` : tx``}
       order by score desc limit ${q.limit}`;
    for (const r of rows) out.push({ type: 'meeting', id: r.id, title: r.title, snippet: null, score: r.score + 0.2, workspaceId: r.workspaceId, listId: null, taskId: null, meetingId: r.id, meta: { startedAt: r.startedAt } });
  }

  if (want.has('transcript') && ts && !taskScopedFilter) {
    const rows = await tx<{ id: string; meetingId: string; title: string; startMs: number; speaker: string | null; snippet: string; score: number; workspaceId: string }[]>`
      select s.id, s.meeting_id, m.title, m.workspace_id, s.start_ms, s.speaker,
             ts_headline('simple', s.text, to_tsquery('simple', ${ts}), ${hl}) as snippet,
             ts_rank(s.search, to_tsquery('simple', ${ts})) as score
        from meeting_transcript_segments s join meeting_sessions m on m.id = s.meeting_id
       where m.deleted_at is null and s.search @@ to_tsquery('simple', ${ts})
         ${ws ? tx`and m.workspace_id = ${ws}` : tx``}
       order by score desc limit ${q.limit}`;
    for (const r of rows) out.push({ type: 'transcript', id: r.id, title: r.title, snippet: r.snippet, score: r.score, workspaceId: r.workspaceId, listId: null, taskId: null, meetingId: r.meetingId, meta: { startMs: r.startMs, speaker: r.speaker } });
  }

  if (want.has('file') && !taskScopedFilter) {
    const rows = await tx<{ id: string; name: string; mimeType: string; sizeBytes: number; taskId: string | null; listId: string | null; workspaceId: string; score: number }[]>`
      select a.id, a.name, a.mime_type, a.size_bytes, a.task_id, a.list_id, a.workspace_id,
             similarity(a.name, ${q.q}) + case when a.name ilike ${like} then 0.5 else 0 end as score
        from attachments a
       where a.deleted_at is null and a.status = 'ready' and (a.name % ${q.q} or a.name ilike ${like})
         ${ws ? tx`and a.workspace_id = ${ws}` : tx``}
       order by score desc limit ${q.limit}`;
    for (const r of rows) out.push({ type: 'file', id: r.id, title: r.name, snippet: null, score: r.score, workspaceId: r.workspaceId, listId: r.listId, taskId: r.taskId, meetingId: null, meta: { mimeType: r.mimeType, sizeBytes: r.sizeBytes } });
  }

  if (want.has('person') && !taskScopedFilter) {
    const rows = await tx<{ id: string; displayName: string; email: string | null; avatarPath: string | null; score: number }[]>`
      select p.id, p.display_name, p.email, p.avatar_path,
             greatest(similarity(p.display_name, ${q.q}), similarity(coalesce(p.email, ''), ${q.q})) as score
        from profiles p
       where p.deleted_at is null and (p.display_name ilike ${like} or p.email ilike ${like} or p.display_name % ${q.q})
       order by score desc limit ${Math.min(q.limit, 10)}`;
    for (const r of rows) out.push({ type: 'person', id: r.id, title: r.displayName, snippet: r.email, score: r.score + 0.1, workspaceId: null, listId: null, taskId: null, meetingId: null, meta: { avatarPath: r.avatarPath } });
  }

  if (want.has('label') && !taskScopedFilter) {
    const rows = await tx<{ id: string; name: string; color: string; workspaceId: string; score: number }[]>`
      select id, name, color, workspace_id, similarity(name, ${q.q}) + case when name ilike ${like} then 0.5 else 0 end as score
        from labels where deleted_at is null and (name % ${q.q} or name ilike ${like})
        ${ws ? tx`and workspace_id = ${ws}` : tx``}
       order by score desc limit 10`;
    for (const r of rows) out.push({ type: 'label', id: r.id, title: r.name, snippet: null, score: r.score, workspaceId: r.workspaceId, listId: null, taskId: null, meetingId: null, meta: { color: r.color } });
  }

  return out.sort((a, b) => b.score - a.score).slice(0, q.limit * 2);
}

export function searchRoutes(app: Hono<ApiEnv>, authed: Hono<ApiEnv>) {
  authed.get('/search', rateLimit('search', 120, 60), async (c) => {
    const q = query(c, searchQuerySchema);
    const results = await asUser(c.get('deps').sql, { userId: c.get('user').userId }, async (tx) => {
      await tx`select set_config('pg_trgm.similarity_threshold', '0.25', true)`;
      return runSearch(tx, c.get('user').userId, q);
    }, { readOnly: true });
    return c.json({ results });
  });
}
