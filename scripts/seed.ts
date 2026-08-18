/**
 * VMS Demo Seed Script — S14 / goal.md §2.2
 *
 * Creates 3 departments, HODs + delegates, a guard, an admin, and sample
 * visits in every status so the demo has realistic data.
 *
 * The material-pass module (public.gate_passes / gate_pass_items) has no UI in
 * this app — it moved to the separate GatePass app (gatepass schema). The
 * tables stay in the shared project for the RLS/realtime security tests, but
 * this seed no longer plants demo rows in them (the old "Gate passes" section
 * was removed 2026-08-08: rows no screen reads).
 *
 * Usage:
 *   cp .env.example .env          # fill VITE_SUPABASE_URL + SERVICE_ROLE_KEY
 *   npm run seed
 *
 * Requires: VITE_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in .env
 * The service-role key is NEVER bundled into the client (see .env.example).
 */

import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
import type { Database } from '../src/types/index.js';

const SUPABASE_URL          = process.env.VITE_SUPABASE_URL!;
const SUPABASE_SERVICE_KEY  = process.env.SUPABASE_SERVICE_ROLE_KEY!;

if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  console.error('ERROR: Missing VITE_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in .env');
  process.exit(1);
}

// Service-role client — used ONLY in this server-side script, never bundled to client.
const admin = createClient<Database>(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

// ── Helpers ──────────────────────────────────────────────────────────────────

async function createUser(email: string, password: string, fullName: string) {
  const { data, error } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: { full_name: fullName },
  });
  if (error) {
    // If user already exists, fetch it and RESET its password to the seed value.
    // Without the reset, re-seeding a project that already has the demo users leaves
    // whatever password they were first created with. That silently breaks every
    // consumer that assumes the documented demo123 — notably tests/security/rls.test.ts,
    // which then fails with a misleading "Invalid login credentials".
    if (error.message?.includes('already')) {
      const { data: list } = await admin.auth.admin.listUsers({ perPage: 1000 });
      const existing = list?.users.find((u) => u.email === email) ?? null;
      if (existing) {
        const { error: pwErr } = await admin.auth.admin.updateUserById(existing.id, {
          password,
          email_confirm: true,
          user_metadata: { full_name: fullName },
        });
        if (pwErr) throw new Error(`resetPassword ${email}: ${pwErr.message}`);
      }
      return existing;
    }
    throw new Error(`createUser ${email}: ${error.message}`);
  }
  return data.user;
}

