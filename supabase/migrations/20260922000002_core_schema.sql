-- Core domain: people, workspaces, lists, sections, labels, tasks, documents, attachments,
-- messages, activity and notifications.

-- ───────────────────────────── profiles ─────────────────────────────
-- profiles.id equals auth.users.id (created by the signup trigger). There is intentionally no
-- foreign key: when an account is deleted the auth user is removed and the profile is
-- anonymised ("Deleted user"), so shared content in team workspaces keeps valid references.
create table public.profiles (
  id            uuid primary key,
  email         text,
  display_name  text not null default '' check (char_length(display_name) <= 120),
  avatar_path   text,
  timezone      text not null default 'UTC',
  locale        text not null default 'en',
  usage_type    text check (usage_type in ('personal', 'team')),
  onboarded_at  timestamptz,
  settings      jsonb not null default '{}'::jsonb,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  deleted_at    timestamptz,
  change_xid    xid8 not null default pg_current_xact_id()
);
create index profiles_email_idx on public.profiles (lower(email));
create index profiles_change_idx on public.profiles (change_xid);

-- ───────────────────────────── workspaces ─────────────────────────────
create table public.workspaces (
  id          uuid primary key default gen_random_uuid(),
  name        text not null check (char_length(name) between 1 and 100),
  kind        text not null check (kind in ('personal', 'team')),
  owner_id    uuid not null references public.profiles (id),
  icon        text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  deleted_at  timestamptz,
  change_xid  xid8 not null default pg_current_xact_id()
);
create unique index workspaces_one_personal_idx on public.workspaces (owner_id)
  where kind = 'personal' and deleted_at is null;
create index workspaces_change_idx on public.workspaces (change_xid);

create table public.workspace_members (
  id            uuid primary key default gen_random_uuid(),
  workspace_id  uuid not null references public.workspaces (id) on delete cascade,
  user_id       uuid not null references public.profiles (id) on delete cascade,
  role          text not null check (role in ('owner', 'admin', 'member', 'guest')),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  deleted_at    timestamptz,
  change_xid    xid8 not null default pg_current_xact_id(),
  unique (workspace_id, user_id)
);
create index workspace_members_user_idx on public.workspace_members (user_id) where deleted_at is null;
create index workspace_members_change_idx on public.workspace_members (workspace_id, change_xid);
-- Exactly one active owner per workspace.
create unique index workspace_members_one_owner_idx on public.workspace_members (workspace_id)
  where role = 'owner' and deleted_at is null;

