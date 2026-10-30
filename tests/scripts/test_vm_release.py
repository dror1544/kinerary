"""control-plane/deployment/vm-release.py (kinerary-cp-release) and vm-release-gate.sh.

What is tested here is everything that decides whether something is SAFE,
because that is the part a mistake in turns into a production incident rather
than a failed command:

- the gate: which verbs and flags an agent may use, that a request's code is
  never stored, that three wrong codes lock it, that an approval runs exactly
  what was requested, that requests expire and cannot be spammed;
- the forced command in front of it: no shell metacharacter survives;
- rollback safety: an undeclared migration is breaking, a declaration must be a
  real header with a reason;
- pruning: the newest snapshot and the newest backup are never deleted, Hermes
  images are never pruned, the running version's images are kept.

The parts that drive docker, git, psql and Proxmox are exercised by the
dry-run and the rehearsal on a cloned VM (docs/control-plane-vm-deployment.md).
"""
from __future__ import annotations

import contextlib
import importlib.util
import io
import json
import os
import re
import shlex
import shutil
import stat
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[2]
TOOL = ROOT / "control-plane" / "deployment" / "vm-release.py"
GATE = ROOT / "control-plane" / "deployment" / "vm-release-gate.sh"

_tmp = Path(tempfile.mkdtemp(prefix="vm-release-test-"))
for key, sub in (("KINERARY_CP_STATE_DIR", "state"), ("KINERARY_CP_BACKUP_DIR", "backups"), ("KINERARY_CP_LOG_DIR", "log")):
    os.environ[key] = str(_tmp / sub)
_spec = importlib.util.spec_from_file_location("vm_release", TOOL)
vr = importlib.util.module_from_spec(_spec)
sys.modules["vm_release"] = vr
_spec.loader.exec_module(vr)


class Clock:
    def __init__(self, now: float = 1_800_000_000.0):
        self.now = now

    def __call__(self) -> float:
        return self.now


class ProductionLimits(unittest.TestCase):
    """This module is imported with the VM's own paths, so it must carry the VM's
    own limits — a rehearsal lowers them by pointing the tool somewhere else, and
    nothing else can."""

    def test_the_vm_keeps_its_limits(self):
        self.assertTrue(vr.ON_THE_VM, "no KINERARY_CP_REPO/DEPLOY_ROOT override is set for these tests")
        self.assertEqual(vr.MIN_ROOT_FREE_GB, 10)
        self.assertEqual((vr.BACKUP_KEEP, vr.BACKUP_MAX_TOTAL_GB), (10, 5))
        self.assertEqual(vr.SNAPSHOT_MAX_AGE_DAYS, 14)


class GateParsing(unittest.TestCase):
    def test_read_only_verbs(self):
        for verb in ("status", "help", "history", "snapshots", "verify"):
            self.assertEqual(vr.parse_gate([verb]), (verb, []))
        self.assertEqual(vr.parse_gate(["plan", "main"]), ("plan", ["main"]))
        self.assertEqual(vr.parse_gate(["plan", "3a9f1c2"]), ("plan", ["3a9f1c2"]))

    def test_actions_an_agent_may_dry_run_or_request(self):
        self.assertEqual(vr.parse_gate(["request", "upgrade", "main"]), ("request", ["upgrade", "main"]))
        self.assertEqual(vr.parse_gate(["dry-run", "upgrade", "3a9f1c2", "--hermes-rev", "ab0d98414"]),
                         ("dry-run", ["upgrade", "3a9f1c2", "--hermes-rev", "ab0d98414"]))
        self.assertEqual(vr.parse_gate(["request", "rollback", "--restore-db"]), ("request", ["rollback", "--restore-db"]))
        self.assertEqual(vr.parse_gate(["request", "rollback", "--to", "aa61f6e"]), ("request", ["rollback", "--to", "aa61f6e"]))
        self.assertEqual(vr.parse_gate(["dry-run", "prune"]), ("dry-run", ["prune"]))
        self.assertEqual(vr.parse_gate(["request", "restart-bridges"]), ("request", ["restart-bridges"]))

    def test_a_persons_flags_are_refused(self):
        for tokens in (
            ["request", "upgrade", "main", "--force-live"],
            ["request", "rollback", "--keep-db"],
            ["request", "rollback", "--restore-hermes"],
            ["dry-run", "upgrade", "main", "--force"],
            ["request", "upgrade", "main", "--dry-run"],
        ):
            with self.assertRaises(vr.GateRefusal, msg=tokens):
                vr.parse_gate(tokens)

    def test_nothing_outside_the_catalogue(self):
        for tokens in (
            [],
            ["install"],
            ["run-request", "r-1"],
            ["upgrade", "main"],                          # only through request
            ["request", "install"],
            ["request", "upgrade", "feature/branch"],     # not a rev token
            ["request", "upgrade", "HEAD~1"],
            ["request", "upgrade", "main;reboot"],
            ["plan", "$(id)"],
            ["approve", "r-1", "12345"],                  # 5 digits
            ["approve", "1", "123456"],
            ["request", "rollback", "--to", "main"],      # --to wants a commit
            ["status", "extra"],
        ):
            with self.assertRaises(vr.GateRefusal, msg=tokens):
                vr.parse_gate(tokens)


class ApprovalCodes(unittest.TestCase):
    def setUp(self):
        self.dir = Path(tempfile.mkdtemp(prefix="requests-"))
        self.clock = Clock()
        self.requests = vr.Requests(self.dir, clock=self.clock)

    def test_the_code_is_never_stored(self):
        request, code = self.requests.create(["upgrade", "3a9f1c2"], "summary")
        stored = json.loads((self.dir / f"{request['id']}.json").read_text())
        # No field holds the code (a substring test would be flaky: six digits
        # can occur inside a 64-character hex digest by chance).
        self.assertFalse(any(value == code for value in stored.values()))
        self.assertEqual(sorted(k for k in stored if "code" in k), ["code_sha256"])
        self.assertEqual(oct(os.stat(self.dir / f"{request['id']}.json").st_mode & 0o777), "0o600")
        self.assertNotIn("salt", vr.Requests.public(request))
        self.assertNotIn("code_sha256", vr.Requests.public(request))

    def test_the_right_code_approves_exactly_once(self):
        request, code = self.requests.create(["upgrade", "3a9f1c2"], "summary")
        approved = self.requests.approve(request["id"], code)
        self.assertEqual(approved["status"], "approved")
        self.assertEqual(approved["action"], ["upgrade", "3a9f1c2"])
        with self.assertRaises(vr.GateRefusal):
            self.requests.approve(request["id"], code)

    def test_three_wrong_codes_lock_the_request(self):
        request, code = self.requests.create(["upgrade", "3a9f1c2"], "summary")
        wrong = "000000" if code != "000000" else "111111"
        for _ in range(2):
            with self.assertRaises(vr.GateRefusal):
                self.requests.approve(request["id"], wrong)
        with self.assertRaises(vr.GateRefusal) as locked:
            self.requests.approve(request["id"], wrong)
        self.assertIn("locked", str(locked.exception))
        with self.assertRaises(vr.GateRefusal):
            self.requests.approve(request["id"], code)
        self.assertEqual(self.requests.get(request["id"])["status"], "locked")

    def test_parallel_wrong_codes_share_one_attempt_limit(self):
        request, code = self.requests.create(["upgrade", "3a9f1c2"], "summary")
        wrong = "000000" if code != "000000" else "111111"
        # Every worker imports the tool, then spins until one shared instant, so
        # the read-modify-write really does overlap. Waiting on a file instead
        # left milliseconds of jitter between them — more than the unguarded
        # window itself, so they took turns and the race never showed.
        worker = """
import importlib.util
import sys
import time
from pathlib import Path

tool, directory, start_at, request_id, code = sys.argv[1:]
spec = importlib.util.spec_from_file_location("vm_release_worker", tool)
module = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = module
spec.loader.exec_module(module)
requests = module.Requests(Path(directory))
while time.time() < float(start_at):
    pass
try:
    requests.approve(request_id, code)
except module.GateRefusal:
    pass
"""
        start_at = time.time() + 1.5  # long enough for eight interpreters to be ready and spinning
        processes = [
            subprocess.Popen(
                [sys.executable, "-c", worker, str(TOOL), str(self.dir), str(start_at), request["id"], wrong],
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
            )
            for _ in range(8)
        ]
        failures = []
        for process in processes:
            stdout, stderr = process.communicate(timeout=10)
            if process.returncode:
                failures.append((process.returncode, stdout, stderr))
        self.assertEqual(failures, [])
        stored = self.requests.get(request["id"])
        self.assertEqual(stored["attempts"], vr.REQUEST_MAX_ATTEMPTS)
        self.assertEqual(stored["status"], "locked")
        # The temp files a save writes are dotfiles, which glob("*.tmp") never sees.
        self.assertEqual([p.name for p in self.dir.iterdir() if p.name.endswith(".tmp")], [])

    def test_a_request_expires(self):
        request, code = self.requests.create(["rollback"], "summary")
        self.clock.now += vr.REQUEST_TTL_SECONDS + 1
        with self.assertRaises(vr.GateRefusal):
            self.requests.approve(request["id"], code)
        self.assertEqual(self.requests.get(request["id"])["status"], "expired")

    def test_a_new_request_supersedes_the_pending_one(self):
        first, first_code = self.requests.create(["upgrade", "3a9f1c2"], "a")
        second, _ = self.requests.create(["rollback"], "b")
        self.assertNotEqual(first["id"], second["id"])
        self.assertEqual(self.requests.get(first["id"])["status"], "superseded")
        with self.assertRaises(vr.GateRefusal):
            self.requests.approve(first["id"], first_code)

    def test_requests_cannot_be_spammed(self):
        for _ in range(vr.REQUESTS_PER_HOUR):
            self.requests.create(["prune"], "x")
        with self.assertRaises(vr.GateRefusal):
            self.requests.create(["prune"], "x")
        self.clock.now += 3601
        self.requests.create(["prune"], "x")

    def test_cancel(self):
        request, code = self.requests.create(["prune"], "x")
        self.requests.cancel(request["id"])
        with self.assertRaises(vr.GateRefusal):
            self.requests.approve(request["id"], code)

    def test_codes_are_six_digits_and_differ(self):
        codes = set()
        for _ in range(5):
            request, code = self.requests.create(["prune"], "x")
            self.assertRegex(code, r"^[0-9]{6}$")
            codes.add(code)
            self.requests.cancel(request["id"])
        self.assertGreater(len(codes), 1)


class RollbackDeclarations(unittest.TestCase):
    def test_header_forms(self):
        self.assertEqual(vr.rollback_declaration("-- rollback: compatible — new table\nCREATE TABLE x();"), ("compatible", "new table"))
        self.assertEqual(vr.rollback_declaration("-- rollback: breaking - drops y\nDROP TABLE y;"), ("breaking", "drops y"))
        self.assertIsNone(vr.rollback_declaration("-- rollback: compatible\nSELECT 1;"))
        self.assertIsNone(vr.rollback_declaration("SELECT 1;"))
        self.assertIsNone(vr.rollback_declaration("-- x\n" * 20 + "-- rollback: compatible — too late"))

    def test_undeclared_counts_as_breaking(self):
        headers = {"0052_a.sql": ("compatible", "new table"), "0053_b.sql": None}
        verdict, details = vr.classify_migrations(headers, headers.get)
        self.assertEqual(verdict, "breaking")
        self.assertEqual(details[1][1], "breaking")

    def test_all_compatible(self):
        headers = {"0052_a.sql": ("compatible", "x"), "0053_b.sql": ("compatible", "y")}
        self.assertEqual(vr.classify_migrations(headers, headers.get)[0], "compatible")
        self.assertEqual(vr.classify_migrations([], headers.get), ("compatible", []))


