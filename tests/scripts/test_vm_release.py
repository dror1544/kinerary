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
import json
import os
import stat
import subprocess
import sys
import tempfile
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
        self.assertEqual(vr.last_good_upgrade(rows)["from_rev"], "aa61f6e")
        vr.append_history({"utc": "t2", "action": "upgrade", "from_rev": "3a9f1c2", "to_rev": "bbbbbbb", "result": "snapshot-failed"}, path)
        self.assertEqual(vr.last_good_upgrade(vr.read_history(path))["to_rev"], "3a9f1c2")
        vr.append_history({"utc": "t3", "action": "rollback", "from_rev": "3a9f1c2", "to_rev": "aa61f6e", "result": "ok"}, path)
        self.assertIsNone(vr.last_good_upgrade(vr.read_history(path)))


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
