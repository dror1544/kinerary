"""scripts/link-worktree-deps.sh — a linked install must be current, not just real.

`main_nm_usable` used to require only that main's node_modules was a real
directory. It said nothing about whether that install still matched main's
own lockfile, so a worktree could be linked (or relinked) to an install that
predated a dependency added on main days earlier — exactly what left three
nightly e2e runs red (server/node_modules/.package-lock.json from 2026-09-18,
server/package-lock.json from 2026-09-27, after @modelcontextprotocol/sdk was
added). A stale main install must fall through to a real install in the
worktree instead of being linked.
"""
from __future__ import annotations

import os
import subprocess
import tempfile
import unittest
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
SCRIPT = REPO / "scripts" / "link-worktree-deps.sh"

GIT_ENV = {
    "GIT_AUTHOR_NAME": "Test", "GIT_AUTHOR_EMAIL": "test@example.com",
    "GIT_COMMITTER_NAME": "Test", "GIT_COMMITTER_EMAIL": "test@example.com",
}

PACKAGE_JSON = '{"name": "server", "version": "1.0.0"}\n'
LOCKFILE = '{"name": "server", "lockfileVersion": 2, "packages": {}}\n'


class LinkWorktreeDeps(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        root = Path(self.tmp.name)

        # A fake npm on PATH ahead of the real one — records its argv and
        # behaves just enough like npm to satisfy the linker: it leaves a
        # real node_modules/.package-lock.json behind.
        self.bin = root / "bin"
        self.bin.mkdir()
        self.npm_log = root / "npm-calls.log"
        npm = self.bin / "npm"
        npm.write_text(
            "#!/bin/sh\n"
            'printf \'%s\\n\' "$*" >> "$NPM_LOG"\n'
            "mkdir -p node_modules\n"
            ": > node_modules/.package-lock.json\n"
        )
        npm.chmod(0o755)

        # A main checkout with a committed server/package.json + lockfile.
        self.main = root / "main"
        self.main.mkdir()
        self._git("init", "-q", cwd=self.main)
        server = self.main / "server"
        server.mkdir()
        (server / "package.json").write_text(PACKAGE_JSON)
        (server / "package-lock.json").write_text(LOCKFILE)
        self._git("add", "-A", cwd=self.main)
        self._git("commit", "-q", "-m", "init", cwd=self.main)

        # A worktree off it — same tracked files, so the same lockfile.
        self.worktree = root / "worktree"
        self._git("worktree", "add", "--detach", "-q", str(self.worktree), cwd=self.main)

        self.env = {
            **os.environ,
            "PATH": f"{self.bin}:{os.environ['PATH']}",
            "NPM_LOG": str(self.npm_log),
            **GIT_ENV,
        }

    def _git(self, *args, cwd):
        subprocess.run(["git", *args], cwd=cwd, env={**os.environ, **GIT_ENV},
                        check=True, capture_output=True, text=True)

    def _age_main_install(self, *, older_than_lockfile: bool) -> None:
        main_nm = self.main / "server" / "node_modules"
        main_nm.mkdir()
        marker = main_nm / ".package-lock.json"
        marker.write_text("")
        lockfile_mtime = (self.main / "server" / "package-lock.json").stat().st_mtime
        delta = -3600 if older_than_lockfile else 3600
        stamp = lockfile_mtime + delta
        os.utime(marker, (stamp, stamp))

    def _seed_worktree_install(self) -> None:
        """A worktree that already has its own real, current node_modules —
        the sibling failure mode: a stale main must not `rm -rf` it."""
        wt_nm = self.worktree / "server" / "node_modules"
        wt_nm.mkdir()
        marker = wt_nm / ".package-lock.json"
        marker.write_text("")
        lockfile_mtime = (self.worktree / "server" / "package-lock.json").stat().st_mtime
        stamp = lockfile_mtime + 3600  # newer than the lockfile: current
        os.utime(marker, (stamp, stamp))

    def run_linker(self):
        return subprocess.run(
            ["bash", str(SCRIPT), str(self.worktree)],
            env=self.env, capture_output=True, text=True, timeout=30,
        )

    def npm_calls(self) -> str:
        return self.npm_log.read_text() if self.npm_log.exists() else ""

    def test_stale_main_install_is_not_linked_worktree_gets_a_real_install(self):
        self._age_main_install(older_than_lockfile=True)
        result = self.run_linker()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("main's node_modules is older than its lockfile", result.stderr + result.stdout)

        wt_nm = self.worktree / "server" / "node_modules"
        self.assertTrue(wt_nm.is_dir(), "worktree node_modules must exist")
        self.assertFalse(wt_nm.is_symlink(), "a stale main install must never be linked")

        calls = self.npm_calls()
        self.assertIn("ci", calls, f"npm must be run with `ci`, got: {calls!r}")

    def test_current_main_install_is_linked_npm_never_runs(self):
        self._age_main_install(older_than_lockfile=False)
        result = self.run_linker()
        self.assertEqual(result.returncode, 0, result.stderr)

        wt_nm = self.worktree / "server" / "node_modules"
        self.assertTrue(wt_nm.is_symlink(), "a current main install should be linked")
        self.assertEqual(wt_nm.resolve(), (self.main / "server" / "node_modules").resolve())

        self.assertEqual(self.npm_calls(), "", "npm must not run when linking succeeds")

    def test_worktree_already_has_a_current_real_install_stale_main_leaves_it_untouched(self):
        self._seed_worktree_install()
        wt_nm = self.worktree / "server" / "node_modules"
        inode_before = wt_nm.stat().st_ino
        self._age_main_install(older_than_lockfile=True)

        result = self.run_linker()
        self.assertEqual(result.returncode, 0, result.stderr)

        self.assertTrue(wt_nm.is_dir(), "worktree's own install must remain a directory")
        self.assertFalse(wt_nm.is_symlink())
        self.assertEqual(wt_nm.stat().st_ino, inode_before,
                          "a stale main install must not rm -rf a good worktree install")
        self.assertEqual(self.npm_calls(), "", "npm must not run over an already-current install")

    def test_worktree_real_install_relinks_to_main_when_main_is_current(self):
        self._seed_worktree_install()
        self._age_main_install(older_than_lockfile=False)

        result = self.run_linker()
        self.assertEqual(result.returncode, 0, result.stderr)

        wt_nm = self.worktree / "server" / "node_modules"
        self.assertTrue(wt_nm.is_symlink(), "a current main install still wins — dedup is the point")
        self.assertEqual(wt_nm.resolve(), (self.main / "server" / "node_modules").resolve())
        self.assertEqual(self.npm_calls(), "")

    # preflight-deploy.sh's own NEED_LINK branch for a stale symlink is not
    # covered here: exercising it means running preflight-deploy.sh itself,
    # which brings up a Python venv and a test Postgres — out of scope for a
    # fast unit test, and the brief allows stating that rather than covering it.


if __name__ == "__main__":
    unittest.main()
