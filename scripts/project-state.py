#!/usr/bin/env python3
"""scripts/project-state.py — the sprint and baseline state, as one file.

`.project/sprint.json` is the single source of truth for: which sprint is
active and what its locked scope is; which commit the sprint's baseline is;
whether the sprint and the baseline are locked; and what an override takes.

Until 2026-09-20 both locks lived in a memory file and in Dror's head, so a
fresh session could not tell whether `integration/sprint-6` was ready to leave
or whether the baseline it was about to build on was still moving. Now every
session reads this at start (`scripts/claude-hooks/sessionstart.sh`) and every
commit checks it (`scripts/preflight-checks.sh`, B8).

Read:
    show [--json | --line]          the state, for a person / an agent / one line
    check                           consistent with the tree? exit 1 and say why
Change (each records who, when and why in `history`):
    lock   sprint|baseline --by WHO --reason WHY [--commit REF] [--report PATH]
    unlock sprint|baseline --by WHO --reason WHY
    set-baseline --commit REF --by WHO --reason WHY [--report PATH] [--release ID] [--override]
    set-sprint --id N --integration-branch B [--title T] [--scope k=v ...] --by WHO --reason WHY [--override]
    init …                          create the file for a new checkout or a new sprint
Used by preflight:
    describe-change OLD NEW         one line per lock, baseline, sprint or override change

Two things need `--override`: moving `baseline.commit` while the baseline is
locked, and changing the sprint while the sprint is locked. Both refuse without
it, and an override is recorded. The file change is then a commit — hard rule 1
makes every commit a human approval, and the commit prompt names the change.

Never edit the JSON by hand: the Write hook refuses, because a hand edit
carries no who/when/why.
"""
from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
from datetime import date, datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
FORMAT = 1
LOCKS = ("sprint", "baseline")
STATES = ("locked", "open")

MEANING = {
    "sprint": {
        "locked": "the integration branch is not ready to leave: do not assess it, deploy it, or merge it to main",
        "open": "the integration branch may be assessed, merged to main and deployed, through the normal gates",
    },
    "baseline": {
        "locked": "the baseline is settled: baseline.commit is what sprint work builds on, and the agent team may start",
        "open": "the baseline is still being prepared: baseline.commit moves with each fix, and the agent team does not start",
    },
}
FORBIDS = {
    "sprint": {
        "locked": ["regression assessment of the integration branch",
                   "deploying the integration branch",
                   "merging the integration branch to main",
                   "merging main into the integration branch"],
        "open": [],
    },
    "baseline": {
        "locked": ["moving baseline.commit without --override"],
        "open": ["starting sprint work through the agent team (docs/agent-team-plan.md)"],
    },
}
OVERRIDE_RULE = ("A lock, the baseline commit or the sprint changes only through scripts/project-state.py, "
                 "with --by and --reason. Moving baseline.commit while the baseline is locked, or changing the "
                 "sprint while the sprint is locked, needs --override and is recorded as such. The resulting "
                 "file change is a commit; hard rule 1 makes every commit a human approval, and the commit "
                 "prompt names every lock, baseline and override change in it.")


def now() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def today() -> str:
    return date.today().isoformat()


def git(*args: str, cwd: Path) -> subprocess.CompletedProcess:
    return subprocess.run(["git", *args], cwd=cwd, capture_output=True, text=True)


def resolve(ref: str, root: Path) -> str:
    r = git("rev-parse", "--verify", "-q", f"{ref}^{{commit}}", cwd=root)
    if r.returncode != 0:
        raise SystemExit(f"refused: {ref!r} is not a commit in this repository")
    return r.stdout.strip()


def load(path: Path) -> dict:
    try:
        return json.loads(path.read_text())
    except FileNotFoundError:
        raise SystemExit(f"no state file at {path} — create one with: scripts/project-state.py init …")
    except json.JSONDecodeError as e:
        raise SystemExit(f"{path} is not valid JSON: {e}")