class SiteConfiguration(unittest.TestCase):
    """The kinerary repo is public: no address, VMID, key name or bot name lives
    in the tool. They come from kinerary-deploy's control-plane.env (and
    PROXMOX_HOST / PROXMOX_SSH_USER from provisioning.env), or nothing runs."""

    CONTROL_PLANE_ENV = (
        "# facts\nCP_VMID=900\nCP_EXPECT_BOT=Example_bot\n"
        "CP_PROXMOX_SSH_KEY_ON_VM=/root/.ssh/pve_key\nCP_PROXMOX_KNOWN_HOSTS_ON_VM=/root/.ssh/known_hosts\n"
        "CP_REFUSE_STORAGE=nas-share other-share\n"
    )
    PROVISIONING_ENV = "SECRET_TOKEN=do-not-read\n# PROXMOX_HOST=commented.example\nPROXMOX_HOST=pve.example\nPROXMOX_SSH_USER=root\n"

    def test_facts_come_from_the_deploy_repo_files(self):
        site = vr.site_from_texts(self.CONTROL_PLANE_ENV, self.PROVISIONING_ENV, "")
        self.assertEqual(site["CP_VMID"], "900")
        self.assertEqual(site["PROXMOX_HOST"], "pve.example")
        self.assertEqual(site["CP_REFUSE_STORAGE"], "nas-share other-share")
        self.assertNotIn("SECRET_TOKEN", site, "only the facts the tool needs are kept from provisioning.env")

    def test_vm_env_overrides_provisioning_env_like_compose_does(self):
        site = vr.site_from_texts(self.CONTROL_PLANE_ENV, self.PROVISIONING_ENV, "PROXMOX_HOST=other.example\n")
        self.assertEqual(site["PROXMOX_HOST"], "other.example")

    def test_no_file_no_defaults(self):
        with self.assertRaises(vr.Refused) as missing:
            vr.site_from_texts(None, self.PROVISIONING_ENV, "")
        self.assertIn("control-plane.env", str(missing.exception))
        with self.assertRaises(vr.Refused) as incomplete:
            vr.site_from_texts("CP_VMID=900\n", "", "")
        for key in ("CP_EXPECT_BOT", "PROXMOX_HOST", "PROXMOX_SSH_USER"):
            self.assertIn(key, str(incomplete.exception))

    def test_values_that_reach_a_remote_shell_are_checked(self):
        for bad in ("CP_VMID=90; reboot", "CP_REFUSE_STORAGE=nas'share", "CP_EXPECT_BOT=bot name"):
            key = bad.split("=", 1)[0]
            text = "\n".join(l for l in self.CONTROL_PLANE_ENV.splitlines() if not l.startswith(key + "=")) + "\n" + bad + "\n"
            with self.assertRaises(vr.Refused, msg=bad):
                vr.site_from_texts(text, self.PROVISIONING_ENV, "")
        with self.assertRaises(vr.Refused):
            vr.site_from_texts(self.CONTROL_PLANE_ENV, "PROXMOX_HOST=pve.example;id\nPROXMOX_SSH_USER=root\n", "")

    def test_the_tool_itself_carries_no_infrastructure(self):
        source = TOOL.read_text()
        for needle in ("192.168.", "id_ed25519", "Kinerary_bot", "nvme", "truenas"):
            self.assertNotIn(needle, source, needle)


class Helpers(unittest.TestCase):
    def test_vm_env_updates_touch_only_the_named_keys(self):
        text = "# comment\nKINERARY_REV=aa61f6e\nHERMES_REV=ab0d98414\nPROVISIONER_COMPUTE_ENABLED=1\n"
        updated = vr.update_env_text(text, {"KINERARY_REV": "3a9f1c2"})
        self.assertEqual(updated, "# comment\nKINERARY_REV=3a9f1c2\nHERMES_REV=ab0d98414\nPROVISIONER_COMPUTE_ENABLED=1\n")
        self.assertIn("NEW_KEY=1", vr.update_env_text(text, {"NEW_KEY": "1"}))
        self.assertEqual(vr.read_env_text(updated)["KINERARY_REV"], "3a9f1c2")

    def test_agent_tools_are_read_from_interview_mcp(self):
        source = 'mcp.tool("public_tool", …)\nif (AGENT_KEY) {\n  mcp.tool(\n    "say_for_chat", …)\n  mcp.tool( "ask_question_for_chat", …)\n}'
        self.assertEqual(vr.extract_agent_tools(source), ["say_for_chat", "ask_question_for_chat"])
        self.assertEqual(vr.extract_agent_tools("no agent block"), [])

    def test_runner_output_parsing(self):
        values, checks, snapshots = vr.parse_runner_output(
            "check.lock=pass not locked\ncheck.pool_meta=fail metadata 55%\npool.vg-fast/data=data 28%\n"
            "snapshot=pre-aa61f6e-202609161830\t1789000000\taa61f6e -> 3a9f1c2\nresult=refused 1 failed\n")
        self.assertEqual(checks, [("lock", "pass not locked"), ("pool_meta", "fail metadata 55%")])
        self.assertEqual(snapshots, [("pre-aa61f6e-202609161830", 1789000000, "aa61f6e -> 3a9f1c2")])
        self.assertEqual(values["result"], "refused 1 failed")


class Pruning(unittest.TestCase):
    def test_the_newest_release_snapshot_is_never_pruned(self):
        day = 86400
        now = 100 * day
        snapshots = [("pre-a", now - 40 * day, ""), ("pre-b", now - 30 * day, ""), ("manual", now - 90 * day, "")]
        # Both older than 14 days: only the older release goes, the newest stays, the manual one is not ours.
        self.assertEqual(vr.snapshots_to_prune(snapshots, now, keep_newest=2, max_age_days=14), ["pre-a"])
        self.assertEqual(vr.snapshots_to_prune([("pre-a", now - 40 * day, "")], now, keep_newest=2, max_age_days=14), [])

    def test_before_an_upgrade_only_the_newest_snapshot_survives(self):
        snapshots = [("pre-a", 1, ""), ("pre-b", 2, ""), ("pre-c", 3, "")]
        self.assertEqual(sorted(vr.snapshots_to_prune(snapshots, 10, keep_newest=1, max_age_days=None)), ["pre-a", "pre-b"])

    def test_backups_keep_a_count_and_a_size_but_never_the_newest(self):
        gb = 1024 ** 3
        backups = [(f"202609{day:02d}T000000Z-x", gb) for day in range(1, 13)]
        doomed = vr.backups_to_prune(backups, keep=10, max_total_bytes=5 * gb)
        kept = sorted(set(b[0] for b in backups) - set(doomed))
        self.assertEqual(kept, [f"202609{day:02d}T000000Z-x" for day in range(8, 13)])
        huge = [("20260901T000000Z-old", gb), ("20260916T000000Z-new", 50 * gb)]
        self.assertEqual(vr.backups_to_prune(huge, keep=10, max_total_bytes=5 * gb), ["20260901T000000Z-old"])

    def test_images_keep_recent_revisions_and_never_hermes(self):
        tags = ["kinerary-cp/api:aa61f6e", "kinerary-cp/worker:aa61f6e", "kinerary-cp/agent-runtime:3264c4a",
                "kinerary-cp/api:3264c4a", "kinerary-cp/hermes:ab0d98414", "postgres:16-alpine", "kinerary-cp/api:latest"]
        self.assertEqual(vr.images_to_prune(tags, {"aa61f6e", ""}), ["kinerary-cp/agent-runtime:3264c4a", "kinerary-cp/api:3264c4a"])


class History(unittest.TestCase):
    def test_round_trip_and_the_way_back(self):
        path = Path(tempfile.mkdtemp()) / "history.tsv"
        vr.append_history({"utc": "t0", "action": "baseline", "to_rev": "aa61f6e", "result": "ok"}, path)
        vr.append_history({"utc": "t1", "action": "upgrade", "from_rev": "aa61f6e", "to_rev": "3a9f1c2", "result": "ok",
                           "backup_dir": "/b/x", "snapshot": "pre-3a9f1c2-1"}, path)
        rows = vr.read_history(path)
        self.assertEqual([r["action"] for r in rows], ["baseline", "upgrade"])
        self.assertEqual(vr.recovery_point(rows, "3a9f1c2")["from_rev"], "aa61f6e")
        vr.append_history({"utc": "t2", "action": "upgrade", "from_rev": "3a9f1c2", "to_rev": "bbbbbbb", "result": "snapshot-failed"}, path)
        self.assertEqual(vr.recovery_point(vr.read_history(path), "3a9f1c2")["to_rev"], "3a9f1c2",
                         "a snapshot that failed switched nothing, so the upgrade before it still describes the VM")
        vr.append_history({"utc": "t3", "action": "rollback", "from_rev": "3a9f1c2", "to_rev": "aa61f6e", "result": "ok"}, path)
        self.assertIsNone(vr.recovery_point(vr.read_history(path), "aa61f6e"))


class RestoreScriptArguments(unittest.TestCase):
    """vm-restore-snapshot.sh: the facts come from the deploy repo, and a bad
    request is refused before anything is sent to the Proxmox host."""

    SCRIPT = ROOT / "control-plane" / "deployment" / "vm-restore-snapshot.sh"

    def run_script(self, *args: str, config: bool = True):
        root = Path(tempfile.mkdtemp())
        if config:
            (root / "control-plane.env").write_text("CP_VMID=900\nCP_PROXMOX_SSH_KEY_ON_MAC=~/.ssh/pve_key\nCP_REFUSE_STORAGE=nas-share\n")
            (root / "provisioning.env").write_text("SECRET=x\nPROXMOX_HOST=pve.example\nPROXMOX_SSH_USER=root\n")
        fake_bin = root / "bin"
        fake_bin.mkdir()
        # Any ssh call fails the test loudly: these cases must stop before one.
        (fake_bin / "ssh").write_text("#!/bin/sh\necho SSH-CALLED; exit 99\n")
        (fake_bin / "ssh").chmod(0o755)
        env = {**os.environ, "KINERARY_DEPLOY_ROOT": str(root), "PATH": f"{fake_bin}:{os.environ['PATH']}"}
        return subprocess.run(["/bin/bash", str(self.SCRIPT), *args], capture_output=True, text=True, env=env)

    def test_help_needs_no_configuration(self):
        proc = self.run_script("--help", config=False)
        self.assertEqual(proc.returncode, 0)
        self.assertIn("vm-restore-snapshot.sh", proc.stdout)

    def test_no_configuration_no_defaults(self):
        proc = self.run_script("--list", config=False)
        self.assertEqual(proc.returncode, 2)
        self.assertIn("missing CP_VMID", proc.stderr)
        self.assertNotIn("SSH-CALLED", proc.stdout)

    def test_bad_requests_stop_before_the_host(self):
        for args, message in (
            (("--snapshot", "pre-x;id"), "bad snapshot name"),
            (("--snapshot", "before-maintenance"), "only release snapshots"),
            (("--execute",), "--execute needs --snapshot"),
        ):
            proc = self.run_script(*args)
            self.assertEqual(proc.returncode, 2, args)
            self.assertIn(message, proc.stderr, args)
            self.assertNotIn("SSH-CALLED", proc.stdout, args)


class RecoveryPoint(unittest.TestCase):
    """A partly failed upgrade must keep its way back: the dump, the snapshot and
    the version it came from. Only `ok` and `verify-failed` used to count, so a
    migrate that succeeded before a service failed to start left rollback
    refusing, and --restore-db unable to find the dump it had recorded."""

    def rows(self, *results_and_revs):
        rows = [{"utc": "t0", "action": "baseline", "from_rev": "", "to_rev": "aaaaaaa", "result": "ok",
                 "backup_dir": "", "snapshot": "", "hermes_from": "", "hermes_to": ""}]
        for index, (action, frm, to, result) in enumerate(results_and_revs, start=1):
            rows.append({"utc": f"t{index}", "action": action, "from_rev": frm, "to_rev": to, "result": result,
                         "backup_dir": f"/backups/{index}", "snapshot": f"pre-{to}-{index}", "hermes_from": "", "hermes_to": ""})
        return rows

    def test_a_clean_upgrade_is_the_way_back(self):
        point = vr.recovery_point(self.rows(("upgrade", "aaaaaaa", "bbbbbbb", "ok")), "bbbbbbb")
        self.assertEqual((point["from_rev"], point["backup_dir"]), ("aaaaaaa", "/backups/1"))

    def test_an_upgrade_that_failed_after_switching_keeps_its_dump(self):
        for result in ("switch-failed", "verify-failed", "switching"):
            rows = self.rows(("upgrade", "aaaaaaa", "bbbbbbb", result))
            point = vr.recovery_point(rows, "bbbbbbb")
            self.assertIsNotNone(point, result)
            self.assertEqual(point["backup_dir"], "/backups/1", result)
            named = vr.recovery_point(rows, "bbbbbbb", to="aaaaaaa")
            self.assertEqual(named["backup_dir"], "/backups/1", f"{result} with --to")

    def test_a_failed_migrate_leaves_the_old_version_running_with_the_dump_to_restore(self):
        # Migrations can commit one by one before the failing one; the checkout
        # and vm.env went back, so the VM runs the old version on a newer schema.
        point = vr.recovery_point(self.rows(("upgrade", "aaaaaaa", "bbbbbbb", "migrate-failed")), "aaaaaaa")
        self.assertEqual((point["result"], point["from_rev"], point["backup_dir"]), ("migrate-failed", "aaaaaaa", "/backups/1"))

    def test_a_crash_mid_switch_is_recoverable_from_the_row_written_before_it(self):
        rows = self.rows(("upgrade", "aaaaaaa", "bbbbbbb", "switching"))
        self.assertEqual(vr.recovery_point(rows, "bbbbbbb")["from_rev"], "aaaaaaa")

    def test_the_final_row_supersedes_the_switching_row(self):
        rows = self.rows(("upgrade", "aaaaaaa", "bbbbbbb", "switching"), ("upgrade", "aaaaaaa", "bbbbbbb", "ok"))
        self.assertEqual(vr.recovery_point(rows, "bbbbbbb")["result"], "ok")

    def test_nothing_to_recover(self):
        self.assertIsNone(vr.recovery_point(self.rows(("upgrade", "aaaaaaa", "bbbbbbb", "snapshot-failed")), "aaaaaaa"))
        rolled_back = self.rows(("upgrade", "aaaaaaa", "bbbbbbb", "ok"), ("rollback", "bbbbbbb", "aaaaaaa", "ok"))
        self.assertIsNone(vr.recovery_point(rolled_back, "aaaaaaa"), "a rollback consumed that upgrade")
        self.assertIsNone(vr.recovery_point(self.rows(("upgrade", "aaaaaaa", "bbbbbbb", "ok")), "ccccccc"),
                          "the recorded upgrade does not describe what is running")


