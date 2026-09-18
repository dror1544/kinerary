"""scripts/claude-hooks/match-command.py — what becomes a commit/deploy prompt.

Hard rules 1 and 2 are about intent, so the hook's job is to make sure every
commit and every live change is a question put to a person. A miss here is
silent: the command just runs. Hence a table of the commands that matter.
"""
from __future__ import annotations

import subprocess
import sys
import unittest
from pathlib import Path

SCRIPT = Path(__file__).resolve().parents[2] / "scripts" / "claude-hooks" / "match-command.py"


def classify(command: str) -> str:
    return subprocess.run([sys.executable, str(SCRIPT)], input=command, capture_output=True, text=True).stdout.strip()


class Classify(unittest.TestCase):
    def test_commits(self):
        self.assertEqual(classify("git commit -m 'x'"), "commit")
        self.assertEqual(classify("git -C some/dir commit -F -"), "commit")

    def test_prose_about_commits_is_not_a_commit(self):
        self.assertEqual(classify("cat > notes.md <<'EOF'\nnever git commit without approval\nEOF"), "none")

    def test_deploys(self):
        for command in (
            "~/kinerary-deploy/trips/japan-2026/deploy.sh",
            "docker compose -f control-plane/deployment/compose.local.yml up -d --build --wait",
            "scripts/preflight-deploy.sh --deploy",
            "scripts/preflight-deploy.sh",  # every preflight prompts: safe direction, one keystroke
        ):
            self.assertEqual(classify(command), "deploy", command)

    def test_a_teardown_that_executes_is_a_live_change(self):
        self.assertEqual(classify("scripts/teardown-trip.py --trip japan-2026 --execute"), "deploy")
        self.assertEqual(classify("cd x && python3 scripts/teardown-trip.py --trip trip_abc --execute"), "deploy")

    def test_a_teardown_dry_run_is_read_only(self):
        self.assertEqual(classify("scripts/teardown-trip.py --trip japan-2026"), "none")

    def test_ordinary_commands(self):
        self.assertEqual(classify("ls -la && git status"), "none")

    def test_control_plane_release_changes_are_live(self):
        # Upgrading, rolling back or pruning the production control plane moves
        # every live trip's bot and companion; prune deletes ways back.
        for command in (
            "sudo kinerary-cp-release upgrade 3a9f1c2",
            "kinerary-cp-release rollback --restore-db",
            "/usr/local/sbin/kinerary-cp-release prune",
            "sudo kinerary-cp-release install",
            "kinerary-cp-release restart-bridges",
            "control-plane/deployment/vm-release.py upgrade main",
            "sudo python3 /opt/kinerary/control-plane/deployment/vm-release.py rollback",
            "ssh debian@cp.example 'sudo kinerary-cp-release rollback'",
            "control-plane/deployment/vm-restore-snapshot.sh --snapshot pre-aa61f6e-202609161800 --execute",
        ):
            self.assertEqual(classify(command), "deploy", command)

    def test_control_plane_release_reads_and_dry_runs_do_not_prompt(self):
        # A prompt on read-only commands teaches people to click through.
        for command in (
            "kinerary-cp-release status",
            "kinerary-cp-release plan main",
            "kinerary-cp-release verify",
            "sudo kinerary-cp-release upgrade 3a9f1c2 --dry-run",
            "kinerary-cp-release rollback --restore-db --dry-run",
            "kinerary-cp-release prune --dry-run",
            "control-plane/deployment/vm-restore-snapshot.sh --list",
            "control-plane/deployment/vm-restore-snapshot.sh --snapshot pre-aa61f6e-202609161800",
        ):
            self.assertEqual(classify(command), "none", command)

    def test_proxmox_snapshot_state_changes_are_live(self):
        # A snapshot freezes the guest's filesystems; a rollback discards data;
        # a vzdump into an NFS share froze the host's storage VM, every NFS mount
        # and the control-plane VM on 2026-09-13. Each is a question for a person.
        for command in (
            "ssh root@pve.example qm snapshot 900 pre-x",
            "ssh root@pve.example 'qm rollback 900 pre-x'",
            "qm delsnapshot 900 pre-x --force",
            "qm unlock 900",
            "vzdump 901 --storage nas-share",
            "ssh root@pve.example \"vzdump 900 --storage local\"",
        ):
            self.assertEqual(classify(command), "deploy", command)

    def test_proxmox_reads_do_not_prompt(self):
        for command in (
            "ssh root@pve.example qm listsnapshot 900",
            "qm config 900",
            "qm guest cmd 900 fsfreeze-status",
        ):
            self.assertEqual(classify(command), "none", command)


if __name__ == "__main__":
    unittest.main()
