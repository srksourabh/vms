#!/usr/bin/env bash
# Start the on-prem VMS on this machine (Docker + local Supabase + Vite).
# Visitor data never leaves the box.
set -euo pipefail
cd "$(dirname "$0")/.."
if ! docker info >/dev/null 2>&1; then
  echo "Docker is not running. Start the daemon first." >&2
  exit 1
fi
npx supabase start
if [ ! -f .env ]; then
  echo "Missing .env — copy values from: npx supabase status" >&2
  exit 1
fi
npm run seed
exec npm run dev -- --host 0.0.0.0 --port 5173