class DatabasePruning(unittest.TestCase):
    def test_the_newest_replaced_database_is_kept_and_scratch_copies_go(self):
        names = [
            "kinerary_control_plane",
            "kinerary_control_plane_pre_rollback_20260901t100000z",
            "kinerary_control_plane_pre_rollback_20260915t100000z",
            "kinerary_control_plane_verify_20260916t090000z",
            "kinerary_control_plane_restore_20260916t090500z",
            "kinerary_control_plane_restore_failed_20260916t091000z",
            "postgres",
        ]
        self.assertEqual(sorted(vr.databases_to_prune(names)), [
            "kinerary_control_plane_pre_rollback_20260901t100000z",
            "kinerary_control_plane_restore_20260916t090500z",
            "kinerary_control_plane_restore_failed_20260916t091000z",
            "kinerary_control_plane_verify_20260916t090000z",
        ])

    def test_the_live_database_can_never_be_dropped(self):
        stub = vr.ControlPlane(vr.Report(io.StringIO(), color=False))
        with self.assertRaises(vr.Refused):
            stub.drop_database("kinerary_control_plane")
        with self.assertRaises(vr.Refused):
            stub.drop_database("postgres")


class RestoreOrchestration(unittest.TestCase):
    """--restore-db: the live database is only replaced by a copy that already
    restored cleanly and matched the dump, and any failure brings the services
    back on the untouched database."""

    class Stub(vr.ControlPlane):
        def __init__(self, fail_at=None, error=None, drop_fails=False, start_fails=False, drop_error=None):
            super().__init__(vr.Report(io.StringIO(), color=False))
            self.calls = []
            self.fail_at = fail_at
            self.error = error or vr.Refused(f"{fail_at} failed")
            self.drop_fails = drop_fails
            self.drop_error = drop_error
            self.start_fails = start_fails

        def _step(self, name, result=None):
            self.calls.append(name)
            if self.fail_at == name:
                raise self.error
            return result

        def prepare_restored_database(self, dump_dir, stamp):
            return self._step("prepare", "scratch_db")

        def stop_database_clients(self):
            self._step("stop")

        def take_backup(self, label, include_hermes):
            return self._step("backup", Path("/b"))

        def swap_in_database(self, scratch, stamp):
            return self._step("swap", vr.Swap("aside_db", stamp))

        def drop_database(self, name):
            self.calls.append(f"drop:{name}")
            if self.drop_fails:
                raise self.drop_error or subprocess.TimeoutExpired(["psql"], 120)

        def start_database_clients(self):
            self.calls.append("start")
            if self.start_fails:
                raise subprocess.TimeoutExpired(["docker", "compose", "up"], 900)

    def test_a_restore_that_fails_changes_nothing(self):
        stub = self.Stub(fail_at="prepare")
        with self.assertRaises(vr.Refused):
            vr.restore_database_for_rollback(stub, Path("/d"), "label")
        self.assertEqual(stub.calls, ["prepare"], "services were never stopped")

    def test_a_failed_swap_brings_the_services_back(self):
        for failing in ("stop", "backup", "swap"):
            stub = self.Stub(fail_at=failing)
            with self.assertRaises(vr.Refused):
                vr.restore_database_for_rollback(stub, Path("/d"), "label")
            self.assertIn("drop:scratch_db", stub.calls, failing)
            self.assertEqual(stub.calls[-1], "start", failing)

    def test_any_failure_after_the_stop_brings_the_services_back(self):
        # Not only Refused: a pg_dump past its timeout, a full disk, Ctrl-C.
        errors = (subprocess.TimeoutExpired(["pg_dump"], 900), OSError(28, "No space left on device"), KeyboardInterrupt())
        for error in errors:
            for failing in ("stop", "backup", "swap"):
                stub = self.Stub(fail_at=failing, error=error)
                with self.assertRaises(type(error)):
                    vr.restore_database_for_rollback(stub, Path("/d"), "label")
                self.assertIn("drop:scratch_db", stub.calls, (failing, error))
                self.assertEqual(stub.calls[-1], "start", (failing, error))

    def test_a_failed_cleanup_does_not_keep_the_services_down(self):
        stub = self.Stub(fail_at="backup", error=OSError(28, "No space left on device"), drop_fails=True)
        with self.assertRaises(OSError):
            vr.restore_database_for_rollback(stub, Path("/d"), "label")
        self.assertEqual(stub.calls[-1], "start")

    def test_ctrl_c_while_dropping_the_copy_still_restarts_the_services(self):
        stub = self.Stub(fail_at="backup", error=OSError(28, "No space left on device"),
                         drop_fails=True, drop_error=KeyboardInterrupt())
        with self.assertRaises(OSError):
            vr.restore_database_for_rollback(stub, Path("/d"), "label")
        self.assertEqual(stub.calls[-1], "start", "the bot and signups come back whatever the cleanup did")

    def test_services_that_cannot_be_started_again_are_named(self):
        stub = self.Stub(fail_at="backup", error=subprocess.TimeoutExpired(["pg_dump"], 900), start_fails=True)
        with self.assertRaises(vr.Refused) as refused:
            vr.restore_database_for_rollback(stub, Path("/d"), "label")
        message = str(refused.exception)
        self.assertIn("STOPPED", message)
        self.assertIn("pg_dump", message, "the failure that started it is still reported")
        self.assertIn("vm-relay-restart.sh", message, "and how to bring the services back by hand")
        self.assertIsInstance(refused.exception.__cause__, subprocess.TimeoutExpired)

    def test_success_replaces_the_database_after_an_exact_pre_rollback_backup(self):
        stub = self.Stub()
        swap = vr.restore_database_for_rollback(stub, Path("/d"), "label")
        self.assertEqual(stub.calls, ["prepare", "stop", "backup", "swap"])
        self.assertEqual(swap.aside, "aside_db", "the caller needs the replaced database to undo the swap")


class RecoveryCommands(unittest.TestCase):
    """The commands that bring production back must be able to fail.

    start_database_clients() runs where the caller is about to report whether
    the bot and signups are back. With unchecked commands that report could say
    "the rollback was undone" over a stopped stack, which is worse than the
    failure it is reporting.
    """

    def start_clients(self, compose_argv, relay_exit: int):
        tmp = Path(tempfile.mkdtemp(prefix="recovery-"))
        relay = tmp / "vm-relay-restart.sh"
        relay.write_text(f"#!/bin/sh\nexit {relay_exit}\n")
        relay.chmod(relay.stat().st_mode | stat.S_IEXEC)

        class CP(vr.ControlPlane):
            def compose(self, *args):
                return list(compose_argv)

        cp = CP(vr.Report(io.StringIO(), color=False))
        saved, vr.DEPLOYMENT_DIR = vr.DEPLOYMENT_DIR, tmp
        try:
            cp.start_database_clients()
        finally:
            vr.DEPLOYMENT_DIR = saved

    def test_a_compose_that_fails_is_reported(self):
        with self.assertRaises(vr.Refused):
            self.start_clients(["false"], relay_exit=0)

    def test_a_relay_restart_that_fails_is_reported(self):
        with self.assertRaises(vr.Refused):
            self.start_clients(["true"], relay_exit=1)

    def test_a_clean_restart_says_nothing(self):
        self.start_clients(["true"], relay_exit=0)


class RemoteRunnerCommand(unittest.TestCase):
    """ssh joins its argv with spaces and the far side runs the result through a
    shell, so every argument is shell source there. A snapshot description is
    "aa61f6e -> 8c89e30": unquoted, that `>` wrote the runner's output into a
    file on the Proxmox host and the caller saw no checks and no recovery."""

    def tokens(self, *args, **kwargs) -> list:
        return shlex.split(vr.remote_runner_command(*args, **kwargs))

    def test_a_description_with_an_arrow_arrives_whole(self):
        args = ["pre-8c89e30-202609180900", "aa61f6e -> 8c89e30"]
        self.assertEqual(self.tokens("create", "110", args), ["env", "bash", "-s", "--", "create", "110", *args])
        self.assertIn("\'aa61f6e -> 8c89e30\'", vr.remote_runner_command("create", "110", args),
                      "the description reaches the host quoted, or its `>` redirects there")

    def test_environment_values_with_spaces_stay_one_value(self):
        self.assertEqual(
            self.tokens("preflight", "110", ignore_snapshots=["pre-a-1", "pre-b-2"], refuse_storage="truenas-nfs other"),
            ["env", "IGNORE_SNAPSHOTS=pre-a-1 pre-b-2", "REFUSE_STORAGE=truenas-nfs other",
             "bash", "-s", "--", "preflight", "110"])

    def test_what_the_far_side_receives_is_what_was_meant(self):
        """End to end through a fake ssh that behaves as ssh does: it joins the
        arguments it is given with spaces and runs the result through a shell on
        the far side. Here that shell is real, so an unquoted `>` redirects."""
        tmp = Path(tempfile.mkdtemp(prefix="remote-"))
        bin_dir = tmp / "bin"
        bin_dir.mkdir()
        (bin_dir / "ssh").write_text(
            "#!/bin/sh\n"
            "while [ $# -gt 0 ]; do case \"$1\" in *@*) shift; break ;; *) shift ;; esac; done\n"
            "exec sh -c \"$*\"\n")                       # exactly what ssh does with its argv
        (bin_dir / "bash").write_text(
            "#!/usr/bin/env python3\n"
            "import json, os, sys\n"
            "sys.stdin.buffer.read()\n"
            "open(os.environ['FAKE_REMOTE_ARGS'], 'w').write(json.dumps(sys.argv[1:]))\n")
        for tool in ("ssh", "bash"):
            (bin_dir / tool).chmod((bin_dir / tool).stat().st_mode | stat.S_IEXEC)

        cp = vr.ControlPlane(vr.Report(io.StringIO(), color=False))
        cp._site = {"CP_VMID": "110", "CP_PROXMOX_SSH_KEY_ON_VM": "/root/.ssh/k",
                    "CP_PROXMOX_KNOWN_HOSTS_ON_VM": "/root/.ssh/kh", "PROXMOX_HOST": "pve.example",
                    "PROXMOX_SSH_USER": "root", "CP_REFUSE_STORAGE": "nas-share other-share"}
        args_file = tmp / "remote-args.json"
        saved_path, saved_cwd = os.environ["PATH"], os.getcwd()
        saved_dirs = (vr.LIB_DIR, vr.DEPLOYMENT_DIR)
        os.environ["PATH"] = f"{bin_dir}:{saved_path}"
        os.environ["FAKE_REMOTE_ARGS"] = str(args_file)
        vr.LIB_DIR, vr.DEPLOYMENT_DIR = tmp / "absent", ROOT / "control-plane" / "deployment"
        os.chdir(tmp)  # a redirection on the far side would land here, not in the repo
        try:
            cp.proxmox("create", "pre-8c89e30-202609180900", "aa61f6e -> 8c89e30")
        finally:
            os.environ["PATH"] = saved_path
            os.environ.pop("FAKE_REMOTE_ARGS", None)
            vr.LIB_DIR, vr.DEPLOYMENT_DIR = saved_dirs
            os.chdir(saved_cwd)

        self.assertEqual(json.loads(args_file.read_text()),
                         ["-s", "--", "create", "110", "pre-8c89e30-202609180900", "aa61f6e -> 8c89e30"])
        self.assertEqual(sorted(f.name for f in tmp.iterdir() if f.is_file()), ["remote-args.json"],
                         "the description's `>` created a file on the Proxmox host")

    def test_nothing_a_caller_passes_can_become_another_command(self):
        tokens = self.tokens("delete", "110", ["pre-x-1; rm -rf /etc", "$(id)", "`id`", "a|b"])
        self.assertEqual(tokens[-4:], ["pre-x-1; rm -rf /etc", "$(id)", "`id`", "a|b"])


