"""The Hermes patches we carry are applied by something, and provably so.

The fork has no remote and `/opt/hermes-src` is a history-less snapshot, so
`control-plane/deployment/hermes-patches/` is the only copy of what we add to
it. On 2026-09-18 that directory held the patch that makes the runtime read
`HERMES_RELAY_MEDIA_DIR` while nothing in the repo applied it: no Dockerfile,
no compose build, no script. `compose.vm.yml` was changed to set the variable
in the same breath. Nothing would have failed loudly — media would have gone on
landing in the container's own /tmp, where the host's trip-mcp cannot open it —
and no check of the compose file could tell, because what was wrong was the
contents of an image.

So the build applies every patch in that directory, refuses a tree that is not
pristine, and stamps a manifest that `hermes-image-check.sh` reads back out of
whatever is actually running.
"""
from __future__ import annotations

import hashlib
import os
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
DEPLOYMENT = REPO / "control-plane/deployment"
PATCHES = DEPLOYMENT / "hermes-patches"
BUILD = DEPLOYMENT / "build-hermes-image.sh"
CHECK = DEPLOYMENT / "hermes-image-check.sh"
MANIFEST = ".kinerary-patches"

FIXTURE_BEFORE = "one\ntwo\nthree\nfour\nfive\n"
FIXTURE_AFTER = "one\ntwo\nPATCHED\nfour\nfive\n"


def patch_files() -> list[Path]:
    return sorted(PATCHES.glob("*.patch"))


def manifest_for(files: list[Path]) -> str:
    return "".join(
        f"{hashlib.sha256(f.read_bytes()).hexdigest()}  {f.name}\n" for f in files
    )


class ApplyingAFixturePatchSet(unittest.TestCase):
    """Drive the real script with a patch set built here, so the invariants are
    exercised rather than read off the source."""

    def setUp(self) -> None:
        self.work = Path(tempfile.mkdtemp(prefix="hermes-patch-test-"))
        self.patches = self.work / "patches"
        self.patches.mkdir()
        self.tree = self.work / "src"
        (self.tree / "gateway").mkdir(parents=True)
        (self.tree / "gateway/thing.py").write_text(FIXTURE_BEFORE)

        after = self.work / "after"
        (after / "gateway").mkdir(parents=True)
        (after / "gateway/thing.py").write_text(FIXTURE_AFTER)
        diff = subprocess.run(
            ["diff", "-u", "--label", "a/gateway/thing.py", "--label", "b/gateway/thing.py",
             str(self.tree / "gateway/thing.py"), str(after / "gateway/thing.py")],
            capture_output=True, text=True,
        )
        (self.patches / "0001-fixture.patch").write_text(diff.stdout)

    def tearDown(self) -> None:
        shutil.rmtree(self.work, ignore_errors=True)

    def apply(self, tree: Path | None = None) -> subprocess.CompletedProcess[str]:
        return subprocess.run(
            ["bash", str(BUILD), "--patches", str(self.patches),
             "--apply-only", str(tree or self.tree)],
            capture_output=True, text=True,
        )

    def test_the_patch_is_applied_and_the_manifest_written(self) -> None:
        result = self.apply()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual((self.tree / "gateway/thing.py").read_text(), FIXTURE_AFTER)
        self.assertEqual(
            (self.tree / MANIFEST).read_text(),
            manifest_for(sorted(self.patches.glob("*.patch"))),
        )

    def test_a_second_patch_added_to_the_directory_is_applied_too(self) -> None:
        """Adding a patch file is the whole act of carrying it — no script edit."""
        (self.tree / "gateway/other.py").write_text("alpha\nbeta\n")
        other_after = self.work / "other-after.py"
        other_after.write_text("alpha\nGAMMA\n")
        diff = subprocess.run(
            ["diff", "-u", "--label", "a/gateway/other.py", "--label", "b/gateway/other.py",
             str(self.tree / "gateway/other.py"), str(other_after)],
            capture_output=True, text=True,
        )
        (self.patches / "0002-fixture-two.patch").write_text(diff.stdout)

        result = self.apply()

        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual((self.tree / "gateway/other.py").read_text(), "alpha\nGAMMA\n")
        self.assertIn("0002-fixture-two.patch", (self.tree / MANIFEST).read_text())

    def test_a_tree_that_is_already_patched_is_refused(self) -> None:
        """An already-patched source means the snapshot was edited by hand, and
        the next `git archive` refresh would drop those edits silently."""
        self.assertEqual(self.apply().returncode, 0)

        second = self.apply()

        self.assertNotEqual(second.returncode, 0, "patches must not stack onto a patched tree")
        self.assertIn("does not apply cleanly", second.stderr)
        self.assertIn("pristine snapshot", second.stderr)

    def test_a_patch_that_does_not_apply_stops_the_build(self) -> None:
        (self.tree / "gateway/thing.py").write_text("nothing like the fork\n")
        result = self.apply()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("does not apply cleanly", result.stderr)
        self.assertFalse((self.tree / MANIFEST).exists(), "a failed run leaves no manifest")

    def test_an_empty_patch_directory_is_an_error_not_a_quiet_pass(self) -> None:
        for patch in self.patches.glob("*.patch"):
            patch.unlink()
        result = self.apply()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("no patches", result.stderr)

    def test_the_manifest_changes_when_a_patch_changes(self) -> None:
        """The image tag is derived from this, so a stale image cannot answer to
        a new patch set's name."""
        self.assertEqual(self.apply().returncode, 0)
        first = (self.tree / MANIFEST).read_text()

        patch = self.patches / "0001-fixture.patch"
        patch.write_text(patch.read_text().replace("PATCHED", "PATCHED2"))
        fresh = self.work / "src2"
        (fresh / "gateway").mkdir(parents=True)
        (fresh / "gateway/thing.py").write_text(FIXTURE_BEFORE)
        self.assertEqual(self.apply(fresh).returncode, 0)

        self.assertNotEqual(first, (fresh / MANIFEST).read_text())


