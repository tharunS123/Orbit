-- Integrations, inbound email, devices/push, billing, MCP tokens and sync bookkeeping.
-- These tables are written by the server (API/worker) after explicit authorization checks;
-- clients get read access to their own rows only, and never to secret columns.

-- ───────────────────────────── integrations ─────────────────────────────
create table public.integration_connections (
  id                 uuid primary key default gen_random_uuid(),
  user_id            uuid not null references public.profiles (id) on delete cascade,
  workspace_id       uuid not null references public.workspaces (id) on delete cascade,
  provider           text not null check (provider in
                     ('gmail', 'google_calendar', 'slack', 'github', 'linear', 'microsoft_todo')),
  account_id         text not null,
  account_label      text not null,
  status             text not null default 'active' check (status in ('active', 'revoked', 'error')),
  scopes             text[] not null default '{}',
  access_token_enc   text,
  refresh_token_enc  text,
  token_expires_at   timestamptz,
  last_error         text,
  last_synced_at     timestamptz,
  sync_cursor        jsonb not null default '{}'::jsonb,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  unique (user_id, provider, account_id)
);
create index integration_connections_provider_account_idx on public.integration_connections (provider, account_id);

create table public.integration_settings (
  connection_id  uuid primary key references public.integration_connections (id) on delete cascade,
  settings       jsonb not null default '{}'::jsonb,
  updated_at     timestamptz not null default now()
);

create table public.external_item_links (
  id             uuid primary key default gen_random_uuid(),
  workspace_id   uuid not null references public.workspaces (id) on delete cascade,
  connection_id  uuid references public.integration_connections (id) on delete set null,
  provider       text not null,
  external_id    text not null,
  external_url   text,
  task_id        uuid references public.tasks (id) on delete cascade,
  event_id       text,
  metadata       jsonb not null default '{}'::jsonb,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);
-- Dedupe: one link per external item per workspace, regardless of which connection saw it.
create unique index external_item_links_dedupe_idx on public.external_item_links (workspace_id, provider, external_id);
create index external_item_links_task_idx on public.external_item_links (task_id);

create table public.integration_webhook_events (
  id           uuid primary key default gen_random_uuid(),
  provider     text not null,
  event_id     text not null,
  event_type   text,
  payload      jsonb not null,
  status       text not null default 'received' check (status in ('received', 'processed', 'failed', 'ignored')),
  attempts     integer not null default 0,
  error        text,
  received_at  timestamptz not null default now(),
  processed_at timestamptz,
  unique (provider, event_id)
);

create table public.calendar_events (
  id              uuid primary key default gen_random_uuid(),
  connection_id   uuid not null references public.integration_connections (id) on delete cascade,
  user_id         uuid not null references public.profiles (id) on delete cascade,
  calendar_id     text not null,
  external_id     text not null,
  title           text not null default '',
  starts_at       timestamptz,
  ends_at         timestamptz,
  start_date      date,
  end_date        date,
  all_day         boolean not null default false,
  location        text,
  html_link       text,
  status          text not null default 'confirmed',
  color           text,
  updated_at      timestamptz not null default now(),
  unique (connection_id, calendar_id, external_id)
);
create index calendar_events_user_range_idx on public.calendar_events (user_id, starts_at, ends_at);
create index calendar_events_user_dates_idx on public.calendar_events (user_id, start_date, end_date);

-- Unique capture address per user+workspace: capture+<token>@<INBOUND_EMAIL_DOMAIN>.
create table public.inbound_email_addresses (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references public.profiles (id) on delete cascade,
  workspace_id  uuid not null references public.workspaces (id) on delete cascade,
  token         text not null unique check (token ~ '^[a-z0-9]{16,40}$'),
  list_id       uuid references public.lists (id) on delete set null,
  allowed_senders text[] not null default '{}',
  created_at    timestamptz not null default now(),
  revoked_at    timestamptz
);
create unique index inbound_email_addresses_active_idx on public.inbound_email_addresses (user_id, workspace_id) where revoked_at is null;

-- ───────────────────────────── devices / push ─────────────────────────────
create table public.devices (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references public.profiles (id) on delete cascade,
  platform      text not null check (platform in ('web', 'ios', 'android', 'macos', 'windows', 'linux')),
  name          text not null default '',
  app_version   text,
  last_seen_at  timestamptz not null default now(),
  created_at    timestamptz not null default now(),
  revoked_at    timestamptz
);
create index devices_user_idx on public.devices (user_id);

