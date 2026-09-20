"""scripts/claude-hooks/pretooluse-bash.sh — who may be asked, and who is refused.

The lead session — the one the person is talking to — is ASKED before a
commit, a merge, a push or a deploy, because hard rules 1 and 2 are about
intent. A subagent (a tool call carrying agent_type) is REFUSED for all four,
with the reason: CLAUDE.md says no agent can commit or deploy, and the agent
team (docs/agent-team-plan.md) has every role hand back instead. An "ask"
inside a background subagent is a prompt nobody expected.

Runs the hook from a throwaway repository, so the real tree's state cannot
decide the result.
"""
from __future__ import annotations

import json
import os
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
GIT_ID = ["-c", "user.name=t", "-c", "user.email=t@example.invalid"]


class Harness(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.hermes = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        (self.root / "scripts/claude-hooks").mkdir(parents=True)
        for name in ("preflight-checks.sh", "project-state.py", "sync-codex-agents.py"):
            shutil.copy2(REPO / "scripts" / name, self.root / "scripts" / name)
        for name in ("pretooluse-bash.sh", "match-command.py"):
            shutil.copy2(REPO / "scripts/claude-hooks" / name, self.root / "scripts/claude-hooks" / name)
        self.env = {k: v for k, v in os.environ.items() if not k.startswith("GIT_")}
        self.env["HERMES_HOME"] = self.hermes.name
        subprocess.run(["git", "init", "-q", "-b", "main"], cwd=self.root, check=True)
        subprocess.run(["git", "add", "-A"], cwd=self.root, check=True)
        subprocess.run(["git", *GIT_ID, "commit", "-qm", "first"], cwd=self.root, check=True)
        (self.root / "note.md").write_text("x\n")
        subprocess.run(["git", "add", "note.md"], cwd=self.root, check=True)

    def hook(self, command: str, agent_type: str = None) -> dict:
        payload = {"tool_name": "Bash", "tool_input": {"command": command}}
        if agent_type is not None:
            payload["agent_type"] = agent_type
        out = subprocess.run(["bash", "scripts/claude-hooks/pretooluse-bash.sh"], cwd=self.root, env=self.env,
                             input=json.dumps(payload), capture_output=True, text=True, timeout=120).stdout.strip()
        return json.loads(out)["hookSpecificOutput"] if out else {}


class TheLeadSessionIsAsked(Harness):
    def test_commit(self):
        d = self.hook("git commit -m 'note'")
        self.assertEqual(d.get("permissionDecision"), "ask")
        self.assertIn("hard rule 1", d["permissionDecisionReason"])

    def test_merge_and_its_relatives(self):
        for command in ("git merge feat/x", "gh pr merge 116 --squash", "git cherry-pick abc123"):
            d = self.hook(command)
            self.assertEqual(d.get("permissionDecision"), "ask", command)
            self.assertIn("creates commits", d["permissionDecisionReason"])

    def test_push(self):
        d = self.hook("git push origin HEAD")
        self.assertEqual(d.get("permissionDecision"), "ask")
        self.assertIn("publishes", d["permissionDecisionReason"])

    def test_reads_are_silent(self):
        for command in ("git status", "git merge-tree --write-tree main feat/x", "gh pr view 116", "git merge --abort"):
            self.assertEqual(self.hook(command), {}, command)


class ASubagentIsRefused(Harness):
    def test_every_landing_verb_is_a_refusal_naming_the_agent(self):
        for command in ("git commit -m 'note'", "git merge feat/x", "gh pr merge 116", "git push origin HEAD",
                        "git cherry-pick abc123"):
            d = self.hook(command, agent_type="developer")
            self.assertEqual(d.get("permissionDecision"), "deny", command)
            self.assertIn("'developer'", d["permissionDecisionReason"])
            self.assertIn("hand back", d["permissionDecisionReason"].lower())

    def test_a_deploy_is_refused_under_hard_rule_2(self):
        d = self.hook("docker compose -f x.yml up -d --build", agent_type="integrator")
        self.assertEqual(d.get("permissionDecision"), "deny")
        self.assertIn("hard rule 2", d["permissionDecisionReason"])

    def test_ordinary_work_is_untouched(self):
        for command in ("git status", "npm test", "git diff main...HEAD --stat", "git merge-base main HEAD"):
            self.assertEqual(self.hook(command, agent_type="developer"), {}, command)


if __name__ == "__main__":
    unittest.main()
