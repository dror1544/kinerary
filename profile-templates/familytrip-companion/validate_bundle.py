#!/usr/bin/env python3
import json,re,sys
from pathlib import Path
REQ=['SOUL.md','profile.yaml','config.overlay.yaml','INSTALL.md','references/sources.md','references/group-context.json','references/interview-context.private.json','skills/travel/familytrip-companion-operations/SKILL.md']
BAD=re.compile(r'(bot_token|api_key|password\s*:|secret\s*:|token\s*:)',re.I)
r=Path(sys.argv[1]); missing=[p for p in REQ if not (r/p).is_file()]
if missing: raise SystemExit(f'missing: {missing}')
for p in r.rglob('*'):
 if p.is_file():
  m=BAD.search(p.read_text(errors='ignore'))
  if m: raise SystemExit(f'forbidden source-specific/secret marker in {p}: {m.group(0)!r}')
for p in (r/'references/group-context.json',r/'references/interview-context.private.json'): json.loads(p.read_text())
print(f'OK: {r}')
