-- 019 — Apply all pending migrations (014–018) safely
-- Run this once in Supabase Dashboard SQL Editor.
-- All statements use IF NOT EXISTS / CREATE OR REPLACE to be idempotent.

-- ── 014: Add walkin_approved enum value ─────────────────────────────────────
alter type public.visit_status add value if not exists 'walkin_approved' before 'checked_in';

-- ── 015: Security-definer RPCs (app_metadata only, dept-scoped) ─────────────
create or replace function public.approve_visit(visit_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare
  hod_dept uuid;
  visit_dept uuid;
  jwt_role text := auth.jwt() -> 'app_metadata' ->> 'role';
begin
  hod_dept := (auth.jwt() -> 'app_metadata' ->> 'department_id')::uuid;
  if jwt_role not in ('hod','admin','super_admin') then
    raise exception 'Only HOD or Admin can approve visits.';
  end if;
  if jwt_role = 'hod' and hod_dept is null then
    raise exception 'Your account is not assigned to any department.';
  end if;
  select department_id into visit_dept from public.visits where id = visit_id;
  if visit_dept is null then raise exception 'Visit not found.'; end if;
  if jwt_role = 'hod' and hod_dept <> visit_dept then
    raise exception 'You can only approve visits in your own department.';
  end if;
  update public.visits set status = 'walkin_approved', rejection_reason = null where id = visit_id;
end;
$$;

create or replace function public.reject_visit(visit_id uuid, reason text)
returns void language plpgsql security definer set search_path = '' as $$
declare
  hod_dept uuid;
  visit_dept uuid;
  jwt_role text := auth.jwt() -> 'app_metadata' ->> 'role';
begin
  if reason is null or trim(reason) = '' then
    raise exception 'Rejection reason is required.';
  end if;
  hod_dept := (auth.jwt() -> 'app_metadata' ->> 'department_id')::uuid;
  if jwt_role not in ('hod','admin','super_admin') then
    raise exception 'Only HOD or Admin can reject visits.';
  end if;
  if jwt_role = 'hod' and hod_dept is null then
    raise exception 'Your account is not assigned to any department.';
  end if;
  select department_id into visit_dept from public.visits where id = visit_id;
  if visit_dept is null then raise exception 'Visit not found.'; end if;
  if jwt_role = 'hod' and hod_dept <> visit_dept then
    raise exception 'You can only reject visits in your own department.';
  end if;
  update public.visits set status = 'rejected', rejection_reason = trim(reason) where id = visit_id;
end;
$$;

create or replace function public.clear_pre_approved()
returns int language plpgsql security definer set search_path = '' as $$
declare
  v_count int;
  v_jwt_role text;
  v_dept_id uuid;
begin
  v_jwt_role := auth.jwt() -> 'app_metadata' ->> 'role';
  v_dept_id := (auth.jwt() -> 'app_metadata' ->> 'department_id')::uuid;
  if v_jwt_role not in ('guard', 'hod', 'admin', 'super_admin') then
    raise exception 'Only Guard, HOD, or Admin can clear pre-approvals.';
  end if;
  if v_jwt_role in ('guard', 'hod') and v_dept_id is null then
    raise exception 'Your account is not assigned to any department.';
  end if;
  if v_jwt_role = 'admin' or v_jwt_role = 'super_admin' then
    update public.visits set status = 'rejected', rejection_reason = 'Cleared by ' || v_jwt_role
    where status = 'approved';
  else
    update public.visits set status = 'rejected', rejection_reason = 'Cleared by ' || v_jwt_role
    where status = 'approved' and department_id = v_dept_id;
  end if;
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

create or replace function public.enforce_visit_update_rules()
returns trigger language plpgsql as $$
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

-- ── 016: Least-privilege SELECT policies ────────────────────────────────────
drop policy if exists "photos: authenticated can read" on storage.objects;
drop policy if exists "photos: guard/admin can read" on storage.objects;
create policy "photos: guard/admin can read"
  on storage.objects for select to authenticated
  using (
    bucket_id = 'visitor-photos'
    and public.current_user_role() in ('guard', 'admin', 'super_admin')
  );

drop policy if exists "profiles: all authenticated can read" on public.profiles;
drop policy if exists "profiles: read scoped by role" on public.profiles;
create policy "profiles: read scoped by role"
  on public.profiles for select to authenticated
  using (
    public.current_user_role() in ('guard', 'admin', 'super_admin')
    or department_id = (auth.jwt() -> 'app_metadata' ->> 'department_id')::uuid
  );

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

-- ── 017: Duplicate visit prevention (SEC-17) ────────────────────────────────
create or replace function public.check_active_visit_exists(p_visitor_id uuid)
returns boolean language plpgsql stable as $$
begin
  return exists (
    select 1 from public.visits
    where visitor_id = p_visitor_id
      and status in ('pending_approval', 'approved', 'walkin_approved', 'checked_in')
  );
end;
$$;

create or replace function public.prevent_duplicate_active_visits()
returns trigger language plpgsql as $$
declare
  jwt_role text := auth.jwt() -> 'app_metadata' ->> 'role';
begin
  if jwt_role in ('admin', 'super_admin') then return new; end if;
  if public.check_active_visit_exists(new.visitor_id) then
    raise exception 'This visitor already has an active visit. Please complete the existing visit before creating a new one.';
  end if;
  return new;
end;
$$;

drop trigger if exists check_duplicate_visit_trigger on public.visits;
create trigger check_duplicate_visit_trigger
  before insert on public.visits
  for each row execute function public.prevent_duplicate_active_visits();

create or replace function public.get_active_visit_for_phone(p_phone text)
returns table (id uuid, status public.visit_status, ref_number text, created_at timestamptz)
language plpgsql security definer set search_path = '' as $$
declare
  v_visitor_id uuid;
begin
  select id into v_visitor_id from public.visitors where phone = p_phone;
  if v_visitor_id is null then return; end if;
  return query
  select v.id, v.status, v.ref_number, v.created_at
  from public.visits v
  where v.visitor_id = v_visitor_id
    and v.status in ('pending_approval', 'approved', 'walkin_approved', 'checked_in')
  order by v.created_at desc limit 1;
end;
$$;

grant execute on function public.check_active_visit_exists(uuid) to authenticated;
grant execute on function public.get_active_visit_for_phone(text) to authenticated;
revoke execute on function public.check_active_visit_exists(uuid) from anon;
revoke execute on function public.get_active_visit_for_phone(text) from anon;
revoke all on function public.prevent_duplicate_active_visits() from anon, authenticated;

-- ── 018: Data retention & overstay (SEC-19/20) ─────────────────────────────
create table if not exists public.settings (
  key text primary key,
  value text not null,
  updated_at timestamptz not null default now()
);

insert into public.settings (key, value) values ('retention_days', '365')
on conflict (key) do nothing;

create or replace function public.get_retention_days()
returns integer language sql stable
as $$ select coalesce((select value::integer from public.settings where key = 'retention_days'), 365); $$;

create or replace function public.set_retention_days(days integer)
returns void language plpgsql security definer as $$
begin
  if days < 30 then raise exception 'retention_days must be at least 30'; end if;
  insert into public.settings (key, value, updated_at)
  values ('retention_days', days::text, now())
  on conflict (key) do update set value = excluded.value, updated_at = excluded.updated_at;
end;
$$;

create or replace function public.retention_cleanup()
returns integer language plpgsql security definer as $$
declare
  cutoff_date timestamptz;
  deleted_count integer;
begin
  cutoff_date := now() - (public.get_retention_days() || ' days')::interval;
  delete from public.visits where created_at < cutoff_date;
  get diagnostics deleted_count = row_count;
  return deleted_count;
end;
$$;

alter table public.visits add column if not exists visit_flags jsonb not null default '{}'::jsonb;

create or replace function public.flag_overstays()
returns integer language plpgsql security definer as $$
declare
  flagged_count integer;
begin
  update public.visits
  set visit_flags = visit_flags || '{"overstay": true}'::jsonb
  where status = 'checked_in'
    and checked_in_at is not null
    and checked_in_at < now() - interval '9 hours'
    and (visit_flags->>'overstay' is null or visit_flags->>'overstay' != 'true');
  get diagnostics flagged_count = row_count;
  return flagged_count;
end;
$$;

create or replace function public.is_overstay(visit public.visits)
returns boolean language sql stable
as $$ select visit.visit_flags->>'overstay' = 'true'; $$;

grant execute on function public.get_retention_days to authenticated;
grant execute on function public.set_retention_days to authenticated;
grant execute on function public.retention_cleanup to authenticated;
grant execute on function public.flag_overstays to authenticated;

alter table public.settings enable row level security;
drop policy if exists "settings_read_authenticated" on public.settings;
create policy "settings_read_authenticated" on public.settings for select to authenticated using (true);
drop policy if exists "settings_insert_admin" on public.settings;
create policy "settings_insert_admin" on public.settings for insert to authenticated
  with check (auth.jwt() -> 'app_metadata' ->> 'role' in ('admin', 'super_admin'));
drop policy if exists "settings_update_admin" on public.settings;
create policy "settings_update_admin" on public.settings for update to authenticated
  using (auth.jwt() -> 'app_metadata' ->> 'role' in ('admin', 'super_admin'))
  with check (auth.jwt() -> 'app_metadata' ->> 'role' in ('admin', 'super_admin'));

-- Done
