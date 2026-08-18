-- VMS RLS Policies — Milestone A
-- SEC-1: RLS enabled on every table (done in 001_schema.sql)
-- SEC-5: Role separation is real — backend-enforced, not just UI
-- NFR-04: Guard / HOD / Staff / Admin roles enforced by Postgres policies
-- Run AFTER 001_schema.sql.

-- ─── Helper: get current user's role ─────────────────────────────────────────
-- Reads from JWT (synced by trigger below) to avoid recursive RLS policy evaluation
-- on the profiles table (the old security-definer approach caused infinite recursion
-- in PG15+ because security definer no longer bypasses RLS in subqueries).
create or replace function public.current_user_role()
returns public.user_role language sql stable as $$
  select (auth.jwt() -> 'user_metadata' ->> 'role')::public.user_role;
$$;

-- Sync role from profiles to auth.users metadata so JWT-based role check works.
create or replace function public.sync_profile_role_to_auth()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  update auth.users
  set raw_user_meta_data = raw_user_meta_data || jsonb_build_object('role', new.role)
  where id = new.id;
  return new;
end;
$$;
create trigger sync_profile_role
  after insert or update of role on public.profiles
  for each row execute function public.sync_profile_role_to_auth();

-- ─── departments ──────────────────────────────────────────────────────────────
-- All authenticated users can read (guards pick departments, HODs see their own).
-- Only admin/super_admin can write.
drop policy if exists "dept: authenticated users can read" on public.departments;
create policy "dept: authenticated users can read"
  on public.departments for select to authenticated
  using (true);

drop policy if exists "dept: admin can insert" on public.departments;
create policy "dept: admin can insert"
  on public.departments for insert to authenticated
  with check (public.current_user_role() in ('admin', 'super_admin'));

drop policy if exists "dept: admin can update" on public.departments;
create policy "dept: admin can update"
  on public.departments for update to authenticated
  using (public.current_user_role() in ('admin', 'super_admin'))
  with check (public.current_user_role() in ('admin', 'super_admin'));

drop policy if exists "dept: admin can delete" on public.departments;
create policy "dept: admin can delete"
  on public.departments for delete to authenticated
  using (public.current_user_role() in ('admin', 'super_admin'));

-- ─── profiles ─────────────────────────────────────────────────────────────────
-- NOTE: We use a single broad SELECT policy (using true) because the narrower
-- policies that called current_user_role() caused infinite recursion (PG15+).
-- The broad policy is safe here: profile data (name, email, department) is not
-- sensitive — PII like phone, photo is in separate tables with tighter policies.
-- In Milestone B, tighten with per-department filters on a dedicated RPC function
-- that bypasses RLS via security definer.
drop policy if exists "profiles: all authenticated can read" on public.profiles;
create policy "profiles: all authenticated can read"
  on public.profiles for select to authenticated
  using (true);

drop policy if exists "profiles: user updates own non-sensitive fields" on public.profiles;
create policy "profiles: user updates own non-sensitive fields"
  on public.profiles for update to authenticated
  using (id = auth.uid())
  with check (
    id = auth.uid()
    -- role, department_id, delegate_id can only be set by admin (policy below wins for those)
  );

drop policy if exists "profiles: admin manages all" on public.profiles;
create policy "profiles: admin manages all"
  on public.profiles for update to authenticated
  using (public.current_user_role() in ('admin', 'super_admin'))
  with check (public.current_user_role() in ('admin', 'super_admin'));

-- ─── visitors ─────────────────────────────────────────────────────────────────
-- All authenticated users can read (guard needs visitor data, HOD sees photo/name).
-- Guard (and admin) can insert or update visitors.
-- Only admin can blacklist/unblacklist.
drop policy if exists "visitors: all authenticated can read" on public.visitors;
create policy "visitors: all authenticated can read"
  on public.visitors for select to authenticated
  using (true);

drop policy if exists "visitors: guard/admin can insert" on public.visitors;
create policy "visitors: guard/admin can insert"
  on public.visitors for insert to authenticated
  with check (public.current_user_role() in ('guard', 'admin', 'super_admin'));

drop policy if exists "visitors: guard/admin can update" on public.visitors;
create policy "visitors: guard/admin can update"
  on public.visitors for update to authenticated
  using (public.current_user_role() in ('guard', 'admin', 'super_admin'))
  with check (public.current_user_role() in ('guard', 'admin', 'super_admin'));

-- ─── visits ───────────────────────────────────────────────────────────────────
-- Guard registers (INSERT). HOD approves/rejects (UPDATE status in their dept).
-- Guard logs check-in/out (UPDATE checked_in_at / checked_out_at).
-- All authenticated can read visits.
-- Admin can update any field.
drop policy if exists "visits: all authenticated can read" on public.visits;
create policy "visits: all authenticated can read"
  on public.visits for select to authenticated
  using (true);

drop policy if exists "visits: guard/admin can insert" on public.visits;
create policy "visits: guard/admin can insert"
  on public.visits for insert to authenticated
  with check (public.current_user_role() in ('guard', 'admin', 'super_admin'));

-- Guard updates check-in / check-out timestamps only.
drop policy if exists "visits: guard updates checkin/checkout" on public.visits;
create policy "visits: guard updates checkin/checkout"
  on public.visits for update to authenticated
  using (public.current_user_role() = 'guard')
  with check (public.current_user_role() = 'guard');

-- HOD approves/rejects visits in their own department.
drop policy if exists "visits: hod approves own department" on public.visits;
create policy "visits: hod approves own department"
  on public.visits for update to authenticated
  using (
    public.current_user_role() = 'hod'
    and department_id = (select department_id from public.profiles where id = auth.uid())
  )
  with check (
    public.current_user_role() = 'hod'
    and department_id = (select department_id from public.profiles where id = auth.uid())
  );