class RollbackUndo(unittest.TestCase):
    """Everything a rollback changed before its point of no return is undoable.

    The point of no return is the moment the target's services start. Before it,
    a half-finished rollback (a missing image, a failed migrate, Ctrl-C) must
    leave nothing behind: not a replaced database with its clients stopped, and
    not a replaced hermes-data with Hermes stopped.
    """

    class Stub:
        def __init__(self):
            self.calls = []
            self.r = vr.Report(io.StringIO(), color=False)
            self.dry_run = False

    def entry(self, stub, what, fails=None):
        def put_back():
            stub.calls.append(f"undo:{what}")
            if fails:
                raise fails
        return vr.Undo(what, put_back, f"do {what} by hand")

    def run_switch(self, stub, undo, switch_error=None, start_error=None):
        def switch_code():
            stub.calls.append("switch")
            if switch_error:
                raise switch_error

        def start_services():
            stub.calls.append("services")
            if start_error:
                raise start_error

        return vr.switch_with_undo(stub, undo, switch_code, start_services)

    def test_a_failure_before_the_services_start_undoes_everything_newest_first(self):
        for error in (vr.Refused("image missing"), vr.MigrateFailed("migrate failed"),
                      subprocess.TimeoutExpired(["git"], 60), KeyboardInterrupt()):
            stub = self.Stub()
            undo = [self.entry(stub, "the database"), self.entry(stub, "Hermes's data")]
            with self.assertRaises(type(error)):
                self.run_switch(stub, undo, switch_error=error)
            self.assertEqual(stub.calls, ["switch", "undo:Hermes's data", "undo:the database"], error)

    def test_a_rollback_that_changed_nothing_first_has_nothing_to_undo(self):
        stub = self.Stub()
        with self.assertRaises(vr.Refused):
            self.run_switch(stub, [], switch_error=vr.Refused("image missing"))
        self.assertEqual(stub.calls, ["switch"])

    def test_once_the_services_start_the_target_is_committed(self):
        stub = self.Stub()
        undo = [self.entry(stub, "the database")]
        with self.assertRaises(vr.Refused):
            self.run_switch(stub, undo, start_error=vr.Refused("relay restart failed"))
        self.assertEqual(stub.calls, ["switch", "services"],
                         "the target is running: putting the older database back would strand it")

    def test_a_clean_rollback_undoes_nothing(self):
        stub = self.Stub()
        self.run_switch(stub, [self.entry(stub, "the database")])
        self.assertEqual(stub.calls, ["switch", "services"])

    def test_ctrl_c_during_an_undo_does_not_abandon_the_others(self):
        # Ctrl-C is a recoverable failure everywhere else in a rollback, and the
        # person pressing it wants OUT of the rollback, not out of the recovery:
        # the database compensation still has to run.
        stub = self.Stub()
        undo = [self.entry(stub, "the database"), self.entry(stub, "Hermes's data", fails=KeyboardInterrupt())]
        with self.assertRaises(vr.Refused) as refused:
            self.run_switch(stub, undo, switch_error=vr.Refused("migrate failed"))
        self.assertEqual(stub.calls, ["switch", "undo:Hermes's data", "undo:the database"])
        self.assertIn("KeyboardInterrupt", str(refused.exception))
        self.assertIn("do Hermes's data by hand", str(refused.exception))

    def test_an_undo_that_fails_is_reported_and_the_rest_still_run(self):
        stub = self.Stub()
        undo = [self.entry(stub, "the database"), self.entry(stub, "Hermes's data", fails=vr.Refused("mv failed"))]
        with self.assertRaises(vr.Refused) as refused:
            self.run_switch(stub, undo, switch_error=vr.Refused("migrate failed"))
        message = str(refused.exception)
        self.assertIn("migrate failed", message, "the failure that started it")
        self.assertIn("mv failed", message)
        self.assertIn("do Hermes's data by hand", message, "what to run by hand")
        self.assertIn("undo:the database", stub.calls, "one step failing does not abandon the others")


class RollbackPreparation(unittest.TestCase):
    """What a rollback changes before the switch, and how each of those is put
    back. --restore-hermes moves the live hermes-data aside and stops Hermes, so
    a switch that then fails has to move it back and start Hermes again — on a
    code-only rollback too, where no database was touched at all."""

    class Stub(vr.ControlPlane):
        def __init__(self):
            super().__init__(vr.Report(io.StringIO(), color=False))
            self.calls = []
            self.sh = self
            self.dry_run = False

        fail_on = None

        def act(self, argv, *, describe="", **kwargs):  # stands in for cp.sh
            argv = [str(a) for a in argv]
            self.calls.append(" ".join(argv))
            if self.fail_on and self.fail_on in argv:
                raise vr.Refused(f"{self.fail_on} failed")
            # The directory moves happen for real, so what the recovery path sees
            # is what it would see on the VM: hermes-data gone from its place.
            if argv[0] == "mv":
                os.replace(argv[1], argv[2])
            if argv[:2] == ["rm", "-rf"]:
                shutil.rmtree(argv[2], ignore_errors=True)
            return subprocess.CompletedProcess(list(argv), 0, b"", b"")

        def prepare_restored_database(self, dump_dir, stamp):
            self.calls.append("prepare")
            return "scratch_db"

        def stop_database_clients(self):
            self.calls.append("stop-clients")

        def take_backup(self, label, include_hermes):
            self.calls.append(f"backup:{label}")
            return Path("/b")

        def swap_in_database(self, scratch, stamp):
            self.calls.append("swap")
            return vr.Swap("aside_db", stamp)

        def undo_swap(self, swap):
            self.calls.append(f"undo-swap:{swap.aside}")

        def start_database_clients(self):
            self.calls.append("start-clients")

    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="hermes-data-"))
        self.saved_hermes_data = vr.HERMES_DATA
        vr.HERMES_DATA = self.tmp / "hermes-data"
        vr.HERMES_DATA.mkdir()
        self.addCleanup(setattr, vr, "HERMES_DATA", self.saved_hermes_data)

    def aside_from(self, calls) -> Path:
        move = next(c for c in calls if c.startswith(f"mv {vr.HERMES_DATA} "))
        return Path(move.split(" ")[-1])

    def test_a_code_only_rollback_with_restore_hermes_can_still_be_undone(self):
        cp = self.Stub()
        undo = vr.prepare_rollback(cp, restore_db=False, dump_dir=Path("/d"), pre_label="lbl",
                                   restore_hermes=True, hermes_changes=True)
        self.assertEqual([entry.what for entry in undo], ["Hermes's data"],
                         "no database was replaced, but hermes-data was")
        self.assertIn("backup:lbl", cp.calls)
        aside = self.aside_from(cp.calls)
        self.assertTrue(aside.is_dir(), "the live hermes-data was kept")

        cp.calls.clear()
        with self.assertRaises(vr.Refused):
            vr.switch_with_undo(cp, undo, lambda: (_ for _ in ()).throw(vr.MigrateFailed("migrate failed")), lambda: None)
        self.assertEqual(
            [c for c in cp.calls if "hermes" in c.lower()],
            [f"rm -rf {vr.HERMES_DATA}", f"mv {aside} {vr.HERMES_DATA}",
             " ".join(cp.compose("up", "-d", "--wait", "hermes"))],
            "hermes-data goes back and Hermes is started again")

    def test_hermes_is_put_back_before_the_database(self):
        cp = self.Stub()
        undo = vr.prepare_rollback(cp, restore_db=True, dump_dir=Path("/d"), pre_label="lbl",
                                   restore_hermes=True, hermes_changes=True)
        self.assertEqual([entry.what for entry in undo], ["the database", "Hermes's data"])

        cp.calls.clear()
        with self.assertRaises(vr.Refused):
            vr.switch_with_undo(cp, undo, lambda: (_ for _ in ()).throw(vr.Refused("image missing")), lambda: None)
        ordered = [c for c in cp.calls if c.startswith(("rm -rf", "mv ", "undo-swap", "start-clients"))]
        self.assertEqual(ordered[0], f"rm -rf {vr.HERMES_DATA}")
        self.assertEqual(ordered[-2:], ["undo-swap:aside_db", "start-clients"])

    def test_a_plain_rollback_registers_nothing_to_undo(self):
        cp = self.Stub()
        undo = vr.prepare_rollback(cp, restore_db=False, dump_dir=None, pre_label="lbl",
                                   restore_hermes=False, hermes_changes=False)
        self.assertEqual(undo, [])
        self.assertEqual(cp.calls, ["backup:lbl"], "only the pre-rollback backup")

    def test_preparing_hermes_badly_undoes_the_database_swap_it_already_did(self):
        """The database is swapped and its clients stopped BEFORE hermes-data is
        touched. A tar that fails there used to escape with the swap in place:
        the old code stopped, against the restored database, with Hermes down."""
        cp = self.Stub()
        cp.fail_on = "tar"
        with self.assertRaises(vr.Refused) as refused:
            vr.prepare_rollback(cp, restore_db=True, dump_dir=Path("/d"), pre_label="lbl",
                                restore_hermes=True, hermes_changes=True)
        self.assertIn("tar failed", str(refused.exception))
        aside = self.aside_from(cp.calls)
        self.assertEqual(cp.calls[-5:],
                         [f"rm -rf {vr.HERMES_DATA}", f"mv {aside} {vr.HERMES_DATA}",
                          " ".join(cp.compose("up", "-d", "--wait", "hermes")),
                          "undo-swap:aside_db", "start-clients"],
                         "hermes-data goes back and Hermes starts, then the database swap is undone")
        self.assertTrue(vr.HERMES_DATA.is_dir(), "the live hermes-data is where it belongs again")

    def test_the_hermes_undo_starts_hermes_when_there_is_nothing_to_move_back(self):
        # Registered before the move, so it also covers a stop that never got
        # as far as moving anything: Hermes is down and must come back.
        cp = self.Stub()
        vr.undo_hermes_data(cp, self.tmp / "hermes-data.before-rollback-never")
        self.assertEqual(cp.calls, [" ".join(cp.compose("up", "-d", "--wait", "hermes"))])

    def test_the_hermes_undo_refuses_when_hermes_data_itself_is_gone(self):
        cp = self.Stub()
        shutil.rmtree(vr.HERMES_DATA)
        with self.assertRaises(vr.Refused) as refused:
            vr.undo_hermes_data(cp, self.tmp / "hermes-data.before-rollback-never")
        self.assertIn("before-rollback-never", str(refused.exception))
        self.assertFalse(cp.calls, "Hermes is not started on a missing profile directory")

    def test_each_step_says_how_to_finish_it_by_hand(self):
        cp = self.Stub()
        database = vr.database_undo(cp, vr.Swap("aside_db", "20260918t090000z"))
        self.assertIn("ALTER DATABASE", database.by_hand)
        self.assertIn("aside_db", database.by_hand)
        hermes = vr.hermes_undo(cp, self.tmp / "hermes-data.before-rollback-20260918T090000Z")
        self.assertIn("mv", hermes.by_hand)
        self.assertIn("hermes", hermes.by_hand)


INTERVIEW_SOURCE = """
if (AGENT_KEY) {
  mcp.tool( "collect_answer_for_chat", schema, handler);
  mcp.tool( "submit_answer_for_chat", schema, handler);
}
"""
COMPANION_SOURCE = (ROOT / "control-plane" / "api" / "src" / "companion-mcp.ts").read_text()


def reg(server, tools, count=None):
    """The line Hermes logs when a gateway registers an MCP server's tools."""
    prefix = "mcp__" + server.replace("-", "_") + "__"
    names = ", ".join(prefix + t for t in tools)
    return (f"2026-10-30 10:00:00 INFO tools.mcp: MCP server '{server}' registered "
            f"{len(tools) if count is None else count} tool(s): {names}")


def config_for(servers):
    body = "".join(f"  {s}:\n    transport: sse\n    url: http://127.0.0.1:1/sse\n" for s in servers)
    return "model:\n  default: x\nmcp_servers:\n" + body + "agent:\n  max_turns: 3\n"


class RetiredPrefixMatchesRelay(unittest.TestCase):
    """#420 AC-7: the Python retired-slug filter and the relay's NOT_RETIRED_SQL
    are two copies of one rule; this is what stops them drifting apart."""

    def test_the_prefix_equals_the_one_the_relay_uses(self):
        source = (ROOT / "control-plane" / "api" / "src" / "trip-retirement.ts").read_text()
        match = re.search(r'export const RETIRED_SLUG_PREFIX = "([^"]+)"', source)
        self.assertIsNotNone(match, "trip-retirement.ts no longer exports RETIRED_SLUG_PREFIX")
        self.assertEqual(vr.RETIRED_SLUG_PREFIX, match.group(1))

    def test_live_companions_filters_on_that_constant(self):
        cp = vr.ControlPlane(vr.Report(io.StringIO(), color=False))
        sql = []
        cp.psql = lambda text, **kw: (sql.append(text), "")[1]
        cp.live_companions()
        self.assertTrue(any(f"NOT LIKE '{vr.RETIRED_SLUG_PREFIX}%'" in s for s in sql), sql)


