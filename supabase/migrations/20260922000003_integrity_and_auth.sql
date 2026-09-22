-- Integrity triggers (derived columns, hierarchy consistency) and auth hooks.

-- ───────────────────────────── tasks: derived columns ─────────────────────────────
create or replace function app.task_before_write() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  parent record;
  cursor_id uuid;
  depth int := 0;
begin
  if tg_op = 'UPDATE' and new.workspace_id <> old.workspace_id then
    raise exception 'tasks cannot change workspace' using errcode = 'check_violation';
  end if;

  if new.parent_task_id is not null then
    select id, root_task_id, list_id, workspace_id into parent from public.tasks where id = new.parent_task_id;
    if not found then
      raise exception 'parent task not found' using errcode = 'foreign_key_violation';
    end if;
    if parent.workspace_id <> new.workspace_id then
      raise exception 'parent task is in another workspace' using errcode = 'check_violation';
    end if;
    -- Cycle check: walk up from the new parent; we must never meet ourselves.
    if tg_op = 'UPDATE' and new.parent_task_id is distinct from old.parent_task_id then
      cursor_id := new.parent_task_id;
      while cursor_id is not null loop
        if cursor_id = new.id then
          raise exception 'a task cannot be nested inside itself' using errcode = 'check_violation';
        end if;
        depth := depth + 1;
        if depth > 1000 then exit; end if;
        select parent_task_id into cursor_id from public.tasks where id = cursor_id;
      end loop;
    end if;
    new.root_task_id := coalesce(parent.root_task_id, parent.id);
    new.list_id := parent.list_id;
  else
    new.root_task_id := null;
  end if;

  if new.due_date is not null and new.due_time is not null then
    new.due_at := (new.due_date + new.due_time) at time zone coalesce(nullif(new.due_tz, ''), 'UTC');
  else
    new.due_at := null;
  end if;
  if new.due_date is null then
    new.due_time := null;
  end if;
  return new;
end;
$$;
create trigger tasks_before_write before insert or update on public.tasks
  for each row execute function app.task_before_write();

-- Keep descendants' root/list in sync when a subtree moves, and parents' child counters fresh.
create or replace function app.task_after_write() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  parents uuid[];
begin
  -- Cascade one level; each child's own trigger continues down the subtree. (Row-by-row
  -- cascading guarantees every child reads an already-updated parent.)
  if tg_op = 'UPDATE' and (new.list_id is distinct from old.list_id or new.root_task_id is distinct from old.root_task_id) then
    update public.tasks t
       set list_id = new.list_id,
           root_task_id = coalesce(new.root_task_id, new.id)
     where t.parent_task_id = new.id
       and (t.list_id is distinct from new.list_id or t.root_task_id is distinct from coalesce(new.root_task_id, new.id));
  end if;

  if tg_op = 'INSERT' then
    parents := array[new.parent_task_id];
  elsif new.parent_task_id is not distinct from old.parent_task_id
        and (new.completed_at is null) = (old.completed_at is null)
        and (new.deleted_at is null) = (old.deleted_at is null) then
    return null;
  else
    parents := array[old.parent_task_id, new.parent_task_id];
  end if;

  update public.tasks p set
    child_count = (select count(*) from public.tasks c where c.parent_task_id = p.id and c.deleted_at is null),
    child_completed_count = (select count(*) from public.tasks c
                              where c.parent_task_id = p.id and c.deleted_at is null and c.completed_at is not null)
  where p.id = any (parents);
  return null;
end;
$$;
create trigger tasks_after_write after insert or update on public.tasks
  for each row execute function app.task_after_write();

-- ───────────────────────────── lists: hierarchy ─────────────────────────────
create or replace function app.list_before_write() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  parent_ws uuid;
  cursor_id uuid;
  depth int := 0;
begin
  if tg_op = 'UPDATE' and new.workspace_id <> old.workspace_id then
    raise exception 'lists cannot change workspace' using errcode = 'check_violation';
  end if;
  if new.parent_list_id is not null and (tg_op = 'INSERT' or new.parent_list_id is distinct from old.parent_list_id) then
    select workspace_id into parent_ws from public.lists where id = new.parent_list_id;
    if parent_ws is null or parent_ws <> new.workspace_id then
      raise exception 'parent list must be in the same workspace' using errcode = 'check_violation';
    end if;
    cursor_id := new.parent_list_id;
    while cursor_id is not null loop
      if cursor_id = new.id then
        raise exception 'a list cannot be nested inside itself' using errcode = 'check_violation';
      end if;
      depth := depth + 1;
      if depth > 100 then exit; end if;
      select parent_list_id into cursor_id from public.lists where id = cursor_id;
    end loop;
  end if;
  return new;
end;
$$;
create trigger lists_before_write before insert or update on public.lists
  for each row execute function app.list_before_write();

-- ───────────────────────────── auth hooks ─────────────────────────────
create or replace function app.valid_timezone(tz text) returns text
language sql stable set search_path = '' as $$
  select case when exists (select 1 from pg_catalog.pg_timezone_names where name = tz) then tz else 'UTC' end;
$$;

-- Every new auth user gets a profile, a personal workspace and owner membership.
create or replace function app.handle_new_user() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  ws uuid := gen_random_uuid();
  display text;
begin
  display := coalesce(
    nullif(trim(new.raw_user_meta_data ->> 'display_name'), ''),
    nullif(trim(new.raw_user_meta_data ->> 'full_name'), ''),
    nullif(trim(new.raw_user_meta_data ->> 'name'), ''),
    nullif(split_part(coalesce(new.email, ''), '@', 1), ''),
    'Me');
  insert into public.profiles (id, email, display_name, timezone)
  values (new.id, lower(new.email), left(display, 120), app.valid_timezone(coalesce(new.raw_user_meta_data ->> 'timezone', 'UTC')))
  on conflict (id) do nothing;
  insert into public.workspaces (id, name, kind, owner_id) values (ws, 'Personal', 'personal', new.id);
  insert into public.workspace_members (workspace_id, user_id, role) values (ws, new.id, 'owner');
  return new;
end;
$$;
create trigger on_auth_user_created after insert on auth.users
  for each row execute function app.handle_new_user();

create or replace function app.handle_user_email_change() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  update public.profiles set email = lower(new.email) where id = new.id;
  return new;
end;
$$;
create trigger on_auth_user_email_changed after update of email on auth.users
  for each row when (old.email is distinct from new.email)
  execute function app.handle_user_email_change();
