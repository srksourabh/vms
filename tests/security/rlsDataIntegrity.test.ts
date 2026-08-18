// @vitest-environment node
//
// This live integration file does real network I/O (Supabase Storage multipart
// upload included). It must run in the Node environment: under jsdom the
// storage upload's fetch fails ("fetch failed") against the local http stack.
//
// CHECK for goal.md S9 + S10 (🎯, SECURITY BASELINE SEC-1/2/3) — FR ref: NFR-04, FR-CAM-13
//
// These are DENIAL tests: they log in as the WRONG role (or unauthenticated) and
// assert the backend says no. They run against the live Supabase project in .env,
// using the seeded demo users (scripts/seed.ts, password demo123). Fixtures are
// created via the service-role client in beforeAll and removed in afterAll.
//
// This file covers server-authoritative data, photo privacy, and blanket RLS
// coverage. Role-enforcement tests (staff/guard/HOD) live in rls.test.ts — each
// file owns its own fixtures since vi/beforeAll state cannot be shared across
// test files.
//
// Enforcement under test:
//   008 — server authority: immutable ref/created_at, server-clock
//         check-in/out, status state machine, dept-scoped reads/inserts
import 'dotenv/config';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

const URL = process.env.VITE_SUPABASE_URL!;
const ANON = process.env.VITE_SUPABASE_ANON_KEY!;
const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const PASS = 'demo123';
const REF_RE = /^VIS-\d{8}-\d{4}$/;

if (!URL || !ANON || !SERVICE) {
  throw new Error('rlsDataIntegrity.test.ts requires VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY in .env');
}

const noSession = { auth: { autoRefreshToken: false, persistSession: false } };
const svc = createClient(URL, SERVICE, noSession);

async function login(email: string): Promise<SupabaseClient> {
  const c = createClient(URL, ANON, noSession);
  const { error } = await c.auth.signInWithPassword({ email, password: PASS });
  if (error) throw new Error(`login ${email}: ${error.message}`);
  return c;
}

// role clients + fixtures
let guard: SupabaseClient;
let anon: SupabaseClient; // never signed in
let itDept = '';
let hodItId = '';
let visitorId = '';
// fixture visits (all IT department): see beforeAll
let vDeny = '', vApproved = '', vCheckedIn = '';
const cleanupVisits: string[] = [];
const cleanupVisitors: string[] = [];
const PROBE_PATH = 'rls-probe/probe.txt';

// Migration 017 forbids a visitor from holding two ACTIVE visits at once. The shared
// fixture visitor deliberately has several, so any test that inserts a visit as a
// normal (non-service) role must use a visitor of its own or it trips that trigger.
let freshVisitorSeq = 0;
async function freshVisitor(): Promise<string> {
  const phone = `99988870${String(freshVisitorSeq++).padStart(2, '0')}`;
  const { data, error } = await svc.from('visitors')
    .upsert({ phone, full_name: `RLS Fresh Visitor ${phone}`, vendor_name: 'TestCo' }, { onConflict: 'phone' })
    .select('id').single();
  if (error) throw error;
  // Clear any active visit left behind by an earlier aborted run.
  await svc.from('visits').delete().eq('visitor_id', data!.id);
  cleanupVisitors.push(data!.id);
  return data!.id;
}

