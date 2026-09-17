"""control-plane/deployment/vm-restore-snapshot.sh — the whole-VM restore, end to end.

`ssh` is replaced by a fake Proxmox host: it answers `qm` the way Proxmox does,
including `qm guest exec`, whose SSH exit status is 0 even when the command
inside the VM failed — the guest's exit code is only in the JSON it prints.
State and behaviour come from a JSON file, so each scenario is a state and a
run. Pinned here:

- live OAuth credentials never appear in the script's output;
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
import stat
import subprocess
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SCRIPT = ROOT / "control-plane" / "deployment" / "vm-restore-snapshot.sh"

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
        if "base64 -w0 /opt/hermes-data/auth.json" in script:
            guest_result(0, base64.b64encode(state["hermes_auth"].encode()).decode())
        if "base64 -w0 /opt/agent-auth/codex/auth.json" in script:
            guest_result(0, base64.b64encode(state["codex_auth"].encode()).decode())
    if args and args[0] == "sha256sum":
        written = state["written"].get(args[1])
        guest_result(0 if written else 1, f"{written}  {args[1]}\n" if written else "")
    if args[:1] == ["docker"]:
        guest_result(0, "")
    if args[:1] == ["/usr/local/sbin/kinerary-cp-release"]:
        guest_result(0, "bridges restarted\n")
    guest_result(127, "")
if tokens[:2] == ["qm", "config"]:
    print("net0: virtio=BC:24:11:00:00:01,bridge=vmbr0")
    sys.exit(0)
sys.exit(0)  # shutdown, rollback, set, start
'''


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
                 "hermes_auth": HERMES_SECRET, "codex_auth": CODEX_SECRET, "write_fail": [], "written": {}}
        state.update(state_overrides)
        self.state_path.write_text(json.dumps(state))
        self.calls_path.write_text("")
        env = {**os.environ, "KINERARY_DEPLOY_ROOT": str(self.tmp), "PATH": f"{self.bin}:{os.environ['PATH']}",
               "FAKE_STATE": str(self.state_path), "FAKE_CALLS": str(self.calls_path)}
        # start_new_session: no controlling terminal, so a prompt on /dev/tty
        # fails instead of waiting for someone to type.
        return subprocess.run(["/bin/bash", str(SCRIPT), *args], capture_output=True, text=True, env=env,
                              timeout=120, start_new_session=True)

    def calls(self) -> list[str]:
        return self.calls_path.read_text().splitlines()

    def docker_calls(self, verb: str) -> list[str]:
        return [c for c in self.calls() if f"-- docker {verb}" in c]

    def test_live_credentials_never_reach_the_output(self):
        proc = self.run_script("--snapshot", "pre-abcdef1-202609161800", "--execute")
        output = proc.stdout + proc.stderr
        self.assertEqual(proc.returncode, 0, output)
        for secret in (HERMES_SECRET, CODEX_SECRET):
            self.assertNotIn(secret, output)
            self.assertNotIn(base64.b64encode(secret.encode()).decode(), output)
            self.assertNotIn("rt_", output)
        self.assertIn("hermes yes, codex yes", output)
        state = json.loads(self.state_path.read_text())
        self.assertEqual(state["written"]["/opt/hermes-data/auth.json"], hashlib.sha256(HERMES_SECRET.encode()).hexdigest())

    def test_credential_holders_stay_down_until_their_credentials_are_back(self):
        proc = self.run_script("--snapshot", "pre-abcdef1-202609161800", "--execute")
        calls = self.calls()
        stop = next(i for i, c in enumerate(calls) if "-- docker stop" in c)
        link_up = next(i for i, c in enumerate(calls) if c.startswith("qm set 900 --net0") and "link_down" not in c)
        first_write = next(i for i, c in enumerate(calls) if "--pass-stdin" in c)
        self.assertLess(stop, first_write, proc.stdout)
        self.assertLess(first_write, link_up)
        for name in ("hermes", "kinerary-cp-relay-1", "kinerary-cp-interview-mcp-1"):
            self.assertIn(name, calls[stop])

    def test_a_failed_hermes_write_keeps_hermes_stopped(self):
        proc = self.run_script("--snapshot", "pre-abcdef1-202609161800", "--execute",
                               write_fail=["/opt/hermes-data/auth.json"])
        output = proc.stdout + proc.stderr
        self.assertNotEqual(proc.returncode, 0, output)
        self.assertIn("could not write Hermes credentials back", output)
        self.assertFalse([c for c in self.docker_calls("start") if "hermes" in c.split("-- docker start", 1)[1]],
                         "Hermes was started on the snapshot's stale credentials")
        self.assertFalse([c for c in self.calls() if "kinerary-cp-release restart-bridges" in c])
        self.assertTrue([c for c in self.docker_calls("start") if "kinerary-cp-relay-1" in c],
                        "the relay's own credential was written, so it comes back")

    def test_a_failed_codex_write_keeps_the_relay_and_sidecar_stopped(self):
        proc = self.run_script("--snapshot", "pre-abcdef1-202609161800", "--execute",
                               write_fail=["/opt/agent-auth/codex/auth.json"])
        output = proc.stdout + proc.stderr
        self.assertNotEqual(proc.returncode, 0, output)
        started = " ".join(self.docker_calls("start"))
        self.assertNotIn("kinerary-cp-relay-1", started)
        self.assertNotIn("kinerary-cp-interview-mcp-1", started)
        self.assertIn("hermes", started, "Hermes's credential was written, so Hermes comes back")

    def test_an_unreadable_database_is_not_a_clean_bill(self):
        proc = self.run_script("--snapshot", "pre-abcdef1-202609161800", psql_fail=True)
        output = proc.stdout + proc.stderr
        self.assertNotEqual(proc.returncode, 0, output)
        self.assertNotIn("no trip was built since the snapshot", output)
        self.assertIn("UNKNOWN", output)

    def test_an_unreadable_profile_list_is_not_a_clean_bill(self):
        proc = self.run_script("--snapshot", "pre-abcdef1-202609161800", profiles_fail=True)
        self.assertNotEqual(proc.returncode, 0)
        self.assertNotIn("no trip was built since the snapshot", proc.stdout)

    def test_an_unverified_restore_is_blocked(self):
        for overrides in ({"psql_fail": True}, {"agent_up": False}):
            proc = self.run_script("--snapshot", "pre-abcdef1-202609161800", "--execute", **overrides)
            self.assertNotEqual(proc.returncode, 0, overrides)
            self.assertFalse([c for c in self.calls() if "qm rollback" in c], f"rolled back unverified: {overrides}")

    def test_accepting_an_unverified_restore_still_needs_the_name_typed(self):
        proc = self.run_script("--snapshot", "pre-abcdef1-202609161800", "--execute", "--accept-unverified", psql_fail=True)
        self.assertNotEqual(proc.returncode, 0)
        self.assertIn("not confirmed", proc.stderr)
        self.assertFalse([c for c in self.calls() if "qm rollback" in c])


if __name__ == "__main__":
    unittest.main()
