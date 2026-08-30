#!/usr/bin/env python3
import sys
from pathlib import Path
import yaml

REQ = ['config.overlay.yaml', 'INSTALL.md']
BAD_PATTERNS = ['bot_token', 'api_key', 'password:', 'secret:', 'token:']

r = Path(sys.argv[1])
missing = [p for p in REQ if not (r / p).is_file()]
if missing:
    raise SystemExit(f'missing: {missing}')

for p in r.rglob('*'):
    if p.is_file():
        text = p.read_text(errors='ignore').lower()
        for pat in BAD_PATTERNS:
            if pat in text:
                raise SystemExit(f'forbidden secret marker {pat!r} in {p}')

# Validate config.overlay.yaml is valid YAML with required keys
overlay = yaml.safe_load((r / 'config.overlay.yaml').read_text())
for key in ('model', 'fallback_providers', 'delegation'):
    if key not in overlay:
        raise SystemExit(f'config.overlay.yaml missing required key: {key}')

print(f'OK: {r}')
