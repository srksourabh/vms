-- 095 — pre_approve_visitor_v2 mints + dispatches the visitor OTP.
--
-- Builds on 094 (every visit already gets an otp_code from set_visit_otp). Here
-- pre_approve_visitor_v2 gains an optional trailing p_email, returns the code so
-- the employee can read it out and the client can email it, and records the
-- dispatch in otp_deliveries. The unified OTP path replaces the standalone
-- pre_register_visitor helper from 094, which is dropped.
--
-- Signature change (added p_email) requires DROP + CREATE — an overload would
-- make PostgREST refuse the call as ambiguous (CLAUDE.md recurring trap), and a
-- DROP resets the ACL, so grants are restated. Calls that omit p_email resolve
-- to this single function via the DEFAULT.
drop function if exists public.pre_register_visitor(text,text,text,text,uuid,uuid,text,timestamptz,timestamptz);
drop function if exists public.pre_approve_visitor_v2(text,text,text,uuid,uuid,text,timestamptz,timestamptz);

create function public.pre_approve_visitor_v2(
  p_phone text, p_full_name text, p_vendor_name text,
  p_department_id uuid, p_host_id uuid, p_purpose text,
  p_scheduled_for timestamptz default null,
  p_expected_departure timestamptz default null,
  p_email text default null
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

  -- Record the OTP dispatch to the visitor (email when known, always SMS).
  if nullif(p_email, '') is not null then
    insert into public.otp_deliveries (visit_id, audience, channel, recipient, code)
    values (v_visit_id, 'visitor', 'email', p_email, v_otp);
  end if;
  insert into public.otp_deliveries (visit_id, audience, channel, recipient, code)
  values (v_visit_id, 'visitor', 'sms', p_phone, v_otp);

  return json_build_object('ref_number', v_ref, 'otp_code', v_otp);
end;
$$;

revoke execute on function public.pre_approve_visitor_v2(text,text,text,uuid,uuid,text,timestamptz,timestamptz,text) from public, anon;
grant  execute on function public.pre_approve_visitor_v2(text,text,text,uuid,uuid,text,timestamptz,timestamptz,text) to authenticated, service_role, postgres;
