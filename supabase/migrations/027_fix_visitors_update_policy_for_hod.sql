-- 027 — Add HOD to visitors UPDATE policy
--
-- Problem: PreApproveForm does upsert on visitors table. When a visitor
-- already exists (phone conflict), the upsert acts as an UPDATE, but the
-- UPDATE policy (from 022) only included guard/admin/super_admin, not hod.
-- This caused: "new row violates row-level security policy for table 'visitors'"

drop policy if exists "visitors: guard/admin can update" on public.visitors;

drop policy if exists "visitors: guard/hod/admin can update" on public.visitors;
create policy "visitors: guard/hod/admin can update"
  on public.visitors for update to authenticated
  using ((auth.jwt() -> 'app_metadata' ->> 'role') in ('guard', 'hod', 'admin', 'super_admin'))
  with check ((auth.jwt() -> 'app_metadata' ->> 'role') in ('guard', 'hod', 'admin', 'super_admin'));
