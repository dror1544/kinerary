"""scripts/preflight-checks.sh B7 — a legacy migration arriving through a MERGE.

B7 grandfathers a migration that is already shipped, because the version is the
whole filename and renaming an applied one makes production run it again. It
decided "already shipped" by asking `git cat-file -e HEAD:<file>`.

On a merge commit HEAD is still the branch being merged INTO, so every file
arriving from the other parent looks like one this change is adding — including
a legacy `00xx_` migration that was committed on the other branch weeks ago.
B7 then blocks the merge and the only ways forward are an allow-list entry for
a file that is genuinely grandfathered, or `--no-verify`. Both teach the wrong
lesson, and `.githooks/pre-merge-commit` runs these checks, so it fires in both
directions on any branch still carrying a legacy name.

Found 2026-09-21 resolving PR #89, where `0054_companion_bug_reports.sql` — the
migration that legitimately owns `0054` on the integration branch — blocked the
merge that brought it in.

A real `git merge` in a throwaway repo, because MERGE_HEAD only exists during
one, and because these tests must never stage into the real tree's shared index
(#135).
"""
from __future__ import annotations

import os
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
SCRIPT = REPO / "scripts/preflight-checks.sh"

HEADER = "-- rollback: compatible — one new table; nothing existing changes shape\n"


class LegacyMigrationThroughAMerge(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self._hermes = tempfile.TemporaryDirectory()
        self.root = Path(self._tmp.name)
        self.env = {k: v for k, v in os.environ.items() if not k.startswith("GIT_")}
        self.env["HERMES_HOME"] = self._hermes.name
        (self.root / "scripts").mkdir()
        shutil.copy2(SCRIPT, self.root / "scripts/preflight-checks.sh")
        (self.root / "control-plane/db/migrations").mkdir(parents=True)
        self.git("init", "-q", "-b", "main")
        self.git("config", "user.email", "t@example.invalid")
        self.git("config", "user.name", "test")
        (self.root / "README.md").write_text("base\n")
        self.git("add", "-A")
        self.git("commit", "-qm", "base")

    def tearDown(self) -> None:
        self._tmp.cleanup()
        self._hermes.cleanup()

    def git(self, *args: str) -> subprocess.CompletedProcess:
        return subprocess.run(["git", *args], cwd=self.root, env=self.env,
                              capture_output=True, text=True, check=False)

    def write_migration(self, name: str, body: str = HEADER + "SELECT 1;\n") -> None:
        (self.root / "control-plane/db/migrations" / name).write_text(body)

    def checks(self, mode: str = "--staged") -> subprocess.CompletedProcess:
        return subprocess.run(["bash", str(self.root / "scripts/preflight-checks.sh"), mode],
                              cwd=self.root, env=self.env, capture_output=True, text=True, timeout=120)

    def start_merge_carrying(self, name: str) -> None:
        """Commit `name` on a side branch, then merge it without committing."""
        self.git("checkout", "-q", "-b", "side")
        self.write_migration(name)
        self.git("add", "-A")
        self.git("commit", "-qm", f"add {name} over here")
        self.git("checkout", "-q", "main")
        (self.root / "README.md").write_text("main moved on\n")
        self.git("add", "-A")
        self.git("commit", "-qm", "main moves")
        merged = self.git("merge", "--no-commit", "--no-ff", "side")
        self.assertTrue((self.root / ".git/MERGE_HEAD").exists(),
                        f"the merge did not start, so this proves nothing: {merged.stderr}")

    def test_a_legacy_migration_from_the_other_parent_does_not_block_the_merge(self):
        self.start_merge_carrying("0054_companion_bug_reports.sql")
        r = self.checks()
        self.assertNotIn("does not use a timestamp name", r.stdout)
        self.assertEqual(r.returncode, 0, r.stdout)

    def test_a_badly_named_migration_this_change_adds_still_blocks_during_a_merge(self):
        """The fix must not turn a merge into an amnesty for new files."""
        self.start_merge_carrying("0054_companion_bug_reports.sql")
        # Added by the person resolving the merge, in neither parent.
        self.write_migration("0099_added_during_the_merge.sql")
        self.git("add", "-A")
        r = self.checks()
        self.assertIn("does not use a timestamp name", r.stdout)
        self.assertIn("0099_added_during_the_merge.sql", r.stdout)
        self.assertEqual(r.returncode, 1)

    def test_outside_a_merge_a_hand_allocated_number_still_blocks(self):
        self.write_migration("0099_zz_probe.sql")
        self.git("add", "-A")
        r = self.checks()
        self.assertIn("does not use a timestamp name", r.stdout)
        self.assertEqual(r.returncode, 1)

    def test_the_rollback_contract_still_applies_to_what_the_merge_adds(self):
        self.start_merge_carrying("0054_companion_bug_reports.sql")
        self.write_migration("20260921120000_headerless.sql", "SELECT 1;\n")
        self.git("add", "-A")
        r = self.checks()
        self.assertIn("rollback", r.stdout.lower())
        self.assertEqual(r.returncode, 1)


if __name__ == "__main__":
    unittest.main()
