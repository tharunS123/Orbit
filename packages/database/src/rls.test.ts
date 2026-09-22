import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { asAnon, asService, asUser, type Sql } from './client';
import { createTestDatabase, createTestUser, type TestDatabase, type TestUser } from './testing';

/**
 * Row Level Security and integrity tests. These run the real migrations in PGlite and act as
 * different users through the same `asUser` path the API uses.
 */

let db: TestDatabase;
let sql: Sql;
let alice: TestUser;
let bob: TestUser;
let carol: TestUser; // guest
let mallory: TestUser; // outsider
let teamId: string;

const as = <T>(u: TestUser, fn: Parameters<typeof asUser<T>>[2]) => asUser(sql, { userId: u.id }, fn);

beforeAll(async () => {
  db = await createTestDatabase();
  sql = db.sql;
  alice = await createTestUser(sql, 'Alice');
  bob = await createTestUser(sql, 'Bob');
  carol = await createTestUser(sql, 'Carol');
  mallory = await createTestUser(sql, 'Mallory');

  teamId = await as(alice, async (tx) => {
    const [ws] = await tx`insert into workspaces (name, kind, owner_id) values ('Acme', 'team', ${alice.id}) returning id`;
    await tx`insert into workspace_members (workspace_id, user_id, role) values (${ws!.id}, ${alice.id}, 'owner')`;
    await tx`insert into workspace_members (workspace_id, user_id, role) values (${ws!.id}, ${bob.id}, 'member')`;
    await tx`insert into workspace_members (workspace_id, user_id, role) values (${ws!.id}, ${carol.id}, 'guest')`;
    return ws!.id as string;
  });
}, 60_000);

afterAll(async () => {
  await db?.close();
});

async function createList(u: TestUser, ws: string, visibility = 'private', title = 'List', parent: string | null = null) {
  return as(u, async (tx) => {
    const [l] = await tx`insert into lists (workspace_id, created_by, title, visibility, parent_list_id)
                         values (${ws}, ${u.id}, ${title}, ${visibility}, ${parent}) returning id`;
    return l!.id as string;
  });
}

async function createTask(u: TestUser, ws: string, listId: string | null, title = 'Task', parent: string | null = null) {
  return as(u, async (tx) => {
    const [t] = await tx`insert into tasks (workspace_id, list_id, parent_task_id, created_by, title, position)
                         values (${ws}, ${listId}, ${parent}, ${u.id}, ${title}, 'a0') returning id`;
    return t!.id as string;
  });
}

const visibleTasks = (u: TestUser) => as(u, (tx) => tx`select id, title from tasks`);
const visibleLists = (u: TestUser) => as(u, (tx) => tx`select id from lists`);

describe('signup trigger', () => {
  it('creates profile, personal workspace and owner membership', async () => {
    const rows = await as(alice, (tx) => tx`select w.kind, m.role, p.display_name from workspaces w
      join workspace_members m on m.workspace_id = w.id and m.user_id = ${alice.id}
      join profiles p on p.id = ${alice.id} where w.id = ${alice.personalWorkspaceId}`);
    expect(rows[0]).toMatchObject({ kind: 'personal', role: 'owner', displayName: 'Alice' });
  });
});

