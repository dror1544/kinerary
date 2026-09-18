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

import importlib.util
import io
import json
import os
import shlex
import shutil
import stat
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path

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
