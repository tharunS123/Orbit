# Implementation Plan

## Phase 0 — Audit (done)
Repository was empty. Environment: macOS, Node 24, pnpm 12 (corepack), Docker Desktop,
Xcode Command Line Tools only (no full Xcode → iOS builds cannot be verified locally),
no Rust toolchain (Tauri compile not verified unless installed), no Android SDK.
Tests use PGlite (in-process Postgres 17) so database/RLS tests run without Docker; local
development uses the Supabase CLI stack.

## Phase order and acceptance
| Phase | Scope | Acceptance |
| --- | --- | --- |
| 1 Foundation | monorepo, tokens/UI, schema+RLS, auth, workspaces, shell, settings skeleton, local store, errors | sign up → reach an authenticated workspace |
| 2 Lists+Tasks | Inbox/Today/Upcoming, lists, sections, tasks, subtasks, labels, assignment, dates, reminders, recurrence, drag, duplicate | usable as a serious task manager |
| 3 Documents | Tiptap editor, list & task docs, slash menu, markdown, images/attachments | notes and tasks mix freely |
| 4 Offline | IndexedDB/SQLite store, outbox, rebase, cached startup | offline edits survive restart & reconnect |
| 5 Collaboration | Yjs server, pokes, invites, sharing, presence, comments, notifications, activity | two users edit safely at once |
| 6 Productivity | search, command palette, multiselect, shortcuts, quick capture, templates, heatmap | |
| 7 Talk | record → transcribe → structured preview → confirm | |
| 8 Meetings | recording, live transcript, summary, action items, chat w/ citations, sharing | |
| 9 Integrations | Gmail, Calendar, Slack, GitHub, Linear, MS To Do, inbound email | code complete; creds external |
| 10 MCP | token UI + server | |
| 11 Billing | Stripe, RevenueCat, entitlements, limits, upgrade UI | |
| 12 Native | Tauri, Capacitor iOS/Android, widgets, share, push, deep links | |
| 13 Hardening | perf, security, a11y, offline & failure testing | |

## Working rules
* Tests accompany each domain module (Vitest) and critical flows (Playwright).
* `docs/BUILD_STATUS.md` is updated at every checkpoint with factual status.
* Commits are grouped by phase on the `dev` branch.
