"""control-plane/deployment/vm-restore-snapshot.sh — the whole-VM restore, end to end.

`ssh` is replaced by a fake Proxmox host: it answers `qm` the way Proxmox does,
including `qm guest exec`, whose SSH exit status is 0 even when the command
inside the VM failed — the guest's exit code is only in the JSON it prints.
State and behaviour come from a JSON file, so each scenario is a state and a
run. The fake also knows which containers are running, and a credential whose
holder is still running when the VM shuts down gets refreshed — rotated — the
way a graceful shutdown lets an in-flight refresh finish. Pinned here:

- live OAuth credentials never appear in the script's output;
- credentials are read only after everything that could rotate them stopped,
  so the bytes carried across are the ones the provider still accepts;
- a credential that could not be read is never treated as one that does not
  exist: its services stay stopped, and without --accept-unverified the
  restore stops before anything changed;
- a live VM that had no credential gives a restored VM with none, rather than
  the snapshot's stale copy;
- a credential write that failed inside the VM is a failure, whatever SSH says,
  and every service that needs that credential stays stopped;
- a database or profile check that could not run is not "no trips were built":
  it blocks the restore unless a person accepts an unverified one by name.
"""
from __future__ import annotations

import base64
import hashlib
import json
import os
import shlex
import stat
import subprocess
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SCRIPT = ROOT / "control-plane" / "deployment" / "vm-restore-snapshot.sh"

SNAP = "pre-abcdef1-202609161800"
HERMES_PATH = "/opt/hermes-data/auth.json"
CODEX_PATH = "/opt/agent-auth/codex/auth.json"
HOLDERS = ("hermes", "kinerary-cp-relay-1", "kinerary-cp-interview-mcp-1")
HERMES_SECRET = '{"openai-codex": {"refresh_token": "rt_HERMES_LIVE_SECRET_123"}}'
CODEX_SECRET = '{"tokens": {"refresh_token": "rt_CODEX_LIVE_SECRET_456"}}'

FAKE_SSH = r'''#!/usr/bin/env python3
import base64, hashlib, json, os, re, shlex, sys
state_path = os.environ["FAKE_STATE"]
state = json.load(open(state_path))
command = sys.argv[-1]
tokens = shlex.split(command)
with open(os.environ["FAKE_CALLS"], "a") as log:
    log.write(command + "\n")

HOLDERS = ["hermes", "kinerary-cp-relay-1", "kinerary-cp-interview-mcp-1"]
FILES = {"/opt/hermes-data/auth.json": "hermes_auth", "/opt/agent-auth/codex/auth.json": "codex_auth"}

def save():
    json.dump(state, open(state_path, "w"))

def guest_result(code=0, out=""):
    print(json.dumps({"exited": 1, "exitcode": code, "out-data": out}))
    sys.exit(0)  # ssh itself succeeds whatever happened in the guest

while tokens and re.match(r"^[A-Z_]+=", tokens[0]) or (tokens and tokens[0] == "env"):
    tokens.pop(0)
if tokens[:3] == ["bash", "-s", "--"]:
    sys.stdin.read()
    mode = tokens[3]
    if mode == "list":
        print("snapshot=pre-abcdef1-202609161800\t1789000000\taaaaaaa -> abcdef1")
        print("result=ok")
    else:
        for check in ("lock", "tasks", "storage"):
            print(f"check.{check}=pass fine")
        print("result=ok preflight passed")
    sys.exit(0)
if tokens[:2] == ["timeout", "10"] and tokens[2:4] == ["qm", "agent"]:
    sys.exit(0 if state["agent_up"] else 1)
if tokens[:3] == ["qm", "guest", "exec"]:
    stdin_mode = "--pass-stdin" in tokens
    args = tokens[tokens.index("--") + 1:]
    if stdin_mode:
        data = sys.stdin.read()
        path = re.search(r"f=(\S+);", args[-1]).group(1)
        if path in state["write_fail"]:
            guest_result(1)
        state["written"][path] = hashlib.sha256(base64.b64decode(data)).hexdigest()
        save()
        guest_result(0)
    if args[:2] == ["docker", "exec"] and "psql" in args:
        if state["psql_fail"]:
            guest_result(2)
        sql = args[-1]
        if "string_agg(slug" in sql:
            guest_result(0, state["built"])
        if "FROM control_plane.jobs" in sql:
            guest_result(0, state["jobs"])
        guest_result(0, "0 trips, 0 interview sessions, 0 chat bindings")
    if args[:2] == ["sh", "-c"]:
        script = args[2]
        if "stat -c %W" in script:
            guest_result(3 if state["profiles_fail"] else 0, "")
        if "echo hermes" in script:
            guest_result(0, "hermes\ncodex\n")
        if "base64 -w0" in script:
            path = args[-1]
            if path in state["read_fail"]:
                guest_result(1)
            value = state[FILES[path]]
            if value is None:
                guest_result(0, "absent\n")
            guest_result(0, "b64:" + base64.b64encode(value.encode()).decode())
        if "rm -f" in script:
            state["removed"].append(args[-1])
            state["written"].pop(args[-1], None)
            save()
            guest_result(0)
    if args and args[0] == "sha256sum":
        written = state["written"].get(args[1])
        guest_result(0 if written else 1, f"{written}  {args[1]}\n" if written else "")
    if args[:2] == ["docker", "stop"]:
        if state["docker_broken"] and not state["booted"]:
            guest_result(1, "")
        state["running"] = [c for c in state["running"] if c not in args[2:]]
        save()
        guest_result(0, "")
    if args[:2] == ["docker", "start"]:
        state["running"] = sorted(set(state["running"]) | set(args[2:]))
        save()
        guest_result(0, "")
    if args[:1] == ["/usr/local/sbin/kinerary-cp-release"]:
        guest_result(0, "bridges restarted\n")
    guest_result(127, "")
if tokens[:2] == ["qm", "config"]:
    print("net0: virtio=BC:24:11:00:00:01,bridge=vmbr0")
    sys.exit(0)
if tokens[:2] == ["qm", "shutdown"]:
    # A holder still running when the VM goes down finishes its refresh: the
    # live credential rotates, and whatever was read before is now stale.
    running = set(state["running"])
    if "hermes" in running and state["hermes_auth"] is not None:
        state["hermes_auth"] += " rotated"
        state["rotations"] += 1
    if running & {"kinerary-cp-relay-1", "kinerary-cp-interview-mcp-1"} and state["codex_auth"] is not None:
        state["codex_auth"] += " rotated"
        state["rotations"] += 1
    state["running"] = []
    save()
    sys.exit(0)
if tokens[:2] == ["qm", "start"]:
    state["running"] = list(HOLDERS)  # the snapshot was taken with everything up
    state["booted"] = True
    save()
    sys.exit(0)
sys.exit(0)  # rollback, set
'''


