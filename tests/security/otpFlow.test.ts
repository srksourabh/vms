// Integration test for the on-prem OTP visitor flow (migrations 094/095).
//
// Runs against the LOCAL self-hosted Supabase in .env, using the seeded demo
// users (scripts/seed.ts, password demo123) — the same pattern as rls.test.ts.
// It exercises real RLS, the OTP triggers and the SECURITY DEFINER RPCs end to
// end: employee pre-registration -> OTP + dispatch log, guard OTP lookup +
// check-in/out with a badge, and walk-in approval dispatching the OTP to
// security + notifying guards. Part of `npm test`, not the offline `npm run
// check` (it needs the running stack).
import 'dotenv/config';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

const URL = process.env.VITE_SUPABASE_URL!;
const ANON = process.env.VITE_SUPABASE_ANON_KEY!;
const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const PASS = 'demo123';

if (!URL || !ANON || !SERVICE) {
  throw new Error('otpFlow.test.ts requires VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY in .env');
}

const noSession = { auth: { autoRefreshToken: false, persistSession: false } };
const svc = createClient(URL, SERVICE, noSession);

async function login(email: string): Promise<SupabaseClient> {
  const c = createClient(URL, ANON, noSession);
  const { error } = await c.auth.signInWithPassword({ email, password: PASS });
  if (error) throw new Error(`login ${email}: ${error.message}`);
  return c;
}

const cleanupVisits: string[] = [];
const cleanupVisitors: string[] = [];
let staff: SupabaseClient, guard: SupabaseClient, hod: SupabaseClient;
let staffId = '', staffDept = '';

beforeAll(async () => {
  staff = await login('staff.it@demo.vms');
  guard = await login('guard@demo.vms');
  hod = await login('hod.it@demo.vms');
  const { data } = await staff.auth.getUser();
  staffId = data.user!.id;
  staffDept = (data.user!.app_metadata as any).department_id;
});

afterAll(async () => {
  for (const id of cleanupVisits) await svc.from('visits').delete().eq('id', id);
  for (const id of cleanupVisitors) await svc.from('visitors').delete().eq('id', id);
});

const uniquePhone = () => '9' + Math.floor(100000000 + Math.random() * 899999999);

describe('OTP flow — pre-registration', () => {
  it('an employee pre-registers a visitor and gets an OTP that is logged for email + SMS', async () => {
    const phone = uniquePhone();
    const { data, error } = await staff.rpc('pre_approve_visitor_v2', {
      p_phone: phone, p_full_name: 'OTP Flow Visitor', p_vendor_name: 'Acme',
      p_department_id: staffDept, p_host_id: staffId, p_purpose: 'meeting',
      p_scheduled_for: new Date(Date.now() + 2 * 3600e3).toISOString(),
      p_email: 'otpflow@example.com',
    });
    expect(error).toBeNull();
    expect(data.ref_number).toMatch(/^VIS-\d{8}-\d{4}$/);
    expect(data.otp_code).toMatch(/^\d{6}$/);

    const { data: visit } = await svc.from('visits').select('id, otp_code').eq('ref_number', data.ref_number).single();
    cleanupVisits.push(visit!.id);
    const { data: vr } = await svc.from('visitors').select('id').eq('phone', phone).single();
    cleanupVisitors.push(vr!.id);

    const { data: deliveries } = await svc.from('otp_deliveries').select('audience, channel, recipient, code').eq('visit_id', visit!.id);
    const channels = (deliveries ?? []).map((d) => d.channel).sort();
    expect(channels).toEqual(['email', 'sms']);
    for (const d of deliveries ?? []) {
      expect(d.audience).toBe('visitor');
      expect(d.code).toBe(data.otp_code);
    }
  });
});

describe('OTP flow — guard gate check-in / check-out by OTP + badge', () => {
  it('a guard finds the visit by OTP, checks in with a badge, and checks out (badge freed)', async () => {
    const phone = uniquePhone();
    const { data: pre } = await staff.rpc('pre_approve_visitor_v2', {
      p_phone: phone, p_full_name: 'Gate OTP Visitor', p_vendor_name: 'Beta',
      p_department_id: staffDept, p_host_id: staffId, p_purpose: 'meeting',
      p_scheduled_for: new Date().toISOString(), p_email: null,
    });
    const otp = pre.otp_code as string;

    // Guard finds the visit purely by OTP (what they type at the gate).
    const { data: found, error: findErr } = await guard.from('visits')
      .select('id, status, visitor:visitors(id, full_name)').eq('otp_code', otp).single();
    expect(findErr).toBeNull();
    expect(found!.status).toBe('approved');
    cleanupVisits.push(found!.id);
    cleanupVisitors.push((found!.visitor as any).id);

    const badge = 'B-' + Math.floor(100 + Math.random() * 899);
    const { error: ciErr } = await guard.from('visits').update({
      status: 'checked_in', checked_in_at: new Date().toISOString(), visitor_card_number: badge,
    }).eq('id', found!.id);
    expect(ciErr).toBeNull();

    const { data: inside } = await svc.from('visits').select('status, visitor_card_number').eq('id', found!.id).single();
    expect(inside!.status).toBe('checked_in');
    expect(inside!.visitor_card_number).toBe(badge);

    const { error: coErr } = await guard.from('visits').update({
      status: 'checked_out', checked_out_at: new Date().toISOString(),
      exit_verified: true, visitor_card_returned_at: new Date().toISOString(),
    }).eq('id', found!.id);
    expect(coErr).toBeNull();

    const { data: out } = await svc.from('visits').select('status, visitor_card_returned_at').eq('id', found!.id).single();
    expect(out!.status).toBe('checked_out');
    expect(out!.visitor_card_returned_at).not.toBeNull();
  });
});

describe('OTP flow — walk-in approval dispatches the OTP to security', () => {
  it('approving a walk-in delivers the OTP to security and notifies a guard', async () => {
    const phone = uniquePhone();
    const { data: vr } = await svc.from('visitors').insert({ phone, full_name: 'Walkin OTP' }).select('id').single();
    cleanupVisitors.push(vr!.id);
    const { data: wv } = await svc.from('visits').insert({
      visitor_id: vr!.id, department_id: staffDept, host_id: staffId,
      purpose: 'vendor', status: 'pending_approval',
    }).select('id, otp_code').single();
    cleanupVisits.push(wv!.id);
    expect(wv!.otp_code).toMatch(/^\d{6}$/);

    const { error: apErr } = await hod.rpc('approve_visit', { visit_id: wv!.id });
    expect(apErr).toBeNull();

    const { data: after } = await svc.from('visits').select('status').eq('id', wv!.id).single();
    expect(after!.status).toBe('walkin_approved');

    const { data: sec } = await svc.from('otp_deliveries').select('code').eq('visit_id', wv!.id).eq('audience', 'security');
    expect(sec!.length).toBe(1);
    expect(sec![0].code).toBe(wv!.otp_code);

    const { data: notifs } = await svc.from('notifications').select('recipient_id, title')
      .eq('related_id', wv!.id).like('title', 'Walk-in approved%');
    expect(notifs!.length).toBeGreaterThanOrEqual(1);
    const { data: guardProfile } = await svc.from('profiles').select('id').eq('id', notifs![0].recipient_id).eq('role', 'guard').maybeSingle();
    expect(guardProfile).not.toBeNull();
  });
});
