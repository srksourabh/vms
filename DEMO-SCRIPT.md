# DEMO-SCRIPT.md — VMS Customer Demo
### Visitor & Material Gate Pass Management System

> **Who runs this**: the salesperson / engineer showing the product.
> **Time needed**: ~12 minutes for the full happy path.
> **Reset command**: `npm run seed` (restores clean demo data in ~15 s).
> **On-prem local host**: `npx supabase start` then `npm run seed` then `npm run dev -- --host 0.0.0.0 --port 5173`. Slide deck: `docs/customer/presentation.html`.

---

## On-prem OTP happy path (the delivery demo)

All passwords: `demo123`. App: http://localhost:5173

1. **Employee books.** Sign in as `staff.it@demo.vms`. Click **+ Pre-Register a Visitor**. Name, 10-digit mobile, vendor, email, schedule (OK on the datetime field). Submit. Read the 6-digit OTP out loud. Mailpit at http://127.0.0.1:54324 has the same email.
2. **Visitor arrives.** They tell the guard the OTP. No app on the visitor's phone is required.
3. **Security formalities.** Sign in as `guard@demo.vms`. **Scan Pass** → type the OTP → Search. Confirm host and department.
4. **Badge.** Check In → Scan ID (camera, or **Enter details from the card** if OCR/camera fails) → photo (camera or **upload from device**) → type badge e.g. `B-218` → Check In.
5. **Visitor entering.** Status is checked in. **Entry & Exit** shows them under Checked In.
6. **Return.** Type `B-218` in **Return a badge**. Tick “card collected”. Complete check-out. The number is free to issue again.

Walk-in variant: guard **Register Walk-in** → HOD `hod.it@demo.vms` approves on Overview → OTP is mailed to security → same gate steps from 3.

---

## Pre-Demo Setup (do before the customer arrives)

