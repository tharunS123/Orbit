-- Access helpers and Row Level Security.
--
-- Access model (mirrors packages/core/src/permissions.ts):
--   * Workspace data requires an active membership.
--   * A list is visible to its creator, to explicit list members, to non-guest workspace members
--     when visibility = 'workspace', and — recursively — wherever its parent list is visible.
--     Access level is the strongest of: owner > editor > viewer.
--   * Tasks in a list inherit the list's access. List-less tasks (Inbox) are visible to their
--     creator and assignee; list-less subtasks follow their root task.
--   * Guests never get workspace-wide visibility.
-- Helper functions are SECURITY DEFINER so policies can consult other RLS-protected tables
-- without recursion, and STABLE so the planner evaluates them once per statement.

create or replace function app.uid() returns uuid
language sql stable set search_path = '' as $$ select auth.uid() $$;

create or replace function app.my_workspace_ids() returns setof uuid
language sql stable security definer set search_path = '' as $$
  select workspace_id from public.workspace_members
   where user_id = auth.uid() and deleted_at is null
$$;

-- Workspaces where the current user is a full (non-guest) member.
create or replace function app.full_member_workspace_ids() returns setof uuid
language sql stable security definer set search_path = '' as $$
  select workspace_id from public.workspace_members
   where user_id = auth.uid() and deleted_at is null and role <> 'guest'
$$;

create or replace function app.workspace_role(ws uuid) returns text
language sql stable security definer set search_path = '' as $$
  select role from public.workspace_members
   where workspace_id = ws and user_id = auth.uid() and deleted_at is null
$$;

create or replace function app.is_workspace_owner(ws uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.workspaces where id = ws and owner_id = auth.uid() and deleted_at is null)
$$;

-- (list_id, level) for every list user `u` can see. level: 3 owner, 2 editor, 1 viewer.
create or replace function app.list_access_levels_for(u uuid) returns table (list_id uuid, level int)
language sql stable security definer set search_path = '' as $$
  with recursive
  me as (select u as uid),
  memberships as (
    select wm.workspace_id, wm.role from public.workspace_members wm, me
     where wm.user_id = me.uid and wm.deleted_at is null
  ),
  direct as (
    select l.id, case
             when l.created_by = me.uid then 3
             when lm.role = 'editor' then 2
             when lm.role = 'viewer' then
               case when l.visibility = 'workspace' and m.role <> 'guest' then 2 else 1 end
             when l.visibility = 'workspace' and m.role <> 'guest' then 2
             else 0
           end as level
      from public.lists l
      join memberships m on m.workspace_id = l.workspace_id
      cross join me
      left join public.list_members lm on lm.list_id = l.id and lm.user_id = me.uid and lm.deleted_at is null
  ),
  tree (id, level, depth) as (
    select id, level, 0 from direct where level > 0
    union all
    select c.id, t.level, t.depth + 1
      from public.lists c
      join tree t on c.parent_list_id = t.id
     where t.depth < 50
  )
  select id, max(level)::int from (
    select id, level from tree
    union all
    select id, level from direct where level > 0
  ) all_levels
  group by id
$$;

create or replace function app.list_access_levels() returns table (list_id uuid, level int)
language sql stable security definer set search_path = '' as $$
  select * from app.list_access_levels_for(auth.uid())
$$;

-- Server-side checks about *other* users (e.g. can the assignee see this list?).
create or replace function app.user_list_level(u uuid, l uuid) returns int
language sql stable security definer set search_path = '' as $$
  select coalesce((select level from app.list_access_levels_for(u) where list_id = l), 0)
$$;

create or replace function app.user_can_access_task(u uuid, tid uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.tasks t
     where t.id = tid
       and exists (select 1 from public.workspace_members wm
                    where wm.workspace_id = t.workspace_id and wm.user_id = u and wm.deleted_at is null)
       and (
         (t.list_id is not null and app.user_list_level(u, t.list_id) > 0)
         or (t.list_id is null and (
               t.created_by = u or t.assignee_id = u
               or exists (select 1 from public.tasks r where r.id = t.root_task_id and (r.created_by = u or r.assignee_id = u))))
       )
  )
$$;

create or replace function app.is_workspace_member(ws uuid, u uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.workspace_members
                  where workspace_id = ws and user_id = u and deleted_at is null)
$$;

create or replace function app.accessible_list_ids() returns setof uuid
language sql stable security definer set search_path = '' as $$
  select list_id from app.list_access_levels()
$$;

create or replace function app.editable_list_ids() returns setof uuid
language sql stable security definer set search_path = '' as $$
  select list_id from app.list_access_levels() where level >= 2
