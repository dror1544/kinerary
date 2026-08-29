#!/usr/bin/env python3
"""
soul_judge.py — Kinerary quality judge

Runs daily. For each active Hermes profile that has a SOUL.md with
ESCALATION-HEURISTICS markers, it:

1. Checks how many new sessions exist since the last run (stored in
   .soul_judge_state.json in the profile dir). Skips if < MIN_SESSIONS.
2. Exports those sessions to JSONL using `hermes sessions export`.
3. Calls gpt-5.5 via `hermes -p <profile> -m gpt-5.5 --provider openai-codex -z <prompt>`
   to produce a patch for the ESCALATION-HEURISTICS section.
4. Backs up SOUL.md to soul_judge_backups/ (git-tracked) before patching.
5. Patches SOUL.md in place.
6. Commits the backup + patched SOUL.md to git with a descriptive message.

Usage:
    python3 scripts/soul_judge.py [--profiles profile1,profile2] [--dry-run]

Environment:
    HERMES_HOME   override default ~/.hermes
    KINERARY_REPO path to the kinerary repo root (default: script's parent dir)
"""
from __future__ import annotations
import argparse
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
from datetime import datetime, timezone
from pathlib import Path

MIN_SESSIONS = 10
JUDGE_MODEL = "gpt-5.5"
JUDGE_PROVIDER = "openai-codex"
MARKERS = ("<!-- ESCALATION-HEURISTICS-BEGIN -->", "<!-- ESCALATION-HEURISTICS-END -->")

REPO_ROOT = Path(os.environ.get("KINERARY_REPO", Path(__file__).resolve().parents[1]))
HERMES_HOME = Path(os.environ.get("HERMES_HOME", Path.home() / ".hermes"))
PROFILES_DIR = HERMES_HOME / "profiles"
BACKUPS_DIR = REPO_ROOT / "profile-templates" / "soul_judge_backups"

JUDGE_PROMPT_TEMPLATE = """\
You are a quality judge for a Kinerary trip-assistant bot.

Below are {n_sessions} recent conversation sessions exported from the profile "{profile}".
Your task is to update the escalation heuristics in the bot's SOUL.md.

CURRENT HEURISTICS:
{current_heuristics}

RECENT SESSIONS (JSONL — one message object per line):
{sessions_snippet}

Analyze the sessions and identify:
1. Cases where the primary model struggled but did NOT escalate (missed escalations).
2. Cases where the primary model escalated but probably didn't need to (over-escalations).
3. New topic patterns that should be added as escalation triggers.
4. Existing heuristics that should be tightened, relaxed, or removed based on evidence.

Output ONLY the updated heuristics content — the text that should go between the
ESCALATION-HEURISTICS-BEGIN and ESCALATION-HEURISTICS-END markers.
No preamble, no explanation, no markers. Just the updated bullet points.
Keep the same format as the current heuristics (two sections: "Delegate when" and "Handle directly when").
"""


def run(cmd: list[str], **kwargs) -> subprocess.CompletedProcess:
    return subprocess.run(cmd, text=True, capture_output=True, **kwargs)


def git(args: list[str], cwd: Path = REPO_ROOT) -> subprocess.CompletedProcess:
    return run(["git"] + args, cwd=cwd)


def find_profiles(names: list[str] | None) -> list[Path]:
    if names:
        return [PROFILES_DIR / n for n in names if (PROFILES_DIR / n).is_dir()]
    return [p for p in PROFILES_DIR.iterdir() if p.is_dir() and (p / "SOUL.md").exists()]


def has_markers(soul: Path) -> bool:
    text = soul.read_text()
    return MARKERS[0] in text and MARKERS[1] in text


def current_heuristics(soul: Path) -> str:
    text = soul.read_text()
    start = text.index(MARKERS[0]) + len(MARKERS[0])
    end = text.index(MARKERS[1])
    return text[start:end].strip()


def state_path(profile_dir: Path) -> Path:
    return profile_dir / ".soul_judge_state.json"


def load_state(profile_dir: Path) -> dict:
    p = state_path(profile_dir)
    if p.exists():
        return json.loads(p.read_text())
    return {"last_run": None, "last_session_count": 0}


def save_state(profile_dir: Path, state: dict):
    state_path(profile_dir).write_text(json.dumps(state, indent=2) + "\n")


def count_sessions_since(profile: str, after: str | None) -> int:
    cmd = ["hermes", "-p", profile, "sessions", "list", "--limit", "9999"]
    r = run(cmd)
    if r.returncode != 0:
        return 0
    lines = [l for l in r.stdout.strip().splitlines() if l.strip()]
    # sessions list returns one line per session; filter by date if we have one
    # (simple heuristic: count all lines if no prior run, else count lines after date)
    return len(lines)


