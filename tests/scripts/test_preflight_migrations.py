"""scripts/preflight-checks.sh B7 — migration naming and the rollback contract.

Each rule here corresponds to a migration failure that is SILENT rather than
loud, which is why a check exists at all:

- a `.sql` whose name the migrator does not match is ignored, not rejected — it
  simply never runs, on every stack, forever;
- hand-allocated numbers collide between branches that never meet until merge
  (`0054` existed three ways at once on 2026-09-19, after two earlier
  renumbers);
- a migration with no `-- rollback:` header is treated as `breaking` by
  vm-release.py, which makes a rollback DISCARD the database rather than keep
  it.

A rule-enforcer that silently stops enforcing is this repository's own
recurring failure, so this asserts both directions: B7 fires on what it must
catch, and stays quiet on the grandfathered tree it must not touch.
"""
from __future__ import annotations

import subprocess
import unittest
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
SCRIPT = REPO / "scripts/preflight-checks.sh"
MIGRATIONS = REPO / "control-plane/db/migrations"

GOOD_HEADER = "-- rollback: compatible — one new table; nothing existing changes shape\n"


def staged(name: str, body: str) -> tuple[int, str]:
    """Write a migration, run --staged over it, and always clean up.

    --staged, not --paths: --paths is the Claude-hook fast path and returns
    after B4, so B7 never runs there. Getting that wrong makes every case below
    look like it passes.
    """
    path = MIGRATIONS / name
    path.write_text(body, encoding="utf-8")
    try:
        subprocess.run(["git", "add", "-f", str(path)], cwd=REPO, capture_output=True, check=True)
        r = subprocess.run([str(SCRIPT), "--staged"], cwd=REPO, capture_output=True, text=True)
        return r.returncode, r.stdout
    finally:
        subprocess.run(["git", "restore", "--staged", str(path)], cwd=REPO, capture_output=True)
        path.unlink(missing_ok=True)


class MigrationNaming(unittest.TestCase):
    def test_a_new_migration_may_not_use_a_hand_allocated_number(self):
        code, out = staged("0099_zz_probe.sql", GOOD_HEADER + "SELECT 1;\n")
        self.assertIn("does not use a timestamp name", out)
        self.assertEqual(code, 1)

    def test_a_timestamped_migration_is_accepted(self):
        code, out = staged("20260919143000_zz_probe.sql", GOOD_HEADER + "SELECT 1;\n")
        self.assertNotIn("timestamp name", out)
        self.assertNotIn("rollback contract", out)
        self.assertEqual(code, 0, out)

    def test_a_name_the_migrator_cannot_see_is_refused(self):
        # applyMigrations filters on ^\d+_ — this one would be skipped in
        # silence, which is worse than being rejected.
        code, out = staged("zz_probe_no_prefix.sql", GOOD_HEADER + "SELECT 1;\n")
        self.assertIn("invisible to the migrator", out)
        self.assertEqual(code, 1)

    def test_the_rollback_contract_is_required_on_a_new_migration(self):
        code, out = staged("20260919143001_zz_probe.sql", "SELECT 1;\n")
        self.assertIn("declares no rollback contract", out)
        self.assertEqual(code, 1)

    def test_either_dash_is_accepted_in_the_header(self):
        # vm-release.py's ROLLBACK_HEADER takes a hyphen or an em dash; the
        # preflight must not be stricter than the thing it is protecting.
        for label, dash in (("em dash", "—"), ("hyphen", "-")):
            with self.subTest(label):
                body = f"-- rollback: compatible {dash} additive only\nSELECT 1;\n"
                code, out = staged("20260919143002_zz_probe.sql", body)
                self.assertNotIn("rollback contract", out)
                self.assertEqual(code, 0, out)

    def test_breaking_is_a_valid_declaration_not_just_compatible(self):
        body = "-- rollback: breaking — drops a column the prior version still writes\nSELECT 1;\n"
        code, out = staged("20260919143003_zz_probe.sql", body)
        self.assertNotIn("rollback contract", out)
        self.assertEqual(code, 0, out)


