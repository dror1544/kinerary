#!/usr/bin/env python3
import re,sys
from pathlib import Path
REQ=['profile/SOUL.md','profile/profile.yaml','profile/config.overlay.yaml','profile/skills/intake/private-intake-interview/SKILL.md','workspace/.hermes.md','workspace/references/sources.md','INSTALL.md']
BAD=re.compile(r'(bot_token|api_key|password\s*:|secret\s*:|credential\s*:)',re.I)
r=Path(sys.argv[1]); missing=[x for x in REQ if not (r/x).is_file()]
if missing: raise SystemExit(f'missing: {missing}')
for p in r.rglob('*'):
 if p.is_file():
  m=BAD.search(p.read_text(errors='ignore'))
  if m: raise SystemExit(f'secret marker in {p}: {m.group(0)!r}')
soul=(r/'profile/SOUL.md').read_text()
for phrase in ('Never provision','explicit Confirm','valid opaque enrollment token'):
 if phrase not in soul: raise SystemExit(f'missing safety invariant: {phrase}')
print(f'OK: {r}')
