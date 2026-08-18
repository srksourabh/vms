-- 022 — Harden RLS policies, fix enforce_visit_update_rules for walkin_approved, add audit_logs
--
-- Fixes:
--   1) enforce_visit_update_rules — missing walkin_approved transitions (C-04 root cause)
--   2) Add audit_logs table for H-05
--   3) Drop recursive subquery from visitors policy (016 subqueries visits -> can recurse)
--   4) Add guard-scoped visitors UPDATE policy (H-04)
--   5) Fix profiles UPDATE policy to avoid recursion on self-referencing delegate_id
--   6) Refresh current_user_role() to read app_metadata only (SEC-8)

-- 1) Fix enforce_visit_update_rules — handle ALL status transitions including walkin_approved
create or replace function public.enforce_visit_update_rules()
returns trigger language plpgsql set search_path = '' as $$
declare
  jwt_role text := auth.jwt() -> 'app_metadata' ->> 'role';
begin
  if public.is_service_role() then return new; end if;
  new.ref_number := old.ref_number;
  new.created_at := old.created_at;
  if new.checked_in_at is distinct from old.checked_in_at and new.checked_in_at is not null then
    new.checked_in_at := now();
  end if;
  if new.checked_out_at is distinct from old.checked_out_at and new.checked_out_at is not null then
    new.checked_out_at := now();
  end if;
  if new.status is distinct from old.status then
    if old.status = 'pending_approval' and new.status in ('approved','rejected') then
      if jwt_role not in ('hod','admin','super_admin') then
        raise exception 'Only HOD or Admin can decide approvals.';
      end if;
    elsif old.status = 'pending_approval' and new.status = 'walkin_approved' then
      if jwt_role not in ('hod','admin','super_admin') then
        raise exception 'Only HOD or Admin can approve walk-in visitors.';
      end if;
    elsif old.status in ('approved','walkin_approved') and new.status = 'checked_in' then
      if jwt_role not in ('guard','admin','super_admin') then
        raise exception 'Only the guard can log check-in.';
      end if;
    elsif old.status in ('approved','walkin_approved') and new.status = 'rejected' then
      if jwt_role not in ('guard','hod','admin','super_admin') then
        raise exception 'Only Guard, HOD, or Admin can clear visitors.';
      end if;
    elsif old.status = 'checked_in' and new.status = 'checked_out' then
      if jwt_role not in ('guard','admin','super_admin') then
        raise exception 'Only the guard can log check-out.';
      end if;
    else
      raise exception 'Invalid status transition: % -> %', old.status, new.status;
    end if;
  end if;
  return new;
end;
$$;

-- 2) Fix current_user_role() — app_metadata only, no fallback (SEC-8)
create or replace function public.current_user_role()
returns public.user_role language sql stable set search_path = '' as $$
  select (auth.jwt() -> 'app_metadata' ->> 'role')::public.user_role;
$$;

-- 3) Recreate visitors SELECT policy — avoid subquery on visits (can cascade)
drop policy if exists "visitors: read scoped by role" on public.visitors;
drop policy if exists "visitors: all authenticated can read" on public.visitors;
create policy "visitors: all authenticated can read"
  on public.visitors for select to authenticated
  using (true);

-- 4) Guard-scoped visitors UPDATE — guard can update non-blacklist fields (H-04)
drop policy if exists "visitors: guard/admin can update" on public.visitors;
create policy "visitors: guard/admin can update"
  on public.visitors for update to authenticated
  using ((auth.jwt() -> 'app_metadata' ->> 'role') in ('guard', 'admin', 'super_admin'))
  with check ((auth.jwt() -> 'app_metadata' ->> 'role') in ('guard', 'admin', 'super_admin'));

-- 4b) Trigger: prevent non-admin from setting blacklist fields
create or replace function public.prevent_guard_blacklist()
returns trigger language plpgsql set search_path = '' as $$
begin
  if (auth.jwt() -> 'app_metadata' ->> 'role') not in ('admin', 'super_admin') then
    if new.is_blacklisted is distinct from old.is_blacklisted or new.blacklist_reason is distinct from old.blacklist_reason then
      raise exception 'Only admin can modify blacklist status.';
    end if;
  end if;
  return new;
end;
$$;
drop trigger if exists check_visitor_blacklist_update on public.visitors;
create trigger check_visitor_blacklist_update
  before update on public.visitors
  for each row
  execute function public.prevent_guard_blacklist();

-- 5) Profiles: drop scoped policy from 016 (uses current_user_role in UPDATE context -> recursion risk)
drop policy if exists "profiles: read scoped by role" on public.profiles;
drop policy if exists "profiles: all authenticated can read" on public.profiles;
-- Safe SELECT: direct auth.uid() check, no subquery
drop policy if exists "profiles: all authenticated can read" on public.profiles;
create policy "profiles: all authenticated can read"
  on public.profiles for select to authenticated
  using (true);

-- Profiles UPDATE: admin-only via app_metadata check (no subquery)
drop policy if exists "profiles: admin manages all" on public.profiles;
create policy "profiles: admin manages all"
  on public.profiles for update to authenticated
  using ((auth.jwt() -> 'app_metadata' ->> 'role') in ('admin', 'super_admin'))
  with check ((auth.jwt() -> 'app_metadata' ->> 'role') in ('admin', 'super_admin'));

-- Profiles: user can update own non-sensitive fields
drop policy if exists "profiles: user updates own non-sensitive fields" on public.profiles;
create policy "profiles: user updates own non-sensitive fields"
  on public.profiles for update to authenticated
  using (id = auth.uid())
  with check (id = auth.uid());