$$;

create or replace function app.list_level(l uuid) returns int
language sql stable security definer set search_path = '' as $$
  select coalesce((select level from app.list_access_levels() where list_id = l), 0)
$$;

-- Can the current user share/unshare a list (owner, or a non-guest editor)?
create or replace function app.can_share_list(l uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.lists li
     where li.id = l
       and (app.list_level(l) = 3
            or (app.list_level(l) = 2 and app.workspace_role(li.workspace_id) in ('owner', 'admin', 'member')))
  )
$$;

create or replace function app.listless_root_ids() returns setof uuid
language sql stable security definer set search_path = '' as $$
  select id from public.tasks
   where list_id is null and parent_task_id is null
     and (created_by = auth.uid() or assignee_id = auth.uid())
$$;

create or replace function app.accessible_task_ids() returns setof uuid
language sql stable security definer set search_path = '' as $$
  select t.id from public.tasks t
   where t.workspace_id in (select app.my_workspace_ids())
     and (
       t.list_id in (select app.accessible_list_ids())
       or (t.list_id is null and (
             t.created_by = auth.uid() or t.assignee_id = auth.uid()
             or t.root_task_id in (select app.listless_root_ids())))
     )
$$;

create or replace function app.editable_task_ids() returns setof uuid
language sql stable security definer set search_path = '' as $$
  select t.id from public.tasks t
   where t.workspace_id in (select app.my_workspace_ids())
     and (
       t.list_id in (select app.editable_list_ids())
       or (t.list_id is null and (
             t.created_by = auth.uid() or t.assignee_id = auth.uid()
             or t.root_task_id in (select app.listless_root_ids())))
     )
$$;

create or replace function app.can_access_task(tid uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from app.accessible_task_ids() x where x = tid)
$$;

-- Users whose basic profile the current user may see.
create or replace function app.visible_user_ids() returns setof uuid
language sql stable security definer set search_path = '' as $$
  select auth.uid()
  union
  select other.user_id
    from public.workspace_members mine
    join public.workspace_members other on other.workspace_id = mine.workspace_id and other.deleted_at is null
   where mine.user_id = auth.uid() and mine.deleted_at is null
     and (mine.role <> 'guest' or other.role in ('owner', 'admin'))
  union
  select l.created_by from public.lists l where l.id in (select app.accessible_list_ids())
  union
  select lm.user_id from public.list_members lm
   where lm.list_id in (select app.accessible_list_ids()) and lm.deleted_at is null
$$;

create or replace function app.my_email() returns text
language sql stable security definer set search_path = '' as $$
  select lower(email) from public.profiles where id = auth.uid()
$$;

grant execute on all functions in schema app to authenticated, service_role;

-- ───────────────────────────── guard triggers ─────────────────────────────
-- Column-level rules that RLS cannot express. They are skipped for service/definer contexts
-- (auth.uid() is null) where the server performs its own checks.

create or replace function app.guard_workspace_update() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if auth.uid() is null then return new; end if;
  if new.owner_id <> old.owner_id or new.kind <> old.kind then
    raise exception 'only ownership transfer can change the owner' using errcode = 'insufficient_privilege';
  end if;
  if new.deleted_at is distinct from old.deleted_at and app.workspace_role(old.id) <> 'owner' then
    raise exception 'only the owner can delete a workspace' using errcode = 'insufficient_privilege';
  end if;
  if old.kind = 'personal' and new.deleted_at is not null then
    raise exception 'the personal workspace cannot be deleted' using errcode = 'check_violation';
  end if;
  return new;
end;
$$;
create trigger workspaces_guard before update on public.workspaces
  for each row execute function app.guard_workspace_update();

create or replace function app.guard_member_write() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  actor text;
  me uuid := auth.uid();
