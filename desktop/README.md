# Secure Gate desktop (Windows / Linux)

Thin client for the **on-premise** VMS. It does not talk to the public internet.

1. The **server** PC in the mall runs Docker + local Supabase + the web app
   (`installer/windows/Start-Server.bat` or `scripts/onprem-up.sh`).
2. This desktop shell pings that server. A **green light** means the app and
   the database are both answering.
3. The guard or employee clicks **Open Secure Gate** and logs in.

## Run in development

```bash
cd desktop
npm install
npm start
```

Requires the VMS already listening on `http://127.0.0.1:5173` and Supabase on
`http://127.0.0.1:54321`. Override with `SECURE_GATE_URL` / `SECURE_GATE_API`.

## Build the Windows installer

On a Windows PC with Node 20+ and [Inno Setup](https://jrsoftware.org/isinfo.php):

```bash
cd desktop
npm install
npm run pack:win
# then compile installer\windows\SecureGate.iss
```

`pack:win` writes `SecureGate-Portable.exe` (no install — double-click).
The Inno script wraps it as `SecureGate-Setup.exe` with a Start Menu shortcut
and a “Start Secure Gate server” helper.

Linux CI can also emit the same PE32 portable (electron-builder + NSIS
binaries; no Wine required for the portable target). Do not commit the
~67 MB `.exe` — it is a build artifact. Copy it onto guard PCs after
the on-prem server is up; the splash shows a **green light** only when
`http://127.0.0.1:5173` and Auth health both answer.