def save(path: Path, state: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(state, indent=2, ensure_ascii=False) + "\n")


def record(state: dict, by: str, change: str, reason: str, override: bool = False) -> None:
    entry = {"at": now(), "by": by, "change": change, "reason": reason}
    if override:
        entry["override"] = True
    state.setdefault("history", []).append(entry)
    state["updated_at"] = entry["at"]
    state["updated_by"] = by


def set_lock(state: dict, which: str, new_state: str, by: str, reason: str, since: str) -> None:
    state.setdefault("locks", {})[which] = {
        "state": new_state,
        "since": since,
        "by": by,
        "reason": reason,
        "meaning": MEANING[which][new_state],
        "forbids": FORBIDS[which][new_state],
    }


# ── read ─────────────────────────────────────────────────────────────────────

def problems(state: dict, root: Path, use_git: bool = True) -> list:
    out = []
    if state.get("format") != FORMAT:
        out.append(f"format is {state.get('format')!r}, expected {FORMAT}")
    sprint = state.get("sprint") or {}
    for k in ("id", "integration_branch", "target_branch"):
        if not sprint.get(k):
            out.append(f"sprint.{k} is missing")
    if not isinstance(sprint.get("scope"), dict) or not sprint.get("scope"):
        out.append("sprint.scope must name at least one document")
    base = state.get("baseline") or {}
    for k in ("branch", "commit", "report"):
        if not base.get(k):
            out.append(f"baseline.{k} is missing")
    commit = base.get("commit") or ""
    if commit and not re.fullmatch(r"[0-9a-f]{40}", commit):
        out.append("baseline.commit must be a full 40-character sha")
    locks = state.get("locks") or {}
    for name in LOCKS:
        lock = locks.get(name) or {}
        if lock.get("state") not in STATES:
            out.append(f"locks.{name}.state must be one of {STATES}")
        for k in ("since", "by", "reason"):
            if not lock.get(k):
                out.append(f"locks.{name}.{k} is missing — a lock with no who/when/why is a rumour")
    report = base.get("report")
    if report and not (root / report).exists():
        out.append(f"baseline.report does not exist: {report}")
    if use_git and re.fullmatch(r"[0-9a-f]{40}", commit or ""):
        if git("cat-file", "-e", f"{commit}^{{commit}}", cwd=root).returncode != 0:
            out.append(f"baseline.commit {commit[:7]} is not a commit in this repository")
        else:
            branch = base.get("branch")
            if branch and git("rev-parse", "--verify", "-q", branch, cwd=root).returncode == 0:
                if git("merge-base", "--is-ancestor", commit, branch, cwd=root).returncode != 0:
                    out.append(f"baseline.commit {commit[:7]} is not on {branch}")
    return out


def one_line(state: dict, root: Path) -> str:
    s, b, locks = state["sprint"], state["baseline"], state["locks"]
    parts = [
        f"Sprint {s['id']} on {s['integration_branch']}",
        f"sprint lock {locks['sprint']['state'].upper()} since {locks['sprint']['since']} ({locks['sprint']['by']})",
        f"baseline {locks['baseline']['state'].upper()} at {b['commit'][:7]}",
    ]
    head = git("rev-parse", "--short", b["branch"], cwd=root)
    if head.returncode == 0:
        ahead = git("rev-list", "--count", f"{b['commit']}..{b['branch']}", cwd=root).stdout.strip()
        if ahead and ahead != "0":
            parts[-1] += f" ({b['branch']} is {ahead} commit(s) past it, at {head.stdout.strip()})"
    return "; ".join(parts) + ". Details: scripts/project-state.py show."