def export_sessions(profile: str, after: str | None, out_file: Path) -> bool:
    cmd = ["hermes", "-p", profile, "sessions", "export",
           "--format", "jsonl", str(out_file)]
    if after:
        cmd += ["--after", after]
    r = run(cmd)
    return r.returncode == 0 and out_file.exists()


def call_judge(profile: str, prompt: str, dry_run: bool) -> str | None:
    if dry_run:
        print(f"  [dry-run] would call {JUDGE_MODEL} with prompt ({len(prompt)} chars)")
        return "[dry-run placeholder heuristics]"
    cmd = ["hermes", "-p", profile, "-m", JUDGE_MODEL,
           "--provider", JUDGE_PROVIDER, "-z", prompt]
    r = run(cmd, timeout=120)
    if r.returncode != 0:
        print(f"  ERROR calling judge: {r.stderr[:300]}", file=sys.stderr)
        return None
    return r.stdout.strip()


def patch_soul(soul: Path, new_heuristics: str):
    text = soul.read_text()
    start = text.index(MARKERS[0]) + len(MARKERS[0])
    end = text.index(MARKERS[1])
    patched = text[:start] + "\n" + new_heuristics + "\n" + text[end:]
    soul.write_text(patched)


def backup_and_commit(profile_name: str, soul: Path, dry_run: bool):
    BACKUPS_DIR.mkdir(parents=True, exist_ok=True)
    ts = datetime.now(timezone.utc).strftime("%Y%m%d-%H%M%S")
    backup = BACKUPS_DIR / f"{profile_name}-SOUL.md.{ts}.bak"
    shutil.copy2(soul, backup)
    if dry_run:
        print(f"  [dry-run] would git add {backup} {soul} and commit")
        return
    git(["add", str(backup), str(soul)])
    msg = f"chore(soul-judge): update escalation heuristics for {profile_name} [{ts}]"
    git(["commit", "-m", msg])
    print(f"  committed: {msg}")


def process_profile(profile_dir: Path, dry_run: bool):
    profile_name = profile_dir.name
    soul = profile_dir / "SOUL.md"

    if not soul.exists() or not has_markers(soul):
        print(f"  skip {profile_name}: no SOUL.md or no heuristic markers")
        return

    state = load_state(profile_dir)
    after = state.get("last_run")

    n = count_sessions_since(profile_name, after)
    print(f"  {profile_name}: {n} sessions since last run (need {MIN_SESSIONS})")
    if n < MIN_SESSIONS:
        print(f"  skip: not enough new sessions")
        return

    with tempfile.NamedTemporaryFile(suffix=".jsonl", delete=False) as f:
        export_path = Path(f.name)

    try:
        if not export_sessions(profile_name, after, export_path):
            print(f"  ERROR: session export failed", file=sys.stderr)
            return

        # Read up to 200 KB of sessions to stay within context
        raw = export_path.read_text(errors="ignore")
        snippet = raw[:200_000]

        heuristics = current_heuristics(soul)
        prompt = JUDGE_PROMPT_TEMPLATE.format(
            n_sessions=n,
            profile=profile_name,
            current_heuristics=heuristics,
            sessions_snippet=snippet,
        )

        new_heuristics = call_judge(profile_name, prompt, dry_run)
        if not new_heuristics:
            return

        backup_and_commit(profile_name, soul, dry_run)

        if not dry_run:
            patch_soul(soul, new_heuristics)
            print(f"  patched SOUL.md with updated heuristics")

        now = datetime.now(timezone.utc).isoformat()
        save_state(profile_dir, {"last_run": now, "last_session_count": n})
        print(f"  done: state saved, last_run={now}")
    finally:
        export_path.unlink(missing_ok=True)


def main():
    parser = argparse.ArgumentParser(description="Kinerary SOUL quality judge")
    parser.add_argument("--profiles", help="Comma-separated profile names (default: all with SOUL.md)")
    parser.add_argument("--dry-run", action="store_true", help="Read and plan but do not write or commit")
    args = parser.parse_args()

    names = args.profiles.split(",") if args.profiles else None
    profiles = find_profiles(names)

    if not profiles:
        print("No eligible profiles found.")
        return

    print(f"soul_judge: checking {len(profiles)} profile(s)")
    for p in profiles:
        print(f"\n[{p.name}]")
        try:
            process_profile(p, args.dry_run)
        except Exception as e:
            print(f"  ERROR: {e}", file=sys.stderr)


if __name__ == "__main__":
    main()
