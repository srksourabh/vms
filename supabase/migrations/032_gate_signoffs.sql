-- 032 — Gate pass security sign-off (FR-GP-09/10)

-- 1) Sign-off action type
create type public.gate_signoff_action as enum ('out', 'in', 'hold', 'rejected', 'mismatch');

-- 2) Sign-off audit table
create table public.gate_signoffs (
  id                  uuid primary key default uuid_generate_v4(),
  gate_pass_id        uuid not null references public.gate_passes(id) on delete cascade,
  security_user_id    uuid not null references public.profiles(id),
  security_name       text not null,
  security_employee_id text,
  gate_name           text not null default 'Main Gate',
  action_type         public.gate_signoff_action not null,
  action_timestamp    timestamptz not null default now(),
  verified_qty        int,
  verified_vehicle    text,
  remarks             text,
  photo_url           text,
  device_info         jsonb,
  session_id          text,
  created_at          timestamptz not null default now()
);

alter table public.gate_signoffs enable row level security;

drop policy if exists "gate_signoffs: guard can insert" on public.gate_signoffs;
create policy "gate_signoffs: guard can insert"
  on public.gate_signoffs for insert to authenticated
  with check (true);

drop policy if exists "gate_signoffs: authenticated can read" on public.gate_signoffs;
create policy "gate_signoffs: authenticated can read"
  on public.gate_signoffs for select to authenticated
  using (true);

-- 3) Verified vehicle on gate passes
alter table public.gate_passes
  add column if not exists verified_vehicle text;

-- 4) Guard update policy for gate passes (sign-off at gate)
drop policy if exists "gate_passes: guard signs off at gate" on public.gate_passes;
create policy "gate_passes: guard signs off at gate"
  on public.gate_passes for update to authenticated
  using ((auth.jwt() -> 'app_metadata' ->> 'role') in ('guard', 'admin', 'super_admin'))
  with check ((auth.jwt() -> 'app_metadata' ->> 'role') in ('guard', 'admin', 'super_admin'));

-- 5) Gate pass status state machine for sign-off transitions
create or replace function public.enforce_gate_pass_update_rules()
returns trigger language plpgsql as $$
declare
  jwt_role text := coalesce(auth.jwt() -> 'app_metadata' ->> 'role', '');
begin
  if public.is_service_role() then return new; end if;

  -- Immutable columns
  new.ref_number := old.ref_number;
  new.created_at := old.created_at;

  -- Status state machine
  if new.status is distinct from old.status then
    -- HOD approval
    if old.status = 'pending_approval' and new.status in ('approved', 'rejected') then
      if jwt_role not in ('hod', 'admin', 'super_admin') then
        raise exception 'Only HOD or Admin can approve or reject gate passes.';
      end if;
    -- Guard signs off an approved pass (Mark Out / dispatch)
    elsif old.status = 'approved' and new.status in ('dispatched', 'closed', 'awaiting_return') then
      if jwt_role not in ('guard', 'admin', 'super_admin') then
        raise exception 'Only guard can sign off at gate.';
      end if;
    -- Guard marks return on an RGP (Mark In)
    elsif old.status in ('awaiting_return', 'partially_returned') and new.status in ('partially_returned', 'returned', 'closed') then
      if jwt_role not in ('guard', 'admin', 'super_admin') then
        raise exception 'Only guard can mark return at gate.';
      end if;
    -- Auto-close if transitioning from dispatched or returned to closed
    elsif old.status in ('dispatched', 'returned') and new.status = 'closed' then
    -- Admin override
    elsif jwt_role in ('admin', 'super_admin') then
      -- admin can make any transition
    else
      raise exception 'Invalid gate pass status transition: % -> %', old.status, new.status;
    end if;
  end if;

  return new;
end;
$$;

drop trigger if exists gate_passes_update_rules on public.gate_passes;
create trigger gate_passes_update_rules
  before update on public.gate_passes
  for each row execute function public.enforce_gate_pass_update_rules();