def show(state: dict, root: Path) -> str:
    s, b, locks = state["sprint"], state["baseline"], state["locks"]
    lines = [
        f"Sprint {s['id']} — {s.get('title', '')}".rstrip(" —"),
        f"  integration branch : {s['integration_branch']}  ->  {s['target_branch']}",
        f"  milestone          : {s.get('milestone') or '-'}",
        "  scope              :",
    ]
    for k, v in s["scope"].items():
        lines.append(f"    {k:<8} {v}")
    lines += [
        "",
        f"Baseline: {b['commit'][:7]} on {b['branch']}",
        f"  report  : {b['report']}",
        f"  release : {b.get('release') or '-'}",
    ]
    head = git("rev-parse", "--short", b["branch"], cwd=root)
    if head.returncode == 0:
        ahead = git("rev-list", "--count", f"{b['commit']}..{b['branch']}", cwd=root).stdout.strip()
        lines.append(f"  {b['branch']} is now at {head.stdout.strip()}, {ahead} commit(s) past the baseline")
    lines.append("")
    for name in LOCKS:
        lock = locks[name]
        lines.append(f"{name.capitalize()} lock: {lock['state'].upper()}  (since {lock['since']}, by {lock['by']})")
        lines.append(f"  reason  : {lock['reason']}")
        lines.append(f"  meaning : {lock['meaning']}")
        for f in lock.get("forbids", []):
            lines.append(f"  forbids : {f}")
    lines += ["", "Override: " + state.get("override", {}).get("rule", OVERRIDE_RULE), ""]
    hist = state.get("history", [])[-3:]
    if hist:
        lines.append("Last changes:")
        for e in hist:
            flag = "  [OVERRIDE]" if e.get("override") else ""
            lines.append(f"  {e['at']}  {e['by']}: {e['change']} — {e['reason']}{flag}")
    return "\n".join(lines)


def describe(old: dict, new: dict) -> list:
    lines = []
    ol, nl = old.get("locks") or {}, new.get("locks") or {}
    for name in LOCKS:
        a = (ol.get(name) or {}).get("state")
        b = (nl.get(name) or {}).get("state")
        if a != b:
            who = (nl.get(name) or {}).get("by", "?")
            why = (nl.get(name) or {}).get("reason", "")
            lines.append(f"{name} lock: {a or 'none'} -> {b or 'none'} (by {who}: {why})")
    ob, nb = old.get("baseline") or {}, new.get("baseline") or {}
    if ob.get("commit") != nb.get("commit"):
        lines.append(f"baseline commit: {(ob.get('commit') or 'none')[:7]} -> {(nb.get('commit') or 'none')[:7]}")
    os_, ns = old.get("sprint") or {}, new.get("sprint") or {}
    for k in ("id", "integration_branch"):
        if os_.get(k) != ns.get(k):
            lines.append(f"sprint {k}: {os_.get(k) or 'none'} -> {ns.get(k) or 'none'}")
    oh, nh = old.get("history") or [], new.get("history") or []
    for e in nh[len(oh):]:
        if e.get("override"):
            lines.append(f"OVERRIDE used: {e.get('change')} (by {e.get('by')}: {e.get('reason')})")
    return lines


# ── commands ─────────────────────────────────────────────────────────────────

def cmd_init(a, path: Path, root: Path) -> None:
    if path.exists() and not a.force:
        raise SystemExit(f"refused: {path} exists (--force to replace it)")
    scope = {}
    for item in a.scope or []:
        k, _, v = item.partition("=")
        if not k or not v:
            raise SystemExit(f"--scope wants key=path, got {item!r}")
        scope[k] = v
    commit = resolve(a.baseline_commit or a.integration_branch, root)
    state = {
        "format": FORMAT,
        "updated_at": now(),
        "updated_by": a.by,
        "sprint": {
            "id": a.sprint_id,
            "title": a.title or "",
            "integration_branch": a.integration_branch,
            "target_branch": a.target_branch,
            "milestone": a.milestone or "",
            "scope": scope,
        },
        "baseline": {
            "branch": a.integration_branch,
            "commit": commit,
            "report": a.report,
            "release": a.release,
        },
        "locks": {},
        "override": {"rule": OVERRIDE_RULE,
                     "commands": ["scripts/project-state.py lock|unlock sprint|baseline --by WHO --reason WHY",
                                  "scripts/project-state.py set-baseline --commit REF --by WHO --reason WHY [--override]",
                                  "scripts/project-state.py set-sprint --id N --integration-branch B --by WHO --reason WHY [--override]"]},
        "history": [],
    }
    set_lock(state, "sprint", a.sprint_lock, a.by, a.sprint_lock_reason or a.reason, a.sprint_lock_since or today())
    set_lock(state, "baseline", a.baseline_lock, a.by, a.baseline_lock_reason or a.reason, a.baseline_lock_since or today())
    record(state, a.by, f"init sprint {a.sprint_id} at {commit[:7]}", a.reason)
    save(path, state)
    print(f"wrote {path}")