def sha256(text: str) -> str:
    return hashlib.sha256(text.encode()).hexdigest()


class RestoreScript(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="restore-snapshot-"))
        (self.tmp / "control-plane.env").write_text("CP_VMID=900\nCP_PROXMOX_SSH_KEY_ON_MAC=~/.ssh/pve_key\nCP_REFUSE_STORAGE=nas-share\n")
        (self.tmp / "provisioning.env").write_text("PROXMOX_HOST=pve.example\nPROXMOX_SSH_USER=root\n")
        bin_dir = self.tmp / "bin"
        bin_dir.mkdir()
        ssh = bin_dir / "ssh"
        ssh.write_text(FAKE_SSH)
        ssh.chmod(ssh.stat().st_mode | stat.S_IEXEC)
        sleep = bin_dir / "sleep"  # the script's settle pauses cost nothing here
        sleep.write_text("#!/bin/sh\nexit 0\n")
        sleep.chmod(sleep.stat().st_mode | stat.S_IEXEC)
        self.bin = bin_dir
        self.state_path = self.tmp / "state.json"
        self.calls_path = self.tmp / "calls.log"

    def run_script(self, *args: str, **state_overrides) -> subprocess.CompletedProcess:
        state = {"agent_up": True, "psql_fail": False, "profiles_fail": False, "built": "", "jobs": "0",
                 "hermes_auth": HERMES_SECRET, "codex_auth": CODEX_SECRET, "read_fail": [], "write_fail": [],
                 "written": {}, "removed": [], "running": list(HOLDERS), "rotations": 0,
                 "docker_broken": False, "booted": False}
        state.update(state_overrides)
        self.state_path.write_text(json.dumps(state))
        self.calls_path.write_text("")
        env = {**os.environ, "KINERARY_DEPLOY_ROOT": str(self.tmp), "PATH": f"{self.bin}:{os.environ['PATH']}",
               "FAKE_STATE": str(self.state_path), "FAKE_CALLS": str(self.calls_path)}
        # start_new_session: no controlling terminal, so a prompt on /dev/tty
        # fails instead of waiting for someone to type.
        return subprocess.run(["/bin/bash", str(SCRIPT), *args], capture_output=True, text=True, env=env,
                              timeout=120, start_new_session=True)

    def state(self) -> dict:
        return json.loads(self.state_path.read_text())

    def calls(self) -> list[str]:
        # As the host's shell sees them: `guest` escapes each argument with printf %q.
        return [" ".join(shlex.split(line)) for line in self.calls_path.read_text().splitlines()]

    def index(self, predicate, after: int = -1) -> int:
        return next(i for i, c in enumerate(self.calls()) if i > after and predicate(c))

    def docker_calls(self, verb: str) -> list[str]:
        return [c for c in self.calls() if f"-- docker {verb}" in c]

    def started(self) -> str:
        return " ".join(c.split("-- docker start", 1)[1] for c in self.docker_calls("start"))

    def test_live_credentials_never_reach_the_output(self):
        proc = self.run_script("--snapshot", SNAP, "--execute")
        output = proc.stdout + proc.stderr
        self.assertEqual(proc.returncode, 0, output)
        for secret in (HERMES_SECRET, CODEX_SECRET):
            self.assertNotIn(secret, output)
            self.assertNotIn(base64.b64encode(secret.encode()).decode(), output)
            self.assertNotIn("rt_", output)
        self.assertIn("hermes captured, codex captured", output)
        self.assertEqual(self.state()["written"][HERMES_PATH], sha256(HERMES_SECRET))

    def test_credentials_are_read_only_once_nothing_can_rotate_them(self):
        proc = self.run_script("--snapshot", SNAP, "--execute")
        self.assertEqual(proc.returncode, 0, proc.stdout + proc.stderr)
        state = self.state()
        self.assertEqual(state["rotations"], 0, "a credential rotated after it had been read")
        # What was carried is what the provider holds now, not what it held before a refresh.
        self.assertEqual(state["written"][HERMES_PATH], sha256(state["hermes_auth"]))
        self.assertEqual(state["written"][CODEX_PATH], sha256(state["codex_auth"]))

        live_stop = self.index(lambda c: "-- docker stop" in c)
        first_read = self.index(lambda c: "base64 -w0" in c)
        shutdown = self.index(lambda c: c.startswith("qm shutdown"))
        self.assertLess(live_stop, first_read)
        self.assertLess(first_read, shutdown)
        for name in HOLDERS:
            self.assertIn(name, self.calls()[live_stop])

    def test_credential_holders_stay_down_until_their_credentials_are_back(self):
        proc = self.run_script("--snapshot", SNAP, "--execute")
        boot = self.index(lambda c: c.startswith("qm start"))
        stop = self.index(lambda c: "-- docker stop" in c, after=boot)
        first_write = self.index(lambda c: "--pass-stdin" in c)
        link_up = self.index(lambda c: c.startswith("qm set 900 --net0") and "link_down" not in c)
        self.assertLess(stop, first_write, proc.stdout)
        self.assertLess(first_write, link_up)
        for name in HOLDERS:
            self.assertIn(name, self.calls()[stop])

    def test_an_unreadable_credential_stops_the_restore_before_anything_changes(self):
        proc = self.run_script("--snapshot", SNAP, "--execute", read_fail=[CODEX_PATH])
        output = proc.stdout + proc.stderr
        self.assertNotEqual(proc.returncode, 0, output)
        self.assertIn("could not read", output)
        self.assertFalse([c for c in self.calls() if "qm shutdown" in c or "qm rollback" in c],
                         "the VM was shut down although a credential could not be carried")
        self.assertEqual(sorted(self.state()["running"]), sorted(HOLDERS), "the services it stopped are running again")

    def test_an_accepted_unreadable_codex_login_keeps_the_relay_and_sidecar_stopped(self):
        proc = self.run_script("--snapshot", SNAP, "--execute", "--accept-unverified", read_fail=[CODEX_PATH])
        output = proc.stdout + proc.stderr
        self.assertNotEqual(proc.returncode, 0, "a restore that left services down is not a success")
        self.assertTrue([c for c in self.calls() if "qm rollback" in c], output)
        started = self.started()
        self.assertNotIn("kinerary-cp-relay-1", started, "the relay would refresh the snapshot's stale codex login")
        self.assertNotIn("kinerary-cp-interview-mcp-1", started)
        self.assertIn("hermes", started, "Hermes's own credential was carried, so Hermes comes back")
        self.assertNotIn(CODEX_PATH, self.state()["written"])
        self.assertNotIn("✓\x1b[0m read live credentials", output, "no success line for a read that failed")

    def test_a_broken_docker_still_restores_when_accepted_and_carries_nothing(self):
        # A broken Docker is a reason to restore the whole VM, so it cannot be a
        # reason the restore refuses — but a holder that could not be stopped
        # might rotate a credential after it was read, so none is read.
        proc = self.run_script("--snapshot", SNAP, "--execute", docker_broken=True)
        self.assertNotEqual(proc.returncode, 0)
        self.assertFalse([c for c in self.calls() if "qm rollback" in c])

        proc = self.run_script("--snapshot", SNAP, "--execute", "--accept-unverified", docker_broken=True)
        output = proc.stdout + proc.stderr
        self.assertNotEqual(proc.returncode, 0, "services were left stopped")
        self.assertTrue([c for c in self.calls() if "qm rollback" in c], output)
        self.assertFalse([c for c in self.calls() if "b64:" in c], "a credential was read while its holder may still run")
        boot = self.index(lambda c: c.startswith("qm start"))
        self.assertFalse([c for c in self.calls()[boot:] if "-- docker start" in c], "a service started on stale credentials")
        self.assertNotIn("read live credentials into memory", output)

    def test_an_unreachable_guest_carries_nothing_and_starts_nothing(self):
        # --accept-unverified needs the name typed; with no terminal it stops, so
        # the "nothing carried" half is checked as the plan the script prints.
        proc = self.run_script("--snapshot", SNAP, agent_up=False)
        self.assertNotEqual(proc.returncode, 0)
        self.assertIn("cannot be carried across", proc.stdout)

    def test_a_credential_the_live_vm_did_not_have_is_not_left_in_the_restored_one(self):
        proc = self.run_script("--snapshot", SNAP, "--execute", codex_auth=None)
        output = proc.stdout + proc.stderr
        self.assertEqual(proc.returncode, 0, output)
        self.assertIn(CODEX_PATH, self.state()["removed"], "the snapshot's stale codex login was left in place")
        remove = self.index(lambda c: "rm -f" in c)
        link_up = self.index(lambda c: c.startswith("qm set 900 --net0") and "link_down" not in c)
        self.assertLess(remove, link_up)
        self.assertIn("kinerary-cp-relay-1", self.started())

    def test_a_failed_hermes_write_keeps_hermes_stopped(self):
        proc = self.run_script("--snapshot", SNAP, "--execute", write_fail=[HERMES_PATH])
        output = proc.stdout + proc.stderr
        self.assertNotEqual(proc.returncode, 0, output)
        self.assertIn("could not write Hermes credentials back", output)
        boot = self.index(lambda c: c.startswith("qm start"))
        after_boot = [c for c in self.calls()[boot:] if "-- docker start" in c]
        self.assertFalse([c for c in after_boot if "hermes" in c.split("-- docker start", 1)[1]],
                         "Hermes was started on the snapshot's stale credentials")
        self.assertFalse([c for c in self.calls() if "kinerary-cp-release restart-bridges" in c])
        self.assertTrue([c for c in after_boot if "kinerary-cp-relay-1" in c],
                        "the relay's own credential was written, so it comes back")

    def test_a_failed_codex_write_keeps_the_relay_and_sidecar_stopped(self):
        proc = self.run_script("--snapshot", SNAP, "--execute", write_fail=[CODEX_PATH])
        output = proc.stdout + proc.stderr
        self.assertNotEqual(proc.returncode, 0, output)
        started = self.started()
        self.assertNotIn("kinerary-cp-relay-1", started)
        self.assertNotIn("kinerary-cp-interview-mcp-1", started)
        self.assertIn("hermes", started, "Hermes's credential was written, so Hermes comes back")

    def test_an_unreadable_database_is_not_a_clean_bill(self):
        proc = self.run_script("--snapshot", SNAP, psql_fail=True)
        output = proc.stdout + proc.stderr
        self.assertNotEqual(proc.returncode, 0, output)
        self.assertNotIn("no trip was built since the snapshot", output)
        self.assertIn("UNKNOWN", output)

    def test_an_unreadable_profile_list_is_not_a_clean_bill(self):
        proc = self.run_script("--snapshot", SNAP, profiles_fail=True)
        self.assertNotEqual(proc.returncode, 0)
        self.assertNotIn("no trip was built since the snapshot", proc.stdout)

    def test_an_unverified_restore_is_blocked(self):
        for overrides in ({"psql_fail": True}, {"agent_up": False}):
            proc = self.run_script("--snapshot", SNAP, "--execute", **overrides)
            self.assertNotEqual(proc.returncode, 0, overrides)
            self.assertFalse([c for c in self.calls() if "qm rollback" in c], f"rolled back unverified: {overrides}")

    def test_accepting_an_unverified_restore_still_needs_the_name_typed(self):
        proc = self.run_script("--snapshot", SNAP, "--execute", "--accept-unverified", psql_fail=True)
        self.assertNotEqual(proc.returncode, 0)
        self.assertIn("not confirmed", proc.stderr)
        self.assertFalse([c for c in self.calls() if "qm rollback" in c])
        self.assertFalse(self.docker_calls("stop"), "nothing is stopped before the restore is confirmed")


if __name__ == "__main__":
    unittest.main()
