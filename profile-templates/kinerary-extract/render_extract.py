#!/usr/bin/env python3
"""
render_extract.py — Render and optionally install the kinerary-extract profile.

Usage:
    python3 render_extract.py --input example.setup.json --output /tmp/kinerary-extract
    python3 render_extract.py --input setup.json --output /tmp/kinerary-extract \
        --install-profile kinerary-extract
"""
from __future__ import annotations
import argparse, json, re, shutil, subprocess, sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent

def bad(m): raise ValueError(m)

def validate(d):
    req = {'schema_version', 'record_type', 'profile'}
    if req - set(d): bad(f'missing keys: {sorted(req - set(d))}')
    if set(d) - req: bad(f'unknown keys: {sorted(set(d) - req)}')
    if d['schema_version'] != 1: bad('unsupported schema_version')
    if d['record_type'] != 'kinerary_extract_profile_input': bad('invalid record_type')
    n = d['profile'].get('name', '')
    if not re.fullmatch(r'[a-z][a-z0-9\-]{2,31}', n): bad(f'invalid profile name: {n!r}')
    desc = d['profile'].get('description', '')
    if not desc: bad('profile.description is required')

def render(d, out: Path):
    validate(d)
    if out.exists() and any(out.iterdir()): bad(f'output is not empty: {out}')
    out.mkdir(parents=True, exist_ok=True)
    shutil.copy2(ROOT / 'templates' / 'config.overlay.yaml', out / 'config.overlay.yaml')
    install_md = (
        f"# Install {d['profile']['name']}\n\n"
        "Create a fresh profile, copy config.overlay.yaml, and deliberately merge it "
        "into the generated config (do not blindly replace). Never write credentials here.\n\n"
        "```bash\n"
        f"hermes profile create {d['profile']['name']} --no-skills "
        f"--description {json.dumps(d['profile']['description'])}\n"
        f"# Then merge config.overlay.yaml keys into the profile config:\n"
        f"hermes -p {d['profile']['name']} config set model.default gpt-5.6-luna-900k\n"
        f"hermes -p {d['profile']['name']} config set model.provider openai-codex\n"
        f"# Verify fallback working:\n"
        f"hermes -p {d['profile']['name']} -z 'reply OK only'\n"
        "```\n"
    )
    (out / 'INSTALL.md').write_text(install_md)

def install(bundle: Path, name: str):
    home = Path.home() / '.hermes/profiles' / name
    if home.exists(): bad(f'refusing to overwrite existing profile: {home}')
    subprocess.run(
        ['hermes', 'profile', 'create', name, '--no-skills',
         '--description', 'Single-turn document/URL data extraction for kinerary Add Booking'],
        check=True
    )
    shutil.copy2(bundle / 'config.overlay.yaml', home / 'config.overlay.yaml')
    for key, val in [
        ('model.default',       'gpt-5.6-luna-900k'),
        ('model.provider',      'openai-codex'),
        ('delegation.model',    'claude-opus-4-6'),
        ('delegation.provider', 'anthropic'),
        ('display.show_cost',   'true'),
    ]:
        subprocess.run(['hermes', '-p', name, 'config', 'set', key, val], check=True)
    subprocess.run(['hermes', '-p', name, 'config', 'set', 'fallback_providers',
        '[{"provider":"anthropic","model":"claude-sonnet-4-6"},'
        '{"provider":"ollama-cloud","model":"gpt-oss:120b"},'
        '{"provider":"openai-codex","model":"gpt-5.6-sol"}]'], check=True)

def main():
    p = argparse.ArgumentParser()
    p.add_argument('--input', required=True, type=Path)
    p.add_argument('--output', required=True, type=Path)
    p.add_argument('--install-profile')
    a = p.parse_args()
    d = json.loads(a.input.read_text())
    render(d, a.output)
    if a.install_profile:
        if a.install_profile != d['profile']['name']:
            bad('--install-profile must match profile.name')
        install(a.output, a.install_profile)
    print(a.output)

if __name__ == '__main__':
    try:
        main()
    except (ValueError, json.JSONDecodeError, subprocess.CalledProcessError) as e:
        print('ERROR:', e, file=sys.stderr)
        raise SystemExit(2)
