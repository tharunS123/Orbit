-- Server helper functions used by mutators.

-- Recursive JSON object merge (b wins; nested objects merge instead of being replaced).
create or replace function app.jsonb_deep_merge(a jsonb, b jsonb) returns jsonb
language sql immutable set search_path = '' as $$
  select case
    when jsonb_typeof(a) = 'object' and jsonb_typeof(b) = 'object' then (
      select coalesce(jsonb_object_agg(
               coalesce(ka, kb),
               case when va is null then vb
                    when vb is null then va
                    else app.jsonb_deep_merge(va, vb) end), '{}'::jsonb)
        from jsonb_each(a) as ea(ka, va)
        full join jsonb_each(b) as eb(kb, vb) on ka = kb)
    else coalesce(b, a)
  end
$$;

-- Ownership transfer: the only path that changes an owner. Runs the privileged updates with
-- JWT claims cleared (guards treat that as a trusted server context) after checking the caller.
create or replace function app.transfer_workspace(ws uuid, to_user uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare
  me uuid := auth.uid();
  claims text := current_setting('request.jwt.claims', true);
begin
  if me is null or not exists (
    select 1 from public.workspace_members
     where workspace_id = ws and user_id = me and role = 'owner' and deleted_at is null) then
    raise exception 'only the owner can transfer a workspace' using errcode = 'insufficient_privilege';
  end if;
  if exists (select 1 from public.workspaces where id = ws and kind = 'personal') then
    raise exception 'personal workspaces cannot be transferred' using errcode = 'check_violation';
  end if;
  if not exists (
    select 1 from public.workspace_members
     where workspace_id = ws and user_id = to_user and role in ('admin', 'member') and deleted_at is null) then
    raise exception 'the new owner must be a full member of the workspace' using errcode = 'check_violation';
  end if;

  perform set_config('request.jwt.claims', '', true);
  perform set_config('request.jwt.claim.sub', '', true);
  update public.workspace_members set role = 'admin' where workspace_id = ws and user_id = me;
  update public.workspace_members set role = 'owner' where workspace_id = ws and user_id = to_user;
  update public.workspaces set owner_id = to_user where id = ws;
  perform set_config('request.jwt.claims', claims, true);
  perform set_config('request.jwt.claim.sub', me::text, true);

  insert into public.audit_log (user_id, action, target, metadata)
  values (me, 'workspace.transfer', ws::text, jsonb_build_object('to', to_user));
end;
$$;

-- Active (non-archived, non-deleted) lists a user created — for plan limits.
create or replace function app.active_list_count(u uuid) returns integer
language sql stable security definer set search_path = '' as $$
  select count(*)::int from public.lists where created_by = u and deleted_at is null and archived_at is null
$$;

-- Bytes stored by a user — for plan limits.
create or replace function app.storage_bytes(u uuid) returns bigint
language sql stable security definer set search_path = '' as $$
  select coalesce(sum(size_bytes), 0)::bigint from public.attachments where uploaded_by = u and deleted_at is null
$$;

-- Create (or refresh, when dedupe_key matches) a notification for another user. Silently skips
-- recipients who cannot see the referenced task/list, so notifications never leak content.
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
  do update set read_at = null, created_at = now(), actor_id = excluded.actor_id, data = excluded.data, deleted_at = null;
  return true;
end;
$$;

revoke execute on all functions in schema app from public;
grant execute on all functions in schema app to authenticated, service_role;
grant execute on function app.public_list_by_token(text) to anon;
