import type { List, ListMember, WorkspaceRole } from '@orbit/shared';

/**
 * Role/permission rules shared by client (to shape the UI) and server (authoritative checks in
 * mutators; Postgres RLS is the final backstop). Keep this the single place these rules live.
 */

export type WorkspaceAction =
  | 'workspace.rename'
  | 'workspace.delete'
  | 'workspace.transfer'
  | 'members.invite'
  | 'members.remove'
  | 'members.changeRole'
  | 'lists.create'
  | 'labels.manage'
  | 'billing.manage';

const RANK: Record<WorkspaceRole, number> = { guest: 0, member: 1, admin: 2, owner: 3 };

export function roleAtLeast(role: WorkspaceRole | null | undefined, min: WorkspaceRole): boolean {
  return role != null && RANK[role] >= RANK[min];
}

export function canWorkspace(role: WorkspaceRole | null | undefined, action: WorkspaceAction): boolean {
  if (!role) return false;
  switch (action) {
    case 'workspace.delete':
    case 'workspace.transfer':
    case 'billing.manage':
      return role === 'owner';
    case 'workspace.rename':
    case 'members.remove':
    case 'members.changeRole':
      return roleAtLeast(role, 'admin');
    case 'members.invite':
    case 'lists.create':
    case 'labels.manage':
      return roleAtLeast(role, 'member');
  }
}

/** Can `actor` assign `target` to `newRole`? Owners are changed only via transfer. */
export function canChangeRole(
  actor: WorkspaceRole | null,
  target: WorkspaceRole,
  newRole: WorkspaceRole,
): boolean {
  if (!roleAtLeast(actor, 'admin')) return false;
  if (target === 'owner' || newRole === 'owner') return false;
  if (actor === 'admin' && (target === 'admin' || newRole === 'admin')) return false;
  return true;
}

export function canRemoveMember(actor: WorkspaceRole | null, target: WorkspaceRole, self: boolean): boolean {
  if (target === 'owner') return false; // transfer first
  if (self) return true; // leaving
  if (actor === 'owner') return true;
  return actor === 'admin' && RANK[target] < RANK.admin;
}

export interface ListAccessContext {
  userId: string;
  role: WorkspaceRole | null;
  list: Pick<List, 'createdBy' | 'visibility' | 'workspaceId'>;
  membership: Pick<ListMember, 'role'> | null;
  /** Access inherited from an ancestor list. */
  inherited?: 'editor' | 'viewer' | null;
}

export type ListAccess = 'owner' | 'editor' | 'viewer' | null;

export function listAccess(ctx: ListAccessContext): ListAccess {
  if (!ctx.role) return null;
  if (ctx.list.createdBy === ctx.userId) return 'owner';
  if (ctx.membership) return ctx.membership.role;
  if (ctx.list.visibility === 'workspace' && ctx.role !== 'guest') return 'editor';
  return ctx.inherited ?? null;
}

export type ListAction = 'view' | 'edit' | 'share' | 'delete' | 'archive' | 'rename';

export function canList(access: ListAccess, role: WorkspaceRole | null, action: ListAction): boolean {
  if (!access) return false;
  switch (action) {
    case 'view':
      return true;
    case 'edit':
    case 'rename':
      return access !== 'viewer';
    case 'share':
      return access === 'owner' || (access === 'editor' && roleAtLeast(role, 'member'));
    case 'archive':
    case 'delete':
      return access === 'owner' || roleAtLeast(role, 'admin');
  }
}