begin
  if me is null then return new; end if;
  actor := app.workspace_role(new.workspace_id);
  if tg_op = 'INSERT' then
    if new.role = 'owner' then
      if not (new.user_id = me and app.is_workspace_owner(new.workspace_id)) then
        raise exception 'cannot add an owner' using errcode = 'insufficient_privilege';
      end if;
    elsif actor not in ('owner', 'admin') or (actor = 'admin' and new.role = 'admin') then
      raise exception 'insufficient role to add members' using errcode = 'insufficient_privilege';
    end if;
    return new;
  end if;
  -- UPDATE
  if new.user_id <> old.user_id or new.workspace_id <> old.workspace_id then
    raise exception 'membership identity is immutable' using errcode = 'check_violation';
  end if;
  if new.role <> old.role then
    if old.role = 'owner' or new.role = 'owner' then
      raise exception 'use ownership transfer' using errcode = 'insufficient_privilege';
    end if;
    if actor = 'owner' then null;
    elsif actor = 'admin' and old.role in ('member', 'guest') and new.role in ('member', 'guest') then null;
    else raise exception 'insufficient role to change roles' using errcode = 'insufficient_privilege';
    end if;
  end if;
  if new.deleted_at is not null and old.deleted_at is null then
    if old.role = 'owner' then
      raise exception 'the owner must transfer ownership before leaving' using errcode = 'check_violation';
    end if;
    if not (old.user_id = me or actor = 'owner' or (actor = 'admin' and old.role in ('member', 'guest'))) then
      raise exception 'insufficient role to remove members' using errcode = 'insufficient_privilege';
    end if;
  end if;
  if new.deleted_at is null and old.deleted_at is not null and actor not in ('owner', 'admin') then
    raise exception 'insufficient role to restore members' using errcode = 'insufficient_privilege';
  end if;
  return new;
end;
$$;
create trigger workspace_members_guard before insert or update on public.workspace_members
  for each row execute function app.guard_member_write();

create or replace function app.guard_list_update() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  lvl int;
  role text;
begin
  if auth.uid() is null then return new; end if;
  lvl := app.list_level(old.id);
  role := app.workspace_role(old.workspace_id);
  if new.created_by <> old.created_by then
    raise exception 'list creator is immutable' using errcode = 'check_violation';
  end if;
  if new.visibility <> old.visibility and not app.can_share_list(old.id) then
    raise exception 'insufficient access to change sharing' using errcode = 'insufficient_privilege';
  end if;
  if (new.deleted_at is distinct from old.deleted_at or new.archived_at is distinct from old.archived_at)
     and not (lvl = 3 or role in ('owner', 'admin')) then
    raise exception 'only the list owner or an admin can delete or archive a list' using errcode = 'insufficient_privilege';
  end if;
  return new;
end;
$$;
create trigger lists_guard before update on public.lists
  for each row execute function app.guard_list_update();

create or replace function app.guard_message_update() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if auth.uid() is null then return new; end if;
  if new.author_id <> old.author_id or new.task_id <> old.task_id or new.kind <> old.kind then
    raise exception 'message identity is immutable' using errcode = 'check_violation';
  end if;
  if old.author_id <> auth.uid() then
    raise exception 'only the author can edit a message' using errcode = 'insufficient_privilege';
  end if;
  return new;
end;
$$;
create trigger task_messages_guard before update on public.task_messages
  for each row execute function app.guard_message_update();

-- ───────────────────────────── RLS ─────────────────────────────
alter table public.profiles enable row level security;
alter table public.workspaces enable row level security;
alter table public.workspace_members enable row level security;
alter table public.workspace_invitations enable row level security;
alter table public.lists enable row level security;
alter table public.list_members enable row level security;
alter table public.list_public_links enable row level security;
alter table public.sections enable row level security;
alter table public.section_items enable row level security;
alter table public.labels enable row level security;
alter table public.tasks enable row level security;
alter table public.task_user_states enable row level security;
alter table public.task_completions enable row level security;
alter table public.documents enable row level security;
alter table public.document_snapshots enable row level security;
alter table public.attachments enable row level security;
alter table public.task_messages enable row level security;
alter table public.message_reactions enable row level security;
alter table public.activity_events enable row level security;
alter table public.notifications enable row level security;

-- profiles
create policy profiles_select on public.profiles for select to authenticated
  using (id in (select app.visible_user_ids()));
create policy profiles_update on public.profiles for update to authenticated
  using (id = (select auth.uid())) with check (id = (select auth.uid()));

-- workspaces
create policy workspaces_select on public.workspaces for select to authenticated
  using (id in (select app.my_workspace_ids()) or owner_id = (select auth.uid()));
create policy workspaces_insert on public.workspaces for insert to authenticated
  with check (owner_id = (select auth.uid()) and kind = 'team');
create policy workspaces_update on public.workspaces for update to authenticated
  using (app.workspace_role(id) in ('owner', 'admin'))
  with check (app.workspace_role(id) in ('owner', 'admin'));

-- workspace members
create policy workspace_members_select on public.workspace_members for select to authenticated
  using (
    user_id = (select auth.uid())
    or workspace_id in (select app.full_member_workspace_ids())
    or (workspace_id in (select app.my_workspace_ids()) and user_id in (select app.visible_user_ids()))
  );
