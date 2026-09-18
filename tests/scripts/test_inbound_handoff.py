"""Files sent on Telegram can reach a trip site: the hand-off folder.

A companion receives a file as a path Hermes saved it to. The trip-mcp tools
that upload a file take a path on the machine running mcp.js — the VM HOST —
while Hermes runs in a container. Until 2026-09-17 Hermes saved into its own
/tmp, a path that did not exist where the upload ran, so no booking PDF or photo
sent on Telegram could be put on a site.

What these tests hold the deployment to:
  - Hermes saves received media into a folder mounted at the identical path
    inside and out — and names that folder for media ALONE, not by moving the
    whole runtime's TMPDIR there, which would leave every other temporary file
    in a host-persistent directory whose janitor does not collect them;
  - that folder is created for uid 10000 before Hermes starts (Docker would
    otherwise create it for root, and the gateways could not write to it);
  - the sweep removes only old `relay_media_*` files, and nothing else.
"""
from __future__ import annotations

import os
import shutil
import subprocess
import tempfile
import time
import unittest
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
COMPOSE = REPO / "control-plane/deployment/compose.vm.yml"
# The one directory Hermes is told to put received media in — read by the fork
# through control-plane/deployment/hermes-patches/0002-relay-media-dir.patch.
MEDIA_DIR_ENV = "HERMES_RELAY_MEDIA_DIR"
SWEEP = REPO / "control-plane/deployment/inbound-sweep.sh"

try:
    import yaml  # type: ignore
except ImportError:  # pragma: no cover — preflight provides it
    yaml = None


def _age(path: Path, minutes: float) -> None:
    then = time.time() - minutes * 60
    os.utime(path, (then, then))


class SweepRemovesOnlyOldTelegramFiles(unittest.TestCase):
    def setUp(self) -> None:
        self.dir = Path(tempfile.mkdtemp(prefix="inbound-sweep-test-"))

    def tearDown(self) -> None:
        shutil.rmtree(self.dir, ignore_errors=True)

    def sweep(self, *args: str) -> subprocess.CompletedProcess[str]:
        return subprocess.run(["sh", str(SWEEP), *args], capture_output=True, text=True)

    def test_parses_as_posix_sh(self) -> None:
        result = subprocess.run(["sh", "-n", str(SWEEP)], capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_old_telegram_files_go_and_everything_else_stays(self) -> None:
        old_pdf = self.dir / "relay_media_abc123.pdf"
        fresh_pdf = self.dir / "relay_media_def456.pdf"
        old_other = self.dir / "pip-build-xyz"  # some other tool's temp file
        nested = self.dir / "sub"
        nested.mkdir()
        old_nested = nested / "relay_media_nested.pdf"
        for path in (old_pdf, fresh_pdf, old_other, old_nested):
            path.write_bytes(b"%PDF-1.4 test")
        _age(old_pdf, 2 * 24 * 60)
        _age(fresh_pdf, 60)
        _age(old_other, 7 * 24 * 60)
        _age(old_nested, 7 * 24 * 60)

        result = self.sweep(str(self.dir), "1440")
        self.assertEqual(result.returncode, 0, result.stderr)

        self.assertFalse(old_pdf.exists(), "a day-old Telegram file is swept")
        self.assertTrue(fresh_pdf.exists(), "a file from this hour may still be in use")
        self.assertTrue(old_other.exists(), "not a Telegram file — not ours to delete")
        self.assertTrue(old_nested.exists(), "top level only")

    def test_refuses_a_missing_directory_or_a_bad_age(self) -> None:
        self.assertEqual(self.sweep(str(self.dir / "nope")).returncode, 2)
        self.assertEqual(self.sweep(str(self.dir), "1d").returncode, 2)
        self.assertNotEqual(self.sweep().returncode, 0)


@unittest.skipIf(yaml is None, "PyYAML not installed")
class ComposeSharesTheFolderAtOnePath(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.services = yaml.safe_load(COMPOSE.read_text())["services"]

    @staticmethod
    def mounts(service: dict) -> dict[str, str]:
        out: dict[str, str] = {}
        for volume in service.get("volumes", []):
            if isinstance(volume, str):
                source, target = volume.split(":")[:2]
                out[target] = source
        return out

    def test_hermes_saves_where_the_host_reads(self) -> None:
        hermes = self.services["hermes"]
        inbox = hermes["environment"][MEDIA_DIR_ENV]
        self.assertTrue(inbox.startswith("/"), inbox)
        self.assertEqual(
            self.mounts(hermes).get(inbox), inbox,
            f"{MEDIA_DIR_ENV} must be bind-mounted from the identical host path — "
            "trip-mcp on the host opens exactly the path Hermes hands the agent",
        )
        self.assertNotEqual(inbox, "/tmp")
        self.assertFalse(inbox.startswith("/opt/data"), "not inside the profiles volume")

    def test_only_media_is_redirected_there(self) -> None:
        """The hand-off folder is host-persistent and swept by name, so only the
        files that sweep names may be sent to it. TMPDIR would send everything."""
        hermes = self.services["hermes"]
        self.assertNotIn(
            "TMPDIR", hermes["environment"],
            "TMPDIR moves every temporary file the runtime makes into a folder "
            f"chosen for received media; name {MEDIA_DIR_ENV} instead (Hermes patch 0002)",
        )

    def test_the_folder_is_ready_for_the_gateways_before_hermes_starts(self) -> None:
        hermes = self.services["hermes"]
        inbox = hermes["environment"][MEDIA_DIR_ENV]
        self.assertEqual(hermes["depends_on"]["inbound"]["condition"], "service_healthy")
        self.assertEqual(str(hermes["environment"]["HERMES_UID"]), "10000")

        inbound = self.services["inbound"]
        self.assertEqual(self.mounts(inbound).get(inbox), inbox)
        command = " ".join(inbound["command"])
        self.assertIn(f"chown 10000:10000 {inbox}", command)
        self.assertIn(f"chmod 0700 {inbox}", command)
        self.assertIn(f"inbound-sweep.sh {inbox}", command)
        self.assertIn("10000:700", " ".join(inbound["healthcheck"]["test"]))
        self.assertEqual(inbound.get("network_mode"), "none", "a janitor needs no network")

    def test_the_sweep_script_mounted_is_the_one_in_the_repo(self) -> None:
        mounts = self.mounts(self.services["inbound"])
        source = mounts.get("/usr/local/bin/inbound-sweep.sh")
        self.assertIsNotNone(source)
        self.assertEqual((COMPOSE.parent / source).resolve(), SWEEP.resolve())


if __name__ == "__main__":
    unittest.main()
