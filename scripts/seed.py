#!/usr/bin/env python3
"""Generate D1 seed SQL from the Muse snapshot, verbatim.
Reads ~/workspace/your_files/muse-backup-2026-11-08/lead-support-engine/data-snapshot-getoverview.json
and writes seed.sql (INSERT OR REPLACE per row, JSON-doc pattern).
No field is invented or altered."""
import json, pathlib

SNAP = pathlib.Path.home() / "workspace/your_files/muse-backup-2026-11-08/lead-support-engine/data-snapshot-getoverview.json"
OUT = pathlib.Path(__file__).resolve().parent.parent / "seed.sql"

snap = json.loads(SNAP.read_text())

def sql_str(v):
    return "'" + json.dumps(v).replace("'", "''") + "'"

lines = ["-- Seed from Muse snapshot data-snapshot-getoverview.json (verbatim)."]
for lead in snap["leads"]:
    lines.append(f"INSERT OR REPLACE INTO leads (id, data) VALUES ({lead['id']}, {sql_str(lead)});")
for page in snap["kbPages"]:
    lines.append(f"INSERT OR REPLACE INTO kb_pages (id, data) VALUES ({page['id']}, {sql_str(page)});")
for entry in snap["dnc"]:
    lines.append(f"INSERT OR REPLACE INTO dnc (id, data) VALUES ({entry['id']}, {sql_str(entry)});")
for rev in snap["reveals"]:
    lines.append(f"INSERT OR REPLACE INTO reveals (id, data) VALUES ({rev['id']}, {sql_str(rev)});")

OUT.write_text("\n".join(lines) + "\n")
print(f"wrote {OUT}: {len(snap['leads'])} leads, {len(snap['kbPages'])} kb pages, "
      f"{len(snap['dnc'])} dnc, {len(snap['reveals'])} reveals")
