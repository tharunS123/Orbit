-- Background worker bookkeeping.

-- Push/email delivery tracking for in-app notifications (idempotent delivery + sweeps).
alter table public.notifications add column pushed_at timestamptz;
alter table public.notifications add column emailed_at timestamptz;
create index notifications_undelivered_idx on public.notifications (created_at) where pushed_at is null;

-- Durable cursors and small state for scheduled scans (e.g. reminder materialisation).
create table public.worker_state (
  key         text primary key,
  value       jsonb not null default '{}'::jsonb,
  updated_at  timestamptz not null default now()
);
alter table public.worker_state enable row level security;
-- No client policies: server only.

create index reminder_deliveries_task_idx on public.reminder_deliveries (task_id) where status = 'scheduled';

-- A deduplicated notification that fires again (e.g. another comment on the same task) must be
-- delivered again: reset delivery markers on upsert.
create or replace function app.notify(
  p_user uuid, p_workspace uuid, p_type text, p_task uuid, p_list uuid, p_data jsonb, p_dedupe text
) returns boolean
language plpgsql security definer set search_path = '' as $$
declare
  actor uuid := auth.uid();
begin
  if actor is null or p_user = actor then return false; end if;
  if not exists (select 1 from app.visible_user_ids() v where v = p_user) then return false; end if;
  if p_task is not null and not app.user_can_access_task(p_user, p_task) then return false; end if;
  if p_task is null and p_list is not null and app.user_list_level(p_user, p_list) = 0 then return false; end if;
  insert into public.notifications (user_id, workspace_id, type, actor_id, task_id, list_id, data, dedupe_key)
  values (p_user, p_workspace, p_type, actor, p_task, p_list, coalesce(p_data, '{}'::jsonb), p_dedupe)
  on conflict (user_id, dedupe_key) where dedupe_key is not null
  do update set read_at = null, created_at = now(), actor_id = excluded.actor_id, data = excluded.data,
                deleted_at = null, pushed_at = null, emailed_at = null;
  return true;
end;
$$;
revoke execute on function app.notify(uuid, uuid, text, uuid, uuid, jsonb, text) from public;
grant execute on function app.notify(uuid, uuid, text, uuid, uuid, jsonb, text) to authenticated, service_role;