create policy workspace_members_insert on public.workspace_members for insert to authenticated
  with check (
    (user_id = (select auth.uid()) and role = 'owner' and app.is_workspace_owner(workspace_id))
    or app.workspace_role(workspace_id) in ('owner', 'admin')
  );
create policy workspace_members_update on public.workspace_members for update to authenticated
  using (user_id = (select auth.uid()) or app.workspace_role(workspace_id) in ('owner', 'admin'))
  with check (user_id = (select auth.uid()) or app.workspace_role(workspace_id) in ('owner', 'admin'));

-- invitations
create policy invitations_select on public.workspace_invitations for select to authenticated
  using (
    invited_by = (select auth.uid())
    or app.workspace_role(workspace_id) in ('owner', 'admin')
    or (status = 'pending' and lower(email) = (select app.my_email()))
  );
create policy invitations_insert on public.workspace_invitations for insert to authenticated
  with check (
    invited_by = (select auth.uid())
    and app.workspace_role(workspace_id) in ('owner', 'admin', 'member')
    and (role <> 'admin' or app.workspace_role(workspace_id) = 'owner')
    and (list_id is null or app.can_share_list(list_id))
  );
create policy invitations_update on public.workspace_invitations for update to authenticated
  using (invited_by = (select auth.uid()) or app.workspace_role(workspace_id) in ('owner', 'admin'))
  with check (invited_by = (select auth.uid()) or app.workspace_role(workspace_id) in ('owner', 'admin'));

-- lists
-- Policies are phrased on the row's own columns where possible: Postgres checks SELECT policies
-- for INSERT ... RETURNING before the new row is visible to helper functions.
create policy lists_select on public.lists for select to authenticated
  using (
    id in (select app.accessible_list_ids())
    or (created_by = (select auth.uid()) and workspace_id in (select app.my_workspace_ids()))
  );
create policy lists_insert on public.lists for insert to authenticated
  with check (
    created_by = (select auth.uid())
    and app.workspace_role(workspace_id) in ('owner', 'admin', 'member')
    and (parent_list_id is null or parent_list_id in (select app.editable_list_ids()))
  );
create policy lists_update on public.lists for update to authenticated
  using (id in (select app.editable_list_ids()))
  with check (id in (select app.editable_list_ids()));

-- list members
create policy list_members_select on public.list_members for select to authenticated
  using (user_id = (select auth.uid()) or list_id in (select app.accessible_list_ids()));
create policy list_members_insert on public.list_members for insert to authenticated
  with check (added_by = (select auth.uid()) and app.can_share_list(list_id)
              and workspace_id = (select workspace_id from public.lists where id = list_id));
create policy list_members_update on public.list_members for update to authenticated
  using (app.can_share_list(list_id) or user_id = (select auth.uid()))
  with check (app.can_share_list(list_id) or user_id = (select auth.uid()));

-- public links (managed by sharers; public reads go through app.public_list_by_token)
create policy list_public_links_select on public.list_public_links for select to authenticated
  using (app.can_share_list(list_id));
create policy list_public_links_insert on public.list_public_links for insert to authenticated
  with check (created_by = (select auth.uid()) and app.can_share_list(list_id));
create policy list_public_links_update on public.list_public_links for update to authenticated
  using (app.can_share_list(list_id)) with check (app.can_share_list(list_id));

-- sections (personal)
create policy sections_all on public.sections for all to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()) and workspace_id in (select app.my_workspace_ids()));
create policy section_items_all on public.section_items for all to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()) and list_id in (select app.accessible_list_ids()));

-- labels
create policy labels_select on public.labels for select to authenticated
  using (workspace_id in (select app.my_workspace_ids()));
create policy labels_insert on public.labels for insert to authenticated
  with check (created_by = (select auth.uid()) and app.workspace_role(workspace_id) in ('owner', 'admin', 'member'));
create policy labels_update on public.labels for update to authenticated
  using (app.workspace_role(workspace_id) in ('owner', 'admin', 'member'))
  with check (app.workspace_role(workspace_id) in ('owner', 'admin', 'member'));

-- tasks
create policy tasks_select on public.tasks for select to authenticated
  using (
    workspace_id in (select app.my_workspace_ids())
    and (
      list_id in (select app.accessible_list_ids())
      or (list_id is null and (
            created_by = (select auth.uid()) or assignee_id = (select auth.uid())
            or root_task_id in (select app.listless_root_ids())))
    )
  );
create policy tasks_insert on public.tasks for insert to authenticated
  with check (
    created_by = (select auth.uid())
    and workspace_id in (select app.my_workspace_ids())
    and (
      (list_id is not null and list_id in (select app.editable_list_ids()))
      or (list_id is null and parent_task_id is null)
      or (parent_task_id is not null and parent_task_id in (select app.editable_task_ids()))
    )
  );
