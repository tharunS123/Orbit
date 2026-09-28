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
- **Phase 6 Productivity** — search, command palette, multiselect/bulk actions, templates (earlier)
  plus, in this milestone:
  - *Shortcut registry* (`apps/web/src/lib/shortcuts.ts`): every shortcut defined once (id,
    label, category, scope, keys, platform overrides, feature gate) and used for execution
    (`bindingsFor`), menus, tooltips, palette, Settings → Shortcuts and the overlay. OS-aware
    labels/validation in `packages/shared/src/keyboard.ts` (⌘⌥⇧ on macOS, Ctrl/Alt/Shift on
    Windows/Linux, detected at runtime). Talk/Meetings shortcuts stay hidden and unbound until
    those features exist.
  - *Keyboard shortcuts overlay*: from the profile menu, the palette, `?` or ⌘/ / Ctrl+/;
    grouped (Navigation, Creation, Editing, Selection, Application, Documents), filterable,
    focus-trapped, Escape/click-outside close, focus returns to the initiating control,
    screen-reader labels for keycaps, responsive to phone width.
  - *App commands* (`useAppCommands`): New task, New list, Quick capture, Keyboard shortcuts,
    palette, sidebar — shared by hotkeys, palette and menus.
  - *Desktop Quick Capture*: new `apps/desktop` Tauri 2 shell — configurable global shortcut
    (default ⇧⌥Space macOS / Ctrl+Alt+Space Windows), exactly one pre-created floating window
    (`/capture`) shown/focused on demand, hide on Escape/save/blur (optional), draft kept 5 min,
    tray (Open / Quick Capture / Quit), single instance, close-to-tray so the shortcut keeps
    working, preferences persisted in `quick-capture.json` and restored on launch, registration
    errors surfaced ("already being used by another application"). The window is a *satellite*
    on the shared outbox (see ARCHITECTURE §10): same parser, same mutators, works offline, the
    main window adopts and syncs; logged-out and never-synced states handled.
  - *Settings → Desktop app*: enable/disable, record a new shortcut (validated against reserved
    OS combos, universal editing shortcuts and Orbit's own shortcuts; the OS check runs too),
    reset to default, hide-on-blur. Browser shows an explanation instead.
  - *Capture UX shared by both surfaces*: parsed metadata chips (e.g. "Tomorrow, Sep 24 · 7pm",
    "#work", "Inbox") and keyboard-reachable destination/due/label/assignee controls;
    at-most-once save per draft (fixed task id + guard).
  - *Polish*: `mod+\` (toggle sidebar) never matched — fixed; the key that opens New task / the
    overlay / the palette no longer types itself into the new field; `?capture=1` deep link and
    PWA shortcut now open New task; Talk/mic controls hidden until Talk exists; add-row
    placeholder ellipsis on phones; Next dev badge moved off the account menu; CSP allows Tauri
    IPC.
  - *Build fix*: `pnpm build` was failing for worker and collaboration server (tsup has no
    `--noExternal` CLI flag); options moved to `tsup.config.ts` with a `createRequire` banner for
    bundled CJS deps. Both built services start (worker `/health` ok, collab listening).

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

### Phase 6 verification (2026-09-23, macOS 27 arm64)
- `pnpm lint` 13/13, `pnpm typecheck` 14/14 (incl. `cargo check` of the desktop crate),
  `pnpm test` 12/12 (201 TS tests + 20 Rust tests), `pnpm build` 3/3; `build:native` static
  export OK (includes `/capture`).
- Unit: keyboard formatting per OS, accelerator parsing/validation/conflicts, registry
  invariants (unique ids, no duplicate combo per scope/OS, bindings), capture parsing through the
  real `Actions` ("Submit CS project tomorrow at 7pm #school", "Call Sarah next Friday #work",
  recurrence, overrides), duplicate-save guard. Sync: satellite window + primary adoption —
  offline capture visible in the main store immediately, synced once on reconnect, concurrent
  double push applied once.
- Rust (`apps/desktop/src-tauri`, Tauri MockRuntime + fake registrar): one capture window even
  under 8 concurrent opens, show focuses the existing window, hide keeps it; registration on
  start exactly once, no double registration (incl. differently spelled combos), conflicting
  shortcut refused with the old one kept, pause while recording, disable/enable, reset,
  persistence across relaunch, OS error classification, safe navigation paths.
- Playwright (`pnpm test:e2e`, 13 tests, real signup): overlay from profile menu with focus
  trap + Escape + focus return, `?` and Ctrl+/ / ⌘/ open the same dialog, Windows (Ctrl) and
  macOS (⌘) labels, filtering, click-outside, phone width without overflow; palette New task /
  New list / Quick capture / Keyboard shortcuts; in-app capture chips + exactly one task on
  repeated Enter; `/capture` window page with the Inbox open in another tab: online and offline
  capture shown immediately in the main window and exactly once after reconnect + reload;
  never-synced device and signed-out states.
- Native macOS (dev build, `tauri dev`): global shortcut registered at launch; ⇧⌥Space pressed
  while another app (Arc) was frontmost opened the capture window on top and focused it;
  repeated presses focus the same window (never a second one); Escape hides it (JS → Rust IPC);
  window resizes to its content (IPC); switching apps hides it (hide-on-blur, 3/3).
- Release bundle: `tauri build --bundles app` → `Orbit.app` (5 MB, unsigned); launched it:
  shortcut registered, capture window served from the static export, Escape hides it.
- Visual pass (light/dark, desktop/phone): sidebar, Inbox, Today, list, task detail, profile
  menu, New task dialog, shortcuts overlay, Quick Capture window.

## In Progress
- Phase 6 — code and automated verification complete; one manual check outstanding: the
  *signed-in* desktop flow (sign in inside the desktop app, press ⇧⌥Space from another app,
  capture "Submit CS project tomorrow at 7pm #school" / offline "Buy groceries tomorrow", confirm
  Inbox/Today). Each part is verified separately above, but the agent could not sign in inside
  the native window (no password entry by the agent; screen control declined), so the combined
  path has not been observed. (Dev builds only: while Quick Capture is visible, macOS
  accessibility lists an extra 280×168 panel owned by the process; it does not exist in the
  release bundle — likely the Next.js dev tooling.)

## Blocked Only By External Credentials
- Push delivery to real devices: needs `VAPID_*` (web, generated locally), `APNS_*`, `FCM_*`.
- Production email: `RESEND_API_KEY` or `SMTP_URL` (local uses the Supabase mail catcher).

## Remaining
- Phase 7 Talk / Make AI (`packages/ai`), Phase 8 Meetings, Phase 9 integrations (incl.
  `/api/calendar/events`), Phase 10 MCP server + token UI, Phase 11 billing (Stripe,
  RevenueCat), Phase 12 native shells (Capacitor, widgets, share extensions; desktop: deep
  links, notifications, auto-update, signing), Phase 13 hardening; Maestro E2E, CI workflows,
  remaining docs.

## Known Issues
- Local machine lacks full Xcode and the Android SDK (iOS/Android builds can't be compiled here).
  Rust is installed (rustup, stable 1.98): the desktop shell builds and runs on macOS.
- Desktop, Windows: code path shared (Ctrl+Alt+Space default, RegisterHotKey conflicts reported
  as "used by another application") but not built or run — no Windows machine/toolchain here.
- Desktop packaging: bundles are unsigned/un-notarized (needs an Apple Developer ID and a Windows
  code-signing certificate). A production desktop build must set `NEXT_PUBLIC_API_URL` to the
  hosted API; dev uses `http://localhost:3000`.
- Desktop tests run with `pnpm test` when cargo is present; without Rust they print SKIPPED
  (set `ORBIT_REQUIRE_RUST=1` in desktop CI to make that an error).
- Several browser tabs of the web app still keep separate in-memory stores; they converge via
  sync (tab-to-tab outbox adoption is only enabled for the desktop capture window).
- Meetings nav entry has no page yet (Phase 8).
- Account deletion does not yet cancel paid subscriptions (added with billing, Phase 11).
