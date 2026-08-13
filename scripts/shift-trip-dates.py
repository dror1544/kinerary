#!/usr/bin/env python3
"""Shift every date in a trip.config.json by N days.

The trip clock answers "where is this trip right now?", so the only way to see
its mid-trip and finished states is for today's date to fall inside or after the
trip. Rather than fake the clock, this moves the trip to where the clock is —
which exercises the real config, the real server and the real render path.

Intended for the japan-2025 test trip. It rewrites a live config file, so it
refuses to touch anything without --slug and always writes a .bak first.

    # put today in the middle of the trip
    python3 scripts/shift-trip-dates.py --slug japan-2025 --days -28

    # put the trip in the past
    python3 scripts/shift-trip-dates.py --slug japan-2025 --days -60

    # undo, exactly
    python3 scripts/shift-trip-dates.py --slug japan-2025 --restore

Shifts ISO dates only (YYYY-MM-DD and YYYY-MM-DDTHH:MM:SS±ZZ). Hebrew day
labels like "א׳ 37/9" are prose, not dates, so they are left alone and will
disagree with the shifted dates — that is cosmetic and expected while testing.
"""
import argparse
import datetime as dt
import io
import json
import re
import shutil
import sys
from pathlib import Path

ISO_DATETIME = re.compile(r'\b(\d{4})-(\d{2})-(\d{2})(T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})?)')
ISO_DATE = re.compile(r'\b(\d{4})-(\d{2})-(\d{2})\b')


def shift_text(raw: str, days: int) -> tuple[str, int]:
    n = 0

    def move(y, m, d):
        return (dt.date(int(y), int(m), int(d)) + dt.timedelta(days=days)).isoformat()

    def dt_sub(mt):
        nonlocal n
        n += 1
        return move(mt.group(1), mt.group(2), mt.group(3)) + mt.group(4)

    def d_sub(mt):
        nonlocal n
        n += 1
        return move(mt.group(1), mt.group(2), mt.group(3))

    # Datetimes first, so the date half of a timestamp isn't shifted twice.
    out = ISO_DATETIME.sub(dt_sub, raw)
    out = ISO_DATE.sub(d_sub, out)
    return out, n


def is_tracked(path: Path) -> bool:
    """True if git has this file, i.e. a forgotten restore ends up in a commit."""
    import subprocess
    try:
        r = subprocess.run(['git', 'ls-files', '--error-unmatch', str(path)],
                           cwd=path.parent, capture_output=True)
        return r.returncode == 0
    except Exception:
        return False


def trip_is_running(cfg_text: str) -> bool:
    """A trip whose departure has passed and whose return hasn't."""
    try:
        meta = json.loads(cfg_text).get('meta', {})
        dep = meta.get('departure', '')[:10]
        ret = meta.get('returnDate', '')[:10]
        today = dt.date.today().isoformat()
        return bool(dep and ret and dep <= today <= ret)
    except Exception:
        return False


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--slug', required=True, help='trip slug under kinerary-deploy/trips/ or trips/')
    ap.add_argument('--days', type=int, help='days to shift (negative moves the trip earlier)')
    ap.add_argument('--restore', action='store_true', help='restore from the .shift-backup')
    ap.add_argument('--status', action='store_true', help='report whether this trip is currently shifted')
    ap.add_argument('--force', action='store_true', help='shift even a trip that is running right now')
    ap.add_argument('--root', default=str(Path.home() / 'kinerary-deploy' / 'trips'))
    a = ap.parse_args()

    cfg = Path(a.root) / a.slug / 'trip.config.json'
    if not cfg.exists():
        cfg = Path(__file__).resolve().parents[1] / 'trips' / a.slug / 'trip.config.json'
    if not cfg.exists():
        sys.exit(f'no trip.config.json for slug {a.slug}')

    backup = cfg.with_suffix('.json.shift-backup')

    if a.status:
        if backup.exists():
            print(f'SHIFTED — {cfg} is not its real dates')
            print(f'  restore with: python3 scripts/{Path(__file__).name} --slug {a.slug} --restore')
            sys.exit(1)
        print(f'clean — {cfg} holds its real dates')
        return

    if a.restore:
        if not backup.exists():
            sys.exit(f'nothing to restore: {backup} does not exist')
        shutil.copy2(backup, cfg)
        backup.unlink()
        print(f'restored {cfg} from backup, backup removed')
        return

    if a.days is None:
        sys.exit('--days is required unless --restore is given')

    original = io.open(cfg, encoding='utf-8').read()

    # Never quietly rewrite the dates of a trip people are actually on. Their
    # phone would jump to the wrong day, and the schedule would disagree with
    # where they are standing.
    if trip_is_running(original) and not a.force:
        sys.exit(f'refusing: {a.slug} is running right now (departure passed, return has not).\n'
                 f'         shifting it would move a live trip under its travellers.\n'
                 f'         pass --force only if you are certain.')

    # One backup only: shifting twice must still restore to the true original.
    if not backup.exists():
        shutil.copy2(cfg, backup)
        print(f'original saved to {backup.name}')
    else:
        print(f'{backup.name} already exists — keeping the original one')

    out, n = shift_text(original, a.days)
    json.loads(out)                       # refuse to write anything unparseable
    io.open(cfg, 'w', encoding='utf-8').write(out)

    meta = json.loads(out).get('meta', {})
    print(f'shifted {n} date(s) by {a.days:+d} days')
    print(f'  departure : {meta.get("departure")}')
    print(f'  return    : {meta.get("returnDate")}')
    print(f'  today     : {dt.date.today().isoformat()}')

    # The whole risk of this script is forgetting to undo it. Say so loudest
    # where it actually bites: a config git is tracking.
    if is_tracked(cfg):
        print()
        print(f'  !! {cfg.name} is TRACKED BY GIT — these fake dates will show up in')
        print(f'     git status and can be committed by accident.')
        print(f'     RESTORE BEFORE COMMITTING:')
        print(f'       python3 scripts/shift-trip-dates.py --slug {a.slug} --restore')


if __name__ == '__main__':
    main()
