"""scripts/sync-codex-agents.py — .codex/agents/*.toml are generated, never hand-kept.

By 2026-09-20 the hand-kept mirrors had drifted: two said AGENTS.md where the
source said CLAUDE.md, and the newest agent existed on the Codex side only as
an untracked file. Codex works the same issue queue as Claude, so the two sides
must describe one role.
"""
from __future__ import annotations

import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
SCRIPT = REPO / "scripts/sync-codex-agents.py"

MD = """---
name: sample
description: Does one thing — and says so.
tools: Read, Bash
model: opus
---

You do one thing.

## Report

- one line per suite: `cd tests && npm test`
"""


def run(root: Path, *args: str) -> subprocess.CompletedProcess:
    return subprocess.run([sys.executable, str(SCRIPT), "--root", str(root), *args], capture_output=True, text=True)


class Render(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        (self.root / ".claude/agents").mkdir(parents=True)
        (self.root / ".claude/agents/sample.md").write_text(MD)

    def test_writes_a_mirror_carrying_name_description_and_the_body_verbatim(self):
        out = run(self.root)
        self.assertEqual(out.returncode, 0, out.stderr)
        toml = (self.root / ".codex/agents/sample.toml").read_text()
        self.assertIn('name = "sample"', toml)
        self.assertIn('description = "Does one thing — and says so."', toml)
        self.assertIn('developer_instructions = """\nYou do one thing.\n', toml)
        self.assertTrue(toml.endswith('- one line per suite: `cd tests && npm test`"""\n'))
        self.assertNotIn("tools", toml)
        self.assertNotIn("model", toml)
        self.assertTrue(toml.startswith("# Generated from .claude/agents/sample.md"))

    def test_check_is_clean_after_a_write_and_dirty_after_a_hand_edit(self):
        run(self.root)
        self.assertEqual(run(self.root, "--check").returncode, 0)
        toml = self.root / ".codex/agents/sample.toml"
        toml.write_text(toml.read_text().replace("one thing", "another thing"))
        check = run(self.root, "--check")
        self.assertEqual(check.returncode, 1)
        self.assertIn("differs: .codex/agents/sample.toml", check.stdout)

    def test_a_missing_mirror_and_an_orphan_both_fail_check(self):
        (self.root / ".codex/agents").mkdir(parents=True)
        (self.root / ".codex/agents/ghost.toml").write_text('name = "ghost"\n')
        check = run(self.root, "--check")
        self.assertEqual(check.returncode, 1)
        self.assertIn("missing: .codex/agents/sample.toml", check.stdout)
        self.assertIn("orphan: .codex/agents/ghost.toml", check.stdout)

    def test_a_body_with_a_backslash_is_a_literal_string(self):
        (self.root / ".claude/agents/sample.md").write_text(MD.replace("You do one thing.", "printf '%s\\n' x"))
        run(self.root)
        toml = (self.root / ".codex/agents/sample.toml").read_text()
        self.assertIn("developer_instructions = '''\n", toml)
        self.assertIn("printf '%s\\n' x", toml)

    def test_a_name_that_does_not_match_the_filename_is_refused(self):
        (self.root / ".claude/agents/sample.md").write_text(MD.replace("name: sample", "name: other"))
        out = run(self.root)
        self.assertNotEqual(out.returncode, 0)
        self.assertIn("does not match the filename", out.stderr)


class RealTree(unittest.TestCase):
    def test_the_repository_mirror_is_current(self):
        out = run(REPO, "--check")
        self.assertEqual(out.returncode, 0, out.stdout + out.stderr)


if __name__ == "__main__":
    unittest.main()
