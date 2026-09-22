# Build Status

Factual state of the build. "Verified" means exercised by automated tests and/or manually in a
browser against the local Supabase stack — not just compiled.

## Complete
- **Phase 0** — repository audit, `ARCHITECTURE.md`, `PRODUCT_SPEC.md`, `IMPLEMENTATION_PLAN.md`.
- **Phase 1 foundation** — pnpm/Turborepo monorepo, strict TypeScript, ESLint/Prettier, env
  validation (`@orbit/shared/env`), `scripts/setup.mjs` for local `.env`, Supabase migrations
  (schema, RLS, integrity triggers, RPCs), feature flags, product name centralised in
  `@orbit/shared/product`.
- **Data & sync** — local-first entity store with pending overlay and deterministic rebase,
  idempotent intent mutators shared by client and server, xid8 change cursors, scope
  backfill/purge, reconcile. Tests: `packages/sync` (sync + views), `packages/database` (RLS).
- **API** (`packages/api`, Hono mounted in Next.js) — sync push/pull, invitations, search,
  content (attachments, exports/imports, account), devices/push registration. Tests: `api.test.ts`.
- **Editor & collaboration** — Tiptap + Yjs documents with task/list reference nodes, Markdown
  import/export, collaboration server (Hocuspocus) with auth, access re-checks, position
  derivation, previews, snapshots and sync pokes.
- **Web app** — auth (signup/login/reset), onboarding with templates, Inbox/Today/Upcoming/lists/
  task detail, natural-language quick add, recurrence, labels, reminders UI, comments, activity,
  attachments, search, command palette, multiselect/bulk actions, settings, trash, sharing.
  Browser-verified end to end (see Verification).
- **Background worker** (`apps/worker`, pg-boss) — reminders (exactly-once via
  `reminder_deliveries`, catch-up after downtime ≤ 6h, email fallback when no push device),
  notification push fan-out + delayed unread email / digest honouring per-category preferences,
  trash purge (30 days, including files), attachment purge/copy, account deletion (anonymise,
  delete solo workspaces/files/tokens/auth user), meeting-audio retention, bookkeeping pruning,
  missed-job sweeps, `/health` endpoint. Tests: `apps/worker/src/worker.test.ts` (9).
- **Dev seed** — `pnpm db:seed` (`packages/testing`): demo accounts via the Auth admin API and
  content through the real server mutators; idempotent and resumable; refuses non-local DBs.

## Verification
- `pnpm exec turbo run typecheck lint test`: 37/37 tasks green across 14 packages (core, shared,
  auth, sync, database RLS, api, editor, notifications, collaboration server, worker).
- Collaboration server (live Hocuspocus + WebSocket clients): auth rejection, writer→viewer sync,
  persistence, server-side dropping of read-only edits, access revocation closing connections.
- Browser: signup → onboarding → templates → quick add ("Send invoice tomorrow at 9am #finance")
  → list editing ([] tasks, Enter, Tab nesting) → task detail/comments; document persistence and
  derived positions checked in the DB.
- Worker against local Supabase: queues created with the intended policies, cron schedules
  registered; a live reminder fired on schedule → exactly one delivery row → in-app
  notification → push job → fallback email received in the local mail catcher.
- Seed: seeded Yjs documents decode with the editor schema and every task node resolves.

## In Progress
- Phase 6 polish: shortcuts help overlay, desktop quick-capture window route.

## Blocked Only By External Credentials
- Push delivery to real devices: needs `VAPID_*` (web, generated locally), `APNS_*`, `FCM_*`.
- Production email: `RESEND_API_KEY` or `SMTP_URL` (local uses the Supabase mail catcher).

## Remaining
- Phase 7 Talk / Make AI (`packages/ai`), Phase 8 Meetings, Phase 9 integrations (incl.
  `/api/calendar/events`), Phase 10 MCP server + token UI, Phase 11 billing (Stripe,
  RevenueCat), Phase 12 native shells (Tauri, Capacitor, widgets, share extensions), Phase 13
  hardening; Playwright/Maestro E2E, CI workflows, remaining docs.

## Known Issues
- Local machine lacks full Xcode, Android SDK and Rust: native builds cannot be compiled here.
- Meetings nav entry has no page yet (Phase 8).
- Account deletion does not yet cancel paid subscriptions (added with billing, Phase 11).