describe('workspace isolation', () => {
  it('user A cannot see user B personal data', async () => {
    const list = await createList(alice, alice.personalWorkspaceId, 'private', 'Secret');
    await createTask(alice, alice.personalWorkspaceId, list, 'Secret task');
    await createTask(alice, alice.personalWorkspaceId, null, 'Inbox secret');
    expect((await visibleTasks(mallory)).length).toBe(0);
    expect((await visibleLists(mallory)).length).toBe(0);
    const ws = await as(mallory, (tx) => tx`select id from workspaces where id = ${alice.personalWorkspaceId}`);
    expect(ws.length).toBe(0);
  });

  it('cannot insert into someone else\'s workspace', async () => {
    await expect(createList(mallory, alice.personalWorkspaceId)).rejects.toMatchObject({ code: 'forbidden' });
    await expect(createTask(mallory, alice.personalWorkspaceId, null)).rejects.toMatchObject({ code: 'forbidden' });
  });

  it('cannot update rows it cannot see (silently zero rows)', async () => {
    const list = await createList(alice, alice.personalWorkspaceId, 'private', 'Mine');
    const task = await createTask(alice, alice.personalWorkspaceId, list, 'Keep');
    const res = await as(mallory, (tx) => tx`update tasks set title = 'pwned' where id = ${task} returning id`);
    expect(res.length).toBe(0);
    const [row] = await asService(sql, (tx) => tx`select title from tasks where id = ${task}`);
    expect(row!.title).toBe('Keep');
  });

  it('cannot add itself to a workspace', async () => {
    await expect(
      as(mallory, (tx) => tx`insert into workspace_members (workspace_id, user_id, role) values (${teamId}, ${mallory.id}, 'member')`),
    ).rejects.toMatchObject({ code: 'forbidden' });
  });

  it('personal workspaces cannot be created directly', async () => {
    await expect(
      as(mallory, (tx) => tx`insert into workspaces (name, kind, owner_id) values ('x', 'personal', ${mallory.id})`),
    ).rejects.toMatchObject({ code: 'forbidden' });
  });
});

describe('list visibility', () => {
  it('private lists are visible only to the creator', async () => {
    const list = await createList(alice, teamId, 'private', 'Alice private');
    await createTask(alice, teamId, list, 'private task');
    expect((await visibleLists(bob)).map((r) => r.id)).not.toContain(list);
  });

  it('workspace lists are visible to members but not guests', async () => {
    const list = await createList(alice, teamId, 'workspace', 'Team list');
    const task = await createTask(alice, teamId, list, 'team task');
    expect((await visibleTasks(bob)).map((r) => r.id)).toContain(task);
    expect((await visibleTasks(carol)).map((r) => r.id)).not.toContain(task);
    // Bob can edit
    const upd = await as(bob, (tx) => tx`update tasks set title = 'edited by bob' where id = ${task} returning id`);
    expect(upd.length).toBe(1);
  });

  it('guests see only lists shared with them, and sublists inherit sharing', async () => {
    const parent = await createList(alice, teamId, 'shared', 'Project');
    const child = await createList(alice, teamId, 'private', 'Sub', parent);
    const task = await createTask(alice, teamId, child, 'nested task');
    await as(alice, (tx) => tx`insert into list_members (list_id, workspace_id, user_id, role, added_by)
                                values (${parent}, ${teamId}, ${carol.id}, 'viewer', ${alice.id})`);
    const lists = (await visibleLists(carol)).map((r) => r.id);
    expect(lists).toEqual(expect.arrayContaining([parent, child]));
    expect((await visibleTasks(carol)).map((r) => r.id)).toContain(task);
    // Viewer cannot edit
    const upd = await as(carol, (tx) => tx`update tasks set title = 'x' where id = ${task} returning id`);
    expect(upd.length).toBe(0);
    await expect(createTask(carol, teamId, child, 'guest task')).rejects.toMatchObject({ code: 'forbidden' });
  });

  it('guest cannot create lists or share', async () => {
    await expect(createList(carol, teamId)).rejects.toMatchObject({ code: 'forbidden' });
    const list = await createList(alice, teamId, 'shared', 'Shared w/ carol');
    await as(alice, (tx) => tx`insert into list_members (list_id, workspace_id, user_id, role, added_by)
                                values (${list}, ${teamId}, ${carol.id}, 'editor', ${alice.id})`);
    await expect(
      as(carol, (tx) => tx`insert into list_members (list_id, workspace_id, user_id, role, added_by)
                           values (${list}, ${teamId}, ${bob.id}, 'editor', ${carol.id})`),
    ).rejects.toMatchObject({ code: 'forbidden' });
    // but can edit tasks there
    const t = await createTask(carol, teamId, list, 'guest-created');
    expect(t).toBeTruthy();
  });

  it('only owner/admin can delete a list; editors can rename', async () => {
    const list = await createList(alice, teamId, 'workspace', 'Deletable');
    const renamed = await as(bob, (tx) => tx`update lists set title = 'Renamed' where id = ${list} returning id`);
    expect(renamed.length).toBe(1);
    await expect(as(bob, (tx) => tx`update lists set deleted_at = now() where id = ${list}`)).rejects.toMatchObject({
      code: 'forbidden',
    });
    await as(alice, (tx) => tx`update lists set deleted_at = now() where id = ${list}`);
  });
});

