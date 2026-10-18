"""`scripts/hermes-patches.sh` tests the patch set against a Hermes tree before
anything is written to it.

Upstream Hermes moves under the patches we carry (`control-plane/deployment/
hermes-patches/`). On 2026-10-03 the Mac's Hermes went to a revision the repo's
three patches no longer applied to, and the only way to learn that had been the
image build refusing with "does not apply cleanly" — which cannot say "upstream
already fixed this" and cannot say "it applies, and its own tests fail".

These tests drive the real script against a small fixture tree and a stand-in
interpreter. The stand-in answers `-m pytest <files>` by running each file as a
plain script, so the suite does not need Hermes' dependencies — what is under
test is the script's classification and its write discipline, not pytest.
"""
from __future__ import annotations

import hashlib
import os
import shutil
import signal
import subprocess
import tempfile
import time
import unittest
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
# HERMES_PATCHES_TOOL points the suite at another copy of the script — how the
# new write-phase tests were shown to fail against the version they replaced.
TOOL = Path(os.environ.get("HERMES_PATCHES_TOOL") or REPO / "scripts/hermes-patches.sh")
BUILD = REPO / "control-plane/deployment/build-hermes-image.sh"

# macOS's own bash (3.2) where there is one: a script run over ssh or by hand gets
# whatever bash the PATH finds, and 3.2 is the strictest of them.
BASH = "/bin/bash" if Path("/bin/bash").exists() else "bash"

STOCK_THING ="def answer():\n    return 1\n"
PATCHED_THING = "def answer():\n    return 2\n"
STOCK_API = "from pkg import thing\n\n\ndef final():\n    return thing.answer()\n"
# Upstream fixed the same behaviour somewhere else, leaving the line the patch edits alone.
FIXED_API = "from pkg import thing\n\n\ndef final():\n    return max(thing.answer(), 2)\n"
TEST_ANSWER = "from pkg import api\n\nassert api.final() == 2, 'api.final() is %r' % api.final()\n"
TEST_FAILS = "assert False, 'a patched test that fails'\n"

# The stand-in interpreter: `-m pytest [options] <files>` runs each file as a script.
FAKE_PYTHON = """#!/bin/sh
[ "$1" = "-m" ] && [ "$2" = "pytest" ] || { echo "fake python: only -m pytest" >&2; exit 99; }
shift 2
files=""
while [ $# -gt 0 ]; do
  case "$1" in
    -o|-p) shift 2 ;;
    -*) shift ;;
    *) files="$files $1"; shift ;;
  esac
done
n=0
for f in $files; do
  PYTHONDONTWRITEBYTECODE=1 PYTHONPATH=. python3 "$f" || { echo "FAILED $f"; exit 1; }
  n=$((n + 1))
done
echo "$n passed"
"""

# A `patch` that delegates to the real one, except on the Nth REAL forward
# application (dry runs and reverse applications always pass through):
#   FAKE_PATCH_FAIL_AT=N     fail before writing anything — disk full, killed.
#   FAKE_PATCH_PARTIAL_AT=N  write some of the patch's files (FAKE_PATCH_PARTIAL_FILES,
#                            relative to the -d tree: append to an existing file,
#                            create a missing one, chmod 600 the first), then fail —
#                            what a patch that dies halfway leaves behind.
#   FAKE_PATCH_BLOCK_AT=N    apply the whole patch, then announce itself (pid in
#                            FAKE_PATCH_PID, then FAKE_PATCH_READY appears) and
#                            block on a FIFO nobody writes to: mid-write, until killed.
FAKE_PATCH = """#!/bin/sh
real=/usr/bin/patch
case " $* " in
  *" --dry-run "*|*" --reverse "*|*" -R "*) exec "$real" "$@" ;;
esac
dir=.
prev=""
for a in "$@"; do
  [ "$prev" = "-d" ] && dir="$a"
  prev="$a"
done
n=$(cat "$FAKE_PATCH_COUNTER" 2>/dev/null || echo 0)
n=$((n + 1))
echo "$n" > "$FAKE_PATCH_COUNTER"
[ "$n" = "$FAKE_PATCH_FAIL_AT" ] && { echo "fake patch: write failed" >&2; exit 1; }
if [ "$n" = "$FAKE_PATCH_PARTIAL_AT" ]; then
  first=1
  for f in $FAKE_PATCH_PARTIAL_FILES; do
    mkdir -p "$(dirname "$dir/$f")"
    echo "PARTIAL WRITE" >> "$dir/$f"
    [ "$first" = 1 ] && chmod 600 "$dir/$f"
    first=0
  done
  echo "fake patch: died halfway" >&2
  exit 1
fi
if [ "$n" = "$FAKE_PATCH_BLOCK_AT" ]; then
  "$real" "$@" || exit 1
  echo $$ > "$FAKE_PATCH_PID"
  : > "$FAKE_PATCH_READY"
  read -r _ < "$FAKE_PATCH_FIFO"
  exit 1
fi
exec "$real" "$@"
"""