create table public.push_tokens (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references public.profiles (id) on delete cascade,
  device_id   uuid references public.devices (id) on delete cascade,
  channel     text not null check (channel in ('webpush', 'apns', 'fcm')),
  token       text not null,
  endpoint    text,
  keys        jsonb,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  failed_at   timestamptz,
  unique (channel, token)
);
create index push_tokens_user_idx on public.push_tokens (user_id) where failed_at is null;

-- Materialised reminder deliveries (worker-owned). Unique key prevents duplicate sends.
create table public.reminder_deliveries (
  id           uuid primary key default gen_random_uuid(),
  task_id      uuid not null references public.tasks (id) on delete cascade,
  user_id      uuid not null references public.profiles (id) on delete cascade,
  reminder_id  text not null,
  fire_at      timestamptz not null,
  status       text not null default 'scheduled' check (status in ('scheduled', 'sent', 'cancelled', 'failed')),
  sent_at      timestamptz,
  error        text,
  created_at   timestamptz not null default now(),
  unique (task_id, user_id, reminder_id, fire_at)
);
create index reminder_deliveries_due_idx on public.reminder_deliveries (fire_at) where status = 'scheduled';

-- ───────────────────────────── billing ─────────────────────────────
create table public.billing_customers (
  user_id             uuid primary key references public.profiles (id) on delete cascade,
  stripe_customer_id  text unique,
  revenuecat_app_user_id text unique,
  created_at          timestamptz not null default now()
);

create table public.subscriptions (
  id                        uuid primary key default gen_random_uuid(),
  user_id                   uuid not null references public.profiles (id) on delete cascade,
  provider                  text not null check (provider in ('stripe', 'app_store', 'play_store', 'dev')),
  provider_subscription_id  text not null,
  plan                      text not null check (plan in ('plus', 'ultra')),
  billing_interval          text check (billing_interval in ('month', 'year')),
  status                    text not null check (status in
                            ('active', 'trialing', 'past_due', 'canceled', 'incomplete', 'expired', 'paused')),
  current_period_end        timestamptz,
  cancel_at_period_end      boolean not null default false,
  grace_until               timestamptz,
  created_at                timestamptz not null default now(),
  updated_at                timestamptz not null default now(),
  unique (provider, provider_subscription_id)
);
create index subscriptions_user_idx on public.subscriptions (user_id);

create table public.subscription_events (
  id            uuid primary key default gen_random_uuid(),
  provider      text not null,
  event_id      text not null,
  event_type    text not null,
  payload       jsonb not null,
  status        text not null default 'received' check (status in ('received', 'processed', 'failed', 'ignored')),
  error         text,
  received_at   timestamptz not null default now(),
  processed_at  timestamptz,
  unique (provider, event_id)
);

-- Server-reconciled effective plan. Never written by clients.
create table public.entitlements (
  user_id     uuid primary key references public.profiles (id) on delete cascade,
  plan        text not null default 'free' check (plan in ('free', 'plus', 'ultra')),
  source      text not null default 'default',
  valid_until timestamptz,
  updated_at  timestamptz not null default now()
);

-- ───────────────────────────── MCP / API tokens ─────────────────────────────
create table public.mcp_tokens (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references public.profiles (id) on delete cascade,
  name          text not null check (char_length(name) between 1 and 80),
  token_hash    text not null unique,
  token_prefix  text not null,
  scopes        text[] not null check (cardinality(scopes) > 0),
  workspace_ids uuid[],
  last_used_at  timestamptz,
  expires_at    timestamptz,
  revoked_at    timestamptz,
  created_at    timestamptz not null default now()
);
create index mcp_tokens_user_idx on public.mcp_tokens (user_id);

-- ───────────────────────────── sync bookkeeping ─────────────────────────────
-- Idempotency log for client mutations: a mutation id is applied at most once.
create table public.sync_mutations (
  id           uuid primary key,
  user_id      uuid not null references public.profiles (id) on delete cascade,
  client_id    uuid not null,
  name         text not null,
  status       text not null check (status in ('applied', 'rejected')),
  error        jsonb,
  applied_at   timestamptz not null default now()
);
create index sync_mutations_user_idx on public.sync_mutations (user_id, applied_at);

