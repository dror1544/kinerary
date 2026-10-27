"""build-hermes-image.sh installs pytest into the built image before running the
patched tests — and that step must not be able to fail silently (issue #379).

It used to run `uv pip install ... >/dev/null 2>&1; ...` and ignore the result.
Newer Hermes images do not ship `uv`, so the install did nothing, no one saw the
error, and the next line failed with "No module named pytest" — a message about
the wrong thing. Now: uv if the image has it, else the venv's own pip (bootstrapped
with ensurepip), output visible, and a failed install stops the build with its own
message.

A fake `docker` on PATH stands in for the daemon. For the one `docker run` that
executes the install script it runs that script for real under `sh`, with
/opt/hermes pointed at a fixture venv whose `python` (and, in some cases, `uv`)
are stubs that log what they were asked. Nothing here builds an image or contacts
any host.
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
BUILD = REPO / "control-plane/deployment/build-hermes-image.sh"

FAKE_DOCKER = r"""#!/bin/sh
# argv: build ... | run --rm --entrypoint sh [-v X -w Y -e Z] TAG -lc SCRIPT
case "$1" in
  build) exit 0 ;;
  run)
    for last; do :; done
    case "$last" in
      "cat /opt/hermes/.kinerary-patches") cat "$FAKE_MANIFEST"; exit 0 ;;
    esac
    script=$(printf '%s' "$last" | sed "s|/opt/hermes|$FAKE_ROOT|g")
    cd "$FAKE_ROOT" || exit 1
    PATH="$FAKE_CONTAINER_PATH" exec sh -c "$script"
    ;;
esac
exit 0
"""

FAKE_PYTHON = r"""#!/bin/sh
echo "python $*" >> "$FAKE_LOG"
case "$*" in
  "-m pip --version") [ -f "$FAKE_ROOT/pip-bootstrapped" ] || [ -n "$FAKE_PIP_PRESENT" ]; exit $? ;;
  "-m ensurepip"*) touch "$FAKE_ROOT/pip-bootstrapped"; exit 0 ;;
  "-m pip install"*)
    if [ -n "$FAKE_PIP_FAIL" ]; then echo "ERROR: could not reach the package index" >&2; exit 1; fi
    exit 0 ;;
esac
exit 0
"""

FAKE_UV = r"""#!/bin/sh
echo "uv $*" >> "$FAKE_LOG"
if [ -n "$FAKE_UV_FAIL" ]; then echo "error: uv could not resolve pytest" >&2; exit 2; fi
exit 0
"""


def write_exec(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text)
    path.chmod(0o755)


class PytestInstallInTheBuiltImage(unittest.TestCase):
    def setUp(self) -> None:
        self.work = Path(tempfile.mkdtemp(prefix="hermes-build-pytest-"))
        self.addCleanup(shutil.rmtree, self.work, ignore_errors=True)
        self.source = self.work / "src"
        (self.source / "tests").mkdir(parents=True)
        (self.source / "tests/test_thing.py").write_text("one\ntwo\nthree\n")
        after = self.work / "after.py"
        after.write_text("one\nPATCHED\nthree\n")
        # The patch names a file under tests/, which is what makes the build run pytest.
        diff = subprocess.run(
            ["diff", "-u", "--label", "a/tests/test_thing.py", "--label", "b/tests/test_thing.py",
             str(self.source / "tests/test_thing.py"), str(after)],
            capture_output=True, text=True).stdout
        self.patches = self.work / "patches"
        self.patches.mkdir()
        patch = self.patches / "0001-fixture.patch"
        patch.write_text(diff)
        self.manifest = self.work / "manifest"
        self.manifest.write_text(f"{hashlib.sha256(patch.read_bytes()).hexdigest()}  {patch.name}\n")

        self.root = self.work / "opt-hermes"
        write_exec(self.root / ".venv/bin/python", FAKE_PYTHON)
        self.bin = self.work / "bin"
        write_exec(self.bin / "docker", FAKE_DOCKER)
        self.uv_dir = self.work / "uvbin"
        self.log = self.work / "log"
        self.log.write_text("")

    def build(self, with_uv: bool = False, **extra: str) -> subprocess.CompletedProcess[str]:
        container_path = "/usr/bin:/bin"
        if with_uv:
            write_exec(self.uv_dir / "uv", FAKE_UV)
            container_path = f"{self.uv_dir}:{container_path}"
        # The stub `docker` first, then what bash, patch and sha256sum need.
        env = {**os.environ, "PATH": f"{self.bin}:/usr/bin:/bin:/sbin:/usr/sbin",
               "FAKE_ROOT": str(self.root), "FAKE_LOG": str(self.log), "FAKE_MANIFEST": str(self.manifest),
               "FAKE_CONTAINER_PATH": container_path, **extra}
        return subprocess.run(
            ["bash", str(BUILD), "--patches", str(self.patches), "--source", str(self.source),
             "--base-rev", "abc1234"],
            capture_output=True, text=True, env=env, timeout=60)

    def calls(self) -> list[str]:
        return self.log.read_text().splitlines()

    def test_without_uv_it_uses_the_venv_pip_after_ensurepip(self) -> None:
        result = self.build()
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        calls = self.calls()
        ensure = next(i for i, c in enumerate(calls) if c.startswith("python -m ensurepip"))
        install = next(i for i, c in enumerate(calls) if c.startswith("python -m pip install"))
        pytest_run = next(i for i, c in enumerate(calls) if c.startswith("python -m pytest"))
        self.assertLess(ensure, install)
        self.assertLess(install, pytest_run)
        self.assertFalse([c for c in calls if c.startswith("uv ")])

    def test_ensurepip_is_skipped_when_the_venv_already_has_pip(self) -> None:
        result = self.build(FAKE_PIP_PRESENT="1")
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertFalse([c for c in self.calls() if "ensurepip" in c])

    def test_uv_is_used_when_the_image_ships_it(self) -> None:
        result = self.build(with_uv=True)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        calls = self.calls()
        self.assertTrue([c for c in calls if c.startswith("uv pip install")])
        self.assertFalse([c for c in calls if c.startswith("python -m pip install")])

    def test_a_failed_pip_install_stops_the_build_and_shows_why(self) -> None:
        result = self.build(FAKE_PIP_FAIL="1")
        self.assertNotEqual(result.returncode, 0, "a failed pytest install must not be ignored")
        out = result.stdout + result.stderr
        self.assertIn("could not reach the package index", out, "the installer's own error is discarded")
        self.assertIn("could not install pytest", out)
        self.assertFalse([c for c in self.calls() if c.startswith("python -m pytest")],
                         "the tests must not run on an image that has no pytest")
        self.assertNotIn("built and verified", out)

    def test_a_failed_uv_install_stops_the_build_and_shows_why(self) -> None:
        result = self.build(with_uv=True, FAKE_UV_FAIL="1")
        self.assertNotEqual(result.returncode, 0)
        out = result.stdout + result.stderr
        self.assertIn("uv could not resolve pytest", out)
        self.assertIn("could not install pytest", out)


if __name__ == "__main__":
    unittest.main()
