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
# A verbatim copy of the Dockerfile in the pristine snapshot (`/opt/hermes-src`
# on the VM, read 2026-09-28). A synthetic file with the same context would prove
# nothing about whether a patch applies to the real one.
PRISTINE_DOCKERFILE = REPO / "tests/scripts/fixtures/hermes-src/Dockerfile"

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


class TheDockerfilePatchAppliesToTheRealDockerfile(unittest.TestCase):
    """0003 adds `postgresql-client` because the fleet monitor's MCP shells out
    to `psql` and the Hermes image has none. The fork is not ours, so the only
    proof the patch lands is applying it, at fuzz 0, to the real Dockerfile.

    The other patches edit gateway/ and tools/ files that this one-file fixture
    does not carry, so the set handed to the script here is the patches that
    touch the Dockerfile — today one; any future one is picked up by the glob and
    has to apply in order onto the same copy."""

    def setUp(self) -> None:
        self.work = Path(tempfile.mkdtemp(prefix="hermes-dockerfile-test-"))
        self.tree = self.work / "src"
        self.tree.mkdir()
        shutil.copy(PRISTINE_DOCKERFILE, self.tree / "Dockerfile")
        self.only = self.work / "dockerfile-patches"
        self.only.mkdir()
        for p in patch_files():
            if "+++ b/Dockerfile" in p.read_text():
                shutil.copy(p, self.only / p.name)

    def tearDown(self) -> None:
        shutil.rmtree(self.work, ignore_errors=True)

    def apply_to_the_fixture(self) -> subprocess.CompletedProcess[str]:
        return subprocess.run(
            ["bash", str(BUILD), "--patches", str(self.only), "--apply-only", str(self.tree)],
            capture_output=True, text=True,
        )

    def patched_stages(self) -> tuple[str, str]:
        """(everything before the runtime stage's FROM, the runtime stage)."""
        result = self.apply_to_the_fixture()
        self.assertEqual(result.returncode, 0, result.stderr)
        lines = (self.tree / "Dockerfile").read_text().splitlines(keepends=True)
        froms = [i for i, line in enumerate(lines) if line.startswith("FROM debian:")]
        self.assertEqual(len(froms), 2, "expected the sqlite_build stage and the runtime stage")
        return "".join(lines[: froms[-1]]), "".join(lines[froms[-1]:])

    def test_0003_is_in_the_set_and_is_a_dockerfile_patch(self) -> None:
        named = [p for p in patch_files() if p.name.startswith("0003-postgresql-client")]
        self.assertEqual(len(named), 1, [p.name for p in patch_files()])
        text = named[0].read_text()
        self.assertIn("--- a/Dockerfile", text)
        self.assertIn("+++ b/Dockerfile", text)

    def test_the_dockerfile_patches_apply_cleanly_to_the_pristine_dockerfile(self) -> None:
        self.assertTrue(list(self.only.glob("*.patch")), "no patch in the set touches the Dockerfile")
        result = self.apply_to_the_fixture()
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_the_runtime_stage_installs_postgresql_client_and_the_build_stage_does_not(self) -> None:
        build_stage, runtime_stage = self.patched_stages()
        self.assertIn("postgresql-client", runtime_stage)
        self.assertNotIn("postgresql-client", build_stage,
                         "the sqlite_build stage is discarded — psql there reaches nobody")

    def test_it_extends_the_existing_install_and_keeps_no_install_recommends(self) -> None:
        _, runtime_stage = self.patched_stages()
        lines = runtime_stage.splitlines()
        hits = [i for i, line in enumerate(lines) if "postgresql-client" in line]
        self.assertEqual(len(hits), 1, "postgresql-client must appear exactly once in the runtime stage")
        self.assertIn("install -y --no-install-recommends", lines[hits[0] - 1])
        self.assertIn("ca-certificates", lines[hits[0]])
        self.assertIn("docker-cli", lines[hits[0]], "the existing package list must be kept whole")

    def test_nothing_else_in_the_dockerfile_changes(self) -> None:
        self.patched_stages()
        before = PRISTINE_DOCKERFILE.read_text().splitlines()
        after = (self.tree / "Dockerfile").read_text().splitlines()
        self.assertEqual(len(before), len(after), "an edit of one line, not a new layer")
        changed = [(b, a) for b, a in zip(before, after) if b != a]
        self.assertEqual(len(changed), 1, changed)
        self.assertEqual(changed[0][1].replace(" postgresql-client", "", 1), changed[0][0])


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


class CheckingThatPsqlIsInsideTheRunningImage(unittest.TestCase):
    """The patch is only worth carrying if `psql` is really in what runs: the
    fleet monitor's bootstrap refuses without it, and a monitor that cannot
    reach the database reports nothing, which reads like a healthy fleet. The
    check asks the image itself, through a stand-in `docker` on PATH."""

    FAKE_DOCKER = """#!/bin/sh
# Stand-in for docker: `exec`/`run` answer the manifest read and the psql probe.
case "$*" in
  *"command -v psql"*) [ "$FAKE_PSQL" = present ] && { echo /usr/bin/psql; exit 0; } || exit 1 ;;
  *) cat "$FAKE_MANIFEST" ;;
esac
"""

    def setUp(self) -> None:
        self.work = Path(tempfile.mkdtemp(prefix="hermes-check-test-"))
        bin_dir = self.work / "bin"
        bin_dir.mkdir()
        docker = bin_dir / "docker"
        docker.write_text(self.FAKE_DOCKER)
        docker.chmod(0o755)
        (self.work / "manifest").write_text(manifest_for(patch_files()))
        self.bin = bin_dir

    def tearDown(self) -> None:
        shutil.rmtree(self.work, ignore_errors=True)

    def run_check(self, psql: str, *args: str) -> subprocess.CompletedProcess[str]:
        env = dict(os.environ, PATH=f"{self.bin}:{os.environ['PATH']}",
                   FAKE_PSQL=psql, FAKE_MANIFEST=str(self.work / "manifest"))
        return subprocess.run(["bash", str(CHECK), *args], capture_output=True, text=True, env=env)

    def test_a_running_container_with_psql_passes(self) -> None:
        result = self.run_check("present")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("psql", result.stdout)

    def test_a_running_container_without_psql_fails_and_names_the_fix(self) -> None:
        result = self.run_check("absent")
        self.assertNotEqual(result.returncode, 0, "a manifest match must not hide a missing psql")
        self.assertIn("psql", result.stderr)
        self.assertIn("0003-postgresql-client", result.stderr)
        self.assertIn("never", result.stderr)  # never install into the running container

    def test_an_image_argument_is_probed_the_same_way(self) -> None:
        self.assertEqual(self.run_check("present", "some/image:tag").returncode, 0)
        result = self.run_check("absent", "some/image:tag")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("psql", result.stderr)


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