describe('revoked memberships', () => {
  it('removing a member revokes access immediately', async () => {
    const dave = await createTestUser(sql, 'Dave');
    await as(alice, (tx) => tx`insert into workspace_members (workspace_id, user_id, role) values (${teamId}, ${dave.id}, 'member')`);
    const list = await createList(alice, teamId, 'workspace', 'Visible to dave');
    const task = await createTask(alice, teamId, list, 'dave sees');
    expect((await visibleTasks(dave)).map((r) => r.id)).toContain(task);
    await as(alice, (tx) => tx`update workspace_members set deleted_at = now() where workspace_id = ${teamId} and user_id = ${dave.id}`);
    expect((await visibleTasks(dave)).map((r) => r.id)).not.toContain(task);
    // but still sees its own (tombstoned) membership so the client can purge
    const own = await as(dave, (tx) => tx`select deleted_at from workspace_members where workspace_id = ${teamId}`);
    expect(own[0]!.deletedAt).not.toBeNull();
  });

  it('removed list member loses access', async () => {
    const list = await createList(alice, teamId, 'shared', 'Temp share');
    await as(alice, (tx) => tx`insert into list_members (list_id, workspace_id, user_id, role, added_by)
                                values (${list}, ${teamId}, ${carol.id}, 'editor', ${alice.id})`);
    expect((await visibleLists(carol)).map((r) => r.id)).toContain(list);
    await as(alice, (tx) => tx`update list_members set deleted_at = now() where list_id = ${list} and user_id = ${carol.id}`);
    expect((await visibleLists(carol)).map((r) => r.id)).not.toContain(list);
  });
});

describe('role guards', () => {
  it('admins cannot promote to admin; members cannot change roles; owner cannot leave', async () => {
    const erin = await createTestUser(sql, 'Erin');
    await as(alice, (tx) => tx`insert into workspace_members (workspace_id, user_id, role) values (${teamId}, ${erin.id}, 'admin')`);
    await expect(
      as(erin, (tx) => tx`update workspace_members set role = 'admin' where workspace_id = ${teamId} and user_id = ${bob.id}`),
    ).rejects.toMatchObject({ code: 'forbidden' });
    await expect(
      as(bob, (tx) => tx`update workspace_members set role = 'admin' where workspace_id = ${teamId} and user_id = ${bob.id}`),
    ).rejects.toMatchObject({ code: 'forbidden' });
    await expect(
      as(alice, (tx) => tx`update workspace_members set deleted_at = now() where workspace_id = ${teamId} and user_id = ${alice.id}`),
    ).rejects.toMatchObject({ code: 'validation' });
    await expect(
      as(alice, (tx) => tx`update workspaces set owner_id = ${bob.id} where id = ${teamId}`),
    ).rejects.toMatchObject({ code: 'forbidden' });
  });
});

describe('inbox tasks', () => {
  it('list-less tasks are private to creator and assignee, subtasks follow the root', async () => {
    const root = await createTask(alice, teamId, null, 'alice inbox');
    const sub = await createTask(alice, teamId, null, 'alice sub', root);
    expect((await visibleTasks(bob)).map((r) => r.id)).not.toContain(root);
    await as(alice, (tx) => tx`update tasks set assignee_id = ${bob.id} where id = ${root}`);
    const ids = (await visibleTasks(bob)).map((r) => r.id);
    expect(ids).toEqual(expect.arrayContaining([root, sub]));
  });
});

