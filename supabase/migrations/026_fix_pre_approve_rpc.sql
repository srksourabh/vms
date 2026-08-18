-- 026 — Fix pre_approve_visitor RPC function + allow HOD direct insert
--
-- Problem: The pre_approve_visitor RPC function has two competing definitions
-- (011 had 6 params, 021 had 7 params but the DROP was ambiguous), and the
-- schema cache may have stale entries. This migration:
--   1. Explicitly drops ALL overloads of pre_approve_visitor
--   2. Creates a clean 7-param version matching the frontend call signature
--   3. Adds HOD to visitors/visits INSERT policies as a belt-and-suspenders
--      fallback so pre-approval works even without the RPC function.

-- Step 1 — Drop all overloads explicitly
drop function if exists public.pre_approve_visitor(text, text, text, uuid, uuid, text);
drop function if exists public.pre_approve_visitor(text, text, text, text, uuid, uuid, text);

-- Step 2 — Create the 7-param version (matches PreApproveForm.tsx call)
create or replace function public.pre_approve_visitor(
  p_phone text,
  p_full_name text,
  p_company text,
  p_vehicle_number text,
  p_department_id uuid,
  p_host_id uuid,
  p_purpose text
)
returns json
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_visitor_id uuid;
  v_ref text;
  v_jwt_role text;
  v_jwt_dept_id uuid;
begin
  v_jwt_role := auth.jwt() -> 'app_metadata' ->> 'role';
  if v_jwt_role not in ('hod', 'admin', 'super_admin') then
    raise exception 'Only HOD or Admin can pre-approve visitors.';
  end if;

  if v_jwt_role = 'hod' then
    v_jwt_dept_id := (auth.jwt() -> 'app_metadata' ->> 'department_id')::uuid;
    if v_jwt_dept_id is null or v_jwt_dept_id <> p_department_id then
      raise exception 'You can only pre-approve visitors for your own department.';
    end if;
  end if;

  insert into public.visitors (phone, full_name, company, vehicle_number)
  values (p_phone, p_full_name, nullif(p_company, ''), nullif(p_vehicle_number, ''))
  on conflict (phone) do update set
    full_name = p_full_name,
    company = coalesce(nullif(p_company, ''), visitors.company),
    vehicle_number = coalesce(nullif(p_vehicle_number, ''), visitors.vehicle_number)
  returning id into v_visitor_id;

  insert into public.visits (visitor_id, department_id, host_id, purpose, status, carrying_material)
  values (v_visitor_id, p_department_id, p_host_id, p_purpose::public.visitor_purpose, 'approved', false)
  returning ref_number into v_ref;

  return json_build_object('ref_number', v_ref);
end;
$$;

revoke execute on function public.pre_approve_visitor(text, text, text, text, uuid, uuid, text) from anon;

-- Step 3 — Expand visitors INSERT policy to include HOD
drop policy if exists "visitors: guard/admin can insert" on public.visitors;
drop policy if exists "visitors: guard/hod/admin can insert" on public.visitors;
create policy "visitors: guard/hod/admin can insert"
  on public.visitors for insert to authenticated
  with check (public.current_user_role() in ('guard', 'hod', 'admin', 'super_admin'));

-- Step 4 — Expand visits INSERT policy to include HOD
drop policy if exists "visits: guard/admin can insert" on public.visits;
drop policy if exists "visits: guard/hod/admin can insert" on public.visits;
create policy "visits: guard/hod/admin can insert"
  on public.visits for insert to authenticated
  with check (public.current_user_role() in ('guard', 'hod', 'admin', 'super_admin'));
