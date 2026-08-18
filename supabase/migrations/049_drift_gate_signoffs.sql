-- 049 — DRIFT RECONCILIATION 4/10: gate_signoffs (from 032).
--
-- 032_gate_signoffs.sql was applied to this project only PARTIALLY: the live
-- database has public.enforce_gate_pass_update_rules() and its
-- gate_passes_update_rules trigger, but it is missing:
--   * the public.gate_signoff_action enum type
--   * the public.gate_signoffs table and its two policies
--   * the "gate_passes: guard signs off at gate" UPDATE policy
-- (gate_passes.verified_vehicle is handled in 047.)
--
-- src/types/index.ts:220 declares gate_signoffs in the Database type, so the
-- types and the schema currently disagree.
--
-- 032's `create type` had no guard and its two gate_signoffs policies had no
-- `drop policy if exists`; both are made idempotent here.

do $$
begin
  if not exists (
    select 1 from pg_type t
    join pg_namespace n on n.oid = t.typnamespace
    where n.nspname = 'public' and t.typname = 'gate_signoff_action'
  ) then
    create type public.gate_signoff_action as enum ('out', 'in', 'hold', 'rejected', 'mismatch');
  end if;
end $$;

create table if not exists public.gate_signoffs (
  id                uuid primary key default uuid_generate_v4(),
  gate_pass_id      uuid not null references public.gate_passes(id) on delete cascade,
  security_user_id  uuid not null references public.profiles(id),
  security_name     text not null,
  security_employee_id text,
  gate_name         text not null default 'Main Gate',
  action_type       public.gate_signoff_action not null,
  action_timestamp  timestamptz not null default now(),
  verified_qty      int,
  verified_vehicle  text,
  remarks           text,
  photo_url         text,
  device_info       jsonb,
  session_id        text,
  created_at        timestamptz not null default now()
);

alter table public.gate_signoffs enable row level security;

-- Only a guard/admin may record a sign-off, and only as themselves. 032 used a
-- bare `with check (true)`, which let any authenticated user forge a sign-off
-- row attributed to another user. Scoped by role + security_user_id here.
drop policy if exists "gate_signoffs: guard can insert" on public.gate_signoffs;
create policy "gate_signoffs: guard can insert"
  on public.gate_signoffs for insert to authenticated
  with check (
    (auth.jwt() -> 'app_metadata' ->> 'role') in ('guard', 'admin', 'super_admin')
    and security_user_id = auth.uid()
  );

-- Reads follow the parent gate pass's own department scoping (see 043), rather
-- than 032's `using (true)` which would have leaked every gate movement to
-- every authenticated user regardless of department.
drop policy if exists "gate_signoffs: authenticated can read" on public.gate_signoffs;
drop policy if exists "gate_signoffs: read scoped by role" on public.gate_signoffs;
create policy "gate_signoffs: read scoped by role"
  on public.gate_signoffs for select to authenticated
  using (
    public.current_user_role() in ('guard', 'admin', 'super_admin')
    or exists (
      select 1 from public.gate_passes gp
      where gp.id = gate_signoffs.gate_pass_id
        and gp.department_id = (auth.jwt() -> 'app_metadata' ->> 'department_id')::uuid
    )
  );

create index if not exists idx_gate_signoffs_pass
  on public.gate_signoffs(gate_pass_id, action_timestamp desc);

-- Guard sign-off UPDATE path on gate_passes (state machine enforced by the
-- existing enforce_gate_pass_update_rules trigger).
drop policy if exists "gate_passes: guard signs off at gate" on public.gate_passes;
create policy "gate_passes: guard signs off at gate"
  on public.gate_passes for update to authenticated
  using ((auth.jwt() -> 'app_metadata' ->> 'role') in ('guard', 'admin', 'super_admin'))
  with check ((auth.jwt() -> 'app_metadata' ->> 'role') in ('guard', 'admin', 'super_admin'));
