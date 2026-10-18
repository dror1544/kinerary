"""scripts/preflight-checks.sh B6 — the product repo must not name this deployment.

`kinerary` says what and how; `kinerary-deploy` says where. The reason is
portability, not secrecy: the product has to run on k3s, on another Proxmox, on
hardware nobody here owns, and every value naming THIS house is one the second
deployment has to find and undo.

A rule-enforcer that silently stops enforcing is this repository's own recurring
failure — the Hermes drift check once compared nothing and could never block,
and it looked fine by hand. So this asserts both directions: the check fires on
what it must catch, and stays quiet on what it must not.
"""
from __future__ import annotations

import subprocess
import tempfile
import unittest
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
SCRIPT = REPO / "scripts/preflight-checks.sh"


def check_paths(*rel_paths: str) -> str:
    """Run the whole-tree check and return its output."""
    return subprocess.run([str(SCRIPT), "--all"], cwd=REPO, capture_output=True, text=True).stdout


def check_one(body: str, name: str) -> tuple[int, str]:
    """Write `body` to scripts/<name>, run --staged over just it, clean up."""
    path = REPO / "scripts" / name
    path.write_text(body, encoding="utf-8")
    try:
        subprocess.run(["git", "add", "-f", str(path)], cwd=REPO, capture_output=True, check=True)
        r = subprocess.run([str(SCRIPT), "--staged"], cwd=REPO, capture_output=True, text=True)
        return r.returncode, r.stdout
    finally:
        subprocess.run(["git", "restore", "--staged", str(path)], cwd=REPO, capture_output=True)
        path.unlink(missing_ok=True)


class NamingThisDeployment(unittest.TestCase):
    def test_a_script_naming_this_deployment_is_blocked(self):
        code, out = check_one(
            '#!/usr/bin/env bash\n'
            'ssh debian@192.168.0.45 "docker exec kinerary-cp-api-1 cat /opt/kinerary-deploy/vm.env"\n',
            "zz-boundary-probe.sh",
        )
        self.assertIn("hard rule 6", out)
        self.assertIn("zz-boundary-probe.sh", out)
        self.assertEqual(code, 1, "naming this deployment must block the commit")

    def test_each_kind_of_infrastructure_literal_is_caught_on_its_own(self):
        for label, line in (
            ("private address", 'HOST=192.168.0.40\n'),
            ("deploy root", 'ROOT=/opt/kinerary-deploy\n'),
            ("hermes data", 'H=/opt/hermes-data\n'),
            ("container name", 'C=kinerary-cp-postgres-1\n'),
            ("ssh key", 'K=~/.ssh/id_ed25519_proxmox_hermes\n'),
            ("user@host", 'T=debian@example\n'),
        ):
            with self.subTest(label):
                code, out = check_one(f"#!/usr/bin/env bash\n{line}", "zz-boundary-probe.sh")
                self.assertIn("hard rule 6", out, f"{label} was not caught")
                self.assertEqual(code, 1)

    def test_a_portable_script_passes(self):
        code, out = check_one(
            '#!/usr/bin/env bash\n'
            '# Values come from the environment; this refuses rather than guessing.\n'
            '[ -n "${CONTROL_PLANE_HOST:-}" ] || { echo "CONTROL_PLANE_HOST is required" >&2; exit 1; }\n'
            'ssh "$CONTROL_PLANE_HOST" "$@"\n',
            "zz-boundary-probe.sh",
        )
        self.assertNotIn("hard rule 6", out)
        self.assertEqual(code, 0, out)

    def test_the_tree_is_clean_so_the_allow_list_is_honest(self):
        # Every current offender is recorded in .preflight-allow with a reason.
        # A BLOCK here means something was added without that decision.
        out = check_paths()
        self.assertNotIn("hard rule 6", out, "an unrecorded rule-6 offender is in the tree")

    def test_the_detector_never_reports_itself_even_with_no_allow_file(self):
        # preflight-checks.sh must contain the literals it searches for. An
        # entry in .preflight-allow is NOT enough to exempt it: a harness that
        # runs the script against a temp repo has no allow file, `allowed` says
        # no, and the check reports itself into output another test is
        # asserting on. That is how this was found — on main, where
        # test_preflight_doc_paths.py does exactly that. So the skip is by path.
        with tempfile.TemporaryDirectory() as tmp:
            repo = Path(tmp)
            subprocess.run(["git", "init", "-q"], cwd=repo, check=True)
            (repo / "scripts").mkdir()
            (repo / "scripts/preflight-checks.sh").write_bytes(SCRIPT.read_bytes())
            (repo / "scripts/preflight-checks.sh").chmod(0o755)
            subprocess.run(["git", "add", "-A"], cwd=repo, capture_output=True, check=True)
            self.assertFalse((repo / ".preflight-allow").exists(), "the point is that there is none")
            out = subprocess.run([str(repo / "scripts/preflight-checks.sh"), "--all"],
                                 cwd=repo, capture_output=True, text=True).stdout
            self.assertNotIn("preflight-checks.sh", out, "the detector reported itself")

    def test_the_allow_list_says_permanent_or_backlog_for_every_entry(self):
        # The two kinds are the point: PERMANENT means the rule cannot apply,
        # BACKLOG means it applies and has not been paid yet. An entry that
        # says neither is a silent exemption wearing a reason.
        text = (REPO / ".preflight-allow").read_text(encoding="utf-8")
        parts = text.split("hard rule 6", 1)
        self.assertEqual(len(parts), 2, ".preflight-allow has no hard rule 6 section")
        # Drop the remainder of the section header line itself.
        section = parts[1].split("\n", 1)[1]
        for line in section.splitlines():
            line = line.strip()
            if not line or line.startswith("#"):
                continue
            self.assertIn("#", line, f"no reason given: {line}")
            path, reason = line.split("#", 1)
            self.assertTrue((REPO / path.strip()).exists(), f"allow-list names a missing file: {path.strip()}")
            self.assertTrue(
                reason.strip().startswith("BACKLOG:") or len(reason.strip()) > 20,
                f"reason is too thin to be a decision: {line}",
            )


if __name__ == "__main__":
    unittest.main()
