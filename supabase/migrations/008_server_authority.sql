-- 008 — Server-authoritative data + state machine + department scoping (S9 / SEC-3 / NFR-07)
-- Closes three gaps found while activating tests/security/rls.test.ts:
--   1. ref_number / created_at / check-in/out timestamps were only protected on INSERT,
--      not UPDATE — a guard could rewrite them (NFR-07 violation).
--   2. The guard UPDATE policy had no column/status restrictions — a guard could set
--      status='approved' directly, bypassing the HOD (SEC-5 violation).
--   3. HOD PreApproveForm INSERTs visits, but only guard/admin had an INSERT policy.
-- Also narrows visits SELECT: guard/admin see all (gate + evacuation view);
-- hod/staff see their own department only (S9: "anyone from reading another
-- department's pending approvals").

-- Helper: requests made with the service-role key (seed script, server jobs)
-- bypass the rules below — they are trusted server-side code.
create or replace function public.is_service_role()
returns boolean language sql stable as $$
  select coalesce(auth.jwt() ->> 'role', '') = 'service_role';
$$;

-- ── 1. Visits: immutability + server clock + status state machine ────────────
create or replace function public.enforce_visit_update_rules()
returns trigger language plpgsql as $$
declare
  jwt_role text := coalesce(auth.jwt() -> 'user_metadata' ->> 'role', '');
begin
  if public.is_service_role() then return new; end if;

  -- Immutable columns (NFR-07): client-supplied values silently ignored
  new.ref_number := old.ref_number;
  new.created_at := old.created_at;

  -- Server clock wins on entry/exit timestamps (SEC-3)
  if new.checked_in_at is distinct from old.checked_in_at and new.checked_in_at is not null then
    new.checked_in_at := now();
  end if;
  if new.checked_out_at is distinct from old.checked_out_at and new.checked_out_at is not null then
    new.checked_out_at := now();
  end if;

  -- Status state machine: only these transitions exist, each gated by role
  if new.status is distinct from old.status then
    if old.status = 'pending_approval' and new.status in ('approved','rejected') then
      if jwt_role not in ('hod','admin','super_admin') then
        raise exception 'Only HOD or Admin can decide approvals.';
      end if;
    elsif old.status = 'approved' and new.status = 'checked_in' then
      if jwt_role not in ('guard','admin','super_admin') then
        raise exception 'Only the guard can log check-in.';
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

drop trigger if exists visits_update_rules on public.visits;
create trigger visits_update_rules
  before update on public.visits
  for each row execute function public.enforce_visit_update_rules();

-- ── 2. Gate passes: ref_number / created_at immutable ───────────────────────
create or replace function public.enforce_gate_pass_update_rules()
returns trigger language plpgsql as $$
begin
  if public.is_service_role() then return new; end if;
  new.ref_number := old.ref_number;
  new.created_at := old.created_at;
  return new;
end;
$$;

drop trigger if exists gate_passes_update_rules on public.gate_passes;
create trigger gate_passes_update_rules
  before update on public.gate_passes
  for each row execute function public.enforce_gate_pass_update_rules();

-- ── 3. Visits SELECT scoped by role (replaces broad USING(true)) ────────────
drop policy if exists "visits: all authenticated can read" on public.visits;
drop policy if exists "visits: read scoped by role" on public.visits;
create policy "visits: read scoped by role"
  on public.visits for select to authenticated
  using (
    public.current_user_role() in ('guard','admin','super_admin')
    or department_id = (auth.jwt() -> 'user_metadata' ->> 'department_id')::uuid
  );

-- ── 4. Visits INSERT: HOD may pre-approve visits for their own department ───
drop policy if exists "visits: hod pre-approves own department" on public.visits;
create policy "visits: hod pre-approves own department"
  on public.visits for insert to authenticated
  with check (
    public.current_user_role() = 'hod'
    and department_id = (auth.jwt() -> 'user_metadata' ->> 'department_id')::uuid
    and status = 'approved'
  );

-- ── 5. Gate passes INSERT: staff/hod restricted to own department ───────────
drop policy if exists "gate_passes: staff/hod/guard/admin can insert" on public.gate_passes;
drop policy if exists "gate_passes: insert scoped by role" on public.gate_passes;
create policy "gate_passes: insert scoped by role"
  on public.gate_passes for insert to authenticated
  with check (
    public.current_user_role() in ('guard','admin','super_admin')
    or (
      public.current_user_role() in ('staff','hod')
      and department_id = (auth.jwt() -> 'user_metadata' ->> 'department_id')::uuid
    )
  );
