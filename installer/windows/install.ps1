#Requires -RunAsAdministrator
<#
  Secure Gate — first-run on a Windows on-prem server.
  1. Checks Docker Desktop is running.
  2. Starts the local Supabase stack (Postgres, Auth, Storage, Realtime).
  3. Serves the built SPA on http://127.0.0.1:5173
  4. The Secure Gate desktop .exe then shows a green light and the login page.

  Run from the installed folder, or:  powershell -File install.ps1
#>
$ErrorActionPreference = 'Stop'
Set-Location (Split-Path -Parent $MyInvocation.MyCommand.Path)
Set-Location ..\..

Write-Host 'Secure Gate — starting on-premise services' -ForegroundColor Yellow

if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
  Write-Host 'Docker Desktop is required. Install it from https://www.docker.com/products/docker-desktop/ then re-run this script.' -ForegroundColor Red
  exit 1
}
docker info | Out-Null

if (-not (Get-Command npx -ErrorAction SilentlyContinue)) {
  Write-Host 'Node.js 20+ is required (includes npx). Install from https://nodejs.org then re-run.' -ForegroundColor Red
  exit 1
}

if (-not (Test-Path .env)) {
  Copy-Item .env.example .env
  Write-Host 'Created .env from .env.example — fill VITE_SUPABASE_URL / keys from npx supabase status' -ForegroundColor Yellow
}

Write-Host 'Starting local Supabase (this keeps ALL visitor data on this machine)…'
npx supabase start

Write-Host 'Installing Node packages…'
npm install

Write-Host 'Seeding demo users (password demo123)…'
npm run seed

Write-Host 'Building the app…'
npm run build

Write-Host 'Serving on http://127.0.0.1:5173'
npx vite preview --host 0.0.0.0 --port 5173