def cmd_lock(a, path: Path, root: Path) -> None:
    state = load(path)
    lock = state["locks"][a.which]
    if lock["state"] == "locked":
        raise SystemExit(f"refused: {a.which} is already locked (since {lock['since']}, by {lock['by']})")
    change = f"lock {a.which}"
    if a.which == "baseline":
        commit = resolve(a.commit or state["baseline"]["branch"], root)
        state["baseline"]["commit"] = commit
        if a.report:
            state["baseline"]["report"] = a.report
        change += f" at {commit[:7]}"
    set_lock(state, a.which, "locked", a.by, a.reason, today())
    record(state, a.by, change, a.reason)
    save(path, state)
    print(f"{a.which}: locked — {MEANING[a.which]['locked']}")


def cmd_unlock(a, path: Path, root: Path) -> None:
    state = load(path)
    lock = state["locks"][a.which]
    if lock["state"] == "open":
        raise SystemExit(f"refused: {a.which} is already open (since {lock['since']}, by {lock['by']})")
    set_lock(state, a.which, "open", a.by, a.reason, today())
    record(state, a.by, f"unlock {a.which}", a.reason)
    save(path, state)
    print(f"{a.which}: open — {MEANING[a.which]['open']}")


def cmd_set_baseline(a, path: Path, root: Path) -> None:
    state = load(path)
    locked = state["locks"]["baseline"]["state"] == "locked"
    if locked and not a.override:
        raise SystemExit("refused: the baseline is locked; moving its commit needs --override, and a reason that says why")
    commit = resolve(a.commit, root)
    before = state["baseline"]["commit"]
    state["baseline"]["commit"] = commit
    if a.branch:
        state["baseline"]["branch"] = a.branch
    if a.report:
        state["baseline"]["report"] = a.report
    if a.release is not None:
        state["baseline"]["release"] = a.release
    record(state, a.by, f"set-baseline {before[:7]} -> {commit[:7]}" + (" while locked" if locked else ""),
           a.reason, override=locked)
    save(path, state)
    print(f"baseline: {before[:7]} -> {commit[:7]}" + ("  [OVERRIDE recorded]" if locked else ""))


def cmd_set_sprint(a, path: Path, root: Path) -> None:
    state = load(path)
    locked = state["locks"]["sprint"]["state"] == "locked"
    if locked and not a.override:
        raise SystemExit("refused: the sprint is locked; changing it needs --override, and a reason that says why")
    s = state["sprint"]
    before = f"{s['id']} on {s['integration_branch']}"
    s["id"] = a.id
    s["integration_branch"] = a.integration_branch
    if a.title is not None:
        s["title"] = a.title
    if a.milestone is not None:
        s["milestone"] = a.milestone
    if a.scope:
        s["scope"] = {}
        for item in a.scope:
            k, _, v = item.partition("=")
            s["scope"][k] = v
    record(state, a.by, f"set-sprint {before} -> {a.id} on {a.integration_branch}" + (" while locked" if locked else ""),
           a.reason, override=locked)
    save(path, state)
    print(f"sprint: {before} -> {a.id} on {a.integration_branch}" + ("  [OVERRIDE recorded]" if locked else ""))


