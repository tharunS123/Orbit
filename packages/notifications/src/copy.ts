import { routes, type NotificationType } from '@orbit/shared';

/**
 * Human copy for notifications, shared by the in-app Updates view, push and email. Uses only
 * titles the recipient is already allowed to see.
 */
export interface NotificationCopyInput {
  type: NotificationType;
  actorName: string | null;
  data: Record<string, unknown>;
  taskId: string | null;
  listId: string | null;
  meetingId: string | null;
}

export function notificationCopy(n: NotificationCopyInput): { headline: string; detail: string | null; path: string } {
  const actor = n.actorName ?? 'Someone';
  const title = typeof n.data.title === 'string' && n.data.title ? `“${n.data.title}”` : 'a task';
  const path = n.taskId ? routes.task(n.taskId) : n.listId ? routes.list(n.listId) : n.meetingId ? routes.meeting(n.meetingId) : routes.updates();
  switch (n.type) {
    case 'task_assigned':
      return { headline: `${actor} assigned you ${title}`, detail: null, path };
    case 'mention':
      return { headline: `${actor} mentioned you on ${title}`, detail: null, path };
    case 'comment':
      return { headline: `${actor} commented on ${title}`, detail: null, path };
    case 'invitation':
      return n.data.event === 'accepted'
        ? { headline: `${actor} accepted your invitation`, detail: null, path }
        : { headline: `${actor} invited you to collaborate`, detail: null, path: routes.updates() };
    case 'task_updated':
      return { headline: `${actor} ${n.data.event === 'completed' ? 'completed' : 'updated'} ${title}`, detail: null, path };
    case 'task_due':
      return { headline: `${title.replace(/^“|”$/g, '')} is due`, detail: typeof n.data.due === 'string' ? n.data.due : null, path };
    case 'list_shared':
      return { headline: `${actor} shared ${typeof n.data.title === 'string' ? `“${n.data.title}”` : 'a list'} with you`, detail: null, path };
    case 'list_changed':
      return { headline: `${actor} made changes to ${typeof n.data.title === 'string' ? `“${n.data.title}”` : 'a list'}`, detail: null, path };
    case 'meeting_ready':
      return { headline: `Meeting notes are ready${typeof n.data.title === 'string' ? `: ${n.data.title}` : ''}`, detail: null, path };
    case 'integration_error':
      return { headline: `${typeof n.data.provider === 'string' ? n.data.provider : 'An integration'} needs attention`, detail: typeof n.data.message === 'string' ? n.data.message : null, path: routes.settings('integrations') };
  }
}
