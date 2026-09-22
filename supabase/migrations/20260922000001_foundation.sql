-- Foundation: extensions, private helper schema, sync metadata triggers.
--
-- Conventions
--   * Every replicated table has created_at, updated_at, deleted_at (soft delete) and
--     change_xid (xid8 of the last writing transaction). Clients pull rows whose change_xid is
--     >= their cursor, where the cursor is a snapshot xmin, so no committed change is ever missed
--     regardless of commit ordering (see docs/SYNC_ENGINE.md).
--   * Fractional ordering columns use COLLATE "C" so Postgres orders them byte-wise, exactly
--     like JavaScript string comparison.
--   * Access helpers live in the private `app` schema (not exposed through PostgREST).

create extension if not exists pg_trgm with schema extensions;

create schema if not exists app;
grant usage on schema app to authenticated, service_role;

-- Sets updated_at and change_xid on every insert/update of a replicated row.
create or replace function app.touch_row() returns trigger
language plpgsql as $$
begin
  new.updated_at := now();
  new.change_xid := pg_current_xact_id();
  if tg_op = 'INSERT' and new.created_at is null then
    new.created_at := now();
  end if;
  return new;
end;
$$;

-- Emits a lightweight "poke" so realtime servers can tell subscribed clients to pull. The
-- payload never contains data: "w:<workspace_id>" or "u:<user_id>". pg_notify de-duplicates
-- identical payloads within a transaction, so bulk writes produce one poke per scope.
create or replace function app.poke_workspace() returns trigger
language plpgsql as $$
begin
  perform pg_notify('orbit_poke', 'w:' || new.workspace_id::text);
  return null;
end;
$$;

create or replace function app.poke_user() returns trigger
language plpgsql as $$
begin
  perform pg_notify('orbit_poke', 'u:' || new.user_id::text);
  return null;
end;
$$;

create or replace function app.poke_workspace_self() returns trigger
language plpgsql as $$
begin
  perform pg_notify('orbit_poke', 'w:' || new.id::text);
  return null;
end;
$$;

-- Profile changes (names, avatars) are visible to co-members of every workspace.
create or replace function app.poke_profile() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  ws uuid;
begin
  perform pg_notify('orbit_poke', 'u:' || new.id::text);
  for ws in select workspace_id from public.workspace_members where user_id = new.id and deleted_at is null loop
    perform pg_notify('orbit_poke', 'w:' || ws::text);
  end loop;
  return null;
end;
$$;

-- Attach touch + poke triggers to a replicated table.
create or replace function app.replicate(tbl regclass, scope text) returns void
language plpgsql as $$
declare
  name text := split_part(tbl::text, '.', array_length(string_to_array(tbl::text, '.'), 1));
begin
  execute format('create trigger %I before insert or update on %s for each row execute function app.touch_row()', name || '_touch', tbl);
  if scope = 'workspace' then
    execute format('create trigger %I after insert or update on %s for each row execute function app.poke_workspace()', name || '_poke', tbl);
  elsif scope = 'user' then
    execute format('create trigger %I after insert or update on %s for each row execute function app.poke_user()', name || '_poke', tbl);
  end if;
end;
$$;