class FakeShell:
    """Stands in for cp.sh: answers `docker exec hermes …` from a table, records
    what was RUN (act) apart from what was only read, and prints like the real one."""

    def __init__(self, slots=(), down=(), ls_fails=False, restart_fails=(), listening=()):
        self.report = None
        self.dry_run = False
        self.slots = list(slots)
        self.down = set(down)
        self.ls_fails = ls_fails
        self.restart_fails = set(restart_fails)
        self.listening = set(listening)
        self.on_restart = lambda profile: None
        self.executed = []          # act() calls that really ran
        self.reads = []
        self.argvs = []             # every argv, read or act: AC-9 looks for a key in all of them

    def _answer(self, argv):
        rest = argv[3:] if argv[:3] == ["docker", "exec", vr.HERMES_CONTAINER] else []
        if rest[:1] == ["ls"]:
            if self.ls_fails:
                return 1, "Error response from daemon: container is not running"
            return 0, "\n".join(["s6-linux-init-shutdownd", *[f"gateway-{s}" for s in self.slots], "user"])
        if rest[:1] and rest[0].endswith("s6-svstat"):
            profile = rest[1].rsplit("gateway-", 1)[1]
            return 0, ("down (exitcode 0) 5 seconds" if profile in self.down else "up (pid 12) 100 seconds")
        if rest[:1] and rest[0].endswith("s6-svc"):
            profile = rest[2].rsplit("gateway-", 1)[1]
            return (1, "") if profile in self.restart_fails else (0, "")
        if argv[:1] == ["ss"]:
            port = argv[-1].rsplit(":", 1)[1]
            return 0, ("LISTEN 0 511 127.0.0.1:%s" % port) if port in self.listening else ""
        return 0, ""

    def read(self, argv, **kwargs):
        argv = [str(a) for a in argv]
        self.argvs.append(argv)
        self.reads.append(argv)
        rc, out = self._answer(argv)
        return subprocess.CompletedProcess(argv, rc, out.encode(), b"")

    def text(self, argv, **kwargs):
        return self.read(argv, **kwargs).stdout.decode()

    def act(self, argv, *, describe="", check=True, **kwargs):
        argv = [str(a) for a in argv]
        self.argvs.append(argv)
        shown = describe or " ".join(argv)
        if self.dry_run:
            self.report.step(f"would run: {shown}")
            return subprocess.CompletedProcess(argv, 0, b"", b"")
        self.report.step(shown)
        self.executed.append(argv)
        rc, out = self._answer(argv)
        rest = argv[3:] if argv[:3] == ["docker", "exec", vr.HERMES_CONTAINER] else []
        if rest[:1] and rest[0].endswith("s6-svc") and rc == 0:
            self.on_restart(rest[2].rsplit("gateway-", 1)[1])
        if check and rc != 0:
            raise vr.Refused(f"{shown} exited {rc}")
        return subprocess.CompletedProcess(argv, rc, out.encode(), b"")

    def executed_text(self):
        return [" ".join(a) for a in self.executed]


class FleetCP(vr.ControlPlane):
    """A ControlPlane with the database and the relay stubbed and a FakeShell for
    docker. What it does NOT stub is what these tests are about: discovery,
    restarts, registration reads, bridge health and classification."""

    def __init__(self, shell, *, live=(), retired=(), dry_run=False, events=(), core=False):
        self.out = io.StringIO()
        super().__init__(vr.Report(self.out, color=False), dry_run=dry_run)
        self.sh = shell
        shell.report, shell.dry_run = self.r, dry_run
        self.live, self.retired, self.events, self.core = list(live), set(retired), list(events), core

    def live_companions(self):
        return list(self.live)

    def retired_profiles(self):
        return set(self.retired)

    def relay_log(self):
        return self.events

    def vm_env(self):
        return {"KINERARY_REV": "rev1111", "HERMES_REV": "h1"}

    def core_checks(self, findings, events):
        if self.core:
            super().core_checks(findings, events)

    def said(self):
        return self.out.getvalue()


class FleetWorld(unittest.TestCase):
    """A scratch Hermes data directory, checkout and deploy root, patched in."""

    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="vm-release-fleet-"))
        self.addCleanup(shutil.rmtree, self.tmp, ignore_errors=True)
        self.data, self.repo, self.deploy = self.tmp / "hermes", self.tmp / "repo", self.tmp / "deploy"
        (self.data / "profiles").mkdir(parents=True)
        src = self.repo / "control-plane" / "api" / "src"
        src.mkdir(parents=True)
        (src / "interview-mcp.ts").write_text(INTERVIEW_SOURCE)
        (src / "companion-mcp.ts").write_text(COMPANION_SOURCE)
        (self.deploy / "trips").mkdir(parents=True)
        for name, value in (("HERMES_DATA", self.data), ("REPO", self.repo), ("DEPLOY_ROOT", self.deploy),
                            ("DEPLOYMENT_DIR", self.repo / "control-plane" / "deployment")):
            patcher = mock.patch.object(vr, name, value)
            patcher.start()
            self.addCleanup(patcher.stop)
        sleeper = mock.patch.object(vr.time, "sleep", lambda _s: None)
        sleeper.start()
        self.addCleanup(sleeper.stop)

    def profile(self, name, servers, *log):
        home = self.data / "profiles" / name
        (home / "logs").mkdir(parents=True, exist_ok=True)
        (home / "config.yaml").write_text(config_for(servers))
        (home / "logs" / "agent.log").write_text("".join(line + "\n" for line in log))
        return home

    def append_log(self, name, *lines):
        with (self.data / "profiles" / name / "logs" / "agent.log").open("a") as handle:
            handle.writelines(line + "\n" for line in lines)

    def log_text(self, name):
        return (self.data / "profiles" / name / "logs" / "agent.log").read_text()

    INTERVIEW_TOOLS = ["collect_answer_for_chat", "submit_answer_for_chat"]
    COMPANION_TOOLS = vr.extract_companion_tools(COMPANION_SOURCE)

    def healthy(self, name, servers=None):
        """A profile whose every configured server has registered."""
        servers = servers or {"trip-mcp": ["get_config"], "trip-control": self.COMPANION_TOOLS}
        return self.profile(name, list(servers), *[reg(s, t) for s, t in servers.items()])

    def intake(self, *extra):
        return self.profile("trip-intake", ["interview"], *extra, reg("interview", self.INTERVIEW_TOOLS))

    @staticmethod
    def by_id(result):
        return {c.id: c for c in result.checks}


class McpServerNames(unittest.TestCase):
    """The servers a gateway is configured to use come from its config.yaml, not from a list in the tool."""

    def test_the_keys_under_mcp_servers_and_nothing_else(self):
        text = ("model:\n  default: x\n# a comment\nmcp_servers:\n"
                "  trip-mcp:\n    transport: sse\n    url: \"SET_VIA_SECURE_CONFIG\"\n"
                "  # the companion's line to the control plane\n"
                "  trip-control:\n    transport: sse\n    headers:\n      Authorization: \"Bearer x\"\n"
                "  'quoted-one':\n    url: http://x\n"
                "agent:\n  disabled_toolsets:\n    - terminal\n")
        self.assertEqual(vr.mcp_server_names(text), ["trip-mcp", "trip-control", "quoted-one"])

    def test_none_configured(self):
        self.assertEqual(vr.mcp_server_names("mcp_servers: {}\nagent: {}\n"), [])
        self.assertEqual(vr.mcp_server_names("model: x\n"), [])
        self.assertEqual(vr.mcp_server_names(""), [])

    def test_a_disabled_server_is_not_expected_to_register(self):
        text = "mcp_servers:\n  on:\n    url: x\n  off:\n    enabled: false\n    url: y\n"
        self.assertEqual(vr.mcp_server_names(text), ["on"])

    def test_the_companion_tool_list_is_read_from_the_server_source(self):
        self.assertEqual(vr.extract_companion_tools(COMPANION_SOURCE),
                         ["get_assistant_names", "set_assistant_names", "report_bug"])
        self.assertEqual(vr.extract_companion_tools("nothing here"), [])


class GatewayDiscovery(FleetWorld):
    """#420: the running set is read off the supervisor, then judged."""

    def discover(self, shell, **kwargs):
        cp = FleetCP(shell, **kwargs)
        return cp, cp.running_gateways()

    def test_running_slots_with_a_profile_are_the_set_to_restart(self):
        self.intake(); self.healthy("trip-a"); self.healthy("trip-monitor", {"fleet": ["alerts"]})
        shell = FakeShell(slots=["trip-intake", "trip-a", "trip-monitor"])
        _cp, found = self.discover(shell, live=[("a-trip", "trip-a")])
        self.assertEqual(sorted(found.running), ["trip-a", "trip-intake", "trip-monitor"])
        self.assertEqual(found.skipped, [])
        self.assertIsNone(found.error)
        self.assertEqual(found.not_running, [])
        self.assertEqual(shell.executed, [], "discovery only reads")

    def test_a_slot_without_a_profile_directory_is_a_teardown_leftover(self):
        self.intake()
        shell = FakeShell(slots=["trip-intake", "trip-b"])
        _cp, found = self.discover(shell)
        self.assertEqual(found.running, ["trip-intake"])
        self.assertEqual(found.skipped, [("trip-b", "supervisor without a profile (teardown leftover)")])

    def test_a_running_slot_of_a_retired_trip_is_reported_not_restarted(self):
        self.intake(); self.healthy("trip-x")
        shell = FakeShell(slots=["trip-intake", "trip-x"])
        _cp, found = self.discover(shell, retired=["trip-x"])
        self.assertEqual(found.running, ["trip-intake"])
        self.assertEqual(found.skipped, [("trip-x", "retired trip")])

    def test_a_slot_s6_says_is_down_is_not_restarted(self):
        self.intake(); self.healthy("trip-a")
        shell = FakeShell(slots=["trip-intake", "trip-a"], down=["trip-a"])
        _cp, found = self.discover(shell, live=[("a-trip", "trip-a")])
        self.assertEqual(found.running, ["trip-intake"])
        self.assertEqual(found.not_running, ["trip-a"], "expected, and not running: verify fails it, the switch does not start it")
        self.assertEqual([p for p, _why in found.skipped], ["trip-a"])

    def test_a_slot_name_that_is_not_a_profile_name_is_never_passed_on(self):
        self.intake()
        shell = FakeShell(slots=["trip-intake", "Bad_Name", "x;reboot"])
        _cp, found = self.discover(shell)
        self.assertEqual(found.running, ["trip-intake"])
        self.assertEqual(sorted(p for p, _w in found.skipped), ["Bad_Name", "x;reboot"])

    def test_an_expected_profile_that_is_not_running_is_listed(self):
        self.intake()
        shell = FakeShell(slots=["trip-intake"])
        _cp, found = self.discover(shell, live=[("a-trip", "trip-a")])
        self.assertEqual(found.not_running, ["trip-a"])

    def test_an_unreadable_supervisor_is_an_error_never_an_empty_set(self):
        shell = FakeShell(ls_fails=True)
        _cp, found = self.discover(shell)
        self.assertEqual(found.running, [])
        self.assertIn("could not read the Hermes supervisor", found.error)

    def test_a_supervisor_listing_no_gateway_at_all_is_an_error_too(self):
        shell = FakeShell(slots=[])
        _cp, found = self.discover(shell)
        self.assertIn("could not read the Hermes supervisor", found.error)


