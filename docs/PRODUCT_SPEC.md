# Product Spec — Orbit

> Product name is configured in `packages/shared/src/product.ts` (`PRODUCT.name`). Nothing else
> hard-codes it.

**Premise:** tasks and context live together. A user starts with a checkbox list and grows it
into a collaborative project — notes, subtasks, files, discussion, meetings — without switching
tools. The app must feel instant, calm and keyboard/touch friendly, and keep working offline.

## Core objects

| Object | Description |
| --- | --- |
| Workspace | Personal (one per user, auto-created) or team. Roles: owner, admin, member, guest. |
| List | A collaborative document (title, emoji, cover, rich content) whose task rows are real tasks. Can nest (sublists). Visibility: private, specific people, workspace, public read-only link. |
| Task | First-class entity: title, completion, rich details document, parent/children (unlimited depth), list or Inbox, due date/time, reminders, recurrence, labels, assignee, attachments, messages, activity, source metadata. |
| Section | A user's sidebar group of pinned lists. Deleting a section never deletes lists. |
| Label | Workspace-scoped name + color token. |
| Meeting | Recording session → transcript segments → summary, decisions, action items, chat. |
| Update | In-app notification (assignment, mention, comment, invite, due, meeting ready). |

## Views
* **Inbox** — capture destination; triage (complete / schedule / assign / label / move / remove),
  bulk process, filter, sort. Supports Inbox Zero.
* **Today** — Overdue, Today (with manual order), Later today (has time later than now),
  Completed today; optional calendar events.
* **Upcoming** — agenda by date with day/week/month ranges, overdue, "no date" filter,
  drag between dates, calendar events visually distinct (outlined, not checkable).
* **List** — the document editor.
* **Meetings**, **Updates**, **Search**, **Settings**, **Profile** (heatmap).

## Behaviour decisions
* **Recurring tasks**: one live task carries the rule. Completing it records a completion in
  `task_occurrences`, then advances the same task's due date to the next occurrence after
  the *scheduled* date (not the completion date) and resets completion + checklist of
  subtasks. "Skip" advances without recording completion. Rules end by date or count; when
  exhausted the task simply completes. This yields no duplicate instances by construction.
  (A per-rule option `anchor: 'completion'` supports "3 days after I finish".)
* **Reminders** are stored as offsets relative to the due instant (or absolute instants) and are
  materialised into `reminder_deliveries` by the worker. Rescheduling re-materialises.
* **All-day tasks** have a date but no time; they are never shifted by timezone changes.
  Timed tasks keep the IANA timezone they were created in and are shown in the viewer's zone.
* **Duplicate list** resets completion, optionally clears due dates/assignees, optionally
  copies attachments.
* **Delete** is soft for 30 days (Trash in Settings → Data), then purged by the worker.
* **AI never writes without preview** when more than one item is produced.
* **Guests** can only see lists explicitly shared with them; they cannot create lists, invite
  others, or see workspace members beyond collaborators of shared lists.

## Plans (configurable in `packages/core/src/plans.ts`)
| | Free | Plus | Ultra |
| --- | --- | --- | --- |
| Lists (active, own) | 20 | Unlimited | Unlimited |
| Collaborators per list | 5 | 50 | 50 |
| Nested lists | 1 level | Unlimited | Unlimited |
| File size / storage | 10 MB / 1 GB | 100 MB / 25 GB | 100 MB / 25 GB |
| Integrations | Calendar, email forwarding | All | All |
| Talk (voice AI) | 10 / month | Fair use | Fair use |
| Meeting notes | 3 / month | 10 / month | Fair use |
| Meeting chat, Make AI, message summarisation | — | Limited | Fair use |

## Non-goals (v1)
Gantt charts, time tracking, custom fields, enterprise SSO/SCIM, a public API beyond MCP.

## Quality bar
Every core action has loading, empty, error, offline, touch and keyboard behaviour. Priority
order: data correctness → security → sync reliability → task/list UX → performance →
collaboration → AI reliability → integrations → polish.
