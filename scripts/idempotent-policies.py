#!/usr/bin/env python3
"""Make every `create policy "NAME" on TABLE` idempotent by inserting a
matching `drop policy if exists "NAME" on TABLE;` immediately before it.

These migrations were hand-applied against a live project over time, so several
later "drift reconciliation" files re-create policies an earlier file already
made. On a clean sequential apply (supabase db reset / on-prem supabase start)
that raises "policy ... already exists" (SQLSTATE 42710). Prefixing each create
with a conditional drop makes the whole set replayable on a fresh database.
Idempotent itself: skips inserting a drop when one already immediately precedes.
"""
import re
import sys
from pathlib import Path

CREATE_RE = re.compile(
    r'create\s+policy\s+"(?P<name>[^"]+)"\s+on\s+(?P<table>[A-Za-z0-9_.]+)',
    re.IGNORECASE,
)

def process(text: str) -> str:
    out = []
    pos = 0
    for m in CREATE_RE.finditer(text):
        start = m.start()
        name = m.group('name')
        table = m.group('table')
        # Look at what immediately precedes this create (ignoring whitespace)
        preceding = text[:start].rstrip()
        drop_stmt = f'drop policy if exists "{name}" on {table};'
        already = preceding.lower().endswith(drop_stmt.lower())
        out.append(text[pos:start])
        if not already:
            # Preserve indentation of the create statement
            line_start = text.rfind('\n', 0, start) + 1
            indent = text[line_start:start]
            out.append(f'{drop_stmt}\n{indent}')
        pos = start
    out.append(text[pos:])
    return ''.join(out)

def main():
    root = Path(sys.argv[1]) if len(sys.argv) > 1 else Path('supabase/migrations')
    changed = 0
    for f in sorted(root.glob('*.sql')):
        original = f.read_text()
        updated = process(original)
        if updated != original:
            f.write_text(updated)
            changed += 1
            print(f'patched {f.name}')
    print(f'done: {changed} files patched')

if __name__ == '__main__':
    main()