class SwitchOrder(FleetWorld):
    """#420 AC-1, 4, 5, 6, 8: what start_switched runs, and in what order."""

    def world(self, *, restart_fails=(), ls_fails=False, registers=True, dry_run=False):
        self.intake(); self.healthy("trip-a"); self.healthy("trip-monitor", {"fleet": ["alerts"]})
        shell = FakeShell(slots=["trip-intake", "trip-a", "trip-monitor"], restart_fails=restart_fails, ls_fails=ls_fails)
        # A restarted gateway registers again: that is the fresh line the release waits for.
        def on_restart(profile):
            servers = vr.mcp_server_names((self.data / "profiles" / profile / "config.yaml").read_text())
            tools = {"interview": self.INTERVIEW_TOOLS, "trip-control": self.COMPANION_TOOLS}
            self.append_log(profile, *[reg(s, tools.get(s, ["t"])) for s in servers])
        shell.on_restart = on_restart if registers else (lambda _p: None)
        cp = FleetCP(shell, live=[("a-trip", "trip-a")], dry_run=dry_run)
        return cp, shell

    def test_every_running_gateway_restarts_once_between_the_compose_up_and_the_relay(self):
        cp, shell = self.world()
        cp.start_switched(None, restart_hermes=False)
        executed = shell.executed_text()
        restarts = [i for i, a in enumerate(executed) if "/command/s6-svc -r" in a]
        self.assertEqual(sorted(executed[i].split()[-1] for i in restarts),
                         ["/run/service/gateway-trip-a", "/run/service/gateway-trip-intake", "/run/service/gateway-trip-monitor"])
        up = next(i for i, a in enumerate(executed) if "up -d --wait" in a and "interview-mcp" in a and "companion-mcp" in a)
        stop = next(i for i, a in enumerate(executed) if a.endswith(" stop relay"))
        relay = next(i for i, a in enumerate(executed) if "vm-relay-restart.sh" in a)
        self.assertTrue(up < stop < min(restarts) and max(restarts) < relay, executed)
        self.assertNotIn("TRIP_INTAKE", cp.said())
        self.assertEqual(set(cp.gateway_restarted), {"trip-intake", "trip-a", "trip-monitor"})

    def test_each_profile_s_pre_restart_line_count_is_kept_for_verify(self):
        cp, shell = self.world()
        before = {p: self.log_text(p).count("\n") for p in ("trip-intake", "trip-a", "trip-monitor")}
        cp.start_switched(None, restart_hermes=False)
        self.assertEqual(cp.gateway_offsets, before)
        self.assertGreater(self.log_text("trip-a").count("\n"), before["trip-a"])

    def test_the_restart_is_one_function_per_profile(self):
        cp, shell = self.world()
        seen = []
        original = cp.restart_gateway
        cp.restart_gateway = lambda profile: (seen.append(profile), original(profile))[1]
        cp.start_switched(None, restart_hermes=False)
        self.assertEqual(sorted(seen), ["trip-a", "trip-intake", "trip-monitor"])

    def test_a_hermes_recreate_restarts_no_gateway_by_hand(self):
        cp, shell = self.world()
        before = {p: self.log_text(p).count("\n") for p in ("trip-intake", "trip-a", "trip-monitor")}
        cp.start_switched("abc1234", restart_hermes=True)
        executed = shell.executed_text()
        self.assertFalse([a for a in executed if "s6-svc" in a], executed)
        relay = next(i for i, a in enumerate(executed) if "vm-relay-restart.sh" in a)
        hermes = next(i for i, a in enumerate(executed) if a.endswith(" hermes"))
        self.assertGreater(hermes, relay, "Hermes is recreated after the relay restart, as before")
        for profile, count in before.items():
            self.assertEqual(cp.gateway_offsets[profile], count, "the log position is taken BEFORE the container goes")

    def test_one_failed_restart_does_not_stop_the_others_or_the_relay(self):
        cp, shell = self.world(restart_fails=["trip-a"])
        cp.start_switched(None, restart_hermes=False)           # no Refused: this is after the point of no return
        executed = shell.executed_text()
        self.assertEqual(len([a for a in executed if "s6-svc -r" in a]), 3, "all three were tried")
        self.assertTrue(any("vm-relay-restart.sh" in a for a in executed), "the relay still starts")
        self.assertIn("trip-a", cp.gateway_restart_failed)
        self.assertEqual(cp.gateway_restarted, {"trip-intake", "trip-monitor"})
        failed = [line for line in cp.said().splitlines() if "trip-a" in line and "✗" in line]
        self.assertTrue(failed, cp.said())

    def test_a_dry_run_discovers_for_real_and_runs_nothing(self):
        cp, shell = self.world(dry_run=True)
        cp.start_switched(None, restart_hermes=False)
        self.assertTrue([r for r in shell.reads if r[-2:] == ["ls", vr.S6_SCANDIR]], "discovery ran")
        self.assertEqual(shell.executed, [])
        said = cp.said()
        for profile in ("trip-intake", "trip-a", "trip-monitor"):
            self.assertRegex(said, rf"would run: .*{profile}")
        self.assertIn("compose", said)
        self.assertEqual(self.log_text("trip-a").count("registered"), 2, "a dry run changes nothing")

    def test_an_unreadable_supervisor_is_carried_not_swallowed(self):
        cp, shell = self.world(ls_fails=True)
        cp.start_switched(None, restart_hermes=False)
        self.assertIn("could not read the Hermes supervisor", cp.said())
        self.assertIn("could not read the Hermes supervisor", cp.switch_gateway_error)
        self.assertFalse([a for a in shell.executed_text() if "s6-svc" in a])
        self.assertTrue(any("vm-relay-restart.sh" in a for a in shell.executed_text()))

    def test_skipped_slots_are_reported_with_their_reason(self):
        cp, shell = self.world()
        shell.slots += ["trip-b", "trip-x"]
        self.healthy("trip-x")
        cp.retired = {"trip-x"}
        cp.start_switched(None, restart_hermes=False)
        self.assertIn("trip-b: supervisor without a profile (teardown leftover)", cp.said())
        self.assertIn("trip-x: retired trip", cp.said())
        self.assertFalse([a for a in shell.executed_text() if "gateway-trip-b" in a or "gateway-trip-x" in a])

    def test_it_waits_for_a_new_registration_not_the_old_one(self):
        cp, shell = self.world(registers=False)
        cp.start_switched(None, restart_hermes=False)
        self.assertEqual(self.log_text("trip-intake").count("registered"), 1, "nothing new was logged")
        self.assertIn("did not log", cp.said())
        self.assertIn("trip-intake", cp.said())

    def test_it_says_so_when_every_gateway_re_registered(self):
        cp, shell = self.world()
        cp.start_switched(None, restart_hermes=False)
        self.assertNotIn("did not log", cp.said())
        self.assertIn("re-registered", cp.said())

    def test_the_wait_is_bounded(self):
        cp, shell = self.world(registers=False)
        sleeps = []
        with mock.patch.object(vr.time, "sleep", lambda s: sleeps.append(s)):
            cp.start_switched(None, restart_hermes=False)
        self.assertLessEqual(sum(sleeps), 60)


class ProfileToolChecks(FleetWorld):
    """#294: each gateway is judged against the MCP servers in its own config,
    from lines written after its own restart."""

    def verify(self, shell=None, *, baseline=None, setup=None, **kwargs):
        shell = shell or FakeShell(slots=["trip-intake", "trip-a"])
        cp = FleetCP(shell, **kwargs)
        cp.companion_checks = lambda findings, events: None
        if setup:
            setup(cp)
        return cp, cp.verify(baseline)

    def test_a_companion_server_missing_a_tool_fails_with_its_name(self):
        self.intake()
        tools = [t for t in self.COMPANION_TOOLS if t != "report_bug"]
        self.profile("trip-a", ["trip-mcp", "trip-control"], reg("trip-mcp", ["get_config"]), reg("trip-control", tools))
        _cp, result = self.verify(live=[("a-trip", "trip-a")])
        checks = self.by_id(result)
        self.assertFalse(checks["tools:trip-a:trip-control"].ok)
        self.assertEqual(checks["tools:trip-a:trip-control"].code, "MISSING:report_bug")
        self.assertTrue(checks["tools:trip-a:trip-mcp"].ok)
        self.assertTrue(checks["tools:trip-intake:interview"].ok)
        self.assertFalse(result.ok)

    def test_a_complete_registration_passes(self):
        self.intake(); self.healthy("trip-a")
        _cp, result = self.verify(live=[("a-trip", "trip-a")])
        self.assertTrue(result.ok, [c for c in result.checks if not c.ok])
        self.assertTrue(self.by_id(result)["tools:trip-a:trip-control"].ok)

    def test_tool_names_are_exact_not_substrings(self):
        self.intake()
        # `answer_for_chat` is not registered: `collect_answer_for_chat` merely contains it.
        source = self.repo / "control-plane" / "api" / "src" / "interview-mcp.ts"
        source.write_text('if (AGENT_KEY) {\n mcp.tool( "answer_for_chat", s, h);\n mcp.tool( "collect_answer_for_chat", s, h);\n}\n')
        _cp, result = self.verify(shell=FakeShell(slots=["trip-intake"]))
        self.assertEqual(self.by_id(result)["tools:trip-intake:interview"].code, "MISSING:answer_for_chat")

    def test_a_registration_older_than_the_restart_is_not_a_registration(self):
        old = reg("interview", self.INTERVIEW_TOOLS)
        self.profile("trip-intake", ["interview"], old)
        _cp, result = self.verify(shell=FakeShell(slots=["trip-intake"]),
                                  setup=lambda cp: (cp.gateway_offsets.update({"trip-intake": 1}),
                                                    cp.gateway_restarted.add("trip-intake")))
        check = self.by_id(result)["tools:trip-intake:interview"]
        self.assertEqual((check.ok, check.code), (False, "NOT_REGISTERED"))

    def test_a_line_written_after_the_restart_is_accepted(self):
        old = reg("interview", ["stale_for_chat"])
        self.profile("trip-intake", ["interview"], old)
        self.append_log("trip-intake", reg("interview", self.INTERVIEW_TOOLS))
        _cp, result = self.verify(shell=FakeShell(slots=["trip-intake"]),
                                  setup=lambda cp: (cp.gateway_offsets.update({"trip-intake": 1}),
                                                    cp.gateway_restarted.add("trip-intake")))
        self.assertTrue(self.by_id(result)["tools:trip-intake:interview"].ok, "the fresh line is the one judged, not the old")

    def test_a_rotated_log_is_read_whole(self):
        self.intake()
        _cp, result = self.verify(shell=FakeShell(slots=["trip-intake"]),
                                  setup=lambda cp: (cp.gateway_offsets.update({"trip-intake": 500}),
                                                    cp.gateway_restarted.add("trip-intake")))
        self.assertTrue(self.by_id(result)["tools:trip-intake:interview"].ok)

    def test_every_restarted_gateway_is_read_from_its_own_offset(self):
        # AC-13: three profiles, three offsets, no profile name in the check list.
        self.profile("trip-intake", ["interview"], "x", reg("interview", ["old_for_chat"]), "y")
        self.append_log("trip-intake", reg("interview", self.INTERVIEW_TOOLS))                      # line 4: after offset 3
        self.profile("trip-a", ["trip-mcp", "trip-control"], reg("trip-mcp", ["get_config"]),
                     reg("trip-control", self.COMPANION_TOOLS))                                      # both before offset 2
        self.profile("trip-monitor", ["fleet", "issues"], reg("fleet", ["alerts"]))
        self.append_log("trip-monitor", reg("fleet", ["alerts"]))                                   # fleet re-registered, issues did not
        self.profile("brand-new-gateway", ["whatever"], reg("whatever", ["t"]))
        shell = FakeShell(slots=["trip-intake", "trip-a", "trip-monitor", "brand-new-gateway"])

        def setup(cp):
            cp.gateway_offsets.update({"trip-intake": 3, "trip-a": 2, "trip-monitor": 1})
            cp.gateway_restarted.update({"trip-intake", "trip-a", "trip-monitor"})
        _cp, result = self.verify(shell, live=[("a-trip", "trip-a")], setup=setup)
        checks = self.by_id(result)
        self.assertEqual({k for k in checks if k.startswith("tools:")},
                         {"tools:trip-intake:interview", "tools:trip-a:trip-mcp", "tools:trip-a:trip-control",
                          "tools:trip-monitor:fleet", "tools:trip-monitor:issues", "tools:brand-new-gateway:whatever"})
        self.assertTrue(checks["tools:trip-intake:interview"].ok, "its own line 4 is after its own offset 3")
        self.assertEqual(checks["tools:trip-a:trip-mcp"].code, "NOT_REGISTERED", "nothing after ITS offset, whatever the others logged")
        self.assertEqual(checks["tools:trip-a:trip-control"].code, "NOT_REGISTERED")
        self.assertTrue(checks["tools:trip-monitor:fleet"].ok)
        self.assertEqual(checks["tools:trip-monitor:issues"].code, "NOT_REGISTERED")
        self.assertTrue(checks["tools:brand-new-gateway:whatever"].ok, "no restart recorded for it: its newest line stands")

    def test_a_restart_that_failed_leaves_a_recreated_server_stale(self):
        # AC-14: companion-mcp was recreated; the gateway was not restarted, so
        # its old trip-control connection is dead whatever its log says.
        self.intake(); self.healthy("trip-a")

        def setup(cp):
            cp.gateway_offsets["trip-a"] = self.log_text("trip-a").count("\n")
            cp.gateway_restart_failed.add("trip-a")
        _cp, result = self.verify(live=[("a-trip", "trip-a")], setup=setup,
                                  baseline=[vr.Check("tools:trip-a:trip-control", False, "STALE_REGISTRATION")])
        checks = self.by_id(result)
        self.assertEqual(checks["tools:trip-a:trip-control"].code, "STALE_REGISTRATION")
        self.assertTrue(checks["tools:trip-a:trip-mcp"].ok, "trip-mcp was not replaced by the switch: its line stands")
        self.assertIn("tools:trip-a:trip-control", [c.id for c in result.caused], "switch-owned: caused even if it failed before")

    def test_an_unreadable_supervisor_fails_the_discovery_check_as_caused(self):
        # AC-15
        self.intake()
        _cp, result = self.verify(shell=FakeShell(ls_fails=True), baseline=[vr.Check("gateways:discovery", False, "SUPERVISOR_UNREADABLE")])
        check = self.by_id(result)["gateways:discovery"]
        self.assertEqual((check.ok, check.code), (False, "SUPERVISOR_UNREADABLE"))
        self.assertEqual([c.id for c in result.caused], ["gateways:discovery"])

    def test_a_failure_carried_from_the_switch_still_fails_a_later_readable_discovery(self):
        self.intake()
        _cp, result = self.verify(shell=FakeShell(slots=["trip-intake"]), baseline=[],
                                  setup=lambda cp: setattr(cp, "switch_gateway_error", "could not read the Hermes supervisor"))
        self.assertEqual(self.by_id(result)["gateways:discovery"].code, "SUPERVISOR_UNREADABLE")

    def test_an_expected_gateway_that_is_not_running_fails_not_running(self):
        self.intake()
        _cp, result = self.verify(shell=FakeShell(slots=["trip-intake"]), live=[("a-trip", "trip-a")])
        check = self.by_id(result)["gateway:trip-a"]
        self.assertEqual((check.ok, check.code), (False, "NOT_RUNNING"))
        self.assertFalse([c for c in result.checks if c.id.startswith("tools:trip-a")])

    def test_a_gateway_the_switch_restarted_that_did_not_come_back_fails(self):
        self.intake(); self.profile("trip-monitor", ["fleet"], reg("fleet", ["alerts"]))
        _cp, result = self.verify(shell=FakeShell(slots=["trip-intake"]),
                                  setup=lambda cp: cp.gateway_restarted.add("trip-monitor"))
        self.assertEqual(self.by_id(result)["gateway:trip-monitor"].code, "NOT_RUNNING")

    def test_a_dormant_companion_has_no_checks_of_any_kind(self):
        # AC-11: live_companions() already leaves it out, and a stopped gateway is not discovered.
        self.intake(); self.healthy("dormant-one")
        (self.deploy / "trips" / "dormant-trip" / "mcp").mkdir(parents=True)
        (self.deploy / "trips" / "dormant-trip" / "mcp" / ".env").write_text("MCP_PORT=1\nMCP_API_KEY=k\n")
        shell = FakeShell(slots=["trip-intake", "dormant-one"], down=["dormant-one"])
        cp = FleetCP(shell, live=[])
        result = cp.verify(None)
        self.assertFalse([c for c in result.checks if "dormant" in c.id], [c.id for c in result.checks])

    def test_a_server_that_registers_no_tool_fails(self):
        self.intake()
        self.profile("trip-monitor", ["fleet"], reg("fleet", [], count=0))
        _cp, result = self.verify(shell=FakeShell(slots=["trip-intake", "trip-monitor"]))
        self.assertEqual(self.by_id(result)["tools:trip-monitor:fleet"].code, "NO_TOOLS")

    def test_the_interview_server_must_be_configured_on_the_interview_profile(self):
        self.profile("trip-intake", [], )
        _cp, result = self.verify(shell=FakeShell(slots=["trip-intake"]))
        self.assertEqual(self.by_id(result)["tools:trip-intake:interview"].code, "NOT_CONFIGURED")

    def test_a_running_gateway_without_a_readable_config_fails(self):
        self.intake()
        (self.data / "profiles" / "trip-intake" / "config.yaml").unlink()
        _cp, result = self.verify(shell=FakeShell(slots=["trip-intake"]))
        self.assertEqual(self.by_id(result)["tools:trip-intake:config"].code, "NO_CONFIG")

    def test_standalone_verify_without_a_baseline_calls_every_failure_unknown(self):
        self.intake()
        tools = [t for t in self.COMPANION_TOOLS if t != "report_bug"]
        self.profile("trip-a", ["trip-control"], reg("trip-control", tools))
        cp, result = self.verify(live=[("a-trip", "trip-a")])
        self.assertEqual([c.id for c in result.unknown], ["tools:trip-a:trip-control"])
        self.assertEqual(result.caused, [])
        self.assertIn("origin unknown", cp.said())
        self.assertFalse(result.ok)