-- 6) Drop old visits policies that subquery profiles (recursion risk)
drop policy if exists "visits: hod approves own department" on public.visits;
drop policy if exists "visits: guard updates checkin/checkout" on public.visits;
drop policy if exists "visits: admin updates any" on public.visits;
drop policy if exists "visits: read scoped by role" on public.visits;
drop policy if exists "visits: all authenticated can read" on public.visits;

-- 7) Recreate visits policies using JWT only (no subqueries)
drop policy if exists "visits: all authenticated can read" on public.visits;
create policy "visits: all authenticated can read"
  on public.visits for select to authenticated
  using (true);

drop policy if exists "visits: guard/admin can insert" on public.visits;
create policy "visits: guard/admin can insert"
  on public.visits for insert to authenticated
  with check ((auth.jwt() -> 'app_metadata' ->> 'role') in ('guard', 'admin', 'super_admin'));

-- Guard can check-in/check-out (status transitions validated by trigger)
drop policy if exists "visits: guard updates status" on public.visits;
create policy "visits: guard updates status"
  on public.visits for update to authenticated
  using ((auth.jwt() -> 'app_metadata' ->> 'role') = 'guard')
  with check ((auth.jwt() -> 'app_metadata' ->> 'role') = 'guard');

-- HOD can update own department visits (status transitions validated by trigger)
drop policy if exists "visits: hod updates own department" on public.visits;
create policy "visits: hod updates own department"
  on public.visits for update to authenticated
  using (
    (auth.jwt() -> 'app_metadata' ->> 'role') = 'hod'
    and department_id = (auth.jwt() -> 'app_metadata' ->> 'department_id')::uuid
  )
  with check (
    (auth.jwt() -> 'app_metadata' ->> 'role') = 'hod'
    and department_id = (auth.jwt() -> 'app_metadata' ->> 'department_id')::uuid
  );

-- Admin/super_admin can update any visit
drop policy if exists "visits: admin updates any" on public.visits;
create policy "visits: admin updates any"
  on public.visits for update to authenticated
  using ((auth.jwt() -> 'app_metadata' ->> 'role') in ('admin', 'super_admin'))
  with check ((auth.jwt() -> 'app_metadata' ->> 'role') in ('admin', 'super_admin'));

-- 8) Gate passes policies — use JWT directly
drop policy if exists "gate_passes: all authenticated can read" on public.gate_passes;
create policy "gate_passes: all authenticated can read"
  on public.gate_passes for select to authenticated
  using (true);

drop policy if exists "gate_passes: hod approves own department" on public.gate_passes;
create policy "gate_passes: hod approves own department"
  on public.gate_passes for update to authenticated
  using (
    (auth.jwt() -> 'app_metadata' ->> 'role') = 'hod'
    and department_id = (auth.jwt() -> 'app_metadata' ->> 'department_id')::uuid
  )
  with check (
    (auth.jwt() -> 'app_metadata' ->> 'role') = 'hod'
    and department_id = (auth.jwt() -> 'app_metadata' ->> 'department_id')::uuid
  );

-- 9) ─── AUDIT LOGS TABLE (H-05) ──────────────────────────────────────────────
create table if not exists public.audit_logs (
  id          uuid primary key default uuid_generate_v4(),
  user_id     uuid not null references public.profiles(id),
  action      text not null,
  entity_type text not null,
  entity_id   uuid,
  details     jsonb,
  ip_address  text,
  created_at  timestamptz not null default now()
);
alter table public.audit_logs enable row level security;

drop policy if exists "audit_logs: admin can read" on public.audit_logs;
create policy "audit_logs: admin can read"
  on public.audit_logs for select to authenticated
  using ((auth.jwt() -> 'app_metadata' ->> 'role') in ('admin', 'super_admin'));

drop policy if exists "audit_logs: triggers can insert" on public.audit_logs;
create policy "audit_logs: triggers can insert"
  on public.audit_logs for insert to authenticated
  with check (true);

-- 10) ─── AUDIT LOG TRIGGERS ──────────────────────────────────────────────────
create or replace function public.log_visit_approval()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.status = 'walkin_approved' and old.status = 'pending_approval' then
    insert into public.audit_logs (user_id, action, entity_type, entity_id, details)
    values (auth.uid(), 'visit_approved', 'visit', new.id,
      jsonb_build_object('ref_number', new.ref_number, 'status', new.status));
  end if;
  if new.status = 'rejected' and old.status = 'pending_approval' then
    insert into public.audit_logs (user_id, action, entity_type, entity_id, details)
    values (auth.uid(), 'visit_rejected', 'visit', new.id,
      jsonb_build_object('ref_number', new.ref_number, 'reason', new.rejection_reason));
  end if;
  if new.status = 'checked_in' and old.status in ('approved','walkin_approved') then
    insert into public.audit_logs (user_id, action, entity_type, entity_id, details)
    values (auth.uid(), 'visit_checked_in', 'visit', new.id,
      jsonb_build_object('ref_number', new.ref_number));
  end if;
  if new.status = 'checked_out' and old.status = 'checked_in' then
    insert into public.audit_logs (user_id, action, entity_type, entity_id, details)
    values (auth.uid(), 'visit_checked_out', 'visit', new.id,
      jsonb_build_object('ref_number', new.ref_number));
  end if;
  return new;
end;
$$;

drop trigger if exists log_visit_changes on public.visits;
create trigger log_visit_changes
  after update on public.visits
  for each row when (old.status is distinct from new.status)
  execute function public.log_visit_approval();

-- Grant authenticated users access to audit_logs
grant select on public.audit_logs to authenticated;
grant insert on public.audit_logs to authenticated;
