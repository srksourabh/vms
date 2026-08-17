# AGENTS.md

See `CLAUDE.md` for the full architecture, invariants, and per-surface rules — it is the
authoritative product/codebase guide. This file only adds environment/run notes for agents.

## Cursor Cloud specific instructions

Single product: a Vite + React 18 + TypeScript SPA (`npm run dev`, port 5173) backed by an
**external** Supabase project (auth, Postgres, RLS, realtime, storage). There is no local
backend to run — Supabase is a hosted dependency. Standard commands live in `package.json`
`scripts` (`dev`, `lint` = `tsc --noEmit`, `build`, `test`, `check`, `seed`); don't duplicate them.

### Supabase env vars are required (not in the repo)
- `src/supabaseClient.ts` builds the client at import from `VITE_SUPABASE_URL` /
  `VITE_SUPABASE_ANON_KEY`. If `VITE_SUPABASE_URL` is unset, `@supabase/supabase-js` throws
  `supabaseUrl is required` at import — so **~14 unit test files that transitively import the
  client fail to even collect** until those two vars are set. Any non-empty values satisfy the
  offline unit suite (it mocks the client / never hits the network); real values are only needed
  to actually sign in or run the live integration tests below.
- `vite.config.ts`'s dev-only `/api/*` proxy (departments/hosts admin helpers) and
  `scripts/seed.ts` additionally need `SUPABASE_SERVICE_ROLE_KEY`.
- Vite reads `VITE_`-prefixed vars from the real environment as well as a git-ignored `.env`
  (`.env.example` is the template). Prefer setting them as injected env vars/secrets.

### Testing: which suite needs a live backend
- `npm run check` (tsc + unit + `routeProtection` + `csp`) is the **offline-safe** gate and
  passes with placeholder Supabase env values. Use it as the default verification loop.
- `npm test` also runs `tests/security/{rls,rlsDataIntegrity,realtime,noShowWorkflow,lapsedRequests,auditLogsRls}.test.ts`,
  which are **live integration tests**: they connect with `SUPABASE_SERVICE_ROLE_KEY` and log in
  as the seeded demo users (`scripts/seed.ts`, password `demo123`). They fail without a real
  Supabase project that has the migrations applied and `npm run seed` run against it.

### Other gotchas
- `npm run dev`/`npm run build` first run `predev`/`prebuild` = `scripts/sync-ort-assets.mjs`,
  which copies the ~13 MB `onnxruntime-web` WASM runtime into `public/ort/` (git-ignored). This
  requires deps installed; `vite.config.ts` has a matching middleware to serve `/ort/*`.
- Migrations in `supabase/migrations/` (001–093) are **hand-applied to the live project**, in
  order, with real traps (see `CLAUDE.md` → Migrations). This is NOT a `supabase db push` /
  local-stack workflow; do not try to reconstruct the DB locally.