class BridgeServer:
    """A loopback stand-in for a trip-mcp bridge's /health route."""

    def __init__(self, key, mode="ok"):
        outer = self
        self.key, self.mode, self.seen_keys = key, mode, []

        class Handler(BaseHTTPRequestHandler):
            def do_GET(self):
                outer.seen_keys.append(self.headers.get("X-API-Key"))
                if self.path != "/health":
                    return self.reply(404, "text/html", "<pre>Cannot GET " + self.path + "</pre>")
                if outer.mode == "no-route":
                    return self.reply(404, "text/html", "<!DOCTYPE html><pre>Cannot GET /health</pre>")
                if self.headers.get("X-API-Key") != outer.key:
                    return self.reply(401, "application/json", '{"error":"unauthorized"}')
                if outer.mode == "ok":
                    return self.reply(200, "application/json", '{"ok":true,"site":"reachable"}')
                if outer.mode == "site-401":
                    return self.reply(503, "application/json", '{"ok":false,"site":"refused","code":"HTTP_401"}')
                if outer.mode == "unreachable":
                    return self.reply(503, "application/json", '{"ok":false,"site":"unreachable","code":"EHOSTUNREACH"}')
                if outer.mode == "forged":
                    return self.reply(503, "application/json", '{"ok":false,"code":"ok"}\n{"ok":true}')
                return self.reply(500, "text/plain", "boom")

            def reply(self, status, kind, body):
                self.send_response(status)
                self.send_header("Content-Type", kind)
                self.end_headers()
                self.wfile.write(body.encode())

            def log_message(self, *args):
                pass

        self.httpd = HTTPServer(("127.0.0.1", 0), Handler)
        self.port = str(self.httpd.server_address[1])
        threading.Thread(target=self.httpd.serve_forever, daemon=True).start()

    def close(self):
        self.httpd.shutdown()
        self.httpd.server_close()


class BridgeHealth(FleetWorld):
    """#294 AC-3, 4, 9: a bridge that listens is not yet a bridge that works."""

    KEY = "k3y-0123456789-not-a-real-key"

    def bridge(self, mode="ok", key=None):
        server = BridgeServer(key or self.KEY, mode)
        self.addCleanup(server.close)
        return server

    def trip(self, slug, port, key=None):
        env = self.deploy / "trips" / slug / "mcp"
        env.mkdir(parents=True, exist_ok=True)
        text = f"MCP_PORT={port}\n" + (f'MCP_API_KEY="{key}"\n' if key else "")
        (env / ".env").write_text(text)

    def run_bridge_checks(self, server, slug="japan", listening=True, key=KEY):
        self.intake(); self.healthy("japan2026")
        self.trip(slug, server.port, key)
        shell = FakeShell(slots=["trip-intake", "japan2026"], listening=[server.port] if listening else [])
        cp = FleetCP(shell, live=[(slug, "japan2026")], events=[{"event": "relay.gateway_connected", "gateway_id": "japan2026"}])
        return cp, shell, cp.verify(None)

    def test_a_bridge_that_answers_ok_passes(self):
        server = self.bridge("ok")
        _cp, _sh, result = self.run_bridge_checks(server)
        check = self.by_id(result)["bridge:japan"]
        self.assertEqual((check.ok, check.code), (True, "ok"))
        self.assertEqual(server.seen_keys, [self.KEY], "the key went in the X-API-Key header")

    def test_a_stale_key_is_named_with_its_repair(self):
        server = self.bridge("site-401")
        cp, _sh, result = self.run_bridge_checks(server)
        check = self.by_id(result)["bridge:japan"]
        self.assertEqual((check.ok, check.code), (False, "HTTP_401"))
        self.assertIn("restart-bridges", check.text)
        self.assertIn("restart-bridges", cp.said())

    def test_a_bridge_that_refuses_its_own_key(self):
        server = self.bridge("ok", key="a-different-key")
        _cp, _sh, result = self.run_bridge_checks(server)
        self.assertEqual(self.by_id(result)["bridge:japan"].code, "BRIDGE_401")

    def test_a_bridge_that_cannot_reach_its_trip_reports_the_errno(self):
        _cp, _sh, result = self.run_bridge_checks(self.bridge("unreachable"))
        self.assertEqual(self.by_id(result)["bridge:japan"].code, "EHOSTUNREACH")

    def test_a_bridge_with_no_health_route_cannot_be_verified(self):
        # AC-4: distinct from a failure.
        cp, _sh, result = self.run_bridge_checks(self.bridge("no-route"))
        check = self.by_id(result)["bridge:japan"]
        self.assertEqual(check.code, "NO_HEALTH_ROUTE")
        self.assertIn("cannot be verified", cp.said())
        self.assertEqual([c.id for c in result.unverifiable], ["bridge:japan"])
        self.assertEqual(result.unknown, [])
        self.assertTrue(result.ok, "an old bridge is listed, it does not fail a standalone verify")

    def test_a_body_cannot_forge_a_second_line(self):
        _cp, _sh, result = self.run_bridge_checks(self.bridge("forged"))
        self.assertEqual(self.by_id(result)["bridge:japan"].code, "UNRECOGNIZED")

    def test_a_server_error_without_a_code_is_unrecognized(self):
        _cp, _sh, result = self.run_bridge_checks(self.bridge("boom"))
        self.assertEqual(self.by_id(result)["bridge:japan"].code, "UNRECOGNIZED")

    def test_a_bridge_that_is_not_listening_is_not_asked(self):
        server = self.bridge("ok")
        _cp, shell, result = self.run_bridge_checks(server, listening=False)
        check = self.by_id(result)["bridge:japan"]
        self.assertEqual((check.ok, check.code), (False, "none"))
        self.assertIn("restart-bridges", check.text)
        self.assertEqual(server.seen_keys, [], "the port check comes first")

    def test_no_key_beside_the_trip_means_nothing_could_be_asked(self):
        server = self.bridge("ok")
        _cp, _sh, result = self.run_bridge_checks(server, key=None)
        self.assertEqual(self.by_id(result)["bridge:japan"].code, "NO_KEY")
        self.assertEqual(server.seen_keys, [])

    def test_a_trip_without_a_bridge_is_a_note_not_a_check(self):
        self.intake(); self.healthy("japan2026")
        cp = FleetCP(FakeShell(slots=["trip-intake", "japan2026"]), live=[("japan", "japan2026")],
                     events=[{"event": "relay.gateway_connected", "gateway_id": "japan2026"}])
        result = cp.verify(None)
        self.assertNotIn("bridge:japan", self.by_id(result))
        self.assertIn("no trip-mcp bridge configured", cp.said())

    def test_the_key_is_never_on_a_command_line_or_in_any_output(self):
        # AC-9
        server = self.bridge("site-401")
        with mock.patch.object(vr.subprocess, "run", side_effect=AssertionError("a process was spawned")), \
                mock.patch.object(vr.subprocess, "Popen", side_effect=AssertionError("a process was spawned")):
            cp, shell, result = self.run_bridge_checks(server)
        self.assertFalse([a for a in shell.argvs if any(self.KEY in part for part in a)], "key on an argv")
        self.assertNotIn(self.KEY, cp.said())
        path = self.tmp / "baseline.json"
        vr.save_baseline(result.checks, path)
        self.assertNotIn(self.KEY, path.read_text())
        self.assertFalse([c for c in result.checks if self.KEY in c.id + c.code + c.text])

    def test_bridge_health_codes_match_the_install_script(self):
        # companion-install-host.sh bridge_health_code(): same bodies, same codes.
        for body, code in (("", "none"),
                           ('{"ok":true,"site":"reachable"}', "ok"),
                           ('{"ok":false,"code":"ok"}', "UNRECOGNIZED"),
                           ('{"ok":false,"code":"E1"}\n{"ok":true}', "UNRECOGNIZED"),
                           ('{"ok":false,"site":"refused","code":"HTTP_401"}', "HTTP_401"),
                           ('{"ok":false,"site":"unreachable","code":"ETIMEDOUT"}', "ETIMEDOUT"),
                           ('{"error":"unauthorized"}', "BRIDGE_401"),
                           ("<!DOCTYPE html><pre>Cannot GET /health</pre>", "NO_HEALTH_ROUTE"),
                           ("<html>nginx</html>", "UNRECOGNIZED"),
                           ('{"ok":false,"code":"x y"}', "UNRECOGNIZED"),
                           ('{"ok":false,"code":"' + "A" * 41 + '"}', "UNRECOGNIZED"),
                           ('{"ok":false,"code":"E1"}\n{"ok":false,"code":"E2"}', "UNRECOGNIZED")):
            self.assertEqual(vr.bridge_health_code(body), code, body)


