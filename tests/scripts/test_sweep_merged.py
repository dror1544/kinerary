"""scripts/sweep-merged.py — merged work is cleaned up after itself, nothing else is.

On 2026-11-09 the repository held 39 worktrees, ~190 local and ~115 remote
branches, nearly all of them for work merged weeks earlier: pr-steward's Sweep 4
was correct but only ran when somebody asked for it. The sweep is now a script
the post-merge hook runs, so what it refuses to touch matters more than what it
removes. Each refusal below is a case found in that cleanup:

- a branch sitting on a mainline commit with no commits of its own is a branch
  someone just created, not one that was merged;
- a worktree a running container mounts (staging's Postgres read its password
  from one) or a process works in;
- a dirty worktree, an open PR, a detached HEAD, a codex/* branch, anything
  outside .claude/worktrees/, and the long-lived branches themselves.

A `__pycache__` left by a test run is not "dirty"; it blocked two removals.
"""
from __future__ import annotations

import json
import os
import subprocess
import tempfile
import unittest
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
SCRIPT = REPO / "scripts" / "sweep-merged.py"

GIT_ENV = {
    "GIT_AUTHOR_NAME": "Test", "GIT_AUTHOR_EMAIL": "test@example.com",
    "GIT_COMMITTER_NAME": "Test", "GIT_COMMITTER_EMAIL": "test@example.com",
    "GIT_CONFIG_GLOBAL": "/dev/null", "GIT_CONFIG_NOSYSTEM": "1",
}