# A `cp` that blocks the first time it writes INTO the tree (the restoration;
# the backups are written elsewhere), so a second signal can be sent while the
# restoration is under way.
FAKE_CP = """#!/bin/sh
for last; do :; done
case "$last" in
  *"$FAKE_CP_BLOCK_MATCH"*)
    if [ ! -e "$FAKE_CP_READY" ]; then
      : > "$FAKE_CP_READY"
      read -r _ < "$FAKE_CP_FIFO"
    fi ;;
esac
exec /bin/cp "$@"
"""


def snapshot(root: Path) -> dict[str, str]:
    """Every file AND directory under root, with content hash and mode — equality
    is 'nothing changed', down to a directory left behind or a chmod."""
    out: dict[str, str] = {}
    for p in sorted(root.rglob("*")):
        rel = str(p.relative_to(root))
        mode = oct(p.stat().st_mode & 0o7777)
        if p.is_file():
            out[rel] = f"{hashlib.sha256(p.read_bytes()).hexdigest()} {mode}"
        elif p.is_dir():
            out[rel + "/"] = mode
    return out


def wait_for(path: Path, what: str, timeout: float = 60.0) -> None:
    """Wait for a file a stand-in creates to say 'I am here'. Not a pause: the
    tests below act on the event, never on elapsed time."""
    deadline = time.monotonic() + timeout
    while not path.exists():
        if time.monotonic() > deadline:
            raise AssertionError(f"timed out waiting for {what}")
        time.sleep(0.01)


def unified(before: Path | None, after: Path, label: str) -> str:
    result = subprocess.run(
        ["diff", "-u", "--label", "a/" + label if before else "/dev/null", "--label", "b/" + label,
         str(before) if before else "/dev/null", str(after)],
        capture_output=True, text=True,
    )
    return result.stdout


