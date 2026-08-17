-- 016 — Scope SELECT policies for least-privilege (SEC-10).
-- Tightens three overly-broad SELECT policies:
--   1) storage.objects on visitor-photos bucket — role-scoped
--   2) public.profiles — department-scoped for non-admin
--   3) public.visitors — department-scoped for non-admin

-- 1) Storage bucket: only guard, admin, super_admin can read photos
drop policy if exists "photos: authenticated can read" on storage.objects;
drop policy if exists "photos: guard/admin can read" on storage.objects;
create policy "photos: guard/admin can read"
  on storage.objects for select to authenticated
  using (
    bucket_id = 'visitor-photos'
    and public.current_user_role() in ('guard', 'admin', 'super_admin')
  );

-- 2) profiles: department-scoped for non-admin roles
-- Guards see all profiles (they need to know departments/HODs).
-- Staff/HOD see profiles in their own department.
-- Admin/super_admin see all.
drop policy if exists "profiles: all authenticated can read" on public.profiles;
drop policy if exists "profiles: read scoped by role" on public.profiles;
create policy "profiles: read scoped by role"
  on public.profiles for select to authenticated
  using (
    public.current_user_role() in ('guard', 'admin', 'super_admin')
    or department_id = (auth.jwt() -> 'app_metadata' ->> 'department_id')::uuid
  );

-- 3) visitors: department-scoped for non-admin roles
-- Guard, admin, super_admin see all visitors.
-- Staff/HOD only see visitors that have visited their department.
-- We use a subquery on visits to determine which visitors a HOD/staff can see.
drop policy if exists "visitors: all authenticated can read" on public.visitors;
drop policy if exists "visitors: read scoped by role" on public.visitors;
create policy "visitors: read scoped by role"
  on public.visitors for select to authenticated
  using (
    public.current_user_role() in ('guard', 'admin', 'super_admin')
    or exists (
      select 1 from public.visits
      where visits.visitor_id = visitors.id
        and visits.department_id = (auth.jwt() -> 'app_metadata' ->> 'department_id')::uuid
    )
  );
