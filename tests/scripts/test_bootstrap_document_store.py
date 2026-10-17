"""scripts/bootstrap-document-store.sh — the host side of the document store.

The control plane runs in a full VM, so it inherits nothing from the Proxmox
host's mount table the way a trip's LXC does through `mp0`. This script is what
gives such a host the export, and these tests hold it to the two properties
that decide whether an operator can trust it: it REFUSES rather than guessing
infrastructure, and re-running it changes nothing.

The checks it verifies are the ones the product enforces at runtime —
`check_document_store()` in `control_plane_worker/document_handoff.py` and
`checkDocumentStore` in `document-store.ts`. The marker name is asserted here
against those, because three copies of a literal is exactly how a store silently
stops being recognised.
"""
from __future__ import annotations

import os
import re
import subprocess
import tempfile
import unittest
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
SCRIPT = REPO / "scripts" / "bootstrap-document-store.sh"
WORKER_HANDOFF = REPO / "control-plane" / "worker" / "control_plane_worker" / "document_handoff.py"

BASE_ENV = {
    "DOCUMENT_STORE_NFS_SOURCE": "truenas.example:/mnt/pool/kinerary",
    "DOCUMENT_STORE_MOUNT": "/srv/kinerary-nfs",
}


def run(args, env=None, cwd=None):
    merged = {"PATH": os.environ.get("PATH", "/usr/bin:/bin"), "HOME": os.environ.get("HOME", "/tmp")}
    merged.update(env or {})
    return subprocess.run(
        ["bash", str(SCRIPT), *args],
        capture_output=True, text=True, env=merged, cwd=cwd or str(REPO),
    )


class RefusesRatherThanGuessing(unittest.TestCase):
    """A bootstrap that defaults to somebody's machine is worse than none."""

    def test_without_a_source_it_refuses_and_names_the_variable(self):
        env = dict(BASE_ENV)
        del env["DOCUMENT_STORE_NFS_SOURCE"]
        result = run(["--check"], env)
        self.assertEqual(result.returncode, 1, result.stdout + result.stderr)
        self.assertIn("DOCUMENT_STORE_NFS_SOURCE", result.stderr)
        self.assertIn("never guesses", result.stderr)

    def test_without_a_mount_it_refuses(self):
        env = dict(BASE_ENV)
        del env["DOCUMENT_STORE_MOUNT"]
        result = run(["--check"], env)
        self.assertEqual(result.returncode, 1)
        self.assertIn("DOCUMENT_STORE_MOUNT", result.stderr)

    def test_a_source_that_is_not_host_colon_export_is_refused(self):
        env = dict(BASE_ENV, DOCUMENT_STORE_NFS_SOURCE="/mnt/pool/kinerary")
        result = run(["--check"], env)
        self.assertEqual(result.returncode, 1)
        self.assertIn("<host>:/<export>", result.stderr)

    def test_a_relative_mount_is_refused(self):
        env = dict(BASE_ENV, DOCUMENT_STORE_MOUNT="srv/kinerary-nfs")
        result = run(["--check"], env)
        self.assertEqual(result.returncode, 1)
        self.assertIn("must be absolute", result.stderr)

    def test_a_root_outside_the_mount_is_refused(self):
        """KINERARY_NFS_ROOT pointing off the mount is how documents land on a
        local disk that a redeploy throws away."""
        env = dict(BASE_ENV, DOCUMENT_STORE_ROOT="/var/lib/elsewhere")
        result = run(["--check"], env)
        self.assertEqual(result.returncode, 1)
        self.assertIn("must live under the mount", result.stderr)

    def test_apply_without_root_refuses_instead_of_half_running(self):
        if os.geteuid() == 0:
            self.skipTest("running as root; this asserts the non-root refusal")
        result = run([], BASE_ENV)
        self.assertEqual(result.returncode, 1)
        self.assertIn("needs root", result.stderr)


class ReportsTheContractItCannotYetSatisfy(unittest.TestCase):
    def test_check_on_a_host_without_the_export_fails_with_named_reasons(self):
        """--check never changes anything, and says which contract condition fails
        using the product's own vocabulary."""
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp) / "not-mounted"
            env = dict(BASE_ENV, DOCUMENT_STORE_MOUNT=str(root), DOCUMENT_STORE_ROOT=str(root))
            result = run(["--check"], env)
            self.assertEqual(result.returncode, 1, result.stdout)
            self.assertIn("MISSING", result.stdout)
            self.assertIn("NO_MARKER", result.stdout)
            self.assertFalse(root.exists(), "--check created something")

    def test_a_satisfied_directory_passes_every_condition_but_the_mount(self):
        """A directory with a marker satisfies configured/exists/dir/marker/writable.
        On a developer machine it still sits under a real mount, so the whole
        contract passes — which is what lets this be tested off a VM at all."""
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp) / "store"
            root.mkdir()
            (root / ".kinerary-document-store").mkdir()
            env = dict(BASE_ENV, DOCUMENT_STORE_MOUNT=str(root), DOCUMENT_STORE_ROOT=str(root))
            result = run(["--check"], env)
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
            self.assertIn("contract satisfied", result.stdout)

    def test_a_marker_FILE_is_rejected_because_the_provisioner_needs_a_directory(self):
        """The nastiest shape of this bug: both readiness checks only stat() the
        marker, so a file passes them and the provisioner then fails creating
        trip_<id> inside it. Caught here, where it is cheap."""
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp) / "store"
            root.mkdir()
            (root / ".kinerary-document-store").write_text("not a directory\n")
            env = dict(BASE_ENV, DOCUMENT_STORE_MOUNT=str(root), DOCUMENT_STORE_ROOT=str(root))
            result = run(["--check"], env)
            self.assertEqual(result.returncode, 1, result.stdout)
            self.assertIn("NOT_A_DIRECTORY", result.stdout)
            self.assertIn("trip_<id> inside it", result.stdout)

    def test_a_marker_directory_accepts_a_trip_folder(self):
        """What the provisioner will actually do on the real volume."""
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp) / "store"
            root.mkdir()
            (root / ".kinerary-document-store").mkdir()
            env = dict(BASE_ENV, DOCUMENT_STORE_MOUNT=str(root), DOCUMENT_STORE_ROOT=str(root))
            result = run(["--check"], env)
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
            self.assertIn("contract satisfied", result.stdout)

    def test_a_missing_marker_alone_fails_the_contract(self):
        """The marker is the whole point: present means the real volume is here."""
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp) / "store"
            root.mkdir()
            env = dict(BASE_ENV, DOCUMENT_STORE_MOUNT=str(root), DOCUMENT_STORE_ROOT=str(root))
            result = run(["--check"], env)
            self.assertEqual(result.returncode, 1)
            self.assertIn("NO_MARKER", result.stdout)


