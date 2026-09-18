"""control-plane/deployment/proxmox-snapshot-runner.sh — release snapshots that cannot hang a VM.

The runner is streamed over ssh to the Proxmox host and takes, lists and
deletes VM 900's release snapshots. Two things make it worth testing without a
Proxmox host:

- the preconditions: a snapshot is refused for storage that is not lvmthin,
  network shares above all (a vzdump into one froze the host's NFS and the
  control-plane VM on 2026-09-13); for a locked VM; while a backup or snapshot task runs;
  when the guest agent does not answer or the guest is already frozen; and when
  the shared thin pool is short of data, metadata or worst-case room;
- the recovery: a snapshot that stalls must end with the guest thawed, the VM
  unlocked once its task is gone, and no half-made snapshot left behind — and
  it must NOT unlock under a task that is still running.

Proxmox's own tools are replaced by one fake (below) that keeps state in a
JSON file, so each scenario is a state plus a command.
"""
from __future__ import annotations

import json
import os
import stat
import subprocess
import tempfile
import time
import unittest
from pathlib import Path

RUNNER = Path(__file__).resolve().parents[2] / "control-plane" / "deployment" / "proxmox-snapshot-runner.sh"

FAKE = r'''#!/usr/bin/env python3
import json, os, subprocess, sys, time
name = os.path.basename(sys.argv[0]); args = sys.argv[1:]
state_path = os.environ["FAKE_PVE_STATE"]
def load():
    with open(state_path) as f: return json.load(f)
def save(s):
    with open(state_path, "w") as f: json.dump(s, f)
with open(os.environ["FAKE_PVE_CALLS"], "a") as f: f.write(name + " " + " ".join(args) + "\n")
s = load()
now = time.time()
if name == "timeout":
    rest = list(args)
    if rest and rest[0].startswith("--kill-after"): rest.pop(0)
    seconds = float(rest.pop(0))
    try:
        sys.exit(subprocess.run(rest, timeout=seconds).returncode)
    except subprocess.TimeoutExpired:
        sys.exit(124)
if name == "hostname": print("proxmox"); sys.exit(0)
if name == "pvesm":
    print("Name Type Status Total Used Available %")
    for k, v in s["storage_types"].items(): print(f"{k} {v} active 1 1 1 1%")
    sys.exit(0)
if name == "lvs": print("  " + s["lvs"][args[-1]]); sys.exit(0)
if name == "vgs": print("  " + s["vgs"][args[-1]]); sys.exit(0)
if name == "pvesh":
    path = args[1]
    key = "snapshot" if path.endswith("/snapshot") else "tasks" if path.endswith("/tasks") else "other"
    seen = s.setdefault("pvesh_calls", {})
    seen[key] = seen.get(key, 0) + 1
    save(s)
    if key in s.get("pvesh_fails", []) or seen[key] >= s.get("pvesh_fails_after", {}).get(key, 10 ** 9):
        print("api error", file=sys.stderr); sys.exit(2)          # the API answered, badly
    if key in s.get("pvesh_garbage", []):
        print('[{"name": "pre-tru'); sys.exit(0)                    # truncated JSON, exit 0
    if key == "snapshot":
        print(json.dumps(s["snapshots"] + [{"name": "current", "running": 1}])); sys.exit(0)
    if key == "tasks":
        print(json.dumps([t for t in s["tasks"] if t.get("until", now + 1) > now])); sys.exit(0)
    sys.exit(1)
if name == "qm":
    verb = args[0]
    if verb == "config":
        print(s["config"].rstrip("\n"))
        if s["lock"]: print("lock: " + s["lock"])
        sys.exit(0)
    if verb == "status": print("status: " + s["status"]); sys.exit(0)
    if verb == "agent": sys.exit(0 if s["agent_ping"] else 1)
    if verb == "guest":
        cmd = args[3]
        if cmd == "fsfreeze-status":
            if s.get("freeze_hangs"): time.sleep(60)
            print('"' + s["freeze"] + '"'); sys.exit(0)
        if cmd == "fsfreeze-thaw": s["freeze"] = "thawed"; save(s); print(1); sys.exit(0)
    if verb == "unlock": s["lock"] = ""; save(s); sys.exit(0)
    if verb == "delsnapshot":
        s["snapshots"] = [x for x in s["snapshots"] if x["name"] != args[2]]; save(s); sys.exit(0)
    if verb == "snapshot":
        snap = args[2]; how = s["snapshot_behavior"]
        if how == "ok":
            s["snapshots"].append({"name": snap, "snaptime": int(now), "description": "d"}); save(s); sys.exit(0)
        # A stall: the guest is frozen, the VM locked, a task running, and a
        # partial snapshot already registered — then nothing happens until killed.
        s["freeze"] = "frozen"; s["lock"] = "snapshot"
        s["snapshots"].append({"name": snap, "snaptime": int(now), "description": "partial"})
        s["tasks"].append({"type": "qmsnapshot", "id": "900", "upid": "UPID:x", "until": now + s["task_lingers"]})
        save(s)
        if how == "hang": time.sleep(60)
        sys.exit(1)
    sys.exit(2)
sys.exit(3)
'''

