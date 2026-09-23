# Architecture

Orbit is a local-first task + document workspace. This document records the load-bearing
decisions. Deeper detail lives in `SYNC_ENGINE.md`, `DATABASE.md`, `SECURITY.md`, `AI.md`,
`MEETINGS.md`, `INTEGRATIONS.md`, `MCP.md`, `BILLING.md`, and `MOBILE.md`.

## System overview

```
            ┌──────────────── clients ────────────────┐
            │ Web/PWA (Next.js)  Desktop (Tauri 2)     │
            │ iOS / Android (Capacitor 8)              │
            │  ─ shared React UI (apps/web)            │
            │  ─ local store: IndexedDB | SQLite       │
            │  ─ outbox of idempotent mutations        │
            │  ─ Yjs docs persisted in IndexedDB       │
            └───────┬───────────────┬────────────┬─────┘
          HTTPS /api│        WSS    │ (Yjs+pokes) │ Supabase Auth
                    ▼               ▼             ▼
   ┌────────────────────┐ ┌───────────────────┐ ┌────────────┐
   │ API (Hono, mounted │ │ collaboration-    │ │  GoTrue    │
   │ in Next route      │ │ server (Hocuspocus│ └────────────┘
   │ handler)           │ │ + change pokes)   │
   └─────────┬──────────┘ └─────────┬─────────┘
             │  per-request txn: SET ROLE authenticated + JWT claims → RLS
             ▼                      ▼
        ┌───────────────────── PostgreSQL (Supabase) ────────────────────┐
        │ domain tables · RLS · FTS/trigram · pg-boss queue · change log │
        └───────────────────────────┬────────────────────────────────────┘
                                    │ jobs
                           ┌────────▼────────┐        ┌──────────────┐
                           │ worker (pg-boss)│        │ mcp-server   │
                           │ reminders, AI,  │        │ (Streamable  │
                           │ meetings, integ.│        │ HTTP, tokens)│
                           └─────────────────┘        └──────────────┘
```

## Monorepo

| Path | Purpose |
| --- | --- |
| `apps/web` | Next.js 16 app: marketing/auth pages, the whole app UI, API route mount, PWA service worker |
| `apps/desktop` | Tauri 2 shell: global Quick Capture shortcut + floating window, tray, single instance |
| `apps/mobile` | Capacitor 8 shell: iOS/Android projects, widgets, share extension, push |
| `apps/collaboration-server` | Hocuspocus Yjs server with Postgres persistence, auth, change "pokes" |
| `apps/worker` | pg-boss worker: reminders, recurrence, AI jobs, meeting pipeline, integrations, email |
| `apps/mcp-server` | Model Context Protocol server authenticated by scoped personal tokens |
| `packages/shared` | Product config, Zod entity schemas, error types, feature flags, env validation |
| `packages/core` | Pure domain logic: ordering keys, recurrence, natural-language parsing, permissions, plans |
| `packages/database` | Postgres client, RLS-scoped transactions, repositories, migration runner, test harness |
| `packages/api` | Hono application: all HTTP endpoints (sync, search, sharing, billing, integrations, AI, …) |
| `packages/sync` | Mutator definitions (shared client/server), local store adapters, outbox, sync client |
| `packages/editor` | Tiptap schema + extensions (task/list refs, slash menu, markdown), Markdown/JSON conversion |
| `packages/ui` | Design tokens and accessible primitives (Radix based) |
| `packages/ai` | Provider-agnostic AI interfaces, Anthropic/OpenAI adapters, validated structured output |
| `packages/integrations` | Gmail, Google Calendar, Slack, GitHub, Linear, Microsoft To Do, inbound email adapters |
| `packages/billing` | Plans, entitlements, Stripe + RevenueCat reconciliation |
| `packages/notifications` | Web Push, APNs, FCM, email channel adapters |
| `packages/analytics` | Privacy-conscious analytics abstraction |
| `packages/auth` | Supabase auth helpers, JWT verification, token hashing |
| `packages/testing` | Shared fixtures and factories |
| `packages/config` | Shared tsconfig / eslint / prettier configuration |

Domain logic never lives in React components. Components call hooks that read the local
store and dispatch mutators.

## Key decisions

### 1. Local-first, entity store + outbox (not "fetch on render")
Every structured entity the user can see (workspaces, members, lists, sections, tasks,
labels, assignments, comments, notifications …) is replicated into a local store. UI reads
come from memory (hydrated from IndexedDB/SQLite at start), so the app is instant and works
offline. Writes are **mutators**: named, Zod-validated, idempotent operations with a client
generated UUID. The same mutator code runs optimistically on the client and authoritatively on
the server (inside an RLS transaction). See `SYNC_ENGINE.md`.

### 2. Tasks are entities; documents reference them
Lists and task details are Yjs documents edited with Tiptap. Task rows in a document are
`taskRef` atom nodes that point at a task entity; the row renders the live entity (title,
checkbox, due date, assignee) from the store. This keeps tasks first-class (Today, Inbox, search,
MCP, integrations work without parsing documents) while notes and tasks interleave freely.
Rules:
* The document decides the visual order of tasks inside a list. The collaboration server
  derives `tasks.position` from the document on store, so non-editor views agree.
