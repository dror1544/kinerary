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


class FeatureBranchWork(Harness):
    """MVP phase, 2026-09-26: work on a feature branch needs no per-commit or per-push
    approval; the merge into the leading branch is the one prompt, and it carries the
    evidence.

    The lead session may commit and push a `fix/`, `feat/`, `carry/` or `chore/` branch
    — in its own directory or in a sibling worktree of the same repository — because a
    feature-branch commit reaches nobody. The mechanical checks still run first, against
    the index being committed; policy paths, a widened command, any other branch and any
    other repository stay a prompt. `main` is production and `integration/sprint-*` is the
    leading branch: neither is ever exempted here.
    """

    def setUp(self):
        super().setUp()
        self.git(self.root, "reset", "-q", "note.md")
        (self.root / "note.md").unlink()
        self.git(self.root, "checkout", "-q", "-b", "fix/one")
        self.remote = Path(tempfile.mkdtemp(prefix="hook-remote-"))
        self.addCleanup(shutil.rmtree, self.remote, True)
        subprocess.run(["git", "init", "-q", "--bare", "-b", "main", str(self.remote)], check=True)
        self.git(self.root, "remote", "add", "origin", str(self.remote))
        self.other = tempfile.TemporaryDirectory()
        self.addCleanup(self.other.cleanup)
        self.wt = Path(self.other.name) / "wt"
        self.git(self.root, "worktree", "add", "-q", "-b", "feat/two", str(self.wt))

    def git(self, cwd, *args):
        subprocess.run(["git", *GIT_ID, *args], cwd=cwd, check=True, capture_output=True)

    def stage(self, where, *paths, content="x\n"):
        for rel in paths:
            f = where / rel
            f.parent.mkdir(parents=True, exist_ok=True)
            f.write_text(content) if isinstance(content, str) else f.write_bytes(content)
        self.git(where, "add", *paths)

    def decision(self, command, **kw):
        return self.hook(command, **kw).get("permissionDecision")

    def test_a_feature_branch_commit_here_is_allowed(self):
        self.stage(self.root, "src/app.ts", "tests/app.test.ts")
        self.assertEqual(self.decision("git commit -m 'fix: the thing'"), "allow")
        self.assertIn("2026-09-26", self.hook("git commit -m 'fix: the thing'")["permissionDecisionReason"])

    def test_a_feature_branch_commit_in_a_sibling_worktree_is_allowed(self):
        self.stage(self.wt, "src/app.ts")
        self.assertEqual(self.decision(f"cd {self.wt} && git commit -m 'feat: the thing'"), "allow")
        self.assertEqual(self.decision(f"git -C {self.wt} commit -m 'feat: the thing'"), "allow")

    def test_only_the_four_feature_prefixes_qualify(self):
        self.stage(self.root, "src/app.ts")
        for branch, expected in (("fix/a", "allow"), ("feat/a", "allow"), ("carry/a", "allow"), ("chore/a", "allow"),
                                 ("main", "ask"), ("integration/sprint-6", "ask"), ("feature/a", "ask"),
                                 ("sec/a", "ask"), ("release/a", "ask"), ("wip", "ask")):
            self.git(self.root, "checkout", "-q", "-B", branch)
            self.assertEqual(self.decision("git commit -m 'x'"), expected, branch)

    def test_a_policy_path_is_never_allowed(self):
        self.stage(self.root, "src/app.ts")
        self.assertEqual(self.decision("git commit -m 'x'"), "allow")  # control: the same commit without a policy path
        for staged in ("CLAUDE.md", "AGENTS.md", ".claude/agents/developer.md", ".githooks/pre-commit",
                       ".github/workflows/ci.yml", "scripts/other-tool.sh", ".preflight-allow"):
            self.git(self.root, "reset", "-q")
            self.stage(self.root, "src/app.ts", staged)
            self.assertIn(self.decision("git commit -m 'x'"), ("ask", "deny"), staged)

    def test_a_command_that_could_widen_the_commit_is_asked(self):
        self.stage(self.root, "src/app.ts")
        self.assertEqual(self.decision("git commit -m 'x'"), "allow")  # the plain form, so each ask below is earned
        for command in ("git add . && git commit -m 'x'", "git commit -am x", "git commit -a -m x",
                        "git commit --amend -m x", "git commit --no-verify -m x", "git commit -m 'x'; git push",
                        "git commit -m $(cat msg.txt)", "git commit -m 'x' src/app.ts",
                        f"cd {self.wt} && git add -A && git commit -m 'x'"):
            self.assertEqual(self.decision(command), "ask", command)

    def test_another_repository_is_asked(self):
        elsewhere = tempfile.TemporaryDirectory()
        self.addCleanup(elsewhere.cleanup)
        subprocess.run(["git", "init", "-q", "-b", "fix/z", elsewhere.name], check=True)
        self.stage(Path(elsewhere.name), "src/app.ts")
        self.stage(self.wt, "src/ok.ts")
        self.assertEqual(self.decision(f"cd {self.wt} && git commit -m 'x'"), "allow")
        self.assertEqual(self.decision(f"cd {elsewhere.name} && git commit -m 'x'"), "ask")
        self.assertEqual(self.decision("git -C /no/such/dir commit -m x"), "ask")

    def test_the_mechanical_checks_run_against_the_index_being_committed(self):
        self.stage(self.wt, "pic.png", content=b"\x89PNG\r\n\x1a\n\x00\x00")
        d = self.hook(f"cd {self.wt} && git commit -m 'x'")
        self.assertEqual(d.get("permissionDecision"), "deny")
        self.assertIn("hard rule 3", d["permissionDecisionReason"])

    def test_a_subagent_is_still_refused(self):
        self.stage(self.root, "src/app.ts")
        self.assertEqual(self.decision("git commit -m 'x'", agent_type="developer"), "deny")
        self.assertEqual(self.decision("git push -u origin fix/one", agent_type="developer"), "deny")

    def test_pushing_the_checked_out_feature_branch_is_allowed(self):
        self.stage(self.root, "src/app.ts")
        self.git(self.root, "commit", "-q", "-m", "fix: one")
        self.assertEqual(self.decision("git push -u origin fix/one"), "allow")
        self.assertEqual(self.decision("git push origin fix/one"), "allow")
        self.stage(self.wt, "src/two.ts")
        self.git(self.wt, "commit", "-q", "-m", "feat: two")
        self.assertEqual(self.decision(f"cd {self.wt} && git push -u origin feat/two"), "allow")

    def test_any_other_push_is_asked(self):
        self.stage(self.root, "src/app.ts")
        self.git(self.root, "commit", "-q", "-m", "fix: one")
        for command in ("git push", "git push -u origin", "git push origin fix/other", "git push origin main",
                        "git push origin fix/one:main", "git push origin HEAD:main", "git push -f origin fix/one",
                        "git push --force-with-lease origin fix/one", "git push origin :fix/one",
                        "git push --tags", "git push origin fix/one --force", "git push upstream fix/one"):
            self.assertEqual(self.decision(command), "ask", command)
        for branch in ("main", "integration/sprint-6", "feature/a"):
            self.git(self.root, "checkout", "-q", "-B", branch)
            self.assertEqual(self.decision(f"git push origin {branch}"), "ask", branch)

    def gh_stub(self, payload):
        bindir = Path(self.other.name) / "bin"
        bindir.mkdir(exist_ok=True)
        gh = bindir / "gh"
        gh.write_text("#!/bin/sh\n" + (f"cat <<'EOF'\n{payload}\nEOF\n" if payload else "exit 1\n"))
        gh.chmod(0o755)
        self.env["PATH"] = f"{bindir}:{self.env['PATH']}"

    def test_the_merge_prompt_carries_the_evidence(self):
        self.gh_stub('{"baseRefName":"integration/sprint-6","isDraft":false,"statusCheckRollup":'
                     '[{"conclusion":"SUCCESS"},{"conclusion":"SUCCESS"},{"conclusion":"SKIPPED"}]}')
        d = self.hook("gh pr merge 116 --merge")
        self.assertEqual(d["permissionDecision"], "ask")
        reason = d["permissionDecisionReason"]
        for part in ("creates commits", "PR #116", "integration/sprint-6", "leading branch", "skipped 1", "success 2"):
            self.assertIn(part, reason)
        self.assertNotIn("PRODUCTION", reason)

    def test_a_merge_onto_production_says_so_and_a_red_check_shows(self):
        self.gh_stub('{"baseRefName":"main","isDraft":true,"statusCheckRollup":'
                     '[{"conclusion":"FAILURE"},{"status":"IN_PROGRESS"}]}')
        reason = self.hook("gh pr merge 9 --merge")["permissionDecisionReason"]
        for part in ("PR #9", "main", "PRODUCTION", "failure 1", "in_progress 1", "DRAFT"):
            self.assertIn(part, reason)

    def test_a_merge_still_asks_when_github_cannot_be_read(self):
        self.gh_stub("")
        d = self.hook("gh pr merge 116 --merge")
        self.assertEqual(d["permissionDecision"], "ask")
        self.assertIn("creates commits", d["permissionDecisionReason"])
        self.assertIn("could not read", d["permissionDecisionReason"])


if __name__ == "__main__":
    unittest.main()