### 1. Configure Supabase
1. Create a project at [supabase.com](https://supabase.com) (free tier works).
2. Run migrations in the SQL editor:
   ```
   supabase/migrations/001_schema.sql   -- tables + triggers
   supabase/migrations/002_rls.sql      -- RLS policies
   ```
3. In **Storage → Buckets**, create a bucket named `visitor-photos`, set to **Private**.
4. Copy your project URL and anon key into `.env`:
   ```
   VITE_SUPABASE_URL=https://<project>.supabase.co
   VITE_SUPABASE_ANON_KEY=<anon-key>
   SUPABASE_SERVICE_ROLE_KEY=<service-role-key>   # seed script only
   ```

### 2. Seed demo data
```bash
npm run seed
```
This creates 3 departments, 7 users (with roles), and sample visits in every status.
(Material gate passes moved to the separate GatePass app — the seed no longer
plants rows in `public.gate_passes`.)

### 3. Start the app
```bash
npm run dev
```
The app runs at http://localhost:5173

### 4. Pre-open browser tabs (same machine or two separate devices)

| Tab | URL | Logged in as |
|-----|-----|--------------|
| **Guard Console** | http://localhost:5173/guard | guard@demo.vms |
| **HOD Phone** | http://localhost:5173/approvals | hod.it@demo.vms |
| **Who's Inside** | http://localhost:5173/whos-inside | guard@demo.vms (second window) |

> Tip: put the HOD tab on your phone / tablet via the local network IP to make the mobile experience obvious.

---

## Demo Flow — Step by Step

### Act 1 — Visitor Registration (Guard perspective)
*Tab: Guard Console, logged in as guard@demo.vms / demo123*

1. **Show the guard console** — point out the three tabs: Active Visits, Register, Exit Log.
2. Click **Register New Visitor**.
3. Enter phone number: `9876543210` → press Tab.
   - ✨ **Repeat-visitor recall fires**: name "Rohan Desai" and company "TechSoft Pvt Ltd" auto-fill.
   - Say: *"The guard never re-types a returning visitor's details."*
4. Select **Department**: Information Technology.
5. Select **Host**: Priya Sharma (hod.it).
6. Select **Purpose**: Meeting.
7. In the **Photo** section, click **Open Camera** → position face in the oval → click **Capture**.
   - Click **Retake** once to show it's unlimited — then capture again.
8. Tick **Carrying material**.
9. Click **Register Visitor**.
   - ✨ A `VIS-YYYYMMDD-NNNN` reference number is generated instantly by the server.
   - *"That reference number is generated server-side — the guard can't edit it."*

---

### Act 2 — HOD Approval (HOD phone view)
*Tab: HOD Approvals, logged in as hod.it@demo.vms / demo123*

10. Switch to the HOD tab (or hand the customer the phone).
    - ✨ **Notification badge appears** — the pending visit is already there.
11. Click the pending visit card.
    - ✨ The **visitor's photo** is visible to the HOD (signed URL, private bucket).
    - SLA countdown timer shows how long the HOD has.
12. Click **Approve**.

---

### Act 3 — Live "Who's Inside" Board
*Tab: Who's Inside board (second window)*

13. Switch to the Who's Inside tab.
    - ✨ **Rohan Desai appears instantly** — Supabase Realtime, no page reload.
    - *"On demo day we put this on the lobby screen."*

---

### Act 4 — Badge & Check-In
*Tab: Guard Console*

14. Back on the Guard Console → Active Visits tab.
    - ✨ The visit card shows **Approved** status (realtime update, no reload).
15. Click **Check In** to log entry.
16. Click **Print Badge** → show the badge: photo, ref number, department, host, QR stub.
    - *"This goes on a lanyard. Thermal-print compatible."*

---

### Act 5 — Exit
17. Click **Exit** on the same visit → visit moves to Checked Out.
18. Switch to Who's Inside board — Rohan Desai disappears. ✨

---

### Act 6 — Gate Pass (Material Movement)
*Tab: Gate Passes, logged in as guard@demo.vms*

19. Navigate to **Gate Passes** → click **New Gate Pass**.
20. Select: Type = **RGP** (Returnable), Direction = **OUT**, Department = IT.
21. Fill in: Reason = "Laptop sent for repair", Carrier = "Rohan Desai".
22. Set expected return date (tomorrow's date).
23. Add an item: Description = "Dell Laptop", Qty = 1, Serial = "DL-XPS-00123".
24. Submit → ✨ `GP-OUT-YYYYMMDD-NNNN` generated server-side.
25. HOD approves it on the Approvals screen (same flow as visitor).
26. Guard dispatches at gate — status → Dispatched → Awaiting Return.

---

### Act 7 — RGP Overdue Dashboard
27. Navigate to **Gate Passes** → filter **Open RGP**.
    - ✨ The seeded overdue pass shows **red border** and "overdue" badge.
    - *"The system tracks every returnable item until it comes back."*

---

### Act 8 — Reports
28. Navigate to **Reports**.
    - ✨ **Daily Visitor Register** — all today's visits in a table (replaces the paper book).
    - Click **Print Register** to show print preview.
    - Scroll down — **Open Returnables** list with color-coded due dates.

---

### Act 9 — Admin Panel (if time allows)
*Log in as admin@demo.vms / demo123*

29. Navigate to **Admin Panel** → Departments tab → add a new department.
30. Users tab → change a user's role via dropdown.
31. Blacklist tab → show the pre-seeded blacklisted entry.

---

## Blacklist Demo (bonus — 30 seconds)
*Guard Console → Register New Visitor*

- Enter phone `9000000001` → system immediately flags **"BLACKLISTED"** with the reason.
- Registration is blocked. *"No blacklisted person can slip through."*

---

## Reset Between Runs
```bash
# Wipe visits/passes from today and re-seed:
npm run seed
```
> Note: seed uses `upsert`, so it's safe to run multiple times. Auth users are re-used across runs.

---

## Credentials Cheat Sheet

| Role | Email | Password |
|------|-------|----------|
| Guard | guard@demo.vms | demo123 |
| HOD (IT) | hod.it@demo.vms | demo123 |
| HOD (HR) | hod.hr@demo.vms | demo123 |
| HOD (Finance) | hod.fin@demo.vms | demo123 |
| Staff | staff@demo.vms | demo123 |
| Admin | admin@demo.vms | demo123 |

---

## Troubleshooting

| Symptom | Fix |
|---------|-----|
| Webcam not working | Use HTTPS or `localhost`; check browser camera permissions |
| HOD not receiving notifications | Confirm HOD's `department_id` matches the visit's department |
| Photos showing 403 | Bucket must be **private**; app uses signed URLs (60-min expiry) |
| Seed fails on users | Ensure `SUPABASE_SERVICE_ROLE_KEY` is set (not the anon key) |