* Tasks of a list that are not referenced in the document ("orphans", e.g. created through MCP,
  Inbox or an integration) are appended by a deterministic reconciliation plugin; duplicate refs
  keep the first occurrence. Both rules converge across concurrent clients.
* A task's own details document contains refs to its subtasks, so nesting is unlimited.
* Sublists are `listRef` nodes following the same rules.

### 3. Next.js with a client-rendered app surface
The authenticated app is client-rendered (data comes from the local store, not RSC), uses
query-string entity routes (`/list?id=…`) and only `.tsx` page files. API route handlers are
`.ts`. The native build sets `pageExtensions` to `tsx` and `output: 'export'`, producing a static
bundle for Tauri and Capacitor that talks to the hosted API. Pretty share links (`/l/:id`,
`/t/:id`, `/m/:id`, `/invite/:token`) redirect into the app on web and are claimed as
universal/app links on native.

### 4. API = one Hono app, mounted in Next
`packages/api` is framework-agnostic (`fetch` Request → Response). The web app mounts it under
`/api/*`; it can also run standalone. Every request that acts for a user opens a transaction
that executes `SET LOCAL ROLE authenticated` and sets `request.jwt.claims`, so Postgres RLS is
the final authority. Service-role access is limited to webhooks, the worker and explicitly
audited server flows (e.g. accepting an invitation token), each doing its own checks.

### 5. Postgres is canonical; queue in Postgres
Supabase provides Postgres, Auth, Storage. pg-boss provides retryable, idempotent jobs with
singleton keys. Webhooks are persisted to `integration_webhook_events` /
`subscription_events` with unique provider event IDs before processing.

### 6. Realtime = Yjs for documents + pokes for entities
The collaboration server hosts Yjs documents (`list:<id>`, `task:<id>`) and also relays
"poke" messages: a trigger on `change_log` issues `pg_notify`, the server fans out to clients
subscribed to the affected workspace, and clients pull. Pulls are cheap (cursor based), so a
poke never carries data and cannot leak it.

### 7. AI behind interfaces
`packages/ai` exposes `TextGenerator`, `StructuredExtractor`, `Summarizer`, `Transcriber`.
Adapters are chosen by env vars. Every structured output is Zod-validated with repair retries;
AI output never supplies database IDs or authorization decisions — it proposes, the user
confirms, mutators apply.

### 8. Entitlements are server-side
Plan limits (`packages/core/src/plans.ts`) are enforced in mutators and API handlers using the
server-reconciled `entitlements` table. Frontend only mirrors them for UX.

### 9. Keyboard shortcuts: one registry
`apps/web/src/lib/shortcuts.ts` is the only place a shortcut is defined (id, label, category,
scope, keys, platform overrides, feature gate). Hotkey bindings (`bindingsFor(scope, handlers)`
in AppShell and TaskKeyboard), menus, tooltips, the command palette, Settings → Shortcuts and the
shortcuts overlay all read it. Key notation, OS detection, platform labels (⌘ vs Ctrl) and
global-accelerator validation live in `packages/shared/src/keyboard.ts` (pure, tested).
App-level actions (new task/list, quick capture, shortcuts overlay, palette, sidebar) are exposed
once through `useAppCommands()` so no caller re-implements them.

### 10. Desktop Quick Capture = a satellite window on the shared outbox
The Tauri shell (`apps/desktop/src-tauri`) registers a configurable global shortcut
(default ⇧⌥Space on macOS, Ctrl+Alt+Space on Windows/Linux; `quick-capture.json` in the app
config dir) and owns exactly one hidden-until-needed `quick-capture` window that loads `/capture`.
That page runs `SyncProvider mode="satellite"`: it hydrates from the same IndexedDB as the main
window, parses with the same `Actions.preview/createTask`, and appends mutations to the shared
outbox — but never pushes or pulls, so only one window writes the row cache. After saving it
flushes and announces (`BroadcastChannel` + a Tauri `orbit://outbox-changed` event); the main
window's `SyncClient.adoptPending()` re-reads the durable outbox and applies what it doesn't
have, so the task appears immediately (offline too) and is pushed by the primary. Mutation ids
make pushes idempotent, so even a double push applies once. Closing windows hides them; the app
keeps running (tray) so the shortcut keeps working; a second launch focuses the first
(single-instance). Registration refusals from the OS are reported in Settings, never silent.

## Identifiers, time and ordering
* UUID v7 for all ids (sortable, generated client-side for offline creates).
* All timestamps `timestamptz`; due dates are split into `due_date` (date) + optional
  `due_time` (time) + `timezone` so an all-day task never shifts across zones.
* Ordering uses fractional index keys (`packages/core/src/ordering.ts`); ties break on id.

## Error model
`packages/shared/src/errors.ts` defines typed `AppError` codes (`unauthorized`, `forbidden`,
`not_found`, `deleted`, `conflict`, `quota_exceeded`, `validation`, `rate_limited`,
`provider_disconnected`, `network`, `timeout`, `internal`). The API maps them to HTTP; the UI
maps them to human messages.