function ok(label: string, error: { message?: string } | null) {
  if (error) throw new Error(`${label}: ${error.message}`);
  console.log(`  ✓ ${label}`);
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function seed() {
  console.log('\n🌱  VMS Demo Seed\n');

  // ── 1. Departments ──
  console.log('── Departments');
  const deptData = [
    { name: 'Information Technology', code: 'IT'  },
    { name: 'Human Resources',        code: 'HR'  },
    { name: 'Finance & Accounts',     code: 'FIN' },
  ];
  const { data: depts, error: deptErr } = await admin
    .from('departments')
    .upsert(deptData, { onConflict: 'code' })
    .select();
  ok('departments upserted', deptErr);
  const dept = Object.fromEntries((depts ?? []).map((d) => [d.code, d]));
  console.log('  dept IDs:', Object.keys(dept).map((k) => `${k}=${dept[k]?.id?.slice(0, 8)}`).join(', '));

  // ── 2. Auth users ──
  console.log('\n── Auth users');
  const PASS = 'demo123'; // same password for all demo users (VMS + gatepass share this auth project)
  const users: Record<string, { id: string; email: string }> = {};

  const specs = [
    { key: 'guard1',       email: 'guard@demo.vms',       name: 'Arjun Mehta'    },
    { key: 'hod_it',       email: 'hod.it@demo.vms',      name: 'Priya Sharma'   },
    { key: 'hod_hr',       email: 'hod.hr@demo.vms',      name: 'Ravi Kumar'     },
    { key: 'hod_fin',      email: 'hod.fin@demo.vms',     name: 'Meena Patel'    },
    { key: 'delegate_it',  email: 'delegate.it@demo.vms', name: 'Sanjay Gupta'   },
    { key: 'staff1',       email: 'staff@demo.vms',       name: 'Ananya Nair'    },
    { key: 'admin1',       email: 'admin@demo.vms',       name: 'Vikram Singh'   },
    // Additional approvers & staff per department
    { key: 'hod2_it',      email: 'hod2.it@demo.vms',     name: 'Vikram Patel'   },
    { key: 'staff_it',     email: 'staff.it@demo.vms',    name: 'Neha Gupta'     },
    { key: 'hod2_hr',      email: 'hod2.hr@demo.vms',     name: 'Suresh Reddy'   },
    { key: 'staff_hr',     email: 'staff.hr@demo.vms',    name: 'Pooja Sharma'   },
    { key: 'hod2_fin',     email: 'hod2.fin@demo.vms',    name: 'Arun Kumar'     },
    { key: 'staff_fin',    email: 'staff.fin@demo.vms',   name: 'Divya Singh'    },
    { key: 'dummy_admin',  email: 'dummy.admin@demo.vms', name: 'Dummy Admin'    },
    { key: 'dummy_emp',    email: 'dummy.emp@demo.vms',   name: 'Dummy Employee' },
    { key: 'dummy_guard',  email: 'dummy.guard@demo.vms', name: 'Dummy Guard'    },
  ];

  for (const s of specs) {
    const u = await createUser(s.email, PASS, s.name);
    if (!u) throw new Error(`Could not create/find user ${s.email}`);
    users[s.key] = { id: u.id, email: u.email ?? s.email };
    console.log(`  ✓ ${s.key} (${u.id.slice(0, 8)})`);
  }

  // ── 3. Profiles — set roles and departments ──
  console.log('\n── Profiles');
  // Small delay to let auth trigger create stub profiles
  await new Promise((r) => setTimeout(r, 1500));

  const profileUpdates = [
    { id: users['guard1']!.id,      role: 'guard'       as const, department_id: null               },
    { id: users['hod_it']!.id,      role: 'hod'         as const, department_id: dept['IT']?.id ?? null  },
    { id: users['hod_hr']!.id,      role: 'hod'         as const, department_id: dept['HR']?.id ?? null  },
    { id: users['hod_fin']!.id,     role: 'hod'         as const, department_id: dept['FIN']?.id ?? null },
    { id: users['delegate_it']!.id, role: 'staff'       as const, department_id: dept['IT']?.id ?? null  },
    { id: users['staff1']!.id,      role: 'staff'       as const, department_id: dept['HR']?.id ?? null  },
    { id: users['admin1']!.id,      role: 'admin'       as const, department_id: null               },
    { id: users['hod2_it']!.id,     role: 'hod'         as const, department_id: dept['IT']?.id ?? null  },
    { id: users['staff_it']!.id,    role: 'staff'       as const, department_id: dept['IT']?.id ?? null  },
    { id: users['hod2_hr']!.id,     role: 'hod'         as const, department_id: dept['HR']?.id ?? null  },
    { id: users['staff_hr']!.id,    role: 'staff'       as const, department_id: dept['HR']?.id ?? null  },
    { id: users['hod2_fin']!.id,    role: 'hod'         as const, department_id: dept['FIN']?.id ?? null },
    { id: users['staff_fin']!.id,   role: 'staff'       as const, department_id: dept['FIN']?.id ?? null },
    { id: users['dummy_admin']!.id, role: 'admin'       as const, department_id: null               },
    { id: users['dummy_emp']!.id,   role: 'staff'       as const, department_id: dept['IT']?.id ?? null  },
    { id: users['dummy_guard']!.id, role: 'guard'       as const, department_id: null               },
  ];

  for (const up of profileUpdates) {
    const { error } = await admin.from('profiles').update(up).eq('id', up.id);
    ok(`profile ${up.id.slice(0, 8)} → ${up.role}`, error);
  }

  // Set IT HOD's delegate
  const { error: delErr } = await admin
    .from('profiles')
    .update({ delegate_id: users['delegate_it']!.id })
    .eq('id', users['hod_it']!.id);
  ok('delegate_it set for hod_it', delErr);

  // ── 4. Visitors ──
  console.log('\n── Visitors');
  const visitorRows = [
    { phone: '9876543210', full_name: 'Rohan Desai',      vendor_name: 'TechSoft Pvt Ltd',  id_type: 'Aadhar', id_last4: '4321', is_blacklisted: false },
    { phone: '9123456789', full_name: 'Kavita Joshi',     vendor_name: 'VendorCo',           id_type: 'PAN',    id_last4: '6789', is_blacklisted: false },
    { phone: '9988776655', full_name: 'Mohan Das',        vendor_name: null,                 id_type: 'DL',     id_last4: '9900', is_blacklisted: false },
    { phone: '9000000001', full_name: 'Blacklisted User', vendor_name: null,                 id_type: null,     id_last4: null,   is_blacklisted: true, blacklist_reason: 'Theft incident on 2025-01-10' },
  ];
  const { data: visitors, error: visErr } = await admin
    .from('visitors')
    .upsert(visitorRows, { onConflict: 'phone' })
    .select();
  ok('visitors upserted', visErr);
  const vis = visitors ?? [];

  // ── 5. Visits ──
  console.log('\n── Visits');
  const itDeptId  = dept['IT']?.id!;
  const hrDeptId  = dept['HR']?.id!;
  const finDeptId = dept['FIN']?.id!;

  const visitRows = [
    // checked_in — show someone inside right now
    {
      visitor_id:   vis[0]?.id!,
      department_id: itDeptId,
      host_id:       users['hod_it']!.id,
      purpose:       'meeting'      as const,
      status:        'checked_in'   as const,
      checked_in_at: new Date(Date.now() - 30 * 60_000).toISOString(),
      carrying_material: true,
      ref_number:    'SEED-PLACEHOLDER-1', // overwritten by trigger on real insert
    },
    // pending_approval
    {
      visitor_id:   vis[1]?.id!,
      department_id: hrDeptId,
      host_id:       users['hod_hr']!.id,
      purpose:       'vendor'        as const,
      status:        'pending_approval' as const,
      carrying_material: false,
      ref_number:    'SEED-PLACEHOLDER-2',
    },
    // approved (not yet checked in)
    {
      visitor_id:   vis[2]?.id!,
      department_id: finDeptId,
      host_id:       users['hod_fin']!.id,
      purpose:       'delivery'      as const,
      status:        'approved'      as const,
      carrying_material: false,
      ref_number:    'SEED-PLACEHOLDER-3',
    },
    // checked_out
    {
      visitor_id:   vis[0]?.id!,
      department_id: itDeptId,
      host_id:       users['hod_it']!.id,
      purpose:       'audit'         as const,
      status:        'checked_out'   as const,
      checked_in_at:  new Date(Date.now() - 3 * 3600_000).toISOString(),
      checked_out_at: new Date(Date.now() - 2 * 3600_000).toISOString(),
      exit_verified:  true,
      carrying_material: false,
      ref_number:    'SEED-PLACEHOLDER-4',
    },
    // rejected
    {
      visitor_id:   vis[1]?.id!,
      department_id: itDeptId,
      host_id:       users['hod_it']!.id,
      purpose:       'other'         as const,
      status:        'rejected'      as const,
      rejection_reason: 'Not expected today.',
      carrying_material: false,
      ref_number:    'SEED-PLACEHOLDER-5',
    },
  ];

  // Insert one by one so triggers fire per row (generates real ref_number)
  const visitIds: string[] = [];
  for (const v of visitRows) {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { ref_number, ...insertRow } = v;
    const { data, error } = await admin.from('visits').insert(insertRow).select('id, ref_number').single();
    if (error) { console.error('  ✗ visit insert:', error.message); continue; }
    // Update status + timestamps (trigger sets ref_number + created_at; we patch status)
    if (v.status !== 'pending_approval') {
      await admin.from('visits').update({
        status:          v.status,
        checked_in_at:   v.checked_in_at ?? null,
        checked_out_at:  (v as { checked_out_at?: string }).checked_out_at ?? null,
        exit_verified:   (v as { exit_verified?: boolean }).exit_verified ?? null,
        rejection_reason:(v as { rejection_reason?: string }).rejection_reason ?? null,
      }).eq('id', data.id);
    }
    visitIds.push(data.id);
    console.log(`  ✓ visit ${data.ref_number}`);
  }

  // ── 6. Pre-registered visitors with OTP (same RPC the employee UI calls) ──
  console.log('\n── Pre-registered visitors (OTP ready for the gate)');
  const itDept = dept['IT']?.id;
  const preRegs = [
    { phone: '9700000011', name: 'Anita Rao',   vendor: 'Globex',  email: 'anita.demo@example.com' },
    { phone: '9700000012', name: 'Sameer Khan', vendor: 'Initech', email: 'sameer.demo@example.com' },
  ];
  for (const p of preRegs) {
    const { data, error } = await admin.rpc('pre_approve_visitor_v2', {
      p_phone: p.phone, p_full_name: p.name, p_vendor_name: p.vendor,
      p_department_id: itDept, p_host_id: users['staff_it']!.id, p_purpose: 'meeting',
      p_scheduled_for: new Date(Date.now() + 60 * 60_000).toISOString(), p_email: p.email,
    });
    if (error) { console.error(`  ✗ pre-reg ${p.name}: ${error.message}`); continue; }
    const res = data as { otp_code: string; ref_number: string };
    console.log(`  ✓ ${p.name.padEnd(16)} OTP ${res.otp_code}  (${res.ref_number})`);
  }

  // ── Done ──
  console.log('\n════════════════════════════════');
  console.log('✅  Seed complete.\n');
  console.log('Demo user credentials (all use password: demo123):');
  console.log(`  Guard:         guard@demo.vms`);
  console.log(`  HOD (IT):      hod.it@demo.vms, hod2.it@demo.vms`);
  console.log(`  HOD (HR):      hod.hr@demo.vms, hod2.hr@demo.vms`);
  console.log(`  HOD (FIN):     hod.fin@demo.vms, hod2.fin@demo.vms`);
  console.log(`  Admin:         admin@demo.vms`);
  console.log(`  Staff:         staff.it@demo.vms (an employee who pre-registers visitors)`);
  console.log(`  Dummy set:     dummy.admin@demo.vms · dummy.emp@demo.vms · dummy.guard@demo.vms`);
  console.log('\nGate demo: log in as the guard, open Scan Pass, and enter one of the OTPs printed above.');
  console.log('════════════════════════════════\n');
}

seed().catch((err) => {
  console.error('\n💥  Seed failed:', err);
  process.exit(1);
});