class TheEnvFileIsDeploymentOwned(unittest.TestCase):
    def test_it_only_reports_the_value_when_given_no_file(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp) / "store"
            root.mkdir()
            (root / ".kinerary-document-store").mkdir()
            env = dict(BASE_ENV, DOCUMENT_STORE_MOUNT=str(root), DOCUMENT_STORE_ROOT=str(root))
            result = run(["--check"], env)
            self.assertIn(f"KINERARY_NFS_ROOT={root}", result.stdout)

    def test_a_conflicting_value_is_refused_rather_than_rewritten(self):
        """Changing a deployment's storage root is a decision, not a side effect."""
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp) / "store"
            root.mkdir()
            (root / ".kinerary-document-store").mkdir()
            env_file = Path(tmp) / "vm.env"
            env_file.write_text("KINERARY_REV=abc\nKINERARY_NFS_ROOT=/somewhere/else\n")
            env = dict(
                BASE_ENV,
                DOCUMENT_STORE_MOUNT=str(root),
                DOCUMENT_STORE_ROOT=str(root),
                DOCUMENT_STORE_ENV_FILE=str(env_file),
            )
            result = run(["--check"], env)
            self.assertEqual(result.returncode, 1)
            self.assertIn("/somewhere/else", result.stderr)
            self.assertIn("KINERARY_NFS_ROOT=/somewhere/else", env_file.read_text())

    def test_an_already_correct_value_is_left_alone(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp) / "store"
            root.mkdir()
            (root / ".kinerary-document-store").mkdir()
            env_file = Path(tmp) / "vm.env"
            env_file.write_text(f"KINERARY_NFS_ROOT={root}\n")
            before = env_file.read_text()
            env = dict(
                BASE_ENV,
                DOCUMENT_STORE_MOUNT=str(root),
                DOCUMENT_STORE_ROOT=str(root),
                DOCUMENT_STORE_ENV_FILE=str(env_file),
            )
            result = run(["--check"], env)
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
            self.assertEqual(env_file.read_text(), before, "an idempotent run rewrote the env file")


class OneMarkerNameAcrossThreeLanguages(unittest.TestCase):
    def test_the_script_and_the_worker_agree_on_the_marker(self):
        """bash, Python and TypeScript each hold this literal. They must match,
        and nothing but a test can enforce that across three languages.

        The worker's copy arrives with the document-intake work (PR #92). Until
        then there is nothing to compare against, so this skips — and starts
        guarding by itself the moment the counterpart lands, rather than being
        a check somebody has to remember to write then.
        """
        script_marker = re.search(r'^MARKER="([^"]+)"', SCRIPT.read_text(), re.M)
        self.assertIsNotNone(script_marker, "the script no longer defines MARKER at the top")

        if not WORKER_HANDOFF.exists():
            self.skipTest(
                f"{WORKER_HANDOFF.relative_to(REPO)} is not on this branch yet (it arrives with the "
                f"document-intake work); this guard activates when it does. The script says "
                f"{script_marker.group(1)!r}."
            )

        worker_marker = re.search(r'^DOCUMENT_STORE_MARKER = "([^"]+)"', WORKER_HANDOFF.read_text(), re.M)
        self.assertIsNotNone(worker_marker, "document_handoff.py no longer defines DOCUMENT_STORE_MARKER")
        self.assertEqual(
            script_marker.group(1), worker_marker.group(1),
            "the bootstrap writes a marker the product will not recognise",
        )


class TheScriptIsSyntacticallySound(unittest.TestCase):
    def test_bash_parses_it(self):
        result = subprocess.run(["bash", "-n", str(SCRIPT)], capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_it_names_no_real_infrastructure(self):
        """Hard rule 6. The mechanism lives here; the addresses live in
        kinerary-deploy. A literal IP or a real hostname in this file means the
        next deployment has to edit it."""
        body = SCRIPT.read_text()
        self.assertNotRegex(body, r"\b(?:10|172|192)\.\d{1,3}\.\d{1,3}\.\d{1,3}\b")
        self.assertNotIn("/opt/kinerary-deploy", body)


if __name__ == "__main__":
    unittest.main()
