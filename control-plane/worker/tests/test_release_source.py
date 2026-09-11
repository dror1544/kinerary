"""Unit tests for release_source — no PostgreSQL, a throwaway git repo per test."""
from __future__ import annotations

import hashlib
import os
import shutil
import subprocess
import tempfile
import unittest

from control_plane_worker.release_source import (
    ReleaseSourceError,
    materialize_release_source,
    tree_digest,
)


def _git(cwd: str, *args: str) -> str:
    return subprocess.run(
        ["git", "-C", cwd, *args], check=True, capture_output=True, text=True,
    ).stdout


class ReleaseSourceTests(unittest.TestCase):
    def setUp(self) -> None:
        self.repo = tempfile.mkdtemp(prefix="rs-repo-")
        _git(self.repo, "init", "-q")
        _git(self.repo, "config", "user.email", "t@example.test")
        _git(self.repo, "config", "user.name", "Test")
        for rel, body in {
            "site/app.js": "const x = 1;\n",
            "server/server.js": "// server\n",
            "server/Dockerfile": "FROM node:20\n",
            "shared/schema.js": "export const V = 1;\n",
            "docs/not-payload.md": "ignore me\n",
        }.items():
            path = os.path.join(self.repo, rel)
            os.makedirs(os.path.dirname(path), exist_ok=True)
            with open(path, "w", encoding="utf-8") as fh:
                fh.write(body)
        _git(self.repo, "add", "-A")
        _git(self.repo, "commit", "-qm", "c1")
        self.rev = _git(self.repo, "rev-parse", "HEAD").strip()
        self._made: list[str] = []

    def tearDown(self) -> None:
        shutil.rmtree(self.repo, ignore_errors=True)
        for d in self._made:
            shutil.rmtree(d, ignore_errors=True)

    def _materialize(self, *args) -> str:
        d = materialize_release_source(*args)
        self._made.append(d)
        return d

    def test_digest_matches_the_ts_formula(self) -> None:
        listing = _git(self.repo, "ls-tree", "-r", self.rev, "--", "site", "server", "shared")
        rows = sorted(
            f"{line.partition(chr(9))[2]} {line.split()[2]}"
            for line in listing.splitlines() if line
        )
        expected = "sha256:" + hashlib.sha256("\n".join(rows).encode("utf-8")).hexdigest()
        self.assertEqual(tree_digest(self.repo, self.rev), expected)

    def test_digest_ignores_paths_outside_the_payload_roots(self) -> None:
        before = tree_digest(self.repo, self.rev)
        with open(os.path.join(self.repo, "docs/not-payload.md"), "a", encoding="utf-8") as fh:
            fh.write("changed\n")
        _git(self.repo, "commit", "-aqm", "c2")
        after_rev = _git(self.repo, "rev-parse", "HEAD").strip()
        self.assertEqual(tree_digest(self.repo, after_rev), before)

    def test_digest_changes_when_a_payload_file_changes(self) -> None:
        before = tree_digest(self.repo, self.rev)
        with open(os.path.join(self.repo, "site/app.js"), "a", encoding="utf-8") as fh:
            fh.write("// tweak\n")
        _git(self.repo, "commit", "-aqm", "c2")
        after_rev = _git(self.repo, "rev-parse", "HEAD").strip()
        self.assertNotEqual(tree_digest(self.repo, after_rev), before)

    def test_materialize_reproduces_the_payload_tree_only(self) -> None:
        dest = self._materialize(self.repo, self.rev, tree_digest(self.repo, self.rev))
        self.assertTrue(os.path.isfile(os.path.join(dest, "site", "app.js")))
        self.assertTrue(os.path.isfile(os.path.join(dest, "server", "Dockerfile")))
        self.assertTrue(os.path.isfile(os.path.join(dest, "shared", "schema.js")))
        self.assertFalse(os.path.exists(os.path.join(dest, "docs")))

    def test_no_expected_digest_still_materializes(self) -> None:
        dest = self._materialize(self.repo, self.rev, None)
        self.assertTrue(os.path.isfile(os.path.join(dest, "shared", "schema.js")))

    def test_digest_mismatch_raises_without_extracting(self) -> None:
        with self.assertRaises(ReleaseSourceError) as ctx:
            materialize_release_source(self.repo, self.rev, "sha256:" + "0" * 64)
        self.assertEqual(ctx.exception.safe_error_code, "RELEASE_ARTIFACT_DIGEST_MISMATCH")

    def test_unreachable_revision_raises(self) -> None:
        with self.assertRaises(ReleaseSourceError) as ctx:
            materialize_release_source(self.repo, "d" * 40, None)
        self.assertEqual(ctx.exception.safe_error_code, "RELEASE_REVISION_UNAVAILABLE")

    def test_malformed_revision_raises(self) -> None:
        with self.assertRaises(ReleaseSourceError) as ctx:
            materialize_release_source(self.repo, "not-a-sha", None)
        self.assertEqual(ctx.exception.safe_error_code, "RELEASE_REVISION_INVALID")

    def test_no_repo_root_raises(self) -> None:
        with self.assertRaises(ReleaseSourceError) as ctx:
            materialize_release_source("", self.rev, None)
        self.assertEqual(ctx.exception.safe_error_code, "RELEASE_REPO_ROOT_UNSET")


if __name__ == "__main__":
    unittest.main()


class GitOwnershipTests(unittest.TestCase):
    """On the Proxmox VM the worker runs as root against /repo, a bind mount
    owned by the operator's uid. git refuses such a repository ("detected
    dubious ownership") and every release verification failed on it. The
    exception must name exactly the repository the worker was handed — never a
    wildcard, which would trust every directory on the host."""

    def _argv(self, repo_root: str) -> list[str]:
        from unittest import mock
        from control_plane_worker import release_source
        seen: dict = {}

        def fake_run(argv, **kwargs):
            seen["argv"] = argv
            return subprocess.CompletedProcess(argv, 0, b"abc123\n", b"")

        with mock.patch.object(release_source.subprocess, "run", fake_run):
            release_source._git(repo_root, "rev-parse", "HEAD")
        return seen["argv"]

    def test_trusts_exactly_the_repo_it_was_given(self) -> None:
        argv = self._argv("/repo")
        self.assertIn("safe.directory=/repo", argv)
        self.assertFalse(any(a == "safe.directory=*" for a in argv), argv)

    def test_the_exception_precedes_the_subcommand(self) -> None:
        argv = self._argv("/repo")
        # `git -c k=v` only applies when it comes before the subcommand.
        self.assertLess(argv.index("safe.directory=/repo"), argv.index("rev-parse"))
        self.assertEqual(argv[argv.index("safe.directory=/repo") - 1], "-c")
