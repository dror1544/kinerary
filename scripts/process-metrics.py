#!/usr/bin/env python3
"""Is the process getting faster? Two numbers, one command.

    scripts/process-metrics.py --since 2026-09-26T07:46Z            # after the lighter gates
    scripts/process-metrics.py --until 2026-09-26T07:46Z --base integration/sprint-6

1. PR open -> merge, for PRs merged into --base in the window (GitHub, via `gh`).
2. Hook decisions in the window, from the local log pretooluse-bash.sh writes:
   prompts (ask), let through (allow) and refused (deny), by kind. That log is
   per machine and holds no command text; it starts empty on the day it ships,
   so a window before 2026-09-26 has PR timings only.

The baseline these are compared against is
docs/test-reports/process-baseline-2026-09-26.md.
"""
from __future__ import annotations

import argparse
import collections
import datetime as dt
import json
import os
import statistics
import subprocess
from pathlib import Path


def when(text: str) -> dt.datetime:
    return dt.datetime.fromisoformat(text.replace("Z", "+00:00"))


def hook_log() -> Path:
    if os.environ.get("KINERARY_HOOK_LOG"):
        return Path(os.environ["KINERARY_HOOK_LOG"])
    state = os.environ.get("XDG_STATE_HOME") or str(Path.home() / ".local/state")
    return Path(state) / "kinerary" / "hook-decisions.tsv"


def count_decisions(lines, since=None, until=None):
    """{(kind, decision): n} over log lines inside [since, until)."""
    out = collections.Counter()
    for line in lines:
        cols = line.rstrip("\n").split("\t")
        if len(cols) != 5:
            continue
        t = when(cols[0])
        if (since and t < since) or (until and t >= until):
            continue
        out[(cols[3], cols[4])] += 1
    return out


def pr_minutes(base, since=None, until=None):
    raw = subprocess.run(
        ["gh", "pr", "list", "--state", "merged", "--base", base, "--limit", "200",
         "--json", "number,createdAt,mergedAt"],
        capture_output=True, text=True, check=True).stdout
    rows = []
    for pr in json.loads(raw):
        merged = when(pr["mergedAt"])
        if (since and merged < since) or (until and merged >= until):
            continue
        rows.append((pr["number"], (merged - when(pr["createdAt"])).total_seconds() / 60))
    return sorted(rows)


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--base", default="integration/sprint-6")
    ap.add_argument("--since", type=when)
    ap.add_argument("--until", type=when)
    a = ap.parse_args()

    rows = pr_minutes(a.base, a.since, a.until)
    print(f"PRs merged into {a.base}: {len(rows)}")
    if rows:
        mins = sorted(m for _, m in rows)
        p75 = mins[min(len(mins) - 1, (3 * len(mins)) // 4)]
        print(f"  open -> merge: median {statistics.median(mins):.0f} min, 75th pct {p75:.0f} min")
        print("  over a day:", [n for n, m in rows if m > 24 * 60] or "none")

    log = hook_log()
    counts = count_decisions(log.read_text().splitlines() if log.exists() else [], a.since, a.until)
    print(f"Hook decisions ({log}):", "none logged" if not counts else "")
    for (kind, decision), n in sorted(counts.items()):
        print(f"  {kind:7} {decision:5} {n}")
    if rows and counts:
        asks = sum(n for (k, d), n in counts.items() if d == "ask")
        print(f"  prompts per merged PR: {asks / len(rows):.1f}  (all prompts on this machine, not only PR work)")


if __name__ == "__main__":
    main()