beforeAll(async () => {
  anon = createClient(URL, ANON, noSession);
  guard = await login('guard@demo.vms');

  const { data: depts } = await svc.from('departments').select('id, code').in('code', ['IT', 'HR']);
  itDept = depts!.find((d) => d.code === 'IT')!.id;

  const { data: profs } = await svc.from('profiles').select('id, email').in('email', ['hod.it@demo.vms']);
  hodItId = profs!.find((p) => p.email === 'hod.it@demo.vms')!.id;

  const { data: vis, error: visErr } = await svc.from('visitors')
    .upsert({ phone: '9998887778', full_name: 'RLS Integrity Test Visitor', vendor_name: 'TestCo' }, { onConflict: 'phone' })
    .select().single();
  if (visErr) throw visErr;
  visitorId = vis!.id;

  // Migration 060 pins exactly one checked_in visit per visitor (partial
  // unique index). The demo seed, the guard console, or an aborted run of
  // this very suite can leave an open visit on this phone behind, so the
  // checked_in fixture insert below would trip the constraint. Wipe every
  // open visit for the fixture visitor first — same hygiene freshVisitor()
  // applies to its own rows.
  await svc.from('visits').delete().eq('visitor_id', visitorId);

  // One visit per scenario; insert (trigger sets ref) then service-patch status where needed.
  async function mkVisit(dept: string, status: string): Promise<string> {
    const { data, error } = await svc.from('visits')
      .insert({ visitor_id: visitorId, department_id: dept, host_id: hodItId, purpose: 'meeting', carrying_material: false })
      .select('id').single();
    if (error) throw error;
    if (status !== 'pending_approval') {
      const patch: Record<string, unknown> = { status };
      if (status === 'checked_in') patch.checked_in_at = new Date().toISOString();
      const { error: upErr } = await svc.from('visits').update(patch).eq('id', data!.id);
      if (upErr) throw upErr;
    }
    cleanupVisits.push(data!.id);
    return data!.id;
  }
  // Sequential inserts: the ref-number trigger computes max+1 by reading the
  // table, so parallel inserts race into duplicate refs (memory.md SB-03).
  vDeny = await mkVisit(itDept, 'pending_approval');
  vApproved = await mkVisit(itDept, 'approved');
  vCheckedIn = await mkVisit(itDept, 'checked_in');

  // Storage probe object for S10 (create bucket if the project doesn't have it yet)
  await svc.storage.createBucket('visitor-photos', { public: false }).catch(() => undefined);
  const { error: upErr } = await svc.storage.from('visitor-photos')
    .upload(PROBE_PATH, new Blob(['rls probe — not a real photo']), { upsert: true, contentType: 'text/plain' });
  if (upErr) throw new Error(`probe upload: ${upErr.message}`);
}, 120_000);

afterAll(async () => {
  if (cleanupVisits.length) {
    await svc.from('notifications').delete().in('related_id', cleanupVisits);
    await svc.from('visits').delete().in('id', cleanupVisits);
  }
  if (cleanupVisitors.length) {
    await svc.from('visits').delete().in('visitor_id', cleanupVisitors);
    await svc.from('visitors').delete().in('id', cleanupVisitors).then(() => undefined, () => undefined);
  }
  if (visitorId) await svc.from('visitors').delete().eq('id', visitorId).then(() => undefined, () => undefined);
  await svc.storage.from('visitor-photos').remove([PROBE_PATH]);
  await guard?.auth.signOut();
}, 60_000);

const svcStatus = async (id: string) =>
  (await svc.from('visits').select('status, ref_number, created_at, checked_in_at, rejection_reason').eq('id', id).single()).data!;

// ─────────────────────────────────────────────────────────────────────────────

