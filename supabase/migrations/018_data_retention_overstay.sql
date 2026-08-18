-- 018 — Data retention & overstay detection (SEC-19 / SEC-20)

-- ── 1. Settings table for configurable retention ────────────────────────────
create table if not exists public.settings (
  key text primary key,
  value text not null,
  updated_at timestamptz not null default now()
);

insert into public.settings (key, value) values ('retention_days', '365')
on conflict (key) do nothing;

-- ── 2. Read retention_days setting ──────────────────────────────────────────
create or replace function public.get_retention_days()
returns integer
language sql
stable
as $$
  select coalesce((select value::integer from public.settings where key = 'retention_days'), 365);
$$;

-- ── 3. Update retention_days (min 30) ───────────────────────────────────────
create or replace function public.set_retention_days(days integer)
returns void
language plpgsql
security definer
as $$
begin
  if days < 30 then
    raise exception 'retention_days must be at least 30';
  end if;
  insert into public.settings (key, value, updated_at)
  values ('retention_days', days::text, now())
  on conflict (key) do update set value = excluded.value, updated_at = excluded.updated_at;
end;
$$;

-- ── 4. Purge visit records older than retention_days ────────────────────────
create or replace function public.retention_cleanup()
returns integer
language plpgsql
security definer
as $$
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

-- ── 5. visit_flags JSONB column for overstay / other metadata ───────────────
alter table public.visits add column if not exists visit_flags jsonb not null default '{}'::jsonb;

-- ── 6. Flag visits checked in for more than 9 hours ─────────────────────────
create or replace function public.flag_overstays()
returns integer
language plpgsql
security definer
as $$
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

-- ── 7. Predicate for RLS / policies ─────────────────────────────────────────
create or replace function public.is_overstay(visit public.visits)
returns boolean
language sql
stable
as $$
  select visit.visit_flags->>'overstay' = 'true';
$$;

-- ── 8. Permissions ──────────────────────────────────────────────────────────
grant execute on function public.get_retention_days to authenticated;
grant execute on function public.set_retention_days to authenticated;
grant execute on function public.retention_cleanup to authenticated;
grant execute on function public.flag_overstays to authenticated;

-- ── 9. RLS on settings ──────────────────────────────────────────────────────
alter table public.settings enable row level security;
drop policy if exists "settings_read_authenticated" on public.settings;
drop policy if exists "settings_write_admin" on public.settings;
drop policy if exists "settings_insert_admin" on public.settings;
drop policy if exists "settings_update_admin" on public.settings;
drop policy if exists "settings_read_authenticated" on public.settings;
create policy "settings_read_authenticated" on public.settings for select to authenticated using (true);
drop policy if exists "settings_insert_admin" on public.settings;
create policy "settings_insert_admin" on public.settings for insert to authenticated with check (auth.jwt() -> 'app_metadata' ->> 'role' in ('admin', 'super_admin'));
drop policy if exists "settings_update_admin" on public.settings;
create policy "settings_update_admin" on public.settings for update to authenticated using (auth.jwt() -> 'app_metadata' ->> 'role' in ('admin', 'super_admin')) with check (auth.jwt() -> 'app_metadata' ->> 'role' in ('admin', 'super_admin'));