describe('task integrity', () => {
  it('derives root/list for subtasks, keeps counts, prevents cycles, cascades moves', async () => {
    const listA = await createList(alice, teamId, 'workspace', 'A');
    const listB = await createList(alice, teamId, 'workspace', 'B');
    const root = await createTask(alice, teamId, listA, 'root');
    const child = await createTask(alice, teamId, null, 'child', root);
    const grand = await createTask(alice, teamId, null, 'grand', child);
    const rows = await asService(sql, (tx) => tx`select id, list_id, root_task_id, child_count from tasks where id in (${root}, ${child}, ${grand})`);
    const byId = Object.fromEntries(rows.map((r) => [r.id, r]));
    expect(byId[child]).toMatchObject({ listId: listA, rootTaskId: root });
    expect(byId[grand]).toMatchObject({ listId: listA, rootTaskId: root });
    expect(byId[root]!.childCount).toBe(1);

    await as(alice, (tx) => tx`update tasks set completed_at = now() where id = ${child}`);
    const [r1] = await asService(sql, (tx) => tx`select child_completed_count from tasks where id = ${root}`);
    expect(r1!.childCompletedCount).toBe(1);

    await expect(as(alice, (tx) => tx`update tasks set parent_task_id = ${grand} where id = ${root}`)).rejects.toMatchObject({
      code: 'validation',
    });

    await as(alice, (tx) => tx`update tasks set list_id = ${listB} where id = ${root}`);
    const moved = await asService(sql, (tx) => tx`select list_id from tasks where id in (${child}, ${grand})`);
    expect(moved.every((r) => r.listId === listB)).toBe(true);
  });

  it('computes due_at from civil date, time and zone', async () => {
    const t = await createTask(alice, alice.personalWorkspaceId, null, 'timed');
    await as(alice, (tx) => tx`update tasks set due_date = '2026-03-08', due_time = '09:00', due_tz = 'America/New_York' where id = ${t}`);
    const [row] = await asService(sql, (tx) => tx`select due_at from tasks where id = ${t}`);
    expect(row!.dueAt).toBe('2026-03-08T13:00:00.000Z');
  });

  it('bumps change_xid on every write', async () => {
    const t = await createTask(alice, alice.personalWorkspaceId, null, 'xid');
    const [a] = await asService(sql, (tx) => tx`select change_xid::text as x from tasks where id = ${t}`);
    await as(alice, (tx) => tx`update tasks set title = 'xid2' where id = ${t}`);
    const [b] = await asService(sql, (tx) => tx`select change_xid::text as x from tasks where id = ${t}`);
    expect(BigInt(b!.x)).toBeGreaterThan(BigInt(a!.x));
  });
});

describe('invitations', () => {
  it('invitee accepts by token only with matching email', async () => {
    const frank = await createTestUser(sql, 'Frank');
    await as(alice, (tx) => tx`insert into workspace_invitations (workspace_id, email, role, token_hash, invited_by)
                                values (${teamId}, ${frank.email}, 'member', 'hash-frank', ${alice.id})`);
    // invitee sees the pending invite
    const pending = await as(frank, (tx) => tx`select id from workspace_invitations where status = 'pending'`);
    expect(pending.length).toBe(1);
    await expect(as(mallory, (tx) => tx`select * from app.accept_invitation('hash-frank')`)).rejects.toMatchObject({
      code: 'forbidden',
    });
    const [res] = await as(frank, (tx) => tx`select * from app.accept_invitation('hash-frank')`);
    expect(res).toMatchObject({ workspaceId: teamId, role: 'member' });
    await expect(as(frank, (tx) => tx`select * from app.accept_invitation('hash-frank')`)).rejects.toMatchObject({
      code: 'validation',
    });
  });

  it('guests cannot invite and members cannot invite admins', async () => {
    await expect(
      as(carol, (tx) => tx`insert into workspace_invitations (workspace_id, email, role, token_hash, invited_by)
                           values (${teamId}, 'x@example.com', 'member', 'h1', ${carol.id})`),
    ).rejects.toMatchObject({ code: 'forbidden' });
    await expect(
      as(bob, (tx) => tx`insert into workspace_invitations (workspace_id, email, role, token_hash, invited_by)
                         values (${teamId}, 'y@example.com', 'admin', 'h2', ${bob.id})`),
    ).rejects.toMatchObject({ code: 'forbidden' });
  });
});

