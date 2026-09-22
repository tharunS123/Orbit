-- Narrow SECURITY DEFINER entry points for flows that cross RLS boundaries on purpose.
-- Each function performs its own authorization and touches only what the flow needs.

-- Accept an invitation addressed to the current user's email.
create or replace function app.accept_invitation(p_token_hash text)
returns table (workspace_id uuid, list_id uuid, role text)
language plpgsql security definer set search_path = '' as $$
declare
  inv public.workspace_invitations;
  me uuid := auth.uid();
  my_email text;
  existing text;
  rank_new int;
  rank_old int;
begin
  if me is null then
    raise exception 'not authenticated' using errcode = 'insufficient_privilege';
  end if;
  select lower(u.email) into my_email from auth.users u where u.id = me;
  select * into inv from public.workspace_invitations i where i.token_hash = p_token_hash for update;
  if not found then
    raise exception 'invitation not found' using errcode = 'no_data_found';
  end if;
  if inv.status <> 'pending' then
    raise exception 'invitation is %', inv.status using errcode = 'check_violation';
  end if;
  if inv.expires_at < now() then
    update public.workspace_invitations set status = 'expired' where id = inv.id;
    raise exception 'invitation expired' using errcode = 'check_violation';
  end if;
  if lower(inv.email) <> my_email then
    raise exception 'invitation was sent to a different email address' using errcode = 'insufficient_privilege';
  end if;

  select wm.role into existing from public.workspace_members wm
   where wm.workspace_id = inv.workspace_id and wm.user_id = me and wm.deleted_at is null;
  rank_new := case inv.role when 'admin' then 2 when 'member' then 1 else 0 end;
  rank_old := case existing when 'owner' then 3 when 'admin' then 2 when 'member' then 1 when 'guest' then 0 else -1 end;

  insert into public.workspace_members (workspace_id, user_id, role)
  values (inv.workspace_id, me, inv.role)
  on conflict on constraint workspace_members_workspace_id_user_id_key do update
    set role = case when rank_old >= rank_new then public.workspace_members.role else excluded.role end,
        deleted_at = null;

  if inv.list_id is not null then
    insert into public.list_members (list_id, workspace_id, user_id, role, added_by)
    values (inv.list_id, inv.workspace_id, me, 'editor', inv.invited_by)
    on conflict on constraint list_members_list_id_user_id_key do update set deleted_at = null;
  end if;

  update public.workspace_invitations
     set status = 'accepted', accepted_by = me, accepted_at = now()
   where id = inv.id;

  insert into public.notifications (user_id, workspace_id, type, actor_id, list_id, data)
  values (inv.invited_by, inv.workspace_id, 'invitation', me, inv.list_id,
          jsonb_build_object('event', 'accepted', 'email', inv.email));

  return query select inv.workspace_id, inv.list_id, inv.role;
end;
$$;

create or replace function app.decline_invitation(p_invitation_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
begin
  update public.workspace_invitations i
     set status = 'declined'
   where i.id = p_invitation_id and i.status = 'pending'
     and lower(i.email) = (select lower(u.email) from auth.users u where u.id = auth.uid());
  if not found then
    raise exception 'invitation not found' using errcode = 'no_data_found';
  end if;
end;
$$;

-- Read-only snapshot of a publicly shared list. The only anonymous data path.
create or replace function app.public_list_by_token(p_token_hash text) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  link public.list_public_links;
  l public.lists;
  result jsonb;
begin
  select * into link from public.list_public_links where token_hash = p_token_hash and revoked_at is null;
  if not found then return null; end if;
  select * into l from public.lists where id = link.list_id and deleted_at is null;
  if not found then return null; end if;
  select jsonb_build_object(
    'list', jsonb_build_object('id', l.id, 'title', l.title, 'emoji', l.emoji, 'description', l.description,
                               'updatedAt', l.updated_at),
    'tasks', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', t.id, 'parentTaskId', t.parent_task_id, 'title', t.title, 'position', t.position,
               'completed', t.completed_at is not null, 'dueDate', t.due_date) order by t.position, t.id)
        from public.tasks t where t.list_id = l.id and t.deleted_at is null), '[]'::jsonb),
    'document', (select encode(d.state, 'base64') from public.documents d where d.list_id = l.id and d.deleted_at is null)
  ) into result;
  return result;
end;
$$;

grant execute on function app.accept_invitation(text) to authenticated;
grant execute on function app.decline_invitation(uuid) to authenticated;
grant usage on schema app to anon;
grant execute on function app.public_list_by_token(text) to anon, authenticated;

-- Private storage bucket for attachments, avatars, covers and meeting audio. Clients never
-- access it directly: the API authorizes and issues short-lived signed URLs.
do $$
begin
  if exists (select 1 from pg_namespace where nspname = 'storage') then
    insert into storage.buckets (id, name, public, file_size_limit)
    values ('orbit-private', 'orbit-private', false, 104857600)
    on conflict (id) do nothing;
  end if;
end;
$$;

-- Functions are executable by PUBLIC by default; lock the private schema down explicitly.
revoke execute on all functions in schema app from public;
grant execute on all functions in schema app to authenticated, service_role;
grant execute on function app.public_list_by_token(text) to anon;
