-- Meetings, transcripts, AI jobs and usage metering.

create table public.meeting_sessions (
  id               uuid primary key default gen_random_uuid(),
  workspace_id     uuid not null references public.workspaces (id) on delete cascade,
  created_by       uuid not null references public.profiles (id),
  title            text not null default 'Untitled meeting' check (char_length(title) <= 300),
  status           text not null default 'recording'
                   check (status in ('recording', 'uploading', 'processing', 'ready', 'failed')),
  visibility       text not null default 'private' check (visibility in ('private', 'shared', 'workspace')),
  source           text not null default 'web' check (source in ('web', 'desktop', 'mobile', 'upload')),
  capture_mode     text not null default 'microphone' check (capture_mode in ('microphone', 'system', 'mixed')),
  language         text,
  started_at       timestamptz not null default now(),
  ended_at         timestamptz,
  duration_ms      integer,
  audio_path       text,
  audio_deleted_at timestamptz,
  retention_until  timestamptz,
  error            text,
  list_id          uuid references public.lists (id) on delete set null,
  consent_confirmed boolean not null default false,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  deleted_at       timestamptz,
  change_xid       xid8 not null default pg_current_xact_id()
);
create index meeting_sessions_ws_idx on public.meeting_sessions (workspace_id, started_at desc) where deleted_at is null;
create index meeting_sessions_title_trgm_idx on public.meeting_sessions using gin (title extensions.gin_trgm_ops);
select app.replicate('public.meeting_sessions', 'workspace');

create table public.meeting_shares (
  id          uuid primary key default gen_random_uuid(),
  meeting_id  uuid not null references public.meeting_sessions (id) on delete cascade,
  user_id     uuid not null references public.profiles (id) on delete cascade,
  added_by    uuid not null references public.profiles (id),
  created_at  timestamptz not null default now(),
  unique (meeting_id, user_id)
);

create table public.meeting_public_links (
  id          uuid primary key default gen_random_uuid(),
  meeting_id  uuid not null references public.meeting_sessions (id) on delete cascade,
  token_hash  text not null unique,
  created_by  uuid not null references public.profiles (id),
  created_at  timestamptz not null default now(),
  revoked_at  timestamptz
);

create table public.meeting_participants (
  id             uuid primary key default gen_random_uuid(),
  meeting_id     uuid not null references public.meeting_sessions (id) on delete cascade,
  user_id        uuid references public.profiles (id) on delete set null,
  display_name   text not null,
  speaker_label  text,
  created_at     timestamptz not null default now(),
  unique (meeting_id, speaker_label)
);

create table public.meeting_audio_chunks (
  id          uuid primary key default gen_random_uuid(),
  meeting_id  uuid not null references public.meeting_sessions (id) on delete cascade,
  seq         integer not null,
  storage_path text not null,
  start_ms    integer not null,
  duration_ms integer not null,
  size_bytes  integer not null,
  transcribed_at timestamptz,
  created_at  timestamptz not null default now(),
  unique (meeting_id, seq)
);

create table public.meeting_transcript_segments (
  id          uuid primary key default gen_random_uuid(),
  meeting_id  uuid not null references public.meeting_sessions (id) on delete cascade,
  chunk_seq   integer not null default 0,
  seq         integer not null,
  start_ms    integer not null,
  end_ms      integer not null,
  speaker     text,
  text        text not null,
  search      tsvector generated always as (to_tsvector('simple', text)) stored,
  created_at  timestamptz not null default now(),
  unique (meeting_id, chunk_seq, seq)
);
create index meeting_segments_meeting_idx on public.meeting_transcript_segments (meeting_id, start_ms);
create index meeting_segments_search_idx on public.meeting_transcript_segments using gin (search);