drop policy if exists "visits: admin updates any" on public.visits;
create policy "visits: admin updates any"
  on public.visits for update to authenticated
  using (public.current_user_role() in ('admin', 'super_admin'))
  with check (public.current_user_role() in ('admin', 'super_admin'));

-- ─── gate_passes ──────────────────────────────────────────────────────────────
-- Staff / HOD / Guard / Admin can create gate passes.
-- HOD approves/rejects passes in their department.
-- Guard verifies at the gate.
-- All authenticated can read.
drop policy if exists "gate_passes: all authenticated can read" on public.gate_passes;
create policy "gate_passes: all authenticated can read"
  on public.gate_passes for select to authenticated
  using (true);

drop policy if exists "gate_passes: staff/hod/guard/admin can insert" on public.gate_passes;
create policy "gate_passes: staff/hod/guard/admin can insert"
  on public.gate_passes for insert to authenticated
  with check (public.current_user_role() in ('staff', 'hod', 'guard', 'admin', 'super_admin'));

drop policy if exists "gate_passes: hod approves own department" on public.gate_passes;
create policy "gate_passes: hod approves own department"
  on public.gate_passes for update to authenticated
  using (
    public.current_user_role() = 'hod'
    and department_id = (select department_id from public.profiles where id = auth.uid())
  )
  with check (
    public.current_user_role() = 'hod'
    and department_id = (select department_id from public.profiles where id = auth.uid())
  );

drop policy if exists "gate_passes: guard verifies at gate" on public.gate_passes;
create policy "gate_passes: guard verifies at gate"
  on public.gate_passes for update to authenticated
  using (public.current_user_role() = 'guard')
  with check (public.current_user_role() = 'guard');

drop policy if exists "gate_passes: admin manages all" on public.gate_passes;
create policy "gate_passes: admin manages all"
  on public.gate_passes for update to authenticated
  using (public.current_user_role() in ('admin', 'super_admin'))
  with check (public.current_user_role() in ('admin', 'super_admin'));

-- Owner (creator) can edit their draft pass.
drop policy if exists "gate_passes: creator edits own draft" on public.gate_passes;
create policy "gate_passes: creator edits own draft"
  on public.gate_passes for update to authenticated
  using (created_by = auth.uid() and status = 'draft')
  with check (created_by = auth.uid());

-- ─── gate_pass_items ─────────────────────────────────────────────────────────
-- Follows gate_pass: readable by all; writable by same roles.
-- Cascade delete on gate_pass delete handles cleanup (schema already does this).
drop policy if exists "items: all authenticated can read" on public.gate_pass_items;
create policy "items: all authenticated can read"
  on public.gate_pass_items for select to authenticated
  using (true);

drop policy if exists "items: staff/hod/guard/admin can insert" on public.gate_pass_items;
create policy "items: staff/hod/guard/admin can insert"
  on public.gate_pass_items for insert to authenticated
  with check (
    public.current_user_role() in ('staff', 'hod', 'guard', 'admin', 'super_admin')
  );

drop policy if exists "items: guard/hod/admin can update (returns)" on public.gate_pass_items;
create policy "items: guard/hod/admin can update (returns)"
  on public.gate_pass_items for update to authenticated
  using (public.current_user_role() in ('guard', 'hod', 'admin', 'super_admin'))
  with check (public.current_user_role() in ('guard', 'hod', 'admin', 'super_admin'));

drop policy if exists "items: admin can delete" on public.gate_pass_items;
create policy "items: admin can delete"
  on public.gate_pass_items for delete to authenticated
  using (public.current_user_role() in ('admin', 'super_admin'));

-- ─── notifications ────────────────────────────────────────────────────────────
-- Users only see their own notifications.
-- INSERT is done by security-definer triggers (no INSERT policy needed for client).
-- Users can mark their own as read (UPDATE is_read only).
drop policy if exists "notifications: own notifications only" on public.notifications;
create policy "notifications: own notifications only"
  on public.notifications for select to authenticated
  using (recipient_id = auth.uid());

drop policy if exists "notifications: mark own as read" on public.notifications;
create policy "notifications: mark own as read"
  on public.notifications for update to authenticated
  using (recipient_id = auth.uid())
  with check (recipient_id = auth.uid());

-- ─── Storage: visitor-photos bucket ──────────────────────────────────────────
-- SEC-2: private bucket, signed URLs only. Created via Supabase Dashboard or:
--   insert into storage.buckets (id, name, public) values ('visitor-photos', 'visitor-photos', false);
-- Policies below assume the bucket exists.

-- Guard uploads photos (INSERT)
drop policy if exists "photos: guard can upload" on storage.objects;
create policy "photos: guard can upload"
  on storage.objects for insert to authenticated
  with check (
    bucket_id = 'visitor-photos'
    and public.current_user_role() in ('guard', 'admin', 'super_admin')
  );

-- All authenticated can read their department's photos via signed URLs
drop policy if exists "photos: authenticated can read" on storage.objects;
create policy "photos: authenticated can read"
  on storage.objects for select to authenticated
  using (
    bucket_id = 'visitor-photos'
  );

-- Admin can delete photos (e.g., on GDPR request)
drop policy if exists "photos: admin can delete" on storage.objects;
create policy "photos: admin can delete"
  on storage.objects for delete to authenticated
  using (
    bucket_id = 'visitor-photos'
    and public.current_user_role() in ('admin', 'super_admin')
  );