class HermesPatchTool(unittest.TestCase):
    def setUp(self) -> None:
        self.work = Path(tempfile.mkdtemp(prefix="hermes-patches-tool-test-"))
        self.tmpdir = self.work / "tmp"          # the script's mktemp lands here, so leaks are visible
        self.tmpdir.mkdir()
        self.tree = self.work / "hermes"
        self.write(self.tree, "pkg/__init__.py", "")
        self.write(self.tree, "pkg/thing.py", STOCK_THING)
        self.write(self.tree, "pkg/api.py", STOCK_API)
        self.patches = self.work / "patches"
        self.patches.mkdir()
        self.python = self.work / "bin/python"
        self.write(self.work, "bin/python", FAKE_PYTHON)
        self.python.chmod(0o755)
        # Modes are part of "byte-identical": a patch that dies halfway may chmod.
        (self.tree / "pkg/thing.py").chmod(0o640)
        (self.tree / "pkg/api.py").chmod(0o750)
        self.make_patch("0001-answer.patch", "pkg/thing.py", STOCK_THING, PATCHED_THING, TEST_ANSWER)

    def tearDown(self) -> None:
        shutil.rmtree(self.work, ignore_errors=True)

    # ── helpers ──────────────────────────────────────────────────────────────
    def write(self, root: Path, rel: str, text: str) -> None:
        path = root / rel
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text)

    def make_patch(self, name: str, rel: str, before: str, after: str, test: str | None) -> Path:
        """A patch editing `rel` and (when given) adding tests/test_<name>.py."""
        a, b = self.work / "a", self.work / "b"
        for d in (a, b):
            shutil.rmtree(d, ignore_errors=True)
        self.write(a, rel, before)
        self.write(b, rel, after)
        text = unified(a / rel, b / rel, rel)
        if test is not None:
            test_rel = "tests/test_%s.py" % name.split(".")[0].replace("-", "_")
            self.write(b, test_rel, test)
            text += unified(None, b / test_rel, test_rel)
        out = self.patches / name
        out.write_text(text)
        return out

    def run_tool(self, mode: str, tree: Path | None = None, *, python: bool = True,
                 extra_env: dict[str, str] | None = None) -> subprocess.CompletedProcess[str]:
        env = {k: v for k, v in os.environ.items() if k != "HERMES_PATCH_PYTHON"}
        env["TMPDIR"] = str(self.tmpdir)
        if python:
            env["HERMES_PATCH_PYTHON"] = str(self.python)
        env.update(extra_env or {})
        return subprocess.run(
            [BASH, str(TOOL), mode, "--patches", str(self.patches), str(tree or self.tree)],
            capture_output=True, text=True, env=env,
        )

    def tool_env(self, extra_env: dict[str, str]) -> dict[str, str]:
        env = {k: v for k, v in os.environ.items() if k != "HERMES_PATCH_PYTHON"}
        env["TMPDIR"] = str(self.tmpdir)
        env["HERMES_PATCH_PYTHON"] = str(self.python)
        env.update(extra_env)
        return env

    def install_fake(self, name: str, text: str) -> Path:
        self.write(self.work, f"fakebin/{name}", text)
        (self.work / "fakebin" / name).chmod(0o755)
        return self.work / "fakebin"

    def two_patches(self) -> None:
        self.make_patch("0002-second.patch", "pkg/api.py", STOCK_API,
                        STOCK_API + "\n\ndef added():\n    return 1\n", None)

    def assertNoTempLeft(self) -> None:
        self.assertEqual(list(self.tmpdir.iterdir()), [], "the script left its temp directory behind")

    def apply_for_real(self, tree: Path) -> None:
        r = self.run_tool("apply", tree)
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)

    # ── one test per classification ──────────────────────────────────────────
    def test_a_patch_that_applies_is_classified_APPLIES_and_check_is_ready(self) -> None:
        r = self.run_tool("check")
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        self.assertRegex(r.stdout, r"APPLIES\s+0001-answer\.patch")
        self.assertIn("READY", r.stdout)
        self.assertNoTempLeft()

    def test_a_patch_already_in_the_tree_is_ALREADY_APPLIED_and_not_an_error(self) -> None:
        self.apply_for_real(self.tree)
        r = self.run_tool("check")
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        self.assertRegex(r.stdout, r"ALREADY-APPLIED\s+0001-answer\.patch")
        again = self.run_tool("apply")
        self.assertEqual(again.returncode, 0, again.stdout + again.stderr)
        self.assertIn("0 patch(es) written", again.stdout)

    def test_a_patch_whose_tests_already_pass_without_it_is_SUPERSEDED_and_refused(self) -> None:
        """The patch's source hunk still applies — upstream fixed the behaviour in
        another place. Its own tests pass on the tree without it; applying it
        anyway would carry a dead patch forever."""
        self.write(self.tree, "pkg/api.py", FIXED_API)
        before = snapshot(self.tree)

        for mode in ("check", "apply"):
            r = self.run_tool(mode)
            self.assertNotEqual(r.returncode, 0, "superseded must exit non-zero so a person decides")
            self.assertRegex(r.stdout, r"SUPERSEDED\s+0001-answer\.patch")
            self.assertIn("upstream fixed it", r.stdout)
            self.assertEqual(snapshot(self.tree), before, f"{mode} wrote to a tree with a superseded patch")
        self.assertNoTempLeft()

    def test_a_patch_that_fits_neither_direction_is_a_CONFLICT(self) -> None:
        self.write(self.tree, "pkg/thing.py", "def answer():\n    return 7\n")
        before = snapshot(self.tree)
        r = self.run_tool("check")
        self.assertEqual(r.returncode, 1, r.stdout + r.stderr)
        self.assertRegex(r.stdout, r"CONFLICT\s+0001-answer\.patch")
        self.assertIn("REFUSED", r.stdout)
        self.assertEqual(snapshot(self.tree), before)
        self.assertNoTempLeft()

    # ── what the tests decide ────────────────────────────────────────────────
    def test_patched_tests_that_fail_refuse_the_set(self) -> None:
        self.make_patch("0001-answer.patch", "pkg/thing.py", STOCK_THING, PATCHED_THING, TEST_FAILS)
        before = snapshot(self.tree)
        for mode in ("check", "apply"):
            r = self.run_tool(mode)
            self.assertNotEqual(r.returncode, 0)
            self.assertIn("the patched tests fail", r.stdout)
            self.assertEqual(snapshot(self.tree), before)
        self.assertNoTempLeft()

    def test_a_patch_depending_on_an_earlier_one_is_judged_against_it(self) -> None:
        """Classification runs against a copy the earlier patches are already in,
        the way the real application will see them."""
        self.make_patch("0002-second.patch", "pkg/thing.py", PATCHED_THING,
                        "def answer():\n    return 2\n\n\ndef extra():\n    return 3\n", None)
        r = self.run_tool("check")
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        self.assertRegex(r.stdout, r"APPLIES\s+0002-second\.patch")

    # ── write discipline ─────────────────────────────────────────────────────
    def test_check_writes_nothing_to_the_tree(self) -> None:
        before = snapshot(self.tree)
        mtimes = {p: p.stat().st_mtime_ns for p in self.tree.rglob("*") if p.is_file()}
        r = self.run_tool("check")
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        self.assertEqual(snapshot(self.tree), before)
        self.assertEqual({p: p.stat().st_mtime_ns for p in self.tree.rglob("*") if p.is_file()}, mtimes)
        self.assertFalse((self.tree / ".kinerary-patches").exists())
        self.assertNoTempLeft()

    def test_apply_writes_the_patches_and_no_manifest(self) -> None:
        self.apply_for_real(self.tree)
        self.assertEqual((self.tree / "pkg/thing.py").read_text(), PATCHED_THING)
        self.assertTrue((self.tree / "tests/test_0001_answer.py").exists())
        self.assertFalse((self.tree / ".kinerary-patches").exists(),
                         "the manifest is the image build's; this tool must not stamp the tree")
        self.assertNoTempLeft()

    def test_one_conflicting_patch_means_no_patch_is_written(self) -> None:
        """All-or-nothing, the refusal side: patch 1 would apply, patch 2 does not."""
        self.make_patch("0002-second.patch", "pkg/api.py", STOCK_API, FIXED_API, None)
        self.write(self.tree, "pkg/api.py", "something else entirely\n")
        before = snapshot(self.tree)
        r = self.run_tool("apply")
        self.assertEqual(r.returncode, 1, r.stdout + r.stderr)
        self.assertRegex(r.stdout, r"APPLIES\s+0001-answer\.patch")
        self.assertRegex(r.stdout, r"CONFLICT\s+0002-second\.patch")
        self.assertEqual(snapshot(self.tree), before, "patch 1 was written although patch 2 conflicts")
        self.assertNoTempLeft()

    def test_a_write_that_fails_midway_is_reversed(self) -> None:
        """All-or-nothing, the failure side: both patches check clean, the second
        write fails. The first must be taken back out."""
        self.make_patch("0002-second.patch", "pkg/api.py", STOCK_API,
                        STOCK_API + "\n\ndef added():\n    return 1\n", None)
        fake_bin = self.work / "fakebin"
        self.write(self.work, "fakebin/patch", FAKE_PATCH)
        (fake_bin / "patch").chmod(0o755)
        before = snapshot(self.tree)
        r = self.run_tool("apply", extra_env={
            "PATH": f"{fake_bin}:{os.environ['PATH']}",
            "FAKE_PATCH_COUNTER": str(self.work / "counter"),
            "FAKE_PATCH_FAIL_AT": "4",   # two scratch applications, then tree patch 1, then tree patch 2
        })
        self.assertEqual(r.returncode, 1, r.stdout + r.stderr)
        self.assertIn("restoring", r.stderr)
        self.assertEqual(snapshot(self.tree), before, "a half-applied tree was left behind")
        self.assertNoTempLeft()

    # ── a patch that dies halfway, and a process that is interrupted ────────
    def fail_halfway(self, write_number: str, files: str, *, two: bool = False) -> None:
        """Apply with a `patch` that writes `files`, then fails, on real write
        number `write_number`; the tree must come back byte-identical."""
        if two:
            self.two_patches()
        fake_bin = self.install_fake("patch", FAKE_PATCH)
        before = snapshot(self.tree)
        r = self.run_tool("apply", extra_env={
            "PATH": f"{fake_bin}:{os.environ['PATH']}",
            "FAKE_PATCH_COUNTER": str(self.work / "counter"),
            "FAKE_PATCH_PARTIAL_AT": write_number,
            "FAKE_PATCH_PARTIAL_FILES": files,
        })
        self.assertEqual(r.returncode, 1, r.stdout + r.stderr)
        self.assertIn("restoring", r.stderr)
        self.assertEqual(snapshot(self.tree), before,
                         "the failing patch's own partial writes were left in the tree")
        self.assertNoTempLeft()

    def test_a_patch_that_modifies_a_file_then_fails_leaves_the_tree_as_it_was(self) -> None:
        self.fail_halfway("2", "pkg/thing.py")

    def test_a_patch_that_creates_a_file_then_fails_leaves_no_file_and_no_directory(self) -> None:
        self.fail_halfway("2", "tests/test_0001_answer.py")
        self.assertFalse((self.tree / "tests").exists(), "the directory the patch created is still there")

    def test_a_patch_that_creates_and_modifies_then_fails_leaves_the_tree_as_it_was(self) -> None:
        self.fail_halfway("2", "pkg/thing.py tests/test_0001_answer.py")

    def test_the_second_patch_failing_halfway_takes_the_first_back_out_too(self) -> None:
        self.fail_halfway("4", "pkg/api.py", two=True)

    # Interruption. The second patch is applied by a stand-in that has written
    # everything and then blocks, announcing itself through a file; the signal is
    # sent only after that announcement, so nothing here depends on timing.
    def start_interrupted_apply(self) -> tuple[subprocess.Popen[str], dict[str, Path]]:
        self.two_patches()
        fake_bin = self.install_fake("patch", FAKE_PATCH)
        self.install_fake("cp", FAKE_CP)
        paths = {name: self.work / name for name in ("patch.pid", "patch.ready", "patch.fifo",
                                                     "cp.ready", "cp.fifo")}
        os.mkfifo(paths["patch.fifo"])
        os.mkfifo(paths["cp.fifo"])
        env = self.tool_env({
            "PATH": f"{fake_bin}:{os.environ['PATH']}",
            "FAKE_PATCH_COUNTER": str(self.work / "counter"),
            "FAKE_PATCH_BLOCK_AT": "4",   # two scratch writes, tree patch 1, tree patch 2
            "FAKE_PATCH_PID": str(paths["patch.pid"]),
            "FAKE_PATCH_READY": str(paths["patch.ready"]),
            "FAKE_PATCH_FIFO": str(paths["patch.fifo"]),
            "FAKE_CP_BLOCK_MATCH": "/hermes/",     # only a write INTO the tree blocks
            "FAKE_CP_READY": str(paths["cp.ready"]),
            "FAKE_CP_FIFO": str(paths["cp.fifo"]),
        })
        proc = subprocess.Popen(
            [BASH, str(TOOL), "apply", "--patches", str(self.patches), str(self.tree)],
            stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, env=env,
        )
        self.addCleanup(lambda: proc.poll() is None and proc.kill())
        wait_for(paths["patch.ready"], "the second patch to be mid-write")
        # Patch 1 is in the tree and so are patch 2's writes: the signal lands on a dirty tree.
        self.assertEqual((self.tree / "pkg/thing.py").read_text(), PATCHED_THING)
        return proc, paths

    def assert_interrupted_cleanly(self, proc: subprocess.Popen[str], paths: dict[str, Path],
                                   before: dict[str, str], code: int) -> None:
        out, err = proc.communicate(timeout=60)
        self.assertEqual(proc.returncode, code, out + err)
        self.assertEqual(snapshot(self.tree), before, "an interrupted apply left a half-patched tree")
        self.assertNoTempLeft()
        pid = int(paths["patch.pid"].read_text())
        with self.assertRaises(ProcessLookupError, msg="the patch child is still running"):
            os.kill(pid, 0)

    def release(self, fifo: Path) -> None:
        fd = os.open(fifo, os.O_WRONLY)
        try:
            os.write(fd, b"go\n")
        finally:
            os.close(fd)

    def interrupt_once(self, sig: int, code: int) -> None:
        before = snapshot(self.tree)
        proc, paths = self.start_interrupted_apply()
        self.assertNotEqual(snapshot(self.tree), before, "the apply was not mid-write")
        proc.send_signal(sig)
        # The restoration copies files back into the tree through the stand-in cp,
        # which blocks; let it through so this variant ends.
        wait_for(paths["cp.ready"], "the restoration to start")
        self.release(paths["cp.fifo"])
        self.assert_interrupted_cleanly(proc, paths, before, code)

    def test_sigterm_during_the_second_write_restores_the_tree(self) -> None:
        self.interrupt_once(signal.SIGTERM, 143)

    def test_sigint_during_the_second_write_restores_the_tree(self) -> None:
        self.interrupt_once(signal.SIGINT, 130)

    def test_sighup_during_the_second_write_restores_the_tree(self) -> None:
        self.interrupt_once(signal.SIGHUP, 129)

    def test_a_second_signal_during_restoration_does_not_leave_it_half_done(self) -> None:
        before = snapshot(self.tree)
        proc, paths = self.start_interrupted_apply()
        proc.send_signal(signal.SIGTERM)
        wait_for(paths["cp.ready"], "the restoration to be under way")
        # Restoration is blocked inside its first copy. Hit it again, and again.
        proc.send_signal(signal.SIGINT)
        proc.send_signal(signal.SIGTERM)
        self.assertIsNone(proc.poll(), "the script died mid-restoration")
        self.release(paths["cp.fifo"])
        self.assert_interrupted_cleanly(proc, paths, before, 143)

    def test_an_apply_that_is_not_interrupted_leaves_no_backup_and_exits_zero(self) -> None:
        r = self.run_tool("apply")
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        self.assertNotIn("restoring", r.stderr)
        self.assertNoTempLeft()

    # ── refusals before anything runs ────────────────────────────────────────
    def test_unset_interpreter_refuses_in_both_modes(self) -> None:
        before = snapshot(self.tree)
        for mode in ("check", "apply"):
            r = self.run_tool(mode, python=False)
            self.assertEqual(r.returncode, 2, r.stdout + r.stderr)
            self.assertIn("HERMES_PATCH_PYTHON is unset", r.stderr)
            self.assertEqual(snapshot(self.tree), before)
        self.assertNoTempLeft()

    def test_an_interpreter_that_is_not_there_refuses(self) -> None:
        r = self.run_tool("check", extra_env={"HERMES_PATCH_PYTHON": str(self.work / "nope")})
        self.assertEqual(r.returncode, 2)
        self.assertIn("not an executable", r.stderr)

    def test_a_missing_tree_and_an_empty_patch_dir_refuse(self) -> None:
        self.assertEqual(self.run_tool("check", self.work / "no-such-tree").returncode, 2)
        (self.patches / "0001-answer.patch").unlink()
        r = self.run_tool("check")
        self.assertEqual(r.returncode, 2)
        self.assertIn("no patches", r.stderr)

    # ── the same answer as the image build ───────────────────────────────────
    def test_apply_leaves_the_tree_the_image_build_would(self) -> None:
        """build-hermes-image.sh cannot be shared (it stamps a manifest and refuses
        a patched tree), so this holds the two to one result: same patch flags,
        same order, same files."""
        self.make_patch("0002-second.patch", "pkg/api.py", STOCK_API,
                        STOCK_API + "\n\ndef added():\n    return 1\n", None)
        built = self.work / "built"
        shutil.copytree(self.tree, built)
        b = subprocess.run(["bash", str(BUILD), "--patches", str(self.patches), "--apply-only", str(built)],
                           capture_output=True, text=True)
        self.assertEqual(b.returncode, 0, b.stderr)
        (built / ".kinerary-patches").unlink()

        self.apply_for_real(self.tree)

        self.assertEqual(snapshot(self.tree), snapshot(built))


class TheToolIsPartOfTheRepo(unittest.TestCase):
    def test_the_script_is_executable(self) -> None:
        self.assertTrue(os.access(TOOL, os.X_OK))

    def test_it_reads_the_interpreter_from_the_environment_and_names_no_machine(self) -> None:
        text = TOOL.read_text()
        self.assertIn('"$HERMES_PATCH_PYTHON"', text)
        for forbidden in ("/Users/", "/home/", ".hermes/installs", "192.168."):
            self.assertNotIn(forbidden, text)


if __name__ == "__main__":
    unittest.main()