class GrandfatheredTree(unittest.TestCase):
    """Renaming an APPLIED migration makes production re-run it, so the legacy
    00xx_ names are permanent. The rules that could fire on them are scoped to
    migrations a change adds — assert that, or a later edit quietly starts
    demanding a rename that would break production."""

    def test_the_existing_tree_raises_no_migration_complaint(self):
        out = subprocess.run([str(SCRIPT), "--all"], cwd=REPO, capture_output=True, text=True).stdout
        for phrase in ("timestamp name", "rollback contract", "invisible to the migrator"):
            self.assertNotIn(phrase, out, f"--all fires on the grandfathered tree:\n{out}")

    def test_the_tree_really_does_contain_legacy_names_without_headers(self):
        # Otherwise the test above passes vacuously — the grandfathering would
        # be untested the day someone converts every legacy file.
        legacy = [p for p in MIGRATIONS.glob("*.sql") if not p.name[:14].isdigit()]
        self.assertTrue(legacy, "no legacy 00xx_ migrations left — grandfathering is untested")
        headerless = [p for p in legacy if "-- rollback:" not in p.read_text(encoding="utf-8")]
        self.assertTrue(headerless, "no headerless legacy migrations left — scoping is untested")



class MergeIsAlsoGated(unittest.TestCase):
    """`git merge` does not run pre-commit — it runs pre-merge-commit.

    Until 2026-09-19 the repo shipped only pre-commit, so every blocking rule
    was bypassable by arriving through a merge. That matters most for B7:
    scoping is by "already in HEAD", and a migration that arrives by merge is
    in HEAD before anything looks at it, so it would be grandfathered rather
    than refused. A merge can also introduce content committed nowhere else —
    conflict resolution.
    """

    HOOK = REPO / ".githooks/pre-merge-commit"

    def test_the_hook_is_shipped_and_executable(self):
        self.assertTrue(self.HOOK.exists(), "pre-merge-commit is missing — merges bypass every rule")
        self.assertTrue(self.HOOK.stat().st_mode & 0o111, "pre-merge-commit is not executable")

    def test_it_runs_the_same_checks_as_a_commit(self):
        body = self.HOOK.read_text(encoding="utf-8")
        self.assertIn("preflight-checks.sh", body)
        self.assertIn("--staged", body, "must use --staged; --paths returns after B4 and would pass anything")

    def test_git_really_fires_this_hook_on_a_merge(self):
        """The load-bearing assumption. If git ever stopped firing it, the hook
        would sit in the tree looking like protection while protecting nothing."""
        import tempfile

        def git(*args, cwd):
            return subprocess.run(["git", *args], cwd=cwd, capture_output=True, text=True)

        with tempfile.TemporaryDirectory() as tmp:
            repo, hooks = Path(tmp) / "r", Path(tmp) / "h"
            hooks.mkdir()
            (hooks / "pre-merge-commit").write_text('#!/bin/sh\necho FIRED >&2\nexit 1\n', encoding="utf-8")
            (hooks / "pre-merge-commit").chmod(0o755)
            repo.mkdir()
            git("init", "-q", ".", cwd=repo)
            for k, v in (("user.email", "t@t"), ("user.name", "t"), ("core.hooksPath", str(hooks))):
                git("config", k, v, cwd=repo)
            (repo / "a.txt").write_text("base", encoding="utf-8")
            git("add", "-A", cwd=repo); git("commit", "-qm", "base", cwd=repo)
            git("checkout", "-qb", "feature", cwd=repo)
            (repo / "b.txt").write_text("x", encoding="utf-8")
            git("add", "-A", cwd=repo); git("commit", "-qm", "feat", cwd=repo)
            git("checkout", "-q", "-", cwd=repo)
            (repo / "c.txt").write_text("y", encoding="utf-8")
            git("add", "-A", cwd=repo); git("commit", "-qm", "other", cwd=repo)

            before = git("rev-parse", "HEAD", cwd=repo).stdout.strip()
            merged = git("merge", "--no-ff", "feature", "-m", "m", cwd=repo)
            self.assertIn("FIRED", merged.stderr, "git did not run pre-merge-commit on a merge")
            after = git("rev-parse", "HEAD", cwd=repo).stdout.strip()
            self.assertEqual(before, after, "a refusing hook did not stop the merge commit")

if __name__ == "__main__":
    unittest.main()