create policy tasks_update on public.tasks for update to authenticated
  using (
    workspace_id in (select app.my_workspace_ids())
    and (
      list_id in (select app.editable_list_ids())
      or (list_id is null and (
            created_by = (select auth.uid()) or assignee_id = (select auth.uid())
            or root_task_id in (select app.listless_root_ids())))
    )
  )
  with check (
    workspace_id in (select app.my_workspace_ids())
    and (
      (list_id is not null and list_id in (select app.editable_list_ids()))
      or list_id is null
    )
  );

-- per-user task state
create policy task_user_states_all on public.task_user_states for all to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()) and task_id in (select app.accessible_task_ids()));

create policy task_completions_select on public.task_completions for select to authenticated
  using (user_id = (select auth.uid()));
create policy task_completions_insert on public.task_completions for insert to authenticated
  with check (user_id = (select auth.uid()) and task_id in (select app.editable_task_ids()));
create policy task_completions_update on public.task_completions for update to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));

-- documents (clients read via the collaboration server; search reads here)
create policy documents_select on public.documents for select to authenticated
  using (list_id in (select app.accessible_list_ids()) or task_id in (select app.accessible_task_ids()));
-- Users may create documents for things they can edit (e.g. when duplicating); ongoing writes
-- come from the collaboration server after its own authorization check.
create policy documents_insert on public.documents for insert to authenticated
  with check (
    workspace_id in (select app.my_workspace_ids())
    and (
      (list_id is not null and list_id in (select app.editable_list_ids()))
      or (task_id is not null and task_id in (select app.editable_task_ids()))
    )
  );
create policy document_snapshots_select on public.document_snapshots for select to authenticated
  using (document_id in (select id from public.documents));

-- attachments
create policy attachments_select on public.attachments for select to authenticated
  using (
    (task_id is not null and task_id in (select app.accessible_task_ids()))
    or (task_id is null and list_id is not null and list_id in (select app.accessible_list_ids()))
    or (task_id is null and list_id is null and message_id in (
          select m.id from public.task_messages m where m.task_id in (select app.accessible_task_ids())))
  );
create policy attachments_insert on public.attachments for insert to authenticated
  with check (
    uploaded_by = (select auth.uid())
    and workspace_id in (select app.my_workspace_ids())
    and (
      (task_id is not null and task_id in (select app.accessible_task_ids()))
      or (task_id is null and list_id is not null and list_id in (select app.editable_list_ids()))
      or (task_id is null and list_id is null and message_id in (
            select m.id from public.task_messages m where m.author_id = (select auth.uid())))
    )
  );
create policy attachments_update on public.attachments for update to authenticated
  using (
    uploaded_by = (select auth.uid())
    or (task_id is not null and task_id in (select app.editable_task_ids()))
    or (list_id is not null and list_id in (select app.editable_list_ids()))
  )
  with check (workspace_id in (select app.my_workspace_ids()));

-- messages & reactions (anyone who can see a task can discuss it)
create policy task_messages_select on public.task_messages for select to authenticated
  using (task_id in (select app.accessible_task_ids()));
create policy task_messages_insert on public.task_messages for insert to authenticated
  with check (author_id = (select auth.uid()) and task_id in (select app.accessible_task_ids()));
create policy task_messages_update on public.task_messages for update to authenticated
  using (author_id = (select auth.uid())) with check (author_id = (select auth.uid()));

create policy message_reactions_select on public.message_reactions for select to authenticated
  using (task_id in (select app.accessible_task_ids()));
create policy message_reactions_insert on public.message_reactions for insert to authenticated
  with check (user_id = (select auth.uid()) and task_id in (select app.accessible_task_ids()));
create policy message_reactions_update on public.message_reactions for update to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));

-- activity
create policy activity_select on public.activity_events for select to authenticated
  using (
    (task_id is not null and task_id in (select app.accessible_task_ids()))
    or (task_id is null and list_id in (select app.accessible_list_ids()))
  );
create policy activity_insert on public.activity_events for insert to authenticated
  with check (actor_id = (select auth.uid()) and workspace_id in (select app.my_workspace_ids()));

-- notifications: own inbox only. Other users' notifications are created via app.notify(),
-- which checks the recipient can see what the notification points at.
create policy notifications_select on public.notifications for select to authenticated
  using (user_id = (select auth.uid()));
create policy notifications_update on public.notifications for update to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));

-- Clients never use the anon role for data.
revoke all on all tables in schema public from anon;
alter default privileges in schema public revoke all on tables from anon;
