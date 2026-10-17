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
OVERLAY = ROOT / 'templates' / 'config.overlay.yaml'


def overlay():
    """The profile's routing, read from the one file that states it.

    `install()` used to carry its own copy of every key and the whole fallback
    chain, under a comment asking whoever changed one to remember the other.
    Nobody did: the overlay and the `config set` calls both pinned
    `minimax/minimax-m3:free`, a model id that does not exist on OpenRouter, so
    the profile silently ran its 7-deep fallback chain from the day it was
    written. Fixing only the YAML would have changed nothing, because the YAML
    is copied as a reference file and the `config set` calls are what the live
    profile gets.

    So there is now one source and it is the YAML. A missing PyYAML is an error
    rather than a fallback to a built-in copy — a built-in copy is the thing
    this function exists to delete.
    """
    try:
        import yaml
    except ImportError:
        bad('PyYAML is required to read config.overlay.yaml (pip install pyyaml)')
    data = yaml.safe_load(OVERLAY.read_text()) or {}
    for key in ('model', 'fallback_providers'):
        if key not in data: bad(f'{OVERLAY.name} has no {key!r}')
    return data


def config_settings(d):
    """The scalar `config set` pairs, flattened from the overlay in its order."""
    out = []
    for section, value in d.items():
        if section == 'fallback_providers': continue
        for key, val in value.items():
            out.append((f'{section}.{key}', 'true' if val is True else 'false' if val is False else str(val)))
    return out

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
    routing = overlay()
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
        f"# Then merge config.overlay.yaml keys into the profile config, e.g.:\n"
        + "".join(
            f"hermes -p {d['profile']['name']} config set {key} {val}\n"
            for key, val in config_settings(routing)
        )
        + (
        f"# Verify fallback working:\n"
        f"hermes -p {d['profile']['name']} -z 'reply OK only'\n"
        "```\n"
        )
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
    # The copy above is a reference file; the live profile config is whatever
    # these `config set` calls write. Both now come from the same overlay, so
    # they cannot disagree — which they did, silently, for the profile's whole
    # life (see `overlay`).
    routing = overlay()
    for key, val in config_settings(routing):
        subprocess.run(['hermes', '-p', name, 'config', 'set', key, val], check=True)
    subprocess.run(['hermes', '-p', name, 'config', 'set', 'fallback_providers',
        json.dumps(routing['fallback_providers'])], check=True)

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