create table public.workspace_invitations (
  id            uuid primary key default gen_random_uuid(),
  workspace_id  uuid not null references public.workspaces (id) on delete cascade,
  list_id       uuid,
  email         text not null check (email ~* '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
  role          text not null check (role in ('admin', 'member', 'guest')),
  token_hash    text not null unique,
  status        text not null default 'pending'
                check (status in ('pending', 'accepted', 'declined', 'revoked', 'expired')),
  invited_by    uuid not null references public.profiles (id),
  accepted_by   uuid references public.profiles (id),
  accepted_at   timestamptz,
  expires_at    timestamptz not null default now() + interval '14 days',
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  deleted_at    timestamptz,
  change_xid    xid8 not null default pg_current_xact_id()
);
create index workspace_invitations_email_idx on public.workspace_invitations (lower(email)) where status = 'pending';
create index workspace_invitations_change_idx on public.workspace_invitations (workspace_id, change_xid);
create unique index workspace_invitations_pending_idx
  on public.workspace_invitations (workspace_id, lower(email), coalesce(list_id, '00000000-0000-0000-0000-000000000000'::uuid))
  where status = 'pending';

-- ───────────────────────────── lists ─────────────────────────────
create table public.lists (
  id              uuid primary key default gen_random_uuid(),
  workspace_id    uuid not null references public.workspaces (id) on delete cascade,
  parent_list_id  uuid references public.lists (id) on delete set null,
  created_by      uuid not null references public.profiles (id),
  title           text not null default '' check (char_length(title) <= 500),
  emoji           text check (char_length(emoji) <= 16),
  cover_path      text,
  description     text check (char_length(description) <= 2000),
  visibility      text not null default 'private' check (visibility in ('private', 'shared', 'workspace')),
  position        text collate "C" not null default 'a0',
  archived_at     timestamptz,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  deleted_at      timestamptz,
  change_xid      xid8 not null default pg_current_xact_id(),
  check (parent_list_id is null or parent_list_id <> id)
);
create index lists_workspace_idx on public.lists (workspace_id) where deleted_at is null;
create index lists_parent_idx on public.lists (parent_list_id);
create index lists_created_by_idx on public.lists (created_by);
create index lists_change_idx on public.lists (workspace_id, change_xid);
create index lists_title_trgm_idx on public.lists using gin (title extensions.gin_trgm_ops);

alter table public.workspace_invitations
  add constraint workspace_invitations_list_fk foreign key (list_id) references public.lists (id) on delete cascade;

create table public.list_members (
  id            uuid primary key default gen_random_uuid(),
  list_id       uuid not null references public.lists (id) on delete cascade,
  workspace_id  uuid not null references public.workspaces (id) on delete cascade,
  user_id       uuid not null references public.profiles (id) on delete cascade,
  role          text not null default 'editor' check (role in ('editor', 'viewer')),
  added_by      uuid not null references public.profiles (id),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  deleted_at    timestamptz,
  change_xid    xid8 not null default pg_current_xact_id(),
  unique (list_id, user_id)
);
create index list_members_user_idx on public.list_members (user_id) where deleted_at is null;
create index list_members_change_idx on public.list_members (workspace_id, change_xid);

create table public.list_public_links (
  id            uuid primary key default gen_random_uuid(),
  list_id       uuid not null references public.lists (id) on delete cascade,
  workspace_id  uuid not null references public.workspaces (id) on delete cascade,
  token_hash    text not null unique,
  created_by    uuid not null references public.profiles (id),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  revoked_at    timestamptz
);
create unique index list_public_links_active_idx on public.list_public_links (list_id) where revoked_at is null;

-- ───────────────────────────── sidebar ─────────────────────────────
create table public.sections (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references public.profiles (id) on delete cascade,
  workspace_id  uuid not null references public.workspaces (id) on delete cascade,
  name          text not null check (char_length(name) between 1 and 100),
  position      text collate "C" not null,
  collapsed     boolean not null default false,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  deleted_at    timestamptz,
  change_xid    xid8 not null default pg_current_xact_id()
);
create index sections_change_idx on public.sections (user_id, change_xid);

create table public.section_items (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references public.profiles (id) on delete cascade,
  workspace_id  uuid not null references public.workspaces (id) on delete cascade,
  section_id    uuid references public.sections (id) on delete set null,
  list_id       uuid not null references public.lists (id) on delete cascade,
  position      text collate "C" not null,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  deleted_at    timestamptz,
  change_xid    xid8 not null default pg_current_xact_id(),
  unique (user_id, list_id)
);
create index section_items_change_idx on public.section_items (user_id, change_xid);

-- ───────────────────────────── labels ─────────────────────────────
create table public.labels (
  id            uuid primary key default gen_random_uuid(),
  workspace_id  uuid not null references public.workspaces (id) on delete cascade,
  name          text not null check (char_length(name) between 1 and 60),
  color         text not null default 'slate' check (color in
                ('slate','red','orange','amber','lime','green','teal','sky','blue','indigo','violet','pink')),
  created_by    uuid not null references public.profiles (id),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  deleted_at    timestamptz,
  change_xid    xid8 not null default pg_current_xact_id()
);
create unique index labels_name_idx on public.labels (workspace_id, lower(name)) where deleted_at is null;
create index labels_change_idx on public.labels (workspace_id, change_xid);

-- ───────────────────────────── tasks ─────────────────────────────
create table public.tasks (
  id                     uuid primary key default gen_random_uuid(),
  workspace_id           uuid not null references public.workspaces (id) on delete cascade,
  list_id                uuid references public.lists (id) on delete set null,
  parent_task_id         uuid references public.tasks (id) on delete cascade,
  root_task_id           uuid references public.tasks (id) on delete cascade,
  created_by             uuid not null references public.profiles (id),
  assignee_id            uuid references public.profiles (id) on delete set null,
  title                  text not null default '' check (char_length(title) <= 2000),
  position               text collate "C" not null,
  completed_at           timestamptz,
  completed_by           uuid references public.profiles (id) on delete set null,
  due_date               date,
  due_time               time,
  due_tz                 text,
  due_at                 timestamptz,
  reminders              jsonb not null default '[]'::jsonb check (jsonb_typeof(reminders) = 'array'),
  recurrence             jsonb,
  occurrence_count       integer not null default 0,
  label_ids              uuid[] not null default '{}',
  source                 jsonb,
  has_details            boolean not null default false,
  details_preview        text,
  child_count            integer not null default 0,
  child_completed_count  integer not null default 0,
  search                 tsvector generated always as (
                           setweight(to_tsvector('simple', coalesce(title, '')), 'A') ||
                           setweight(to_tsvector('simple', coalesce(details_preview, '')), 'C')
                         ) stored,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now(),
  deleted_at             timestamptz,
  change_xid             xid8 not null default pg_current_xact_id(),
  check (parent_task_id is null or parent_task_id <> id),
  check (due_time is null or due_date is not null),
  check ((parent_task_id is null) = (root_task_id is null))
);
create index tasks_list_idx on public.tasks (list_id) where deleted_at is null;
create index tasks_parent_idx on public.tasks (parent_task_id);
create index tasks_root_idx on public.tasks (root_task_id);
create index tasks_assignee_idx on public.tasks (assignee_id) where deleted_at is null;
create index tasks_created_by_listless_idx on public.tasks (created_by) where list_id is null;
create index tasks_due_idx on public.tasks (workspace_id, due_date) where deleted_at is null and completed_at is null;
create index tasks_due_at_idx on public.tasks (due_at) where deleted_at is null and completed_at is null;
create index tasks_change_idx on public.tasks (workspace_id, change_xid);
create index tasks_labels_idx on public.tasks using gin (label_ids);
create index tasks_search_idx on public.tasks using gin (search);
create index tasks_title_trgm_idx on public.tasks using gin (title extensions.gin_trgm_ops);

create table public.task_user_states (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null references public.profiles (id) on delete cascade,
  task_id         uuid not null references public.tasks (id) on delete cascade,
  workspace_id    uuid not null references public.workspaces (id) on delete cascade,
  in_inbox        boolean not null default false,
  inbox_position  text collate "C",
  today_position  text collate "C",
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  deleted_at      timestamptz,
  change_xid      xid8 not null default pg_current_xact_id(),
  unique (user_id, task_id)
);
create index task_user_states_change_idx on public.task_user_states (user_id, change_xid);
create index task_user_states_inbox_idx on public.task_user_states (user_id) where in_inbox and deleted_at is null;

-- Completion history (recurring occurrences included). Powers heatmap and stats.
create table public.task_completions (
  id               uuid primary key default gen_random_uuid(),
  task_id          uuid not null references public.tasks (id) on delete cascade,
  workspace_id     uuid not null references public.workspaces (id) on delete cascade,
  user_id          uuid not null references public.profiles (id) on delete cascade,
  occurrence_date  date,
  completed_at     timestamptz not null default now(),
  undone_at        timestamptz
);
create index task_completions_user_idx on public.task_completions (user_id, completed_at) where undone_at is null;
create index task_completions_task_idx on public.task_completions (task_id);

-- ───────────────────────────── documents (Yjs) ─────────────────────────────
create table public.documents (
  id            uuid primary key default gen_random_uuid(),
  name          text not null unique check (name ~ '^(list|task):[0-9a-f-]{36}$'),
  workspace_id  uuid not null references public.workspaces (id) on delete cascade,
  list_id       uuid references public.lists (id) on delete cascade,
  task_id       uuid references public.tasks (id) on delete cascade,
  state         bytea,
  plain_text    text not null default '',
  search        tsvector generated always as (to_tsvector('simple', left(plain_text, 200000))) stored,
  size_bytes    integer not null default 0,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  deleted_at    timestamptz,
  check ((list_id is null) <> (task_id is null))
);
create index documents_search_idx on public.documents using gin (search);
create index documents_list_idx on public.documents (list_id);
create index documents_task_idx on public.documents (task_id);

-- Periodic restorable versions of documents (taken hourly while edited and before AI edits).
create table public.document_snapshots (
  id           uuid primary key default gen_random_uuid(),
  document_id  uuid not null references public.documents (id) on delete cascade,
  state        bytea not null,
  reason       text not null default 'periodic' check (reason in ('periodic', 'before_ai', 'manual', 'restore')),
  created_by   uuid references public.profiles (id) on delete set null,
  created_at   timestamptz not null default now()
);
create index document_snapshots_doc_idx on public.document_snapshots (document_id, created_at desc);

-- ───────────────────────────── attachments ─────────────────────────────
create table public.attachments (
  id            uuid primary key default gen_random_uuid(),
  workspace_id  uuid not null references public.workspaces (id) on delete cascade,
  task_id       uuid references public.tasks (id) on delete cascade,
  list_id       uuid references public.lists (id) on delete cascade,
  message_id    uuid,
  uploaded_by   uuid not null references public.profiles (id),
  name          text not null check (char_length(name) between 1 and 255),
  mime_type     text not null,
  size_bytes    bigint not null check (size_bytes >= 0),
  storage_path  text not null unique,
  status        text not null default 'pending' check (status in ('pending', 'ready', 'failed')),
  width         integer,
  height        integer,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  deleted_at    timestamptz,
  change_xid    xid8 not null default pg_current_xact_id(),
  check (task_id is not null or list_id is not null or message_id is not null)
);
create index attachments_task_idx on public.attachments (task_id);
create index attachments_list_idx on public.attachments (list_id);
create index attachments_change_idx on public.attachments (workspace_id, change_xid);
create index attachments_owner_bytes_idx on public.attachments (uploaded_by) where deleted_at is null;
create index attachments_name_trgm_idx on public.attachments using gin (name extensions.gin_trgm_ops);

-- ───────────────────────────── messages ─────────────────────────────
create table public.task_messages (
  id                 uuid primary key default gen_random_uuid(),
  workspace_id       uuid not null references public.workspaces (id) on delete cascade,
  task_id            uuid not null references public.tasks (id) on delete cascade,
  author_id          uuid not null references public.profiles (id),
  parent_message_id  uuid references public.task_messages (id) on delete cascade,
  kind               text not null default 'text' check (kind in ('text', 'voice', 'system')),
  body               text not null default '' check (char_length(body) <= 20000),
  attachment_id      uuid references public.attachments (id) on delete set null,
  mentions           uuid[] not null default '{}',
  edited_at          timestamptz,
  search             tsvector generated always as (to_tsvector('simple', body)) stored,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  deleted_at         timestamptz,
  change_xid         xid8 not null default pg_current_xact_id()
);
create index task_messages_task_idx on public.task_messages (task_id, created_at);
create index task_messages_change_idx on public.task_messages (workspace_id, change_xid);
create index task_messages_search_idx on public.task_messages using gin (search);

alter table public.attachments
  add constraint attachments_message_fk foreign key (message_id) references public.task_messages (id) on delete cascade;

create table public.message_reactions (
  id            uuid primary key default gen_random_uuid(),
  workspace_id  uuid not null references public.workspaces (id) on delete cascade,
  message_id    uuid not null references public.task_messages (id) on delete cascade,
  task_id       uuid not null references public.tasks (id) on delete cascade,
  user_id       uuid not null references public.profiles (id) on delete cascade,
  emoji         text not null check (char_length(emoji) between 1 and 16),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  deleted_at    timestamptz,
  change_xid    xid8 not null default pg_current_xact_id(),
  unique (message_id, user_id, emoji)
);
create index message_reactions_change_idx on public.message_reactions (workspace_id, change_xid);

-- ───────────────────────────── activity & notifications ─────────────────────────────
create table public.activity_events (
  id            uuid primary key default gen_random_uuid(),
  workspace_id  uuid not null references public.workspaces (id) on delete cascade,
  task_id       uuid references public.tasks (id) on delete cascade,
  list_id       uuid references public.lists (id) on delete cascade,
  actor_id      uuid references public.profiles (id) on delete set null,
  type          text not null,
  data          jsonb not null default '{}'::jsonb,
  created_at    timestamptz not null default now()
);
create index activity_events_task_idx on public.activity_events (task_id, created_at desc);
create index activity_events_list_idx on public.activity_events (list_id, created_at desc);

create table public.notifications (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references public.profiles (id) on delete cascade,
  workspace_id  uuid references public.workspaces (id) on delete cascade,
  type          text not null,
  actor_id      uuid references public.profiles (id) on delete set null,
  task_id       uuid references public.tasks (id) on delete cascade,
  list_id       uuid references public.lists (id) on delete cascade,
  meeting_id    uuid,
  data          jsonb not null default '{}'::jsonb,
  dedupe_key    text,
  read_at       timestamptz,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  deleted_at    timestamptz,
  change_xid    xid8 not null default pg_current_xact_id()
);
create index notifications_user_idx on public.notifications (user_id, created_at desc);
create index notifications_change_idx on public.notifications (user_id, change_xid);
create unique index notifications_dedupe_idx on public.notifications (user_id, dedupe_key) where dedupe_key is not null;

-- ───────────────────────────── replication triggers ─────────────────────────────
select app.replicate('public.workspaces', 'none');
select app.replicate('public.workspace_members', 'workspace');
select app.replicate('public.workspace_invitations', 'workspace');
select app.replicate('public.lists', 'workspace');
select app.replicate('public.list_members', 'workspace');
select app.replicate('public.sections', 'user');
select app.replicate('public.section_items', 'user');
select app.replicate('public.labels', 'workspace');
select app.replicate('public.tasks', 'workspace');
select app.replicate('public.task_user_states', 'user');
select app.replicate('public.task_messages', 'workspace');
select app.replicate('public.message_reactions', 'workspace');
select app.replicate('public.attachments', 'workspace');
select app.replicate('public.notifications', 'user');
select app.replicate('public.profiles', 'none');

create trigger workspaces_poke after insert or update on public.workspaces
  for each row execute function app.poke_workspace_self();
create trigger profiles_poke after insert or update on public.profiles
  for each row execute function app.poke_profile();
