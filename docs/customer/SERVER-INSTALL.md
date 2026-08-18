# Secure Gate — on-premise server installation

All visitor data stays on this machine. There is no SaaS signup.

## What you are installing

| Piece | What it is | Where it runs |
|---|---|---|
| Postgres + Auth + Storage + Realtime | The database and login | Docker, via `npx supabase start` |
| Secure Gate web app | The product (guard, employee, admin, CEO) | Node, port **5173** |
| Mailpit (demo) or mall SMTP | OTP email | Docker `:54324` / customer relay |
| Windows `SecureGate-Portable.exe` | Thin client + **green light** | Guard / employee PCs |
| Phone PWA | Same app, Add to Home Screen | Staff phones (needs HTTPS) |

The `.exe` does **not** contain the database. Start the server first. The light turns green when `http://SERVER:5173` and Auth both answer.

## Hardware (one server PC)

- 8 GB RAM minimum (16 GB if photos are kept a year)
- 100 GB free disk (Postgres Docker volume + photos)
- UPS and a lockable cabinet
- Windows 11 **or** Ubuntu 22.04+ with Docker
- A static LAN IP, e.g. `192.168.10.10`

## One-time software

1. [Docker Desktop](https://www.docker.com/products/docker-desktop/) (Windows) or Docker Engine (Linux). Leave it running.
2. [Node.js 20 LTS](https://nodejs.org/) (includes `npm` and `npx`).
3. Copy this repository onto the server (USB, git clone, or zip).

```bash
git clone https://github.com/srksourabh/vms.git
cd vms
git checkout cursor/setup-dev-environment-5109   # until this branch is merged to main
```

## First boot (Linux)

```bash
npm install
npx supabase start
node scripts/write-local-env.mjs
npx supabase migration up --local
npm run seed
npm run dev -- --host 0.0.0.0 --port 5173
```

Or: `bash scripts/onprem-up.sh` after Docker is up.

## First boot (Windows server)

1. Open PowerShell **as Administrator** in the repo folder.
2. Run `installer\windows\Start-Server.bat`  
   (or `powershell -File installer\windows\install.ps1`).
3. Wait until the window prints `Local: http://127.0.0.1:5173`.
4. On this PC or a guard PC, double-click **SecureGate-Portable.exe**.
5. Wait for the **green light** → Open Secure Gate → log in.

Build the `.exe` on any PC with Node:

```bash
cd desktop
npm install
npm run pack:win
```

Copy `desktop/dist/SecureGate-Portable.exe` to each guard/employee PC. Optional: compile `installer/windows/SecureGate.iss` in Inno Setup for a Start Menu installer.

## What `supabase start` actually boots

| Port | Service |
|---|---|
| 54321 | API gateway (Auth, PostgREST, Storage, Realtime) |
| 54322 | Postgres (the visitor database) |
| 54323 | Studio (IT only — do not give this to guards) |
| 54324 | Mailpit (demo OTP inbox) |
| 54325 | SMTP catcher feeding Mailpit |
| 5173 | Secure Gate app |

Migrations `000`–`096` apply on first start. If you pull new SQL later:

```bash
npx supabase migration up --local
```

`096` creates the private `visitor-photos` bucket. Without it the UI still works (photo falls back to a column) but files are not stored as objects.

## Write the env file

`node scripts/write-local-env.mjs` copies the **local** anon JWT and service-role JWT from `npx supabase status` into `.env`. Those keys never leave the building. Do not paste hosted-Supabase keys.

For a shift (not a demo), serve the production build:

```bash
npm run build
npx vite preview --host 0.0.0.0 --port 5173
```

Point other PCs at `http://192.168.10.10:5173`. Override the desktop client:

```
SECURE_GATE_URL=http://192.168.10.10:5173
SECURE_GATE_API=http://192.168.10.10:54321/auth/v1/health
```

## Demo logins (change before a real day)

Password for all seed users: `demo123`

| Role | Email |
|---|---|
| Admin | `admin@demo.vms` |
| Employee | `staff.it@demo.vms` |
| Guard | `guard@demo.vms` |
| HOD | `hod.it@demo.vms` |

OTP demo mailbox: `http://SERVER:54324`

## Production mail (OTP)

Replace Mailpit with the mall SMTP in `.env`:

```
SMTP_HOST=mail.questmall.local
SMTP_PORT=587
MAIL_FROM=Secure Gate <noreply@questmall.in>
```

SMS is written to `otp_deliveries`. Wire a GSM/DLT gateway when the customer has a template ID.

## Phones (PWA)

Production builds register `/sw.js`. On **HTTPS** (or localhost) Chrome/Safari offer Add to Home Screen. A raw `http://192.168…` URL will **not** install. Put Caddy or nginx with a mall-internal certificate in front of 5173.

## Backup

Postgres lives in a Docker volume. Nightly:

```bash
docker exec supabase_db_workspace pg_dump -U postgres postgres > /backup/vms-$(date +%F).sql
```

Restore drill: pick a date, restore onto a spare PC, log in as guard, search yesterday’s OTP. Keep the dump off the same disk as Docker.

## Do not

- Run `npx supabase db reset` on a live day (it wipes visits).
- Expose Studio (`:54323`) on the public internet.
- Commit `.env`.
- Expect the `.exe` to start Docker by itself.

## Smoke test after install

1. Green light on the desktop app.
2. Employee `staff.it@demo.vms` pre-registers one visitor → 6-digit OTP.
3. Mailpit (or SMTP) has the mail.
4. Guard searches that OTP on Scan Pass → ID + photo + badge → Check In.
5. Entry & Exit shows them. Return the badge number → checked out.
