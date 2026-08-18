-- 040 — Fix infinite recursion in the profiles SELECT policies (Postgres 42P17).
--
-- A policy named "profiles: hod can read department profiles" existed on the live
-- database (it is in no migration in this folder — it was applied ad hoc). Its
-- USING clause subqueries public.profiles:
--
--   department_id = (select department_id from profiles where id = auth.uid())
--
-- Reading profiles therefore re-evaluates the same policy, and EVERY authenticated
-- read of public.profiles failed with:
--   42P17  infinite recursion detected in policy for relation "profiles"
--
-- Two visible symptoms in the Admin Panel:
--   1. Department cards showed "No head of department assigned" for every
--      department — useHods() got a 42P17 error and fell back to an empty list.
--   2. Deleting a department failed: deleteDepartment() unlinks member profiles
--      first, and that UPDATE reads profiles, so it raised 42P17 and the delete
--      never ran.
--
-- RULE (same lesson as migration 013): never subquery public.profiles inside a
-- policy ON public.profiles. Role and department must come from the JWT
-- app_metadata, which the sync_profile_role_to_auth trigger (migration 010) keeps
-- in step with the profiles row.

-- 1) Remove every SELECT policy on profiles, recursive or redundant.
drop policy if exists "profiles: hod can read department profiles"     on public.profiles;
drop policy if exists "profiles: authenticated can read basic profile info" on public.profiles;
drop policy if exists "profiles: admin can read all"                   on public.profiles;
drop policy if exists "profiles: own row always visible"               on public.profiles;
drop policy if exists "profiles: all authenticated can read"           on public.profiles;
drop policy if exists "profiles: read scoped by role"                  on public.profiles;

-- 2) One SELECT policy, JWT-only, no subqueries (restores migration 016's intent
--    and additionally guarantees a user can always see their own row).
drop policy if exists "profiles: read scoped by role" on public.profiles;
create policy "profiles: read scoped by role"
  on public.profiles for select to authenticated
  using (
    id = auth.uid()
    or public.current_user_role() in ('guard', 'admin', 'super_admin')
    or department_id = (auth.jwt() -> 'app_metadata' ->> 'department_id')::uuid
  );

-- 3) The UPDATE policies are already JWT-only (migration 022); re-assert them so a
--    database restored from an ad-hoc state converges on the same shape.
drop policy if exists "profiles: admin manages all" on public.profiles;
create policy "profiles: admin manages all"
  on public.profiles for update to authenticated
  using ((auth.jwt() -> 'app_metadata' ->> 'role') in ('admin', 'super_admin'))
  with check ((auth.jwt() -> 'app_metadata' ->> 'role') in ('admin', 'super_admin'));