class BaselineClassification(unittest.TestCase):
    """#294 AC-5 to AC-8, AC-12: a failure the upgrade did not cause is told apart from one it did."""

    @staticmethod
    def fail(id, code="X"):
        return vr.Check(id, False, code)

    @staticmethod
    def good(id):
        return vr.Check(id, True, "ok")

    def test_a_bridge_that_failed_the_same_way_before_is_preexisting(self):
        result = vr.classify([self.fail("bridge:japan", "HTTP_401")], [self.fail("bridge:japan", "HTTP_401")])
        self.assertEqual([c.id for c in result.preexisting], ["bridge:japan"])
        self.assertEqual((result.caused, result.unknown), ([], []))
        self.assertTrue(result.ok)

    def test_a_changed_code_is_caused(self):
        result = vr.classify([self.fail("bridge:japan", "HTTP_401")], [self.fail("bridge:japan", "ECONNREFUSED")])
        self.assertEqual([c.id for c in result.caused], ["bridge:japan"])
        self.assertFalse(result.ok)

    def test_a_non_exemptable_check_that_failed_before_still_counts(self):
        for check_id in ("tools:trip-intake:interview", "readyz", "image:kinerary-cp-api-1", "web:portal-proxy",
                         "relay:ready", "gateways:discovery", "gateway:trip-a", "tools:trip-a:trip-control"):
            result = vr.classify([self.fail(check_id, "C")], [self.fail(check_id, "C")])
            self.assertEqual([c.id for c in result.caused], [check_id], check_id)
            self.assertFalse(result.ok, check_id)

    def test_a_check_that_passed_before_and_fails_now_is_caused(self):
        for check_id in ("bridge:japan", "companion-connected:japan2026"):
            result = vr.classify([self.good(check_id)], [self.fail(check_id, "none")])
            self.assertEqual([c.id for c in result.caused], [check_id])

    def test_a_check_that_did_not_exist_before_and_fails_now_is_caused(self):
        result = vr.classify([], [self.fail("bridge:newtrip", "none")])
        self.assertEqual([c.id for c in result.caused], ["bridge:newtrip"])

    def test_a_companion_that_was_not_connected_before_and_is_not_now_is_preexisting(self):
        result = vr.classify([self.fail("companion-connected:t", "NOT_CONNECTED")], [self.fail("companion-connected:t", "NOT_CONNECTED")])
        self.assertEqual([c.id for c in result.preexisting], ["companion-connected:t"])

    def test_trip_mcp_tools_follow_a_preexisting_bridge_and_only_then(self):
        bridge_broken = [self.fail("bridge:japan", "HTTP_401"), self.good("tools:japan2026:trip-mcp")]
        now = [self.fail("bridge:japan", "HTTP_401"), self.fail("tools:japan2026:trip-mcp", "NOT_REGISTERED")]
        result = vr.classify(bridge_broken, now, bridge_of={"japan2026": "japan"})
        self.assertEqual(sorted(c.id for c in result.preexisting), ["bridge:japan", "tools:japan2026:trip-mcp"])
        self.assertTrue(result.ok)
        # The bridge worked before: a trip-mcp that no longer registers is this upgrade's.
        result = vr.classify([self.good("bridge:japan")], now, bridge_of={"japan2026": "japan"})
        self.assertEqual(sorted(c.id for c in result.caused), ["bridge:japan", "tools:japan2026:trip-mcp"])
        # And every other server of that companion is never exempt, whatever its bridge did.
        result = vr.classify(bridge_broken, [self.fail("bridge:japan", "HTTP_401"), self.fail("tools:japan2026:trip-control", "NOT_REGISTERED")],
                             bridge_of={"japan2026": "japan"})
        self.assertEqual([c.id for c in result.caused], ["tools:japan2026:trip-control"])

    def test_no_health_route_is_caused_only_if_it_passed_before(self):
        # AC-4
        route_gone = self.fail("bridge:japan", "NO_HEALTH_ROUTE")
        result = vr.classify([self.good("bridge:japan")], [route_gone])
        self.assertEqual([c.id for c in result.caused], ["bridge:japan"])
        for before in ([self.fail("bridge:japan", "HTTP_401")], [self.fail("bridge:japan", "NO_HEALTH_ROUTE")], []):
            result = vr.classify(before, [route_gone])
            self.assertEqual([c.id for c in result.unverifiable], ["bridge:japan"])
            self.assertEqual(result.caused, [])
            self.assertTrue(result.ok)

    def test_with_no_baseline_every_failure_is_of_unknown_origin(self):
        # AC-8
        result = vr.classify(None, [self.fail("bridge:japan", "HTTP_401"), self.good("readyz"), self.fail("readyz2", "X")])
        self.assertEqual([c.id for c in result.unknown], ["bridge:japan", "readyz2"])
        self.assertEqual((result.caused, result.preexisting), ([], []))
        self.assertFalse(result.ok)

    def test_a_clean_run_is_ok(self):
        result = vr.classify([self.good("readyz")], [self.good("readyz")])
        self.assertTrue(result.ok)
        self.assertEqual(len(result.checks), 1)

    def test_the_exemptable_classes_are_exactly_those_the_upgrade_does_not_own(self):
        self.assertEqual(sorted(vr.EXEMPTABLE), ["bridge:", "companion-connected:"])


class BaselineFile(FleetWorld):
    """#294 AC-10: a baseline is {id, ok, code} per check and nothing else."""

    def test_the_file_holds_id_ok_and_code_only(self):
        path = self.tmp / "state" / "baseline.json"
        checks = [vr.Check("bridge:japan", False, "HTTP_401", "trip japan: bridge says SECRET words"),
                  vr.Check("readyz", True, "ok", "readyz: ready")]
        vr.save_baseline(checks, path)
        data = json.loads(path.read_text())
        self.assertEqual(data, [{"id": "bridge:japan", "ok": False, "code": "HTTP_401"},
                                {"id": "readyz", "ok": True, "code": "ok"}])
        self.assertNotIn("SECRET", path.read_text())
        self.assertEqual(oct(path.stat().st_mode & 0o777), "0o600")
        self.assertEqual([(c.id, c.ok, c.code) for c in vr.load_baseline(path)], [("bridge:japan", False, "HTTP_401"), ("readyz", True, "ok")])

    def test_taking_a_baseline_writes_the_file_and_keeps_the_checks(self):
        cp = FleetCP(FakeShell(slots=["trip-intake"]))
        cp.collect_checks = lambda: vr.Findings([vr.Check("readyz", True, "ok", "t"), vr.Check("bridge:j", False, "HTTP_401", "t")])
        with mock.patch.object(vr, "STATE_DIR", self.tmp / "state"):
            path = cp.take_baseline("upgrade")
        self.assertTrue(path.exists())
        self.assertEqual(path.parent, self.tmp / "state")
        self.assertEqual([c.id for c in cp.baseline], ["readyz", "bridge:j"])
        self.assertIn("bridge:j", cp.said())

    def test_a_dry_run_reads_the_baseline_and_writes_nothing(self):
        cp = FleetCP(FakeShell(slots=["trip-intake"]), dry_run=True)
        cp.collect_checks = lambda: vr.Findings([vr.Check("readyz", True, "ok", "t")])
        with mock.patch.object(vr, "STATE_DIR", self.tmp / "state"):
            path = cp.take_baseline("upgrade")
        self.assertIsNone(path)
        self.assertFalse((self.tmp / "state").exists())

    def test_a_baseline_that_cannot_be_taken_is_said_and_leaves_nothing_to_compare(self):
        cp = FleetCP(FakeShell(slots=["trip-intake"]))

        def boom():
            raise vr.Refused("psql: connection refused")
        cp.collect_checks = boom
        with mock.patch.object(vr, "STATE_DIR", self.tmp / "state"):
            self.assertIsNone(cp.take_baseline("upgrade"))
        self.assertIsNone(cp.baseline)
        self.assertIn("could not be taken", cp.said())
        self.assertIn("psql: connection refused", cp.said())

    def test_the_history_row_names_the_baseline_and_old_files_still_read(self):
        # Eleven columns, as written before the field existed.
        old = self.tmp / "history.tsv"
        old_fields = vr.HISTORY_FIELDS[:-1]
        self.assertEqual(vr.HISTORY_FIELDS[-1], "baseline")
        old.write_text("\t".join(old_fields) + "\n" + "\t".join(["t0", "upgrade", "aa", "bb", "h1", "h1", "pre-bb", "/b", "compatible", "ok", "human"]) + "\n")
        rows = vr.read_history(old)
        self.assertEqual((rows[0]["result"], rows[0]["baseline"]), ("ok", ""))
        vr.append_history({"utc": "t1", "action": "upgrade", "result": "ok", "baseline": "/var/lib/x/baseline-1.json"}, old)
        self.assertEqual(vr.read_history(old)[-1]["baseline"], "/var/lib/x/baseline-1.json")
        self.assertEqual(vr.read_history(old)[0]["result"], "ok")

    def test_pre_existing_failures_are_listed_for_the_notification(self):
        result = vr.classify([vr.Check("bridge:japan", False, "HTTP_401")], [vr.Check("bridge:japan", False, "HTTP_401"), vr.Check("readyz", True, "ok")])
        text = vr.preexisting_summary(result)
        self.assertIn("already failing before this upgrade", text)
        self.assertIn("bridge:japan (HTTP_401)", text)
        self.assertEqual(vr.preexisting_summary(vr.classify([], [vr.Check("readyz", True, "ok")])), "")


class WebChecks(FleetWorld):
    """#294 AC-12: the portal and runtime gateway belong to the switch, so a proxy that
    failed before the upgrade and fails after it is still the upgrade's to fix."""

    def web_findings(self, answers):
        deployment = self.repo / "control-plane" / "deployment"
        deployment.mkdir(parents=True, exist_ok=True)
        (deployment / "compose.vm.yml").write_text("services:\n  portal:\n    image: p\n  runtime-gateway:\n    image: g\n")
        cp = FleetCP(FakeShell())
        cp.web_enabled = lambda: True
        cp.probe_in = lambda container, url: answers[container]
        findings = vr.Findings()
        running = {"kinerary-cp-portal-1": "kinerary-cp/portal:abc1234", "kinerary-cp-runtime-gateway-1": "kinerary-cp/runtime-gateway:abc1234"}
        cp.verify_web(findings, running, "abc1234")
        return findings

    def test_the_web_checks_have_stable_ids(self):
        findings = self.web_findings({"kinerary-cp-portal-1": (True, '{"emailPassword":true}'),
                                      "kinerary-cp-runtime-gateway-1": (True, '{"ok":true}')})
        self.assertEqual([c.id for c in findings.checks],
                         ["web:portal", "web:runtime-gateway", "web:portal-proxy", "web:gateway-health"])
        self.assertTrue(all(c.ok for c in findings.checks))

    def test_a_proxy_that_failed_before_and_after_is_caused(self):
        answers = {"kinerary-cp-portal-1": (False, "bad gateway"), "kinerary-cp-runtime-gateway-1": (True, '{"ok":true}')}
        before = self.web_findings(answers).checks
        after = self.web_findings(answers).checks
        result = vr.classify(before, after)
        self.assertEqual([c.id for c in result.caused], ["web:portal-proxy"])
        self.assertFalse(result.ok)


def one_failing():
    return vr.Findings([vr.Check("readyz", True, "ok", "readyz: ready"),
                        vr.Check("bridge:japan", False, "HTTP_401", "trip japan: bridge refused")])


class StandaloneVerify(unittest.TestCase):
    """#294 AC-8: no baseline and one failing check: exit 1, origin unknown."""

    def test_the_cli_exits_1(self):
        out = io.StringIO()
        with mock.patch.object(vr, "ON_THE_VM", False), \
                mock.patch.object(vr.ControlPlane, "collect_checks", lambda self: one_failing()), \
                contextlib.redirect_stdout(out):
            code = vr.main(["verify"])
        self.assertEqual(code, 1)
        self.assertIn("origin unknown", out.getvalue())

    def test_the_agent_gate_exits_1_and_says_origin_unknown(self):
        out = io.StringIO()
        with mock.patch.object(vr.ControlPlane, "collect_checks", lambda self: one_failing()), \
                contextlib.redirect_stdout(out):
            code = vr.cmd_gate(["verify"])
        self.assertEqual(code, 1)
        self.assertIn("origin unknown", out.getvalue())

    def test_both_exit_0_when_nothing_fails(self):
        clean = vr.Findings([vr.Check("readyz", True, "ok", "readyz: ready")])
        with mock.patch.object(vr, "ON_THE_VM", False), mock.patch.object(vr.ControlPlane, "collect_checks", lambda self: clean), \
                contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(vr.main(["verify"]), 0)
            self.assertEqual(vr.cmd_gate(["verify"]), 0)


class SourceInvariants(unittest.TestCase):
    def test_no_gateway_profile_is_named_in_the_check_code(self):
        source = TOOL.read_text()
        for name in ("trip-monitor", "familytrip"):
            self.assertNotIn(f'"{name}"', source, name)


class GateWrapper(unittest.TestCase):
    """The forced command: tokens only, handed to `sudo -n <tool> gate` as argv."""

    def run_gate(self, command: str):
        tmp = Path(tempfile.mkdtemp())
        fake_sudo = tmp / "sudo"
        fake_sudo.write_text("#!/bin/sh\nfor a in \"$@\"; do printf '<%s>' \"$a\"; done\necho\n")
        fake_sudo.chmod(fake_sudo.stat().st_mode | stat.S_IEXEC)
        env = {**os.environ, "SSH_ORIGINAL_COMMAND": command, "KINERARY_CP_RELEASE_SUDO": str(fake_sudo),
               "KINERARY_CP_RELEASE_TOOL": "/usr/local/sbin/kinerary-cp-release"}
        proc = subprocess.run(["sh", str(GATE)], capture_output=True, text=True, env=env)
        return proc.returncode, proc.stdout

    def test_tokens_pass_through_as_argv(self):
        code, out = self.run_gate("request upgrade main")
        self.assertEqual(code, 0)
        self.assertEqual(out.strip(), "<-n></usr/local/sbin/kinerary-cp-release><gate><request><upgrade><main>")

    def test_shell_metacharacters_never_reach_anything(self):
        for command in ("status; reboot", "plan $(id)", "plan `id`", "status && rm -rf /", "plan main|sh",
                        "status > /etc/passwd", "plan *", "approve r-1 12'3456", "", "a " * 20):
            code, out = self.run_gate(command)
            self.assertNotEqual(code, 0, command)
            self.assertTrue(out.startswith("refused"), f"{command!r}: {out}")


if __name__ == "__main__":
    unittest.main()
