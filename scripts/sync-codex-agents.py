#!/usr/bin/env python3
"""scripts/sync-codex-agents.py — .codex/agents/*.toml are generated from .claude/agents/*.md.

One source, two readers. Claude Code reads `.claude/agents/<name>.md`; Codex
reads `.codex/agents/<name>.toml`. Until 2026-09-20 the TOML side was copied by
hand and drifted the way hand copies do: two of six said AGENTS.md where the
source said CLAUDE.md, the newest copy did not, and the newest agent existed on
the Codex side only as an untracked file. Codex works the same issue queue as
Claude does (docs/agent-team-plan.md), so the two sides have to describe the
same role.

    scripts/sync-codex-agents.py            # (re)write every mirror that differs
    scripts/sync-codex-agents.py --check    # list what differs; exit 1 if anything does

preflight-checks.sh B9 runs --check on every commit. Never edit a .toml by hand.

Rendering: `name` and `description` from the frontmatter; the body, verbatim,
as `developer_instructions`. Claude-only fields (tools, model, effort,
isolation, …) are not carried — Codex has no equivalent and the role text
already says what the agent may not do. A body containing a backslash or a
triple double-quote is emitted as a TOML literal string (''' … ''') so nothing
is interpreted; otherwise a basic string (\"\"\" … \"\"\"), which is what the
hand-made mirrors used.
"""
from __future__ import annotations

import argparse
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def parse(text: str, path: Path):
    lines = text.split("\n")
    if not lines or lines[0].strip() != "---":
        raise SystemExit(f"{path}: no frontmatter")
    try:
        end = lines.index("---", 1)
    except ValueError:
        raise SystemExit(f"{path}: unterminated frontmatter")
    meta = {}
    for line in lines[1:end]:
        if not line.strip() or line[0] in " \t#":
            continue
        key, _, value = line.partition(":")
        meta[key.strip()] = value.strip()
    body = "\n".join(lines[end + 1:]).strip("\n")
    return meta, body


def render(meta: dict, body: str, source: str) -> str:
    name = meta.get("name")
    if not name:
        raise SystemExit(f"{source}: frontmatter has no name")
    if "\\" in body or '"""' in body:
        if "'''" in body:
            raise SystemExit(f"{source}: body needs a literal string but contains ''' — cannot be emitted as TOML")
        quote = "'''"
    else:
        quote = '"""'

    def basic(s: str) -> str:
        return s.replace("\\", "\\\\").replace('"', '\\"')

    return (
        f"# Generated from {source} by scripts/sync-codex-agents.py — edit the .md, never this file.\n"
        f'name = "{basic(name)}"\n'
        f'description = "{basic(meta.get("description", ""))}"\n'
        f"developer_instructions = {quote}\n{body}{quote}\n"
    )


def main(argv=None) -> int:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--check", action="store_true", help="report differences, write nothing, exit 1 if any")
    p.add_argument("--root", type=Path, default=ROOT)
    a = p.parse_args(argv)
    root = a.root.resolve()
    src, dst = root / ".claude" / "agents", root / ".codex" / "agents"
    if not src.is_dir():
        print(f"no {src.relative_to(root)}/ — nothing to mirror")
        return 0

    findings = []
    names = set()
    for md in sorted(src.glob("*.md")):
        meta, body = parse(md.read_text(), md)
        if meta.get("name") != md.stem:
            raise SystemExit(f"{md.relative_to(root)}: name '{meta.get('name')}' does not match the filename")
        names.add(md.stem)
        expected = render(meta, body, str(md.relative_to(root)))
        toml = dst / f"{md.stem}.toml"
        current = toml.read_text() if toml.exists() else None
        if current == expected:
            continue
        state = "missing" if current is None else "differs"
        if a.check:
            findings.append(f"{state}: {toml.relative_to(root)}")
        else:
            dst.mkdir(parents=True, exist_ok=True)
            toml.write_text(expected)
            print(f"wrote {toml.relative_to(root)}  ({state})")
    if dst.is_dir():
        for toml in sorted(dst.glob("*.toml")):
            if toml.stem not in names:
                msg = f"orphan: {toml.relative_to(root)} has no {src.relative_to(root)}/{toml.stem}.md — git rm it, or add the .md"
                findings.append(msg) if a.check else print(msg)
    if a.check:
        for f in findings:
            print(f)
        if findings:
            print("fix: scripts/sync-codex-agents.py", file=sys.stderr)
            return 1
        print("codex mirror is current")
    return 0


if __name__ == "__main__":
    sys.exit(main())