describe('public links', () => {
  it('exposes exactly one list read-only by token, nothing else to anon', async () => {
    const list = await createList(alice, alice.personalWorkspaceId, 'private', 'Public plan');
    await createTask(alice, alice.personalWorkspaceId, list, 'public task');
    await as(alice, (tx) => tx`insert into list_public_links (list_id, workspace_id, token_hash, created_by)
                                values (${list}, ${alice.personalWorkspaceId}, 'pub-hash', ${alice.id})`);
    const [row] = await asAnon(sql, (tx) => tx`select app.public_list_by_token('pub-hash') as data`);
    const data = row!.data as { list: { title: string }; tasks: { title: string }[] };
    expect(data.list.title).toBe('Public plan');
    expect(data.tasks.map((t) => t.title)).toEqual(['public task']);
    const [none] = await asAnon(sql, (tx) => tx`select app.public_list_by_token('wrong') as data`);
    expect(none!.data).toBeNull();
    await expect(asAnon(sql, (tx) => tx`select * from tasks`)).rejects.toMatchObject({ code: 'forbidden' });
    await expect(asAnon(sql, (tx) => tx`select app.accessible_list_ids()`)).rejects.toMatchObject({ code: 'forbidden' });
    // revoked link stops working
    await as(alice, (tx) => tx`update list_public_links set revoked_at = now() where list_id = ${list}`);
    const [gone] = await asAnon(sql, (tx) => tx`select app.public_list_by_token('pub-hash') as data`);
    expect(gone!.data).toBeNull();
  });
});

describe('secret columns', () => {
  it('clients cannot read OAuth tokens or MCP token hashes', async () => {
    await asService(sql, (tx) => tx`insert into integration_connections (user_id, workspace_id, provider, account_id, account_label, access_token_enc)
                                    values (${alice.id}, ${alice.personalWorkspaceId}, 'gmail', 'acct', 'alice@gmail', 'ENC')`);
    const ok = await as(alice, (tx) => tx`select account_label from integration_connections`);
    expect(ok.length).toBe(1);
    await expect(as(alice, (tx) => tx`select access_token_enc from integration_connections`)).rejects.toMatchObject({
      code: 'forbidden',
    });
    await expect(as(alice, (tx) => tx`select token_hash from mcp_tokens`)).rejects.toMatchObject({ code: 'forbidden' });
  });
});

describe('meetings', () => {
  it('private meetings are invisible to other members; workspace meetings hidden from guests', async () => {
    const [m1] = await as(alice, (tx) => tx`insert into meeting_sessions (workspace_id, created_by, title) values (${teamId}, ${alice.id}, 'private') returning id`);
    const [m2] = await as(alice, (tx) => tx`insert into meeting_sessions (workspace_id, created_by, title, visibility) values (${teamId}, ${alice.id}, 'team', 'workspace') returning id`);
    const bobSees = (await as(bob, (tx) => tx`select id from meeting_sessions`)).map((r) => r.id);
    expect(bobSees).toContain(m2!.id);
    expect(bobSees).not.toContain(m1!.id);
    const carolSees = (await as(carol, (tx) => tx`select id from meeting_sessions`)).map((r) => r.id);
    expect(carolSees).not.toContain(m2!.id);
  });
});
