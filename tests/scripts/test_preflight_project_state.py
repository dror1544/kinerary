"""scripts/preflight-checks.sh B8 and B9 — the sprint/baseline state and the Codex mirror.

B8: a commit is refused while .project/sprint.json disagrees with the tree,
and a staged lock, baseline or override change is NAMED as a warning so the
commit prompt can show it. B9: a commit is refused while any Codex agent
mirror differs from its source, or a source is staged without its mirror.

Runs in a throwaway repository, so the real tree's state cannot decide the result.
"""
from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
GIT_ID = ["-c", "user.name=t", "-c", "user.email=t@example.invalid"]
AGENT = "---\nname: sample\ndescription: A sample.\ntools: Read\n---\n\nYou are a sample.\n"


class Harness(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.hermes = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        (self.root / "scripts").mkdir()
        for name in ("preflight-checks.sh", "project-state.py", "sync-codex-agents.py"):
            shutil.copy2(REPO / "scripts" / name, self.root / "scripts" / name)
        (self.root / ".claude/agents").mkdir(parents=True)
        (self.root / ".claude/agents/sample.md").write_text(AGENT)
        (self.root / "docs/test-reports").mkdir(parents=True)
        (self.root / "docs/test-reports/baseline.md").write_text("# baseline\n")
        self.env = {k: v for k, v in os.environ.items() if not k.startswith("GIT_")}
        self.env["HERMES_HOME"] = self.hermes.name
        self.py("scripts/sync-codex-agents.py")
        self.git("init", "-q", "-b", "integration/sprint-9")
        self.git("add", "-A")
        self.git(*GIT_ID, "commit", "-qm", "first")
        self.py("scripts/project-state.py", "init", "--sprint-id", "9", "--integration-branch", "integration/sprint-9",
                "--scope", "plan=docs/plan.md", "--report", "docs/test-reports/baseline.md", "--by", "t", "--reason", "t")
        self.git("add", "-A")
        self.git(*GIT_ID, "commit", "-qm", "state")

    def git(self, *args: str) -> str:
        return subprocess.run(["git", *args], cwd=self.root, check=True, capture_output=True, text=True).stdout.strip()

    def py(self, *args: str) -> subprocess.CompletedProcess:
        return subprocess.run([sys.executable, *args], cwd=self.root, env=self.env, capture_output=True, text=True)

    def preflight(self, mode: str) -> subprocess.CompletedProcess:
        return subprocess.run(["bash", "scripts/preflight-checks.sh", mode], cwd=self.root, env=self.env,
                              capture_output=True, text=True, timeout=120)


class B8(Harness):
    def test_a_consistent_state_and_a_current_mirror_pass(self):
        out = self.preflight("--all")
        self.assertEqual(out.returncode, 0, out.stdout)
        self.assertNotIn("BLOCK", out.stdout)

    def test_a_baseline_commit_not_in_the_repository_blocks(self):
        state = self.root / ".project/sprint.json"
        state.write_text(state.read_text().replace(self.git("rev-parse", "HEAD~1"), "0" * 40))
        out = self.preflight("--all")
        self.assertEqual(out.returncode, 1)
        self.assertIn("sprint/baseline state disagrees with the tree", out.stdout)

    def test_a_staged_lock_change_is_named_for_the_commit_prompt(self):
        self.py("scripts/project-state.py", "lock", "baseline", "--by", "Dror", "--reason", "settled")
        self.git("add", ".project/sprint.json")
        out = self.preflight("--staged")
        self.assertEqual(out.returncode, 0, out.stdout)
        self.assertIn("state change — baseline lock: open -> locked (by Dror: settled)", out.stdout)


class B9(Harness):
    def test_a_hand_edited_mirror_blocks(self):
        toml = self.root / ".codex/agents/sample.toml"
        toml.write_text(toml.read_text().replace("a sample", "something else"))
        out = self.preflight("--all")
        self.assertEqual(out.returncode, 1)
        self.assertIn("Codex agent mirror is out of date", out.stdout)

    def test_a_source_staged_without_its_mirror_blocks(self):
        (self.root / ".claude/agents/sample.md").write_text(AGENT.replace("a sample", "a changed sample"))
        self.git("add", ".claude/agents/sample.md")
        out = self.preflight("--staged")
        self.assertEqual(out.returncode, 1)
        self.assertIn("agent source staged without its Codex mirror", out.stdout)
        # Regenerate and stage the mirror: clean.
        self.py("scripts/sync-codex-agents.py")
        self.git("add", ".codex/agents/sample.toml")
        out = self.preflight("--staged")
        self.assertEqual(out.returncode, 0, out.stdout)


class CommitPrompt(Harness):
    """The Bash hook names a staged state change inside the approval prompt itself."""

    def hook(self, command: str) -> dict:
        (self.root / "scripts/claude-hooks").mkdir(exist_ok=True)
        for name in ("pretooluse-bash.sh", "match-command.py"):
            shutil.copy2(REPO / "scripts/claude-hooks" / name, self.root / "scripts/claude-hooks" / name)
        out = subprocess.run(["bash", "scripts/claude-hooks/pretooluse-bash.sh"], cwd=self.root, env=self.env,
                             input=json.dumps({"tool_input": {"command": command}}),
                             capture_output=True, text=True, timeout=120).stdout.strip()
        return json.loads(out)["hookSpecificOutput"] if out else {}

    def test_a_staged_lock_change_is_named_in_the_commit_prompt(self):
        self.py("scripts/project-state.py", "lock", "baseline", "--by", "Dror", "--reason", "settled")
        self.git("add", ".project/sprint.json")
        d = self.hook("git commit -m 'lock the baseline'")
        self.assertEqual(d.get("permissionDecision"), "ask")
        self.assertIn("THIS COMMIT CHANGES THE SPRINT/BASELINE STATE", d["permissionDecisionReason"])
        self.assertIn("baseline lock: open -> locked (by Dror: settled)", d["permissionDecisionReason"])

    def test_an_ordinary_commit_prompt_says_nothing_about_state(self):
        (self.root / "note.md").write_text("x\n")
        self.git("add", "note.md")
        d = self.hook("git commit -m 'note'")
        self.assertEqual(d.get("permissionDecision"), "ask")
        self.assertNotIn("SPRINT/BASELINE STATE", d["permissionDecisionReason"])


if __name__ == "__main__":
    unittest.main()