class SweepMerged(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        root = Path(os.path.realpath(self.tmp.name))

        # Fakes for gh, docker and lsof: each answers from a file the test
        # writes, so a case can say "this PR is open" or "a container mounts
        # this" without the real tools.
        self.bin = root / "bin"
        self.bin.mkdir()
        self.gh_json = root / "gh.json"
        self.gh_json.write_text("[]")
        self.mounts = root / "mounts.txt"
        self.mounts.write_text("")
        self.cwds = root / "cwds.txt"
        self.cwds.write_text("")
        self._fake("gh", f'cat "{self.gh_json}"')
        self._fake("docker", f'case "$1" in ps) echo c1 ;; inspect) cat "{self.mounts}" ;; esac')
        self._fake("lsof", f'sed "s/^/n/" "{self.cwds}"')

        origin = root / "origin.git"
        self._git("init", "-q", "--bare", str(origin), cwd=root)
        self.main = root / "repo"
        self.main.mkdir()
        self._git("init", "-q", "-b", "main", cwd=self.main)
        self._commit("base")
        self._git("remote", "add", "origin", str(origin))
        self._git("push", "-q", "origin", "main")
        self._git("checkout", "-q", "-b", "integration/sprint-9")
        self._git("push", "-q", "origin", "integration/sprint-9")
        self._git("checkout", "-q", "--detach")
        self.wts = self.main / ".claude" / "worktrees"
        self.wts.mkdir(parents=True)
        (self.main / ".gitignore").write_text(".claude/\n")

    # ── helpers ────────────────────────────────────────────────────────────
    def _fake(self, name, body):
        p = self.bin / name
        p.write_text(f"#!/bin/sh\n{body}\n")
        p.chmod(0o755)

    def _git(self, *args, cwd=None):
        return subprocess.run(
            ["git", *args], cwd=cwd or self.main, check=True, text=True,
            capture_output=True, env={**os.environ, **GIT_ENV},
        ).stdout.strip()

    def _commit(self, name, cwd=None):
        cwd = cwd or self.main
        (Path(cwd) / f"{name}.txt").write_text(name)
        self._git("add", f"{name}.txt", cwd=cwd)
        self._git("commit", "-q", "-m", name, cwd=cwd)
        return self._git("rev-parse", "HEAD", cwd=cwd)

    def _worktree(self, branch, merge=True, push=True, commit=True):
        """A worktree on `branch` with one commit, optionally merged (--no-ff)."""
        wt = self.wts / branch.replace("/", "-")
        self._git("worktree", "add", "-q", "-b", branch, str(wt), "origin/integration/sprint-9")
        if commit:
            self._commit(branch.replace("/", "-"), cwd=wt)
        if push:
            self._git("push", "-q", "origin", branch, cwd=wt)
        if merge:
            self._merge(branch)
        return wt

    def _merge(self, branch):
        tmp = self.main.parent / f"merge-{branch.replace('/', '-')}"
        self._git("worktree", "add", "-q", str(tmp), "origin/integration/sprint-9")
        self._git("merge", "-q", "--no-ff", "-m", f"Merge {branch}", branch, cwd=tmp)
        self._git("push", "-q", "origin", "HEAD:integration/sprint-9", cwd=tmp)
        self._git("worktree", "remove", str(tmp))
        self._git("fetch", "-q", "origin")

    def sweep(self, *args):
        env = {**os.environ, **GIT_ENV, "PATH": f"{self.bin}:{os.environ['PATH']}"}
        r = subprocess.run(
            ["python3", str(SCRIPT), "--repo", str(self.main), *args],
            text=True, capture_output=True, env=env,
        )
        self.assertEqual(r.returncode, 0, r.stderr + r.stdout)
        return r.stdout

    def remote_branches(self):
        out = self._git("ls-remote", "--heads", "origin")
        return {l.split("refs/heads/", 1)[1] for l in out.splitlines()}

    def local_branches(self):
        return set(self._git("branch", "--format=%(refname:short)").split())

    # ── cases ──────────────────────────────────────────────────────────────
    def test_dry_run_changes_nothing(self):
        wt = self._worktree("fix/done")
        out = self.sweep()
        self.assertIn("fix/done", out)
        self.assertTrue(wt.exists())
        self.assertIn("fix/done", self.remote_branches())

    def test_merged_worktree_branch_and_remote_are_removed(self):
        wt = self._worktree("fix/done")
        self.sweep("--execute")
        self.assertFalse(wt.exists())
        self.assertNotIn("fix/done", self.local_branches())
        self.assertNotIn("fix/done", self.remote_branches())
        self.assertIn("integration/sprint-9", self.remote_branches())
        self.assertIn("main", self.remote_branches())

    def test_pycache_is_not_dirt(self):
        wt = self._worktree("fix/tested")
        (wt / "pkg" / "__pycache__").mkdir(parents=True)
        (wt / "pkg" / "__pycache__" / "x.cpython-312.pyc").write_bytes(b"\0")
        self.sweep("--execute")
        self.assertFalse(wt.exists())

    def test_unmerged_dirty_and_fresh_branches_are_kept(self):
        unmerged = self._worktree("feat/wip", merge=False)
        dirty = self._worktree("fix/dirty")
        (dirty / "notes.txt").write_text("uncommitted")
        fresh = self._worktree("fix/just-started", merge=False, commit=False)
        out = self.sweep("--execute")
        for wt in (unmerged, dirty, fresh):
            self.assertTrue(wt.exists(), out)
        self.assertIn("fix/just-started", self.remote_branches())
        self.assertIn("feat/wip", self.remote_branches())

    def test_open_pr_mount_and_process_keep_a_merged_worktree(self):
        pr = self._worktree("fix/in-review")
        mounted = self._worktree("chore/mounted")
        busy = self._worktree("fix/busy")
        self.gh_json.write_text(json.dumps([
            {"number": 7, "headRefName": "fix/in-review", "headRefOid": "0" * 40, "state": "OPEN"},
        ]))
        self.mounts.write_text(f"{mounted}/secrets/pw\n")
        self.cwds.write_text(f"{busy}/sub\n")
        out = self.sweep("--execute")
        for wt in (pr, mounted, busy):
            self.assertTrue(wt.exists(), out)
        self.assertIn("fix/in-review", self.remote_branches())

    def test_squash_merged_pr_counts_as_merged(self):
        wt = self._worktree("fix/squashed", merge=False)
        head = self._git("rev-parse", "HEAD", cwd=wt)
        self.gh_json.write_text(json.dumps([
            {"number": 8, "headRefName": "fix/squashed", "headRefOid": head, "state": "MERGED"},
        ]))
        self.sweep("--execute")
        self.assertFalse(wt.exists())
        self.assertNotIn("fix/squashed", self.local_branches())

    def test_detached_codex_and_outside_worktrees_are_never_touched(self):
        detached = self.wts / "staging"
        self._git("worktree", "add", "-q", "--detach", str(detached), "origin/main")
        codex = self._worktree("codex/task")
        outside = self.main.parent / "elsewhere"
        self._git("worktree", "add", "-q", "-b", "fix/outside", str(outside), "origin/integration/sprint-9")
        self._commit("outside", cwd=outside)
        self._merge("fix/outside")
        self.sweep("--execute")
        for wt in (detached, codex, outside):
            self.assertTrue(wt.exists())

    def test_count_mode_is_one_line_or_silent(self):
        self.assertEqual(self.sweep("--count", "--no-fetch").strip(), "")
        self._worktree("fix/done")
        out = self.sweep("--count", "--no-fetch").strip()
        self.assertEqual(len(out.splitlines()), 1, out)
        self.assertIn("sweep-merged.py --execute", out)


if __name__ == "__main__":
    unittest.main()