def main(argv=None) -> int:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--file", type=Path, default=None, help="state file (default: <repo>/.project/sprint.json)")
    p.add_argument("--root", type=Path, default=None, help="repository root (default: the checkout this script is in)")
    sub = p.add_subparsers(dest="cmd", required=True)

    s = sub.add_parser("show"); s.add_argument("--json", action="store_true"); s.add_argument("--line", action="store_true")
    sub.add_parser("check")
    d = sub.add_parser("describe-change"); d.add_argument("old", type=Path); d.add_argument("new", type=Path)

    def who(sp):
        sp.add_argument("--by", required=True, help="who decided this")
        sp.add_argument("--reason", required=True, help="why")

    lk = sub.add_parser("lock"); lk.add_argument("which", choices=LOCKS); who(lk)
    lk.add_argument("--commit", help="baseline only: the commit to lock at (default: the integration branch head)")
    lk.add_argument("--report", help="baseline only: the baseline report path")
    ul = sub.add_parser("unlock"); ul.add_argument("which", choices=LOCKS); who(ul)

    sb = sub.add_parser("set-baseline"); who(sb)
    sb.add_argument("--commit", required=True); sb.add_argument("--branch"); sb.add_argument("--report")
    sb.add_argument("--release"); sb.add_argument("--override", action="store_true")

    ss = sub.add_parser("set-sprint"); who(ss)
    ss.add_argument("--id", required=True); ss.add_argument("--integration-branch", required=True)
    ss.add_argument("--title"); ss.add_argument("--milestone"); ss.add_argument("--scope", action="append")
    ss.add_argument("--override", action="store_true")

    i = sub.add_parser("init"); who(i)
    i.add_argument("--sprint-id", required=True); i.add_argument("--title")
    i.add_argument("--integration-branch", required=True); i.add_argument("--target-branch", default="main")
    i.add_argument("--milestone"); i.add_argument("--scope", action="append", help="key=path, repeatable")
    i.add_argument("--baseline-commit", help="default: the integration branch head")
    i.add_argument("--report", required=True); i.add_argument("--release")
    i.add_argument("--sprint-lock", choices=STATES, default="open"); i.add_argument("--sprint-lock-reason"); i.add_argument("--sprint-lock-since")
    i.add_argument("--baseline-lock", choices=STATES, default="open"); i.add_argument("--baseline-lock-reason"); i.add_argument("--baseline-lock-since")
    i.add_argument("--force", action="store_true")

    a = p.parse_args(argv)
    root = (a.root or ROOT).resolve()
    path = (a.file or (root / ".project" / "sprint.json")).resolve()

    if a.cmd == "show":
        state = load(path)
        if a.json:
            print(json.dumps(state, indent=2, ensure_ascii=False))
        elif a.line:
            print(one_line(state, root))
        else:
            print(show(state, root))
        return 0
    if a.cmd == "check":
        state = load(path)
        found = problems(state, root)
        for f in found:
            print(f"PROBLEM: {f}")
        if not found:
            print(f"ok: {one_line(state, root)}")
        return 1 if found else 0
    if a.cmd == "describe-change":
        def read(q: Path) -> dict:
            try:
                text = q.read_text()
            except FileNotFoundError:
                return {}
            return json.loads(text) if text.strip() else {}
        for line in describe(read(a.old), read(a.new)):
            print(line)
        return 0
    try:
        {"init": cmd_init, "lock": cmd_lock, "unlock": cmd_unlock,
         "set-baseline": cmd_set_baseline, "set-sprint": cmd_set_sprint}[a.cmd](a, path, root)
    except SystemExit as e:
        if e.code and isinstance(e.code, str) and e.code.startswith("refused"):
            print(e.code, file=sys.stderr)
            return 2
        raise
    return 0


if __name__ == "__main__":
    sys.exit(main())
