# AGENTS.md

See `CLAUDE.md` for the full architecture, invariants, and per-surface rules — it is the
authoritative product/codebase guide. This file only adds environment/run notes for agents.

## Cursor Cloud specific instructions

On-prem VMS: a Vite + React 18 + TypeScript SPA (`npm run dev`, port 5173) backed by a
**self-hosted Supabase stack** run locally via the Supabase CLI (Docker). All data stays on
the box — nothing leaves the premises. Standard commands live in `package.json` `scripts`
(`dev`, `lint` = `tsc --noEmit`, `build`, `test`, `check`, `seed`); the Supabase CLI is a dev
dependency, invoked as `npx supabase`.

### Bring the stack up (local / on-prem runbook)
1. Docker must be running. This VM needs Docker installed (system dep, NOT in the update
   script) with the `fuse-overlayfs` storage driver and `containerd-snapshotter: false`
   (Docker 29); start it with `sudo dockerd` and `sudo chmod 666 /var/run/docker.sock`.
2. `npx supabase start` — boots Postgres, Auth (GoTrue), PostgREST, Realtime, Storage, Studio
   (`:54323`) and Mailpit (`:54324`). Migrations auto-apply on first boot.
3. `.env` (git-ignored) must hold the values from `npx supabase status`:
   `VITE_SUPABASE_URL=http://127.0.0.1:54321`, `VITE_SUPABASE_ANON_KEY=<anon JWT>`,
   `SUPABASE_SERVICE_ROLE_KEY=<service_role JWT>`. Restart `npm run dev` after editing `.env`.
4. `npx supabase db reset` re-applies every migration on a clean DB — this is the local
   workflow (the old repo comment about "hand-applied, never db push" no longer holds; see
   migrations note below). It wipes data, so re-run the seed after.
5. `npm run seed` — demo departments, users (password `demo123`) and sample visits.
6. `npm run dev` — app at http://localhost:5173. If a client on IPv4 cannot
   connect (Vite sometimes binds `::1` only), restart with
   `npm run dev -- --host 0.0.0.0 --port 5173`.

Demo logins (all `demo123`): `admin@demo.vms`, `guard@demo.vms`, `staff.it@demo.vms`
(employee), `hod.it@demo.vms`, plus dummy trio `dummy.admin@demo.vms` /
`dummy.emp@demo.vms` / `dummy.guard@demo.vms`. Hosted Supabase/Vercel/Resend
secrets are not required — `.env` uses the local `supabase start` demo JWTs.

### Migrations are now replayable on a clean DB
- `000_api_role_grants.sql` grants the PostgREST roles table access + default privileges —
  on hosted Supabase the platform does this; a self-hosted DB must, or every query is
  "permission denied for table". Keep it first.
- Several drift-reconciliation files re-`create policy` an object an earlier file made;
  `scripts/idempotent-policies.py` inserted a `drop policy if exists` before each so
  `db reset` / `supabase start` apply cleanly. Do not remove those drops.

### OTP visitor flow (the on-prem model)
- Every visit gets a 6-digit `otp_code` at insert (trigger, migration 094). Pre-registration
  (`pre_approve_visitor_v2`, now returns `otp_code` + takes `p_email`) dispatches it to the
  visitor; approving a walk-in dispatches it to the security desk + notifies guards
  (migration 094 trigger). Dispatch is logged in `public.otp_deliveries`.
- The guard finds a visitor at the gate by typing the OTP — `lib/searchVisits.searchAllVisits`
  matches `otp_code` exactly for a 4–8 digit query.
- Check-out can be done by typing the returned **badge number** on Entry & Exit
  (`GuardLiveQueue` matches an on-site `visitor_card_number`, then the normal exit write); the
  number is free to reissue afterwards.
- Email really sends: the dev/admin proxy `/api/send-email` (nodemailer) relays to Mailpit;
  view captured mail at http://127.0.0.1:54324. SMS is recorded in `otp_deliveries` (wire a
  local GSM gateway for a real send). `SMTP_HOST`/`SMTP_PORT`/`MAIL_FROM` env override the relay.

### Admin user management runs through the dev proxy (service role)
- Adding/removing employees & guards uses `/api/users` (+ `/api/departments`, `/api/send-email`)
  served by `vite.config.ts`'s proxy using `SUPABASE_SERVICE_ROLE_KEY` server-side, so the key
  never reaches the browser. **These endpoints exist only under `npm run dev`**; a production
  build must provide the same endpoints from a small admin server. Client wrappers:
  `lib/adminUsers.ts`; UI: `pages/Admin/UserManager.tsx` (Settings → Roles & Users).

### Testing
- `npm run check` (tsc + unit + `routeProtection` + `csp`) is the offline gate. With `.env`
  pointed at the local stack the whole `npm test` (incl. `tests/security/*` live integration
  tests) can run against the seeded local DB.
- The guard **check-in photo step needs a webcam**; in a headless VM it errors with "camera
  device not found". Validate check-in/check-out/badge-return via the API/DB if you can't use
  a real camera — the flow is otherwise unchanged.
- `tests/unit/pages/AdminLiveCheckIn.test.tsx` is time-of-day flaky whenever a
  fixture stamped `hoursAgo(N)` falls before today's `istDayStart()` (IST midnight
  and early IST morning). It lives under `tests/unit`, so it can fail `npm run check`
  in that window. Not a code regression — re-run after ~08:00 IST.

### Other gotchas
- `npm run dev`/`npm run build` first run `predev`/`prebuild` = `scripts/sync-ort-assets.mjs`,
  which copies the ~13 MB `onnxruntime-web` WASM runtime into `public/ort/` (git-ignored);
  `vite.config.ts` has a matching middleware to serve `/ort/*`.
- The CSP `connect-src` in `index.html` allows the local Supabase origin (`127.0.0.1:54321`).
- PWA service worker registers only in **production** builds (`import.meta.env.PROD`). `npm run dev` must not cache. Installable from `vite preview` / a built serve. HTTP LAN phones need a local TLS proxy to install.
- Windows thin client lives in `desktop/` (green connection light). It does not start Docker; `installer/windows/Start-Server.bat` / `scripts/onprem-up.sh` do. After `npx supabase start`, run `node scripts/write-local-env.mjs` then `npx supabase migration up --local` (096 = visitor-photos bucket). `cd desktop && npm run pack:win` emits `desktop/dist/SecureGate-Portable.exe` (gitignored, ~67 MB PE32). Customer slides: `docs/customer/presentation.html`; pack: `docs/customer/QUEST-MALL-VMS-ONPREM.html`; install: `docs/customer/SERVER-INSTALL.md`. Public paste-URLs: `docs/customer/PUBLIC-LINKS.md`.
- ID scan: if OCR cannot read the card, the error phase offers **Enter details from the card** (`ManualIdEntry`) — type, last four, printed name. That is the on-prem fallback, not a demo backdoor.
