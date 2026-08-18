#!/usr/bin/env bash
# Applies hand-authored migrations to the local Supabase DB, in order,
# stopping at the first failure. Optional arg = filename prefix to start from
# (e.g. 018). Used only for local on-prem bootstrap.
set -uo pipefail
START="${1:-000}"
DIR="$(cd "$(dirname "$0")/.." && pwd)/supabase/migrations_all"
CONTAINER="supabase_db_workspace"
for f in "$DIR"/*.sql; do
  base="$(basename "$f")"
  num="${base%%_*}"
  if [[ "$num" < "$START" ]]; then continue; fi
  echo "=== APPLYING $base ==="
  if ! docker exec -i "$CONTAINER" psql -U postgres -d postgres -v ON_ERROR_STOP=1 -q -f - < "$f" 2>&1; then
    echo "!!! FAILED AT $base"
    exit 1
  fi
done
echo "=== ALL MIGRATIONS APPLIED ==="
