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


class DocsOnlyNeedsNoApprovalInTheMvpPhase(Harness):
    """CLAUDE.md "MVP phase — lighter rules" (2026-09-25).

    A docs-only commit, and the push of docs-only commits, on an integration or
    docs branch, from the lead session, is not asked about. Everything the hook
    cannot see stays a prompt: it inspects what is STAGED before the command
    runs, so any command that could stage or widen something in the same breath
    (`git add … && git commit`, `-a`, `--amend`, another directory) is asked.
    """

    def setUp(self):
        super().setUp()
        self.git("reset", "-q", "note.md")
        (self.root / "note.md").unlink()
        self.git("checkout", "-q", "-b", "integration/sprint-x")
        (self.root / "msg.txt").write_text("docs: a change\n")

    def git(self, *args):
        subprocess.run(["git", *GIT_ID, *args], cwd=self.root, check=True, capture_output=True)

    def stage(self, *paths):
        for rel in paths:
            f = self.root / rel
            f.parent.mkdir(parents=True, exist_ok=True)
            f.write_text("x\n")
        self.git("add", *paths)

    def decision(self, command, **kw):
        return self.hook(command, **kw).get("permissionDecision")

    def test_a_docs_only_commit_is_allowed(self):
        self.stage("docs/plan.md", "CHANGELOG.md")
        self.assertEqual(self.decision("git commit -q -F msg.txt"), "allow")
        self.assertEqual(self.decision("git commit -m 'docs: a change'"), "allow")

    def test_the_allow_names_the_rule(self):
        self.stage("docs/plan.md")
        self.assertIn("MVP", self.hook("git commit -q -F msg.txt")["permissionDecisionReason"])

    def test_anything_that_is_not_documentation_is_still_asked(self):
        for staged in (["src/app.ts"], ["docs/plan.md", "src/app.ts"], ["CLAUDE.md"], ["docs/plan.md", "CLAUDE.md"],
                       [".claude/settings.json"], ["scripts/other-tool.sh"],
                       ["docs/diagram.html"], ["note.md"]):
            self.git("reset", "-q")
            self.stage(*staged)
            self.assertEqual(self.decision("git commit -q -F msg.txt"), "ask", staged)

    def test_only_an_integration_or_docs_branch_qualifies(self):
        self.stage("docs/plan.md")
        for branch, expected in (("main", "ask"), ("feature/x", "ask"), ("docs/regression-plans", "allow"),
                                 ("integration/sprint-7", "allow")):
            self.git("checkout", "-q", "-B", branch)
            self.assertEqual(self.decision("git commit -q -F msg.txt"), expected, branch)

    def test_a_command_that_could_change_what_is_committed_is_asked(self):
        self.stage("docs/plan.md")
        for command in ("git add src/app.ts && git commit -m x", "git commit -am x", "git commit -a -m x",
                        "git commit --amend -m x", "git commit --no-verify -m x", "git commit -m x; git push",
                        "git commit -m $(cat msg.txt)", "git -C /elsewhere commit -m x",
                        "cd /elsewhere && git commit -m x", "git commit -m x docs/plan.md src/app.ts"):
            self.assertEqual(self.decision(command), "ask", command)

    def test_a_subagent_is_still_refused(self):
        self.stage("docs/plan.md")
        self.assertEqual(self.decision("git commit -q -F msg.txt", agent_type="developer"), "deny")

    def test_a_docs_only_push_is_allowed(self):
        remote = Path(tempfile.mkdtemp(prefix="hook-remote-"))
        self.addCleanup(shutil.rmtree, remote, True)
        subprocess.run(["git", "init", "-q", "--bare", "-b", "main", str(remote)], check=True)
        self.git("remote", "add", "origin", str(remote))
        self.git("push", "-q", "-u", "origin", "integration/sprint-x")
        self.stage("docs/plan.md")
        self.git("commit", "-q", "-m", "docs: plan")
        for command in ("git push", "git push origin", "git push origin integration/sprint-x", "git push -u origin"):
            self.assertEqual(self.decision(command), "allow", command)
        for command in ("git push --force", "git push -f origin integration/sprint-x", "git push origin main",
                        "git push origin HEAD:main", "git push origin :integration/sprint-x", "git push --tags",
                        "git push origin integration/sprint-x --force-with-lease"):
            self.assertEqual(self.decision(command), "ask", command)

    def test_a_push_carrying_anything_but_docs_is_asked(self):
        remote = Path(tempfile.mkdtemp(prefix="hook-remote-"))
        self.addCleanup(shutil.rmtree, remote, True)
        subprocess.run(["git", "init", "-q", "--bare", "-b", "main", str(remote)], check=True)
        self.git("remote", "add", "origin", str(remote))
        self.git("push", "-q", "-u", "origin", "integration/sprint-x")
        self.stage("docs/plan.md")
        self.git("commit", "-q", "-m", "docs: plan")
        self.stage("src/app.ts")
        self.git("commit", "-q", "-m", "feat: code")
        self.assertEqual(self.decision("git push"), "ask")

    def test_a_push_with_no_upstream_is_asked(self):
        self.stage("docs/plan.md")
        self.git("commit", "-q", "-m", "docs: plan")
        self.assertEqual(self.decision("git push"), "ask")


if __name__ == "__main__":
    unittest.main()
