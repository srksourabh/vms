-- 094 — Visitor OTP (on-prem edition).
--
-- Client requirement: a visitor is identified at the gate by a short OTP that
-- is sent to them (pre-registration) or to the security desk (approved
-- walk-in), not by a QR pass. Every visit gets a 6-digit code the moment it is
-- created; delivery of that code (email + SMS) is recorded in otp_deliveries so
-- an on-prem deployment has an auditable dispatch log even when the SMS gateway
-- is a local appliance. The code is what the guard types at the gate.

-- ── 1. otp_code on every visit, unique among the OPEN visits ────────────────
alter table public.visits add column if not exists otp_code text;
create index if not exists visits_otp_code_idx on public.visits (otp_code);

create or replace function public.generate_otp()
returns text language plpgsql security definer set search_path = '' as $$
declare code text;
begin
  loop
    code := lpad((floor(random() * 1000000))::int::text, 6, '0');
    exit when not exists (
      select 1 from public.visits
      where otp_code = code
        and status in ('pending_approval','approved','walkin_approved','checked_in')
    );
  end loop;
  return code;
end;
$$;

create or replace function public.set_visit_otp()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.otp_code is null then
    new.otp_code := public.generate_otp();
  end if;
  return new;
end;
$$;
drop trigger if exists set_visit_otp_trigger on public.visits;
create trigger set_visit_otp_trigger
  before insert on public.visits
  for each row execute function public.set_visit_otp();

-- ── 2. OTP dispatch log (email + SMS) ───────────────────────────────────────
create table if not exists public.otp_deliveries (
  id         uuid primary key default gen_random_uuid(),
  visit_id   uuid references public.visits(id) on delete cascade,
  audience   text not null check (audience in ('visitor','security')),
  channel    text not null check (channel in ('email','sms')),
  recipient  text not null,
  code       text not null,
  created_at timestamptz not null default now()
);
alter table public.otp_deliveries enable row level security;
drop policy if exists "otp_deliveries read" on public.otp_deliveries;
create policy "otp_deliveries read" on public.otp_deliveries
  for select to authenticated using (true);
-- Writes only ever happen through SECURITY DEFINER functions / service_role;
-- no insert/update/delete policy for authenticated (RLS denies by default).

-- ── 3. pre_register_visitor — pre-approval that mints + dispatches the OTP ───
-- Mirrors pre_approve_visitor_v2 (migration 080) but also captures the
-- visitor's email, records the OTP dispatch, and returns the code so the
-- employee can read it out / the client can trigger the email.
create or replace function public.pre_register_visitor(
  p_phone text, p_full_name text, p_vendor_name text, p_email text,
  p_department_id uuid, p_host_id uuid, p_purpose text,
  p_scheduled_for timestamptz default null,
  p_expected_departure timestamptz default null
) returns json language plpgsql security definer set search_path = '' as $$
declare
  v_visitor_id uuid;
  v_visit_id   uuid;
  v_ref        text;
  v_otp        text;
begin
  insert into public.visitors (phone, full_name, vendor_name, email)
  values (p_phone, p_full_name, nullif(p_vendor_name, ''), nullif(p_email, ''))
  on conflict (phone) do update set
    full_name   = p_full_name,
    vendor_name = coalesce(nullif(p_vendor_name, ''), visitors.vendor_name),
    email       = coalesce(nullif(p_email, ''), visitors.email)
  returning id into v_visitor_id;

  insert into public.visits (
    visitor_id, department_id, host_id, purpose, status,
    carrying_material, scheduled_for, expected_departure, qr_expires_at, invitation_sent_at
  ) values (
    v_visitor_id, p_department_id, p_host_id, p_purpose::public.visitor_purpose,
    'approved', false, p_scheduled_for, p_expected_departure,
    public.vms_day_end_ist(coalesce(p_expected_departure, p_scheduled_for, now())), now()
  )
  returning id, ref_number, otp_code into v_visit_id, v_ref, v_otp;

  -- Row is born approved, so log_visit_approval never fires: name the issuer.
  insert into public.audit_logs (user_id, action, entity_type, entity_id, details)
  values (auth.uid(), 'visit_approved', 'visit', v_visit_id,
    jsonb_build_object('ref_number', v_ref, 'status', 'approved', 'pre_approval', true));

  -- Record the OTP dispatch to the visitor (email if we have one, always SMS).
  if nullif(p_email, '') is not null then
    insert into public.otp_deliveries (visit_id, audience, channel, recipient, code)
    values (v_visit_id, 'visitor', 'email', p_email, v_otp);
  end if;
  insert into public.otp_deliveries (visit_id, audience, channel, recipient, code)
  values (v_visit_id, 'visitor', 'sms', p_phone, v_otp);

  return json_build_object('ref_number', v_ref, 'otp_code', v_otp, 'visit_id', v_visit_id);
end;
$$;
revoke execute on function public.pre_register_visitor(text,text,text,text,uuid,uuid,text,timestamptz,timestamptz) from public, anon;
grant  execute on function public.pre_register_visitor(text,text,text,text,uuid,uuid,text,timestamptz,timestamptz) to authenticated, service_role, postgres;

-- ── 4. Walk-in approval dispatches the OTP to the SECURITY desk ─────────────
-- When an employee approves a walk-in (pending_approval -> walkin_approved),
-- the OTP that was minted at registration is dispatched to security and every
-- guard is notified with the code, so the guard can enter it at the gate.
create or replace function public.deliver_walkin_otp()
returns trigger language plpgsql security definer set search_path = '' as $$
declare g record;
begin
  if new.status = 'walkin_approved' and old.status = 'pending_approval'
     and new.otp_code is not null then
    insert into public.otp_deliveries (visit_id, audience, channel, recipient, code)
    values (new.id, 'security', 'email', 'security-gate', new.otp_code);
    for g in select id from public.profiles where role = 'guard' loop
      insert into public.notifications (recipient_id, type, title, body, related_id)
      values (g.id, 'visit_approved',
        'Walk-in approved — OTP ' || new.otp_code,
        'A walk-in was approved. Enter OTP ' || new.otp_code || ' at the gate to check the visitor in.',
        new.id);
    end loop;
  end if;
  return new;
end;
$$;
drop trigger if exists deliver_walkin_otp_trigger on public.visits;
create trigger deliver_walkin_otp_trigger
  after update on public.visits
  for each row execute function public.deliver_walkin_otp();