class CheckingWhatIsActuallyRunning(unittest.TestCase):
    """`hermes-image-check.sh` answers the question compose cannot: not which
    tag is named, but what is inside it."""

    def run_check(self, manifest: str) -> subprocess.CompletedProcess[str]:
        with tempfile.NamedTemporaryFile("w", suffix=".manifest", delete=False) as fh:
            fh.write(manifest)
            path = fh.name
        try:
            return subprocess.run(["bash", str(CHECK), "--manifest", path],
                                  capture_output=True, text=True)
        finally:
            os.unlink(path)

    def test_this_checkouts_patch_set_passes(self) -> None:
        result = self.run_check(manifest_for(patch_files()))
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_an_image_that_was_never_patched_fails(self) -> None:
        result = self.run_check("")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("carries no patch manifest", result.stderr)

    def test_an_image_missing_a_patch_fails(self) -> None:
        lines = manifest_for(patch_files()).splitlines()
        result = self.run_check("\n".join(lines[:-1]) + "\n")
        self.assertNotEqual(result.returncode, 0, "a patch missing from the image must be caught")

    def test_an_image_built_from_an_edited_patch_fails(self) -> None:
        lines = manifest_for(patch_files()).splitlines()
        stale = ["0" * 64 + lines[0][64:]] + lines[1:]
        result = self.run_check("\n".join(stale) + "\n")
        self.assertNotEqual(result.returncode, 0, "contents, not just names, must match")


class TheRepoKeepsThemConnected(unittest.TestCase):
    def test_there_are_patches_to_carry(self) -> None:
        self.assertTrue(patch_files(), "no patches — has the directory moved?")

    def test_the_build_globs_the_directory_rather_than_listing_patches(self) -> None:
        script = BUILD.read_text()
        self.assertIn("-name '*.patch'", script)
        for patch in patch_files():
            self.assertNotIn(patch.name, script,
                             f"{patch.name} is named in the script; the directory is globbed")

    def test_the_runbook_sends_people_to_both_scripts(self) -> None:
        runbook = (REPO / "docs/control-plane-vm-deployment.md").read_text()
        self.assertIn("build-hermes-image.sh", runbook)
        self.assertIn("hermes-image-check.sh", runbook)

    def test_the_scripts_are_executable(self) -> None:
        for script in (BUILD, CHECK):
            self.assertTrue(os.access(script, os.X_OK), f"{script.name} is not executable")


if __name__ == "__main__":
    unittest.main()