create table public.sync_devices (
  id              uuid primary key,
  user_id         uuid not null references public.profiles (id) on delete cascade,
  platform        text,
  last_pull_at    timestamptz,
  last_push_at    timestamptz,
  created_at      timestamptz not null default now()
);

-- Per-user rate limit buckets (fixed windows).
create table public.rate_limits (
  key          text not null,
  window_start timestamptz not null,
  count        integer not null default 0,
  primary key (key, window_start)
);

-- Sensitive-action audit log.
create table public.audit_log (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid references public.profiles (id) on delete set null,
  action      text not null,
  target      text,
  metadata    jsonb not null default '{}'::jsonb,
  ip          text,
  created_at  timestamptz not null default now()
);
create index audit_log_user_idx on public.audit_log (user_id, created_at desc);

-- Account deletion requests (processed by the worker).
create table public.account_deletions (
  user_id       uuid primary key,
  requested_at  timestamptz not null default now(),
  completed_at  timestamptz,
  error         text
);

-- ───────────────────────────── RLS ─────────────────────────────
alter table public.integration_connections enable row level security;
alter table public.integration_settings enable row level security;
alter table public.external_item_links enable row level security;
alter table public.integration_webhook_events enable row level security;
alter table public.calendar_events enable row level security;
alter table public.inbound_email_addresses enable row level security;
alter table public.devices enable row level security;
alter table public.push_tokens enable row level security;
alter table public.reminder_deliveries enable row level security;
alter table public.billing_customers enable row level security;
alter table public.subscriptions enable row level security;
alter table public.subscription_events enable row level security;
alter table public.entitlements enable row level security;
alter table public.mcp_tokens enable row level security;
alter table public.sync_mutations enable row level security;
alter table public.sync_devices enable row level security;
alter table public.rate_limits enable row level security;
alter table public.audit_log enable row level security;
alter table public.account_deletions enable row level security;

-- Clients may read their own connection metadata but never token columns.
revoke select on public.integration_connections from authenticated;
grant select (id, user_id, workspace_id, provider, account_id, account_label, status, scopes,
              token_expires_at, last_error, last_synced_at, created_at, updated_at)
  on public.integration_connections to authenticated;
create policy integration_connections_own on public.integration_connections for select to authenticated
  using (user_id = (select auth.uid()));
create policy integration_settings_own on public.integration_settings for select to authenticated
  using (connection_id in (select id from public.integration_connections where user_id = (select auth.uid())));
create policy external_item_links_select on public.external_item_links for select to authenticated
  using (task_id in (select app.accessible_task_ids()));
create policy calendar_events_own on public.calendar_events for select to authenticated
  using (user_id = (select auth.uid()));
create policy inbound_email_own on public.inbound_email_addresses for select to authenticated
  using (user_id = (select auth.uid()));
create policy devices_own on public.devices for select to authenticated using (user_id = (select auth.uid()));
create policy push_tokens_own on public.push_tokens for select to authenticated using (user_id = (select auth.uid()));
create policy subscriptions_own on public.subscriptions for select to authenticated using (user_id = (select auth.uid()));
create policy entitlements_own on public.entitlements for select to authenticated using (user_id = (select auth.uid()));
create policy billing_customers_own on public.billing_customers for select to authenticated using (user_id = (select auth.uid()));
revoke select on public.mcp_tokens from authenticated;
grant select (id, user_id, name, token_prefix, scopes, workspace_ids, last_used_at, expires_at, revoked_at, created_at)
  on public.mcp_tokens to authenticated;
create policy mcp_tokens_own on public.mcp_tokens for select to authenticated using (user_id = (select auth.uid()));
create policy sync_mutations_own on public.sync_mutations for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
create policy sync_devices_own on public.sync_devices for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
-- integration_webhook_events, subscription_events, reminder_deliveries, rate_limits, audit_log,
-- account_deletions: no client policies (server only).

-- Effective plan for a user (default free).
create or replace function app.user_plan(u uuid) returns text
language sql stable security definer set search_path = '' as $$
  select coalesce(
    (select plan from public.entitlements where user_id = u and (valid_until is null or valid_until > now())),
    'free')
$$;
grant execute on function app.user_plan(uuid) to authenticated, service_role;