create table public.meeting_summaries (
  meeting_id   uuid primary key references public.meeting_sessions (id) on delete cascade,
  summary      text not null,
  notes_md     text not null default '',
  decisions    jsonb not null default '[]'::jsonb,
  questions    jsonb not null default '[]'::jsonb,
  risks        jsonb not null default '[]'::jsonb,
  topics       jsonb not null default '[]'::jsonb,
  model        text,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

create table public.meeting_action_items (
  id                     uuid primary key default gen_random_uuid(),
  meeting_id             uuid not null references public.meeting_sessions (id) on delete cascade,
  text                   text not null,
  details                text,
  suggested_assignee     text,
  suggested_assignee_id  uuid references public.profiles (id) on delete set null,
  suggested_due_date     date,
  confidence             real,
  source_start_ms        integer,
  status                 text not null default 'proposed' check (status in ('proposed', 'accepted', 'dismissed')),
  task_id                uuid references public.tasks (id) on delete set null,
  position               integer not null default 0,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now()
);
create index meeting_action_items_meeting_idx on public.meeting_action_items (meeting_id, position);

create table public.meeting_chat_threads (
  id          uuid primary key default gen_random_uuid(),
  meeting_id  uuid not null references public.meeting_sessions (id) on delete cascade,
  user_id     uuid not null references public.profiles (id) on delete cascade,
  created_at  timestamptz not null default now(),
  unique (meeting_id, user_id)
);

create table public.meeting_chat_messages (
  id          uuid primary key default gen_random_uuid(),
  thread_id   uuid not null references public.meeting_chat_threads (id) on delete cascade,
  role        text not null check (role in ('user', 'assistant')),
  content     text not null,
  citations   jsonb not null default '[]'::jsonb,
  created_at  timestamptz not null default now()
);
create index meeting_chat_messages_thread_idx on public.meeting_chat_messages (thread_id, created_at);

-- ───────────────────────────── AI jobs & usage ─────────────────────────────
create table public.ai_jobs (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references public.profiles (id) on delete cascade,
  workspace_id  uuid references public.workspaces (id) on delete cascade,
  kind          text not null,
  status        text not null default 'queued' check (status in ('queued', 'running', 'succeeded', 'failed', 'cancelled')),
  input         jsonb not null default '{}'::jsonb,
  output        jsonb,
  error         text,
  attempts      integer not null default 0,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  finished_at   timestamptz
);
create index ai_jobs_user_idx on public.ai_jobs (user_id, created_at desc);

create table public.ai_usage_events (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references public.profiles (id) on delete cascade,
  workspace_id  uuid references public.workspaces (id) on delete set null,
  feature       text not null,
  metric        text not null check (metric in ('input_tokens', 'output_tokens', 'transcription_ms', 'requests')),
  quantity      bigint not null check (quantity >= 0),
  provider      text,
  model         text,
  idempotency_key text unique,
  created_at    timestamptz not null default now()
);
create index ai_usage_user_month_idx on public.ai_usage_events (user_id, created_at);

-- ───────────────────────────── access ─────────────────────────────
create or replace function app.accessible_meeting_ids() returns setof uuid
language sql stable security definer set search_path = '' as $$
  select m.id from public.meeting_sessions m
   where m.workspace_id in (select app.my_workspace_ids())
     and (
       m.created_by = auth.uid()
       or (m.visibility = 'workspace' and app.workspace_role(m.workspace_id) <> 'guest')
       or exists (select 1 from public.meeting_shares s where s.meeting_id = m.id and s.user_id = auth.uid())
     )
$$;
grant execute on function app.accessible_meeting_ids() to authenticated, service_role;

alter table public.meeting_sessions enable row level security;
alter table public.meeting_shares enable row level security;
alter table public.meeting_public_links enable row level security;
alter table public.meeting_participants enable row level security;
alter table public.meeting_audio_chunks enable row level security;
alter table public.meeting_transcript_segments enable row level security;
alter table public.meeting_summaries enable row level security;
alter table public.meeting_action_items enable row level security;
alter table public.meeting_chat_threads enable row level security;
alter table public.meeting_chat_messages enable row level security;
alter table public.ai_jobs enable row level security;
alter table public.ai_usage_events enable row level security;

create policy meetings_select on public.meeting_sessions for select to authenticated
  using (
    id in (select app.accessible_meeting_ids())
    or (created_by = (select auth.uid()) and workspace_id in (select app.my_workspace_ids()))
  );
create policy meetings_insert on public.meeting_sessions for insert to authenticated
  with check (created_by = (select auth.uid()) and workspace_id in (select app.my_workspace_ids()));
create policy meetings_update on public.meeting_sessions for update to authenticated
  using (created_by = (select auth.uid())) with check (created_by = (select auth.uid()));

create policy meeting_shares_select on public.meeting_shares for select to authenticated
  using (meeting_id in (select app.accessible_meeting_ids()));
create policy meeting_shares_write on public.meeting_shares for all to authenticated
  using (exists (select 1 from public.meeting_sessions m where m.id = meeting_id and m.created_by = (select auth.uid())))
  with check (exists (select 1 from public.meeting_sessions m where m.id = meeting_id and m.created_by = (select auth.uid())));

create policy meeting_public_links_owner on public.meeting_public_links for all to authenticated
  using (exists (select 1 from public.meeting_sessions m where m.id = meeting_id and m.created_by = (select auth.uid())))
  with check (exists (select 1 from public.meeting_sessions m where m.id = meeting_id and m.created_by = (select auth.uid())));

create policy meeting_participants_select on public.meeting_participants for select to authenticated
  using (meeting_id in (select app.accessible_meeting_ids()));
create policy meeting_participants_write on public.meeting_participants for all to authenticated
  using (exists (select 1 from public.meeting_sessions m where m.id = meeting_id and m.created_by = (select auth.uid())))
  with check (exists (select 1 from public.meeting_sessions m where m.id = meeting_id and m.created_by = (select auth.uid())));

create policy meeting_chunks_owner on public.meeting_audio_chunks for all to authenticated
  using (exists (select 1 from public.meeting_sessions m where m.id = meeting_id and m.created_by = (select auth.uid())))
  with check (exists (select 1 from public.meeting_sessions m where m.id = meeting_id and m.created_by = (select auth.uid())));

create policy meeting_segments_select on public.meeting_transcript_segments for select to authenticated
  using (meeting_id in (select app.accessible_meeting_ids()));
create policy meeting_summaries_select on public.meeting_summaries for select to authenticated
  using (meeting_id in (select app.accessible_meeting_ids()));
create policy meeting_action_items_select on public.meeting_action_items for select to authenticated
  using (meeting_id in (select app.accessible_meeting_ids()));
create policy meeting_action_items_update on public.meeting_action_items for update to authenticated
  using (meeting_id in (select app.accessible_meeting_ids()))
  with check (meeting_id in (select app.accessible_meeting_ids()));

create policy meeting_chat_threads_own on public.meeting_chat_threads for all to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()) and meeting_id in (select app.accessible_meeting_ids()));
create policy meeting_chat_messages_own on public.meeting_chat_messages for all to authenticated
  using (thread_id in (select id from public.meeting_chat_threads where user_id = (select auth.uid())))
  with check (thread_id in (select id from public.meeting_chat_threads where user_id = (select auth.uid())));

create policy ai_jobs_own on public.ai_jobs for select to authenticated using (user_id = (select auth.uid()));
create policy ai_usage_own on public.ai_usage_events for select to authenticated using (user_id = (select auth.uid()));