describe('S9/SEC-3: server-authoritative data', () => {
  it('client-supplied reference numbers are ignored/rejected', async () => {
    const ownVisitor = await freshVisitor();
    const { data: visit, error } = await guard.from('visits')
      .insert({
        visitor_id: ownVisitor, department_id: itDept, host_id: hodItId, purpose: 'other',
        carrying_material: false, ref_number: 'HACK-0001',
      } as never)
      .select('id, ref_number').single();
    expect(error).toBeNull();
    cleanupVisits.push(visit!.id);
    expect(visit!.ref_number).toMatch(REF_RE); // trigger overwrote the client value
    expect(visit!.ref_number).not.toBe('HACK-0001');

    await guard.from('visits').update({ ref_number: 'HACK-0002' } as never).eq('id', visit!.id);
    expect((await svcStatus(visit!.id)).ref_number).toMatch(REF_RE); // immutable on update too
  }, 30_000);

  it('client-supplied timestamps are ignored/rejected', async () => {
    const ownVisitor = await freshVisitor();
    const { data: visit, error } = await guard.from('visits')
      .insert({
        visitor_id: ownVisitor, department_id: itDept, host_id: hodItId, purpose: 'other',
        carrying_material: false, created_at: '2020-01-01T00:00:00Z',
      } as never)
      .select('id, created_at').single();
    expect(error).toBeNull();
    cleanupVisits.push(visit!.id);
    expect(new Date(visit!.created_at).getFullYear()).toBeGreaterThan(2020); // server now()

    await guard.from('visits').update({ created_at: '2020-01-01T00:00:00Z' } as never).eq('id', visit!.id);
    expect(new Date((await svcStatus(visit!.id)).created_at).getFullYear()).toBeGreaterThan(2020);
  }, 30_000);

  it('status transitions violating the state machine are rejected server-side', async () => {
    // approved → checked_out (skipping check-in)
    const { error: skipErr } = await guard.from('visits').update({ status: 'checked_out' }).eq('id', vApproved);
    expect(skipErr).not.toBeNull();
    expect(skipErr!.message).toMatch(/Invalid status transition/i);

    // checked_in → approved (reversal)
    const { error: revErr } = await guard.from('visits').update({ status: 'approved' }).eq('id', vCheckedIn);
    expect(revErr).not.toBeNull();
    expect(revErr!.message).toMatch(/Invalid status transition|Only HOD or Admin/i);
  }, 30_000);
});

describe('S10/SEC-2: photo privacy (FR-CAM-13)', () => {
  it('unauthenticated fetch of a photo URL returns an error (bucket is private)', async () => {
    const res = await fetch(`${URL}/storage/v1/object/public/visitor-photos/${PROBE_PATH}`);
    expect(res.status).not.toBe(200); // 400/403/404 — anything but success
  }, 30_000);

  it('photo access works only via short-lived signed URLs for authorized roles', async () => {
    const { data, error } = await guard.storage.from('visitor-photos').createSignedUrl(PROBE_PATH, 60);
    expect(error).toBeNull();
    const res = await fetch(data!.signedUrl);
    expect(res.status).toBe(200);
  }, 30_000);

  it('anon key CANNOT list the photos bucket', async () => {
    const { data, error } = await anon.storage.from('visitor-photos').list('rls-probe');
    // Either an explicit error or an empty result — never the object listing.
    if (error === null) expect(data ?? []).toHaveLength(0);
    else expect(error).not.toBeNull();
  }, 30_000);
});

describe('SEC-1: RLS coverage', () => {
  const TABLES = ['departments', 'profiles', 'visitors', 'visits', 'gate_passes', 'gate_pass_items', 'notifications'];

  it('no table is readable by the anon role (every policy is to authenticated)', async () => {
    for (const t of TABLES) {
      const { data, error } = await anon.from(t).select('*').limit(1);
      if (error === null) expect(data ?? [], `table ${t} leaked rows to anon`).toHaveLength(0);
    }
  }, 60_000);

  it('anon role cannot write to any table (RLS enabled everywhere)', async () => {
    const { error: e1 } = await anon.from('visitors').insert({ phone: '0000000000', full_name: 'anon hack' });
    expect(e1).not.toBeNull();
    const { error: e2 } = await anon.from('departments').insert({ name: 'anon dept', code: 'ANON' });
    expect(e2).not.toBeNull();
    const { error: e3 } = await anon.from('visits').update({ status: 'approved' }).eq('department_id', itDept);
    // update with no visible rows: either error or silently 0 rows — verify nothing changed
    if (e3 === null) {
      const { data } = await svc.from('visits').select('id').eq('id', vDeny).eq('status', 'pending_approval');
      expect(data).toHaveLength(1);
    }
  }, 60_000);
});