STORAGE_CFG = """dir: local
\tpath /var/lib/vz

lvmthin: fast-thin
\tthinpool data
\tvgname vg-fast
\tcontent rootdir,images

nfs: nas-share
\tserver nas.example
\texport /mnt/pool
"""

CONFIG = """agent: enabled=1
boot: order=scsi0
ide2: fast-thin:vm-900-cloudinit,media=cdrom
memory: 10240
scsi0: fast-thin:vm-900-disk-0,discard=on,iothread=1,size=80G,ssd=1
"""


def healthy_state() -> dict:
    return {
        "config": CONFIG,
        "status": "running",
        "lock": "",
        "freeze": "thawed",
        "agent_ping": True,
        "tasks": [{"type": "vncproxy", "id": "100", "upid": "UPID:vnc"}],
        "snapshots": [],
        "storage_types": {"local": "dir", "fast-thin": "lvmthin", "nas-share": "nfs"},
        "lvs": {"vg-fast/data": "28.83 18.24 906.17"},
        "vgs": {"vg-fast": "47.47"},
        "snapshot_behavior": "ok",
        "task_lingers": 0.2,
    }


class Runner(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="pve-runner-"))
        self.bin = self.tmp / "bin"
        self.bin.mkdir()
        fake = self.bin / "fakepve"
        fake.write_text(FAKE)
        fake.chmod(fake.stat().st_mode | stat.S_IEXEC)
        for tool in ("qm", "pvesh", "pvesm", "lvs", "vgs", "timeout", "hostname"):
            (self.bin / tool).symlink_to(fake)
        (self.tmp / "storage.cfg").write_text(STORAGE_CFG)
        self.state_path = self.tmp / "state.json"
        self.calls_path = self.tmp / "calls.log"
        self.calls_path.write_text("")

    def run_runner(self, state: dict, *args: str, **env_overrides: str) -> tuple[int, dict, str]:
        self.state_path.write_text(json.dumps(state))
        env = {
            **os.environ,
            "PATH": f"{self.bin}:{os.environ['PATH']}",
            "FAKE_PVE_STATE": str(self.state_path),
            "FAKE_PVE_CALLS": str(self.calls_path),
            "STORAGE_CFG": str(self.tmp / "storage.cfg"),
            "RECOVERY_POLL": "0.1",
            "TASK_WAIT_SECONDS": "2",
            "AGENT_TIMEOUT": "3",
            **env_overrides,
        }
        proc = subprocess.run(["bash", str(RUNNER), *args], capture_output=True, text=True, env=env, timeout=120)
        return proc.returncode, json.loads(self.state_path.read_text()), proc.stdout

    def calls(self) -> list[str]:
        return self.calls_path.read_text().splitlines()

    @staticmethod
    def check(output: str, name: str) -> str:
        for line in output.splitlines():
            if line.startswith(f"check.{name}="):
                return line.split("=", 1)[1]
        return ""

    # ------------------------------------------------- queries that fail --
    # A query that could not run is not an empty answer. Reading a failed task
    # query as "nothing running" allows a snapshot while a vzdump hammers the
    # shared storage; reading a failed snapshot query as "no snapshots" counts
    # the pool's worst case as one snapshot when there may be three.

    def test_a_task_query_that_failed_is_not_an_idle_node(self):
        state = healthy_state()
        state["pvesh_fails"] = ["tasks"]
        code, _, out = self.run_runner(state, "preflight", "900")
        self.assertEqual(code, 3, out)
        self.assertTrue(self.check(out, "tasks").startswith("fail"), out)
        self.assertIn("could not read", self.check(out, "tasks"))

    def test_a_snapshot_query_that_failed_is_not_zero_snapshots(self):
        state = healthy_state()
        state["pvesh_fails"] = ["snapshot"]
        code, _, out = self.run_runner(state, "preflight", "900")
        self.assertEqual(code, 3, out)
        self.assertTrue(self.check(out, "snapshots").startswith("fail"), out)
        self.assertTrue(self.check(out, "worst_case").startswith("fail"), "the worst case is a count of snapshots")
        self.assertIn("snapshots.total_count=unknown", out)

    def test_json_that_does_not_parse_is_not_an_empty_list(self):
        state = healthy_state()
        state["pvesh_garbage"] = ["snapshot", "tasks"]
        code, _, out = self.run_runner(state, "preflight", "900")
        self.assertEqual(code, 3, out)
        for name in ("tasks", "snapshots"):
            self.assertTrue(self.check(out, name).startswith("fail"), f"{name}: {out}")

    def test_delete_reports_failure_rather_than_success_it_cannot_see(self):
        state = healthy_state()
        state["snapshots"] = [{"name": "pre-aaaaaaa-202609010000", "snaptime": 1, "description": "d"}]
        state["pvesh_fails"] = ["snapshot"]
        code, after, out = self.run_runner(state, "delete", "900", "pre-aaaaaaa-202609010000")
        self.assertEqual(code, 4, out)
        self.assertIn("result=failed", out)
        self.assertNotIn("result=ok", out)
        self.assertFalse([c for c in self.calls() if c.startswith("qm delsnapshot")])
        self.assertEqual(len(after["snapshots"]), 1)

    def test_a_create_that_cannot_read_the_list_takes_no_snapshot(self):
        state = healthy_state()
        state["pvesh_fails"] = ["snapshot"]
        code, after, out = self.run_runner(state, "create", "900", "pre-bbbbbbb-202609170000", "aaaaaaa -> bbbbbbb")
        self.assertIn(code, (3, 4), out)
        self.assertNotIn("result=ok", out)
        self.assertFalse([c for c in self.calls() if c.startswith("qm snapshot")])

    def test_recovery_does_not_unlock_while_it_cannot_see_the_tasks(self):
        # The task list answers the preflight, then stops answering — which is
        # exactly when unlocking would corrupt a running task's bookkeeping.
        state = healthy_state()
        state["snapshot_behavior"] = "fail"
        state["task_lingers"] = 0.2
        state["pvesh_fails_after"] = {"tasks": 2}
        code, after, out = self.run_runner(state, "create", "900", "pre-bbbbbbb-202609170000", "aaaaaaa -> bbbbbbb")
        self.assertEqual(code, 4, out)
        self.assertIn("recovery.lock=left alone", out)
        self.assertFalse([c for c in self.calls() if c.startswith("qm unlock")], "unlocked under an unreadable task list")
        self.assertEqual(after["lock"], "snapshot")

    # ------------------------------------------------------------ preflight --

    def test_a_healthy_host_passes_every_precondition(self):
        code, _, out = self.run_runner(healthy_state(), "preflight", "900")
        self.assertEqual(code, 0, out)
        for name in ("vm", "storage", "lock", "tasks", "agent", "freeze", "snapshots", "pool_data", "pool_meta", "vg_free", "worst_case"):
            self.assertTrue(self.check(out, name).startswith("pass"), f"{name}: {out}")
        self.assertIn("result=ok", out)

    def test_a_disk_on_nfs_is_refused(self):
        state = healthy_state()
        state["config"] += "scsi1: nas-share:900/vm-900-disk-1.qcow2,size=10G\n"
        code, _, out = self.run_runner(state, "preflight", "900")
        self.assertEqual(code, 3)
        self.assertIn("nas-share", self.check(out, "storage"))
        self.assertTrue(self.check(out, "storage").startswith("fail"))

    def test_storage_named_in_config_is_refused_whatever_its_type(self):
        code, _, out = self.run_runner(healthy_state(), "preflight", "900", REFUSE_STORAGE="nas-share fast-thin")
        self.assertEqual(code, 3, out)
        self.assertIn("fast-thin(refused-by-config)", self.check(out, "storage"))

    def test_the_runner_itself_carries_no_infrastructure(self):
        source = RUNNER.read_text()
        for needle in ("192.168.", "truenas", "nvme", "id_ed25519", "Home Assistant"):
            self.assertNotIn(needle, source, needle)

    def test_the_shared_thin_pool_is_protected(self):
        for lvs, vgs, failing in (
            ("71.00 18.00 906.17", "47.47", "pool_data"),
            ("28.83 50.00 906.17", "47.47", "pool_meta"),
            ("28.83 18.24 906.17", "4.00", "vg_free"),
            ("40.00 18.24 200.00", "47.47", "worst_case"),  # 120G free < 80G + 50G
        ):
            state = healthy_state()
            state["lvs"]["vg-fast/data"] = lvs
            state["vgs"]["vg-fast"] = vgs
            code, _, out = self.run_runner(state, "preflight", "900")
            self.assertEqual(code, 3, failing)
            self.assertTrue(self.check(out, failing).startswith("fail"), f"{failing}: {out}")

    def test_a_busy_or_locked_or_frozen_vm_is_refused(self):
        cases = []
        state = healthy_state(); state["lock"] = "backup"; cases.append((state, "lock"))
        state = healthy_state(); state["tasks"].append({"type": "vzdump", "id": "101", "upid": "UPID:dump", "until": time.time() + 600}); cases.append((state, "tasks"))
        state = healthy_state(); state["freeze"] = "frozen"; cases.append((state, "freeze"))
        state = healthy_state(); state["agent_ping"] = False; cases.append((state, "agent"))
        state = healthy_state()
        state["snapshots"] = [{"name": "pre-aaa-1", "snaptime": 1, "description": ""}, {"name": "pre-bbb-2", "snaptime": 2, "description": ""}]
        cases.append((state, "snapshots"))
        for state, failing in cases:
            code, _, out = self.run_runner(state, "preflight", "900")
            self.assertEqual(code, 3, failing)
            self.assertTrue(self.check(out, failing).startswith("fail"), f"{failing}: {out}")

    def test_snapshots_about_to_be_deleted_do_not_count(self):
        state = healthy_state()
        state["snapshots"] = [{"name": "pre-aaa-1", "snaptime": 1, "description": ""}, {"name": "pre-bbb-2", "snaptime": 2, "description": ""}]
        code, _, out = self.run_runner(state, "preflight", "900", IGNORE_SNAPSHOTS="pre-aaa-1")
        self.assertEqual(code, 0, out)
        self.assertIn("snapshots.release_count=1", out)

    def test_hand_made_snapshots_count_toward_the_worst_case(self):
        # 300G pool at 40%: 180G free. With a hand-made "Baseline" the new
        # snapshot makes two that could diverge: 2*80+50 = 210 — refused.
        # Without it, 1*80+50 = 130 fits.
        state = healthy_state()
        state["lvs"]["vg-fast/data"] = "40.00 18.24 300.00"
        code, _, out = self.run_runner(state, "preflight", "900")
        self.assertEqual(code, 0, out)
        state["snapshots"] = [{"name": "Baseline", "snaptime": 1, "description": "This is the first snapshot of the VM"}]
        code, _, out = self.run_runner(state, "preflight", "900")
        self.assertEqual(code, 3, out)
        self.assertIn("worst case needs 210G", self.check(out, "worst_case"))

    def test_a_hand_made_snapshot_does_not_count_against_the_limit(self):
        state = healthy_state()
        state["snapshots"] = [{"name": "before-maintenance", "snaptime": 1, "description": ""}, {"name": "pre-aaa-1", "snaptime": 2, "description": ""}]
        code, _, out = self.run_runner(state, "preflight", "900")
        self.assertEqual(code, 0, out)

    # --------------------------------------------------------------- create --

    def test_a_snapshot_is_taken_without_vmstate_and_never_with_vzdump(self):
        code, state, out = self.run_runner(healthy_state(), "create", "900", "pre-3a9f1c2-202609161830", "aa61f6e -> 3a9f1c2")
        self.assertEqual(code, 0, out)
        self.assertIn("result=ok pre-3a9f1c2-202609161830", out)
        self.assertEqual([s["name"] for s in state["snapshots"]], ["pre-3a9f1c2-202609161830"])
        snapshot_calls = [c for c in self.calls() if c.startswith("qm snapshot")]
        self.assertEqual(len(snapshot_calls), 1)
        self.assertIn("--vmstate 0", snapshot_calls[0])
        self.assertFalse(any("vzdump" in c or "nas-share" in c for c in self.calls()))

    def test_a_refused_preflight_takes_no_snapshot(self):
        state = healthy_state(); state["lvs"]["vg-fast/data"] = "28.83 60.00 906.17"
        code, state, out = self.run_runner(state, "create", "900", "pre-3a9f1c2-202609161830", "x")
        self.assertEqual(code, 3)
        self.assertIn("result=refused", out)
        self.assertFalse(any(c.startswith("qm snapshot") for c in self.calls()))
        self.assertEqual(state["snapshots"], [])

    def test_a_stalled_snapshot_is_undone_on_the_host(self):
        state = healthy_state()
        state["snapshot_behavior"] = "hang"
        state["task_lingers"] = 0.5  # the killed task's worker ends shortly after
        code, state, out = self.run_runner(state, "create", "900", "pre-3a9f1c2-202609161830", "x", SNAPSHOT_TIMEOUT="2")
        self.assertEqual(code, 4, out)
        self.assertIn("result=failed", out)
        self.assertEqual(state["freeze"], "thawed", out)
        self.assertEqual(state["lock"], "", out)
        self.assertEqual(state["snapshots"], [], out)
        calls = self.calls()
        self.assertTrue(any("fsfreeze-thaw" in c for c in calls))
        self.assertTrue(any(c.startswith("qm unlock 900") for c in calls))
        self.assertTrue(any(c.startswith("qm delsnapshot 900 pre-3a9f1c2-202609161830 --force") for c in calls))
        # The thaw comes before the unlock, and both before removing the partial.
        order = [next(i for i, c in enumerate(calls) if key in c) for key in ("fsfreeze-thaw", "qm unlock", "delsnapshot")]
        self.assertEqual(order, sorted(order))

    def test_a_task_that_is_still_running_is_never_unlocked_under(self):
        state = healthy_state()
        state["snapshot_behavior"] = "hang"
        state["task_lingers"] = 600  # the worker outlives the wait
        code, state, out = self.run_runner(state, "create", "900", "pre-3a9f1c2-202609161830", "x", SNAPSHOT_TIMEOUT="2")
        self.assertEqual(code, 4, out)
        self.assertEqual(state["freeze"], "thawed", "the guest is thawed even when the task lingers")
        self.assertEqual(state["lock"], "snapshot", "the lock stays while a task holds it")
        self.assertIn("recovery.lock=left alone", out)
        calls = self.calls()
        self.assertFalse(any(c.startswith("qm unlock") for c in calls))
        self.assertFalse(any(c.startswith("qm delsnapshot") for c in calls))

    def test_only_release_snapshots_can_be_created_or_deleted(self):
        state = healthy_state()
        state["snapshots"] = [{"name": "before-maintenance", "snaptime": 1, "description": ""}]
        code, _, out = self.run_runner(state, "create", "900", "before-upgrade", "x")
        self.assertEqual(code, 2)
        code, state, out = self.run_runner(state, "delete", "900", "before-maintenance")
        self.assertEqual(code, 2)
        self.assertEqual([s["name"] for s in state["snapshots"]], ["before-maintenance"])
        self.assertFalse(any(c.startswith("qm delsnapshot") for c in self.calls()))

    def test_delete_removes_a_release_snapshot(self):
        state = healthy_state()
        state["snapshots"] = [{"name": "pre-aaa-1", "snaptime": 1, "description": ""}]
        code, state, out = self.run_runner(state, "delete", "900", "pre-aaa-1")
        self.assertEqual(code, 0, out)
        self.assertEqual(state["snapshots"], [])

    def test_list_prints_snapshots_without_current(self):
        state = healthy_state()
        state["snapshots"] = [{"name": "pre-aaa-1", "snaptime": 1789000000, "description": "aa61f6e -> 3a9f1c2"}]
        code, _, out = self.run_runner(state, "list", "900")
        self.assertEqual(code, 0)
        self.assertIn("snapshot=pre-aaa-1\t1789000000\taa61f6e -> 3a9f1c2", out)
        self.assertNotIn("current", out)


if __name__ == "__main__":
    unittest.main()
