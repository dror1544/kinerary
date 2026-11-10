"""kinerary-cp-release rehearsed end to end, on a Mac, without the VM.

The real tool, the real git, the real pg_dump/pg_restore and a real PostgreSQL —
against a scratch repo, a scratch deploy root and stand-ins for the three things
only the VM has: docker compose, the Proxmox host over ssh, and Hermes. What the
stand-ins fake is the command surface, not the outcome: `compose run migrate`
really applies the checkout's migration files to the real database, and the
restore paths really dump, restore, compare and rename databases.

This is the off-production rehearsal the runbook asks for before an upgrade
touches VM 110, kept as a test so it runs in every preflight:

- an upgrade takes a snapshot and a proven backup, applies the new migration,
  moves KINERARY_REV and records the way back;
- a --restore-db rollback puts the database back to the dump and the code back
  to the previous version, keeping what it replaced;
- a rollback whose migrate fails undoes itself completely — the database it had
  already swapped goes back and the services come up again;
- an upgrade restarts every running gateway (discovered from the supervisor, not
  listed in the tool), skips a leftover slot and a retired trip's, and verify
  judges each one by the MCP servers in its own config from lines newer than its
  restart; a bridge that was already failing does not fail the upgrade, one the
  upgrade broke does.

Skipped when docker is not available.
"""
from __future__ import annotations

import json
import os
import re
import shutil
import stat
import subprocess
import tempfile
import threading
import time
import unittest
import uuid
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
TOOL = ROOT / "control-plane" / "deployment" / "vm-release.py"
IMAGE = "postgres:16-alpine"
DOCKER = shutil.which("docker")


def docker_ready() -> bool:
    return bool(DOCKER) and subprocess.run([DOCKER, "image", "inspect", IMAGE], capture_output=True).returncode == 0


FAKE_DOCKER = r'''#!/usr/bin/env python3
"""Stands in for docker on a Mac: compose drives a state file, and anything that
talks to PostgreSQL is handed to the real docker and the real container."""
import json, os, subprocess, sys
from pathlib import Path

args = sys.argv[1:]
state_path = Path(os.environ["FAKE_STATE"])
state = json.loads(state_path.read_text())
Path(os.environ["FAKE_CALLS"]).open("a").write(" ".join(args) + "\n")

def save():
    state_path.write_text(json.dumps(state))

def rev():
    for line in Path(os.environ["FAKE_VM_ENV"]).read_text().splitlines():
        if line.startswith("KINERARY_REV="):
            return line.split("=", 1)[1].strip()
    return "unknown"

def real(rest):
    sys.exit(subprocess.run([os.environ["REAL_DOCKER"], *rest]).returncode)

if args[:1] == ["compose"]:
    verb = next((a for a in args if a in ("stop", "up", "run", "config")), None)
    services = [a for a in args[args.index(verb) + 1:] if not a.startswith("-")] if verb else []
    if verb == "config":
        sys.exit(0)
    if verb == "stop":
        state["running"] = {k: v for k, v in state["running"].items() if k not in services}
        if "relay" in services and state.get("bridge_mode_after"):
            Path(os.environ["FAKE_BRIDGE_MODE"]).write_text(state["bridge_mode_after"])
        save(); sys.exit(0)
    if verb == "up":
        for service in services:
            name = "hermes" if service == "hermes" else f"kinerary-cp-{service}-1"
            state["running"][name] = f"kinerary-cp/{service}:{state['hermes_rev'] if service == 'hermes' else rev()}"
        save(); sys.exit(0)
    if verb == "run":  # migrate: apply what the checkout has and the database lacks
        if state.get("migrate_fails"):
            print("migrate: relation already exists", file=sys.stderr); sys.exit(1)
        pg, db = os.environ["FAKE_PG"], "kinerary_control_plane"
        psql = [os.environ["REAL_DOCKER"], "exec", "-i", pg, "psql", "-U", db, "-d", db, "-At", "-v", "ON_ERROR_STOP=1"]
        applied = subprocess.run(psql, input=b"SELECT version FROM public.control_plane_schema_migrations",
                                 capture_output=True).stdout.decode().split()
        for path in sorted((Path(os.environ["FAKE_REPO"]) / "control-plane/db/migrations").glob("*.sql")):
            if path.name in applied:
                continue
            sql = path.read_text() + f"\nINSERT INTO public.control_plane_schema_migrations(version) VALUES ('{path.name}');"
            done = subprocess.run(psql, input=sql.encode(), capture_output=True)
            if done.returncode:
                print(done.stderr.decode(), file=sys.stderr); sys.exit(1)
            print(f"applied {path.name}")
        sys.exit(0)
if args[:1] == ["ps"]:
    for name, image in sorted(state["running"].items()):
        print(f"{name}\t{image}")
    sys.exit(0)
if args[:1] == ["logs"]:
    print(json.dumps({"event": "relay.bot_identity", "username": "Example_bot"}))
    print(json.dumps({"event": "relay.ready", "polling": True}))
    for profile in state.get("connected", []):
        print(json.dumps({"event": "relay.gateway_connected", "gateway_id": profile}))
    sys.exit(0)
if args[:2] == ["image", "inspect"]:
    sys.exit(0)                      # every version's images are present
if args[:3] == ["exec", "hermes", "ls"]:
    # The Hermes supervisor's scan directory: one gateway-<profile> slot each (#420).
    print("s6-linux-init-shutdownd")
    for profile in state["slots"]:
        print(f"gateway-{profile}")
    sys.exit(0)
if args[:2] == ["exec", "hermes"] and args[2:3] and args[2].endswith("s6-svstat"):
    profile = args[3].rsplit("gateway-", 1)[1]
    print("down (exitcode 0) 4 seconds" if profile in state.get("down", []) else "up (pid 31) 900 seconds")
    sys.exit(0)
if args[:2] == ["exec", "hermes"] and args[2:3] and args[2].endswith("s6-svc"):
    # A restarted gateway registers its MCP servers again: new lines in its own agent.log,
    # which is what the release waits for and verify reads.
    profile = args[-1].rsplit("gateway-", 1)[1]
    if profile in state.get("restart_fails", []):
        print("s6-svc: fatal: unable to control: supervisor not listening", file=sys.stderr); sys.exit(1)
    log = Path(os.environ["KINERARY_CP_HERMES_DATA"]) / "profiles" / profile / "logs" / "agent.log"
    with log.open("a") as handle:
        for line in state.get("registrations", {}).get(profile, []):
            handle.write(line + "\n")
    sys.exit(0)
if args[:1] == ["exec"]:
    real(args)                        # psql, pg_dump and pg_restore are real
if args[:1] in (["stop"], ["start"]):
    for name in args[1:]:
        if args[0] == "stop":
            state["running"].pop(name, None)
        else:
            state["running"][name] = f"kinerary-cp/hermes:{state['hermes_rev']}"
    save(); sys.exit(0)
sys.exit(0)                           # image rm, builder prune, system df
'''

FAKE_SSH = r'''#!/usr/bin/env python3
"""The Proxmox host: it answers the snapshot runner's protocol from a state file."""
import json, os, shlex, sys, time
from pathlib import Path

state_path = Path(os.environ["FAKE_STATE"])
state = json.loads(state_path.read_text())
sys.stdin.buffer.read()                      # the runner script, streamed in
tokens = shlex.split(sys.argv[-1])
Path(os.environ["FAKE_CALLS"]).open("a").write("ssh " + " ".join(tokens) + "\n")
while tokens and ("=" in tokens[0] or tokens[0] == "env"):
    tokens.pop(0)
mode = tokens[3] if tokens[:3] == ["bash", "-s", "--"] else ""
if mode == "preflight":
    for check in ("vm", "storage", "lock", "tasks", "agent", "freeze", "snapshots", "pool_data", "pool_meta", "vg_free", "worst_case"):
        print(f"check.{check}=pass fine")
    print("pool.vg-fast/data=data 28.83% meta 18.24% size 906G vg_free 47G")
    print("result=ok preflight passed")
elif mode == "list":
    for name, when in state["snapshots"].items():
        print(f"snapshot={name}\t{when}\tmade by the rehearsal")
    print("result=ok")
elif mode == "create":
    state["snapshots"][tokens[5]] = int(time.time())
    state_path.write_text(json.dumps(state))
    print(f"result=ok {tokens[5]}")
elif mode == "delete":
    state["snapshots"].pop(tokens[5], None)
    state_path.write_text(json.dumps(state))
    print(f"result=ok deleted {tokens[5]}")
else:
    print("result=refused unknown mode"); sys.exit(2)
'''

FAKE_SUDO = '''#!/bin/sh
# sudo -u <user> -H <command...>  ->  <command...>
while [ $# -gt 0 ]; do
  case "$1" in -u) shift 2 ;; -H|-n) shift ;; *) break ;; esac
done
exec "$@"
'''

FAKE_HERMES = '''#!/bin/sh
case "$*" in
  *"auth list"*) echo "openai-codex  ok"; echo "anthropic  ok"; echo "openrouter  ok" ;;
esac
exit 0
'''

FAKE_SS = '''#!/bin/sh
# ss -ltnH "sport = :PORT": the ports in FAKE_LISTENING are listening.
port="${2##*:}"
for p in $FAKE_LISTENING; do [ "$p" = "$port" ] && echo "LISTEN 0 511 127.0.0.1:$port"; done
exit 0
'''

FAKE_INSTALL = '''#!/bin/sh
# install -D ... : what install_tool_files runs after a green verify. Recorded, not done.
echo "install $*" >> "$FAKE_CALLS"
exit 0
'''

FAKE_FINDMNT = '''#!/bin/sh
case "$*" in
  *FSTYPE*) echo ext4 ;;        # the VM's own disk
  *) : ;;                        # no network filesystem is mounted
esac
exit 0
'''

SCHEMA = """
CREATE SCHEMA control_plane;
CREATE TABLE public.control_plane_schema_migrations (version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now());
INSERT INTO public.control_plane_schema_migrations(version) VALUES ('0001_foundation.sql'), ('0002_bindings.sql');
CREATE TABLE control_plane.trips (id text PRIMARY KEY, slug text NOT NULL UNIQUE, lifecycle_state text NOT NULL,
  reachability text NOT NULL DEFAULT 'reachable',
  unreachable_reason text, reachability_checked_at timestamptz,
  CONSTRAINT trips_reachability_check CHECK (reachability IN ('unknown', 'reachable', 'unreachable')),
  CONSTRAINT trips_unreachable_reason_check CHECK (
    (reachability = 'unreachable' AND unreachable_reason IS NOT NULL)
    OR (reachability <> 'unreachable' AND unreachable_reason IS NULL)),
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE control_plane.telegram_chat_bindings (id text PRIMARY KEY, trip_id text NOT NULL, chat_id text NOT NULL,
  hermes_profile text, closed_at timestamptz, created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE control_plane.jobs (id text PRIMARY KEY, state text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE control_plane.intake_sessions (id text PRIMARY KEY, state text NOT NULL, awaiting text,
  awaiting_since timestamptz, telegram_chat_id text, created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE control_plane.intake_versions (id text PRIMARY KEY, created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE control_plane.releases (source_revision text, status text, created_at timestamptz NOT NULL DEFAULT now());
INSERT INTO control_plane.trips(id, slug, lifecycle_state) VALUES ('trip_aaaaaaaa', 'japan', 'ready_private');
INSERT INTO control_plane.telegram_chat_bindings(id, trip_id, chat_id) VALUES ('tcb_1', 'trip_aaaaaaaa', '1001');
"""

MIGRATION_0003 = """-- rollback: compatible — adds a nullable column nothing older reads
ALTER TABLE control_plane.trips ADD COLUMN IF NOT EXISTS rehearsal_note text;
"""

INTERVIEW_MCP = """
if (AGENT_KEY) {
  mcp.tool( "collect_answer_for_chat", schema, handler);
  mcp.tool( "submit_answer_for_chat", schema, handler);
}
"""

COMPANION_MCP = """
mcp.tool(
  "get_assistant_names", "d", {}, handler);
mcp.tool(
  "set_assistant_names", "d", {}, handler);
mcp.tool(
  "report_bug", "d", {}, handler);
"""

COMPANION_TOOLS = ("get_assistant_names", "set_assistant_names", "report_bug")


def registration(server, tools):
    prefix = "mcp__" + server.replace("-", "_") + "__"
    return f"[gateway] MCP server '{server}' registered {len(tools)} tool(s): " + ", ".join(prefix + t for t in tools)


KEY = "rehearsal-bridge-key-0123456789"

AGENT_LOG = ("[gateway] MCP server 'interview' registered 2 tool(s): "
             "mcp__interview__collect_answer_for_chat, mcp__interview__submit_answer_for_chat\n")



@unittest.skipUnless(docker_ready(), f"docker with {IMAGE} is not available")
class Rehearsal(unittest.TestCase):
    """One world per test: a scratch repo, deploy root, database and fakes."""

    @classmethod
    def setUpClass(cls):
        cls.container = f"cpr-rehearsal-{uuid.uuid4().hex[:8]}"
        subprocess.run([DOCKER, "run", "-d", "--rm", "--name", cls.container,
                        "-e", "POSTGRES_USER=kinerary_control_plane", "-e", "POSTGRES_DB=kinerary_control_plane",
                        "-e", "POSTGRES_PASSWORD=test", IMAGE], check=True, capture_output=True)
        for _ in range(60):
            probe = subprocess.run([DOCKER, "exec", cls.container, "psql", "-U", "kinerary_control_plane",
                                    "-d", "kinerary_control_plane", "-c", "SELECT 1"], capture_output=True)
            if probe.returncode == 0:
                break
            time.sleep(1)
        cls.readyz = HTTPServer(("127.0.0.1", 0), ReadyzHandler)
        threading.Thread(target=cls.readyz.serve_forever, daemon=True).start()

    @classmethod
    def tearDownClass(cls):
        cls.readyz.shutdown()
        subprocess.run([DOCKER, "rm", "-f", cls.container], capture_output=True)

    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="cp-rehearsal-"))
        self.addCleanup(shutil.rmtree, self.tmp, ignore_errors=True)
        self.reset_database()
        self.old_rev, self.new_rev = self.build_repo()
        self.build_world()

    # ------------------------------------------------------------ world --
    def sql(self, text: str, db: str = "kinerary_control_plane") -> str:
        proc = subprocess.run([DOCKER, "exec", "-i", self.container, "psql", "-U", "kinerary_control_plane",
                               "-d", db, "-At", "-v", "ON_ERROR_STOP=1"], input=text.encode(), capture_output=True)
        if proc.returncode:
            raise AssertionError(proc.stderr.decode())
        return proc.stdout.decode().strip()

    def reset_database(self):
        self.sql("DROP DATABASE IF EXISTS kinerary_control_plane WITH (FORCE)", db="postgres")
        for name in self.sql("SELECT datname FROM pg_database", db="postgres").splitlines():
            if name.startswith("kinerary_control_plane_"):
                self.sql(f'DROP DATABASE "{name}" WITH (FORCE)', db="postgres")
        self.sql("CREATE DATABASE kinerary_control_plane", db="postgres")
        self.sql(SCHEMA)

    def git(self, *args: str, cwd: Path) -> str:
        return subprocess.run(["git", *args], cwd=cwd, capture_output=True, text=True, check=True).stdout.strip()

    def build_repo(self) -> tuple[str, str]:
        """A repo with two versions: the second adds one declared migration."""
        origin = self.tmp / "origin.git"
        source = self.tmp / "source"
        (source / "control-plane/db/migrations").mkdir(parents=True)
        (source / "control-plane/api/src").mkdir(parents=True)
        (source / "control-plane/deployment").mkdir(parents=True)
        for name in ("0001_foundation.sql", "0002_bindings.sql"):
            (source / "control-plane/db/migrations" / name).write_text("-- rollback: compatible — grandfathered\nSELECT 1;\n")
        (source / "control-plane/api/src/interview-mcp.ts").write_text(INTERVIEW_MCP)
        (source / "control-plane/api/src/companion-mcp.ts").write_text(COMPANION_MCP)
        (source / "control-plane/deployment/vm-release.py").write_text("# the target's own tool\n")
        (source / "control-plane/deployment/compose.vm.yml").write_text("services: {}\n")
        relay = source / "control-plane/deployment/vm-relay-restart.sh"
        relay.write_text("#!/bin/sh\nexec docker compose up -d --wait relay\n")
        relay.chmod(relay.stat().st_mode | stat.S_IEXEC)
        self.git("init", "-q", "-b", "main", cwd=source)
        self.git("add", "-A", cwd=source)
        self.git("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "first", cwd=source)
        (source / "control-plane/db/migrations/0003_rehearsal.sql").write_text(MIGRATION_0003)
        self.git("add", "-A", cwd=source)
        self.git("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "second", cwd=source)
        subprocess.run(["git", "clone", "-q", "--bare", str(source), str(origin)], check=True, capture_output=True)
        self.repo = self.tmp / "repo"
        subprocess.run(["git", "clone", "-q", str(origin), str(self.repo)], check=True, capture_output=True)
        revisions = self.git("log", "--format=%h", cwd=self.repo).splitlines()
        new_rev, old_rev = revisions[0], revisions[1]
        self.git("checkout", "-q", "--detach", old_rev, cwd=self.repo)
        return old_rev, new_rev

    def build_world(self):
        deploy, hermes, bins = self.tmp / "deploy", self.tmp / "hermes-data", self.tmp / "bin"
        (hermes / "profiles/trip-intake/logs").mkdir(parents=True)
        (hermes / "profiles/trip-intake/logs/agent.log").write_text(AGENT_LOG)
        (hermes / "profiles/trip-intake/config.yaml").write_text("mcp_servers:\n  interview:\n    transport: sse\n")
        (hermes / "auth.json").write_text('{"provider": "not a real token"}')
        deploy.mkdir()
        (deploy / "vm.env").write_text(f"KINERARY_REV={self.old_rev}\nHERMES_REV=h1\n")
        (deploy / "control-plane.env").write_text(
            "CP_VMID=900\nCP_EXPECT_BOT=Example_bot\nCP_PROXMOX_SSH_KEY_ON_VM=/dev/null\n"
            "CP_PROXMOX_KNOWN_HOSTS_ON_VM=/dev/null\nCP_REFUSE_STORAGE=nas-share\n")
        (deploy / "provisioning.env").write_text("PROXMOX_HOST=pve.example\nPROXMOX_SSH_USER=root\n")
        bins.mkdir()
        for name, text in (("docker", FAKE_DOCKER), ("ssh", FAKE_SSH), ("sudo", FAKE_SUDO), ("ss", FAKE_SS),
                           ("install", FAKE_INSTALL), ("hermes", FAKE_HERMES), ("findmnt", FAKE_FINDMNT)):
            path = bins / name
            path.write_text(text)
            path.chmod(path.stat().st_mode | stat.S_IEXEC)
        self.state = self.tmp / "fake-state.json"
        self.state.write_text(json.dumps({
            "running": {f"kinerary-cp-{s}-1": f"kinerary-cp/{s}:{self.old_rev}"
                        for s in ("api", "worker", "relay", "interview-mcp", "companion-mcp")}
                       | {"hermes": "kinerary-cp/hermes:h1"},
            "hermes_rev": "h1", "snapshots": {}, "migrate_fails": False,
            "slots": ["trip-intake"], "connected": [],
            "registrations": {"trip-intake": [AGENT_LOG.strip()]}}))
        self.calls = self.tmp / "calls.log"
        self.calls.write_text("")
        host, port = self.readyz.server_address[0], self.readyz.server_address[1]
        self.env = {
            **os.environ,
            "PATH": f"{bins}:{os.environ['PATH']}",
            "REAL_DOCKER": DOCKER,
            "FAKE_STATE": str(self.state), "FAKE_CALLS": str(self.calls),
            "FAKE_LISTENING": "", "FAKE_BRIDGE_MODE": str(self.tmp / "bridge-mode"),
            "FAKE_VM_ENV": str(deploy / "vm.env"), "FAKE_REPO": str(self.repo), "FAKE_PG": self.container,
            "KINERARY_CP_REPO": str(self.repo), "KINERARY_CP_DEPLOY_ROOT": str(deploy),
            "KINERARY_CP_HERMES_DATA": str(hermes), "KINERARY_CP_PG_CONTAINER": self.container,
            "KINERARY_CP_BACKUP_DIR": str(self.tmp / "backups"), "KINERARY_CP_STATE_DIR": str(self.tmp / "state"),
            "KINERARY_CP_LOG_DIR": str(self.tmp / "log"),
            # The real runner script is streamed to the fake Proxmox host, which
            # answers the protocol rather than the script.
            "KINERARY_CP_LIB_DIR": str(ROOT / "control-plane" / "deployment"),
            "KINERARY_CP_READYZ": f"http://{host}:{port}/readyz",
        }
        self.deploy = deploy

    # ------------------------------------------------------------- runs --
    def release(self, *args: str) -> subprocess.CompletedProcess:
        return subprocess.run(["python3", str(TOOL), *args], capture_output=True, text=True,
                              env=self.env, timeout=600)

    def vm_env(self) -> dict:
        return dict(line.split("=", 1) for line in (self.deploy / "vm.env").read_text().splitlines() if "=" in line)

    def history(self) -> list[dict]:
        path = self.tmp / "state" / "history.tsv"
        if not path.exists():
            return []
        lines = path.read_text().splitlines()
        fields = lines[0].split("\t")
        return [dict(zip(fields, line.split("\t"))) for line in lines[1:]]

    def snapshots(self) -> dict:
        return json.loads(self.state.read_text())["snapshots"]

    def fail_migrate(self, failing: bool = True):
        state = json.loads(self.state.read_text())
        state["migrate_fails"] = failing
        self.state.write_text(json.dumps(state))

    def set_state(self, **fields):
        state = json.loads(self.state.read_text())
        state.update(fields)
        self.state.write_text(json.dumps(state))

    def calls_text(self) -> list[str]:
        return self.calls.read_text().splitlines()

    def restarts(self) -> list[str]:
        """The profiles `s6-svc -r` was issued for, in order."""
        return [m.group(1) for line in self.calls_text() if (m := re.search(r"s6-svc -r /run/service/gateway-(\S+)", line))]

    def fleet(self, bridge="ok", bridge_after=None, restart_fails=()):
        """A fleet beyond trip-intake: a companion with a bridge, the monitor, a slot whose
        profile is gone, and a retired trip's gateway that is still running."""
        hermes = self.tmp / "hermes-data"

        def profile(name, servers, lines):
            home = hermes / "profiles" / name
            (home / "logs").mkdir(parents=True, exist_ok=True)
            (home / "config.yaml").write_text("mcp_servers:\n" + "".join(f"  {s}:\n    transport: sse\n" for s in servers))
            (home / "logs" / "agent.log").write_text("".join(line + "\n" for line in lines))
        companion = [registration("trip-mcp", ["get_config"]), registration("trip-control", COMPANION_TOOLS)]
        profile("trip-a", ["trip-mcp", "trip-control"], companion)
        profile("trip-monitor", ["fleet"], [registration("fleet", ["alerts"])])
        profile("trip-x", ["trip-mcp"], [registration("trip-mcp", ["get_config"])])
        self.sql("""
            INSERT INTO control_plane.trips(id, slug, lifecycle_state) VALUES
              ('trip_cccccccc', 'alsace', 'ready_private'), ('trip_dddddddd', 'retired-x-20261001', 'ready_private');
            INSERT INTO control_plane.telegram_chat_bindings(id, trip_id, chat_id, hermes_profile) VALUES
              ('tcb_a', 'trip_cccccccc', '1002', 'trip-a'), ('tcb_x', 'trip_dddddddd', '1003', 'trip-x');""")
        self.bridge_server = HTTPServer(("127.0.0.1", 0), BridgeHandler)
        BridgeHandler.mode_file, BridgeHandler.key = Path(self.env["FAKE_BRIDGE_MODE"]), KEY
        Path(self.env["FAKE_BRIDGE_MODE"]).write_text(bridge)
        threading.Thread(target=self.bridge_server.serve_forever, daemon=True).start()
        self.addCleanup(self.bridge_server.server_close)
        self.addCleanup(self.bridge_server.shutdown)
        port = str(self.bridge_server.server_address[1])
        (self.deploy / "trips/alsace/mcp").mkdir(parents=True)
        (self.deploy / "trips/alsace/mcp/.env").write_text(f"MCP_PORT={port}\nMCP_API_KEY={KEY}\n")
        self.env["FAKE_LISTENING"] = port
        self.set_state(slots=["trip-intake", "trip-a", "trip-monitor", "trip-b", "trip-x"], connected=["trip-a"],
                       restart_fails=list(restart_fails), bridge_mode_after=bridge_after or "",
                       registrations={"trip-intake": [AGENT_LOG.strip()], "trip-a": companion,
                                      "trip-monitor": [registration("fleet", ["alerts"])],
                                      "trip-x": [registration("trip-mcp", ["get_config"])]})

    # ------------------------------------------------------------ tests --
    def test_the_vm_s_own_paths_still_need_root(self):
        bare = {k: v for k, v in self.env.items() if not k.startswith("KINERARY_CP_")}
        done = subprocess.run(["python3", str(TOOL), "status"], capture_output=True, text=True, env=bare, timeout=120)
        self.assertEqual(done.returncode, 2)
        self.assertIn("runs as root", done.stderr, "the rehearsal's freedom must not reach /opt/kinerary")

    def test_a_dry_run_changes_nothing(self):
        done = self.release("upgrade", self.new_rev, "--dry-run")
        self.assertEqual(done.returncode, 0, done.stdout + done.stderr)
        self.assertIn("Dry run complete", done.stdout)
        self.assertEqual(self.vm_env()["KINERARY_REV"], self.old_rev)
        self.assertEqual(self.snapshots(), {}, "a dry run never takes a snapshot")
        self.assertEqual(self.history(), [])
        self.assertFalse((self.tmp / "backups").exists(), "and never writes a backup")
        self.assertNotIn("s6-svc", self.calls.read_text(), "and never restarts a gateway (#420)")
        self.assertIn("exec hermes ls /run/service", self.calls.read_text(), "but it does read the supervisor, for real")
        self.assertNotIn("stop relay", self.calls.read_text(), "and never stops the relay")
        self.assertFalse((self.tmp / "state").exists(), "and takes a baseline without saving one")
        self.assertIn("baseline:", done.stdout)

    def test_an_upgrade_then_a_restore_db_rollback(self):
        done = self.release("upgrade", self.new_rev)
        self.assertEqual(done.returncode, 0, done.stdout + done.stderr)
        self.assertEqual(self.vm_env()["KINERARY_REV"], self.new_rev)
        self.assertEqual(len(self.snapshots()), 1, "the upgrade took its snapshot")
        self.assertIn("exec hermes /command/s6-svc -r /run/service/gateway-trip-intake", self.calls.read_text(),
                      "the trip-intake gateway was restarted to pick up the new interview tools (#420)")
        self.assertIn("0003_rehearsal.sql", self.sql("SELECT version FROM public.control_plane_schema_migrations"))
        self.assertEqual(self.sql("SELECT count(*) FROM information_schema.columns WHERE table_name='trips' "
                                  "AND column_name='rehearsal_note'"), "1")
        upgrade = self.history()[-1]
        self.assertEqual((upgrade["action"], upgrade["result"], upgrade["to_rev"]), ("upgrade", "ok", self.new_rev))
        backup = Path(upgrade["backup_dir"])
        self.assertTrue((backup / "db.dump").exists() and (backup / "db.counts.json").exists())

        # A trip is created on the new version, and the rollback discards it.
        self.sql("INSERT INTO control_plane.trips VALUES ('trip_bbbbbbbb', 'after-upgrade', 'draft')")
        done = self.release("rollback", "--restore-db")
        self.assertEqual(done.returncode, 0, done.stdout + done.stderr)
        self.assertEqual(self.vm_env()["KINERARY_REV"], self.old_rev)
        self.assertEqual(self.sql("SELECT count(*) FROM control_plane.trips"), "1", "back to the dump")
        self.assertEqual(self.sql("SELECT count(*) FROM pg_database WHERE datname LIKE '%_pre_rollback_%'"), "1",
                         "what it replaced is kept")
        rollback = self.history()[-1]
        self.assertEqual((rollback["action"], rollback["result"], rollback["verdict"]), ("rollback", "ok", "restore-db"))

    def test_an_upgrade_restarts_every_running_gateway(self):
        self.fleet()
        done = self.release("upgrade", self.new_rev)
        self.assertEqual(done.returncode, 0, done.stdout + done.stderr)
        self.assertEqual(sorted(self.restarts()), ["trip-a", "trip-intake", "trip-monitor"],
                         "each running gateway once; the leftover slot and the retired trip's are not touched")
        calls = self.calls_text()
        up = next(i for i, line in enumerate(calls) if "interview-mcp" in line and " up " in line)
        stop = next(i for i, line in enumerate(calls) if line.endswith(" stop relay"))
        relay = next(i for i, line in enumerate(calls) if line == "compose up -d --wait relay")
        svc = [i for i, line in enumerate(calls) if "s6-svc -r" in line]
        first, last = min(svc), max(svc)
        self.assertTrue(up < stop < first and last < relay, calls)
        self.assertIn("trip-b: supervisor without a profile (teardown leftover)", done.stdout)
        self.assertIn("trip-x: retired trip", done.stdout)
        self.assertEqual(self.history()[-1]["result"], "ok")
        self.assertTrue([l for l in calls if l.startswith("install ")], "a green verify installs the tool's own files")
        for profile in ("trip-intake", "trip-a", "trip-monitor"):
            log = (self.tmp / "hermes-data/profiles" / profile / "logs/agent.log").read_text()
            self.assertGreaterEqual(log.count("registered"), 2, f"{profile} registered again after its restart")

    def test_the_baseline_is_a_file_of_id_ok_and_code_and_the_key_is_nowhere(self):
        self.fleet()
        done = self.release("upgrade", self.new_rev)
        self.assertEqual(done.returncode, 0, done.stdout + done.stderr)
        row = self.history()[-1]
        baseline = Path(row["baseline"])
        self.assertTrue(baseline.exists(), row)
        self.assertEqual(baseline.parent, self.tmp / "state")
        checks = json.loads(baseline.read_text())
        self.assertTrue(all(set(c) == {"id", "ok", "code"} for c in checks), checks)
        ids = {c["id"] for c in checks}
        self.assertTrue({"readyz", "bridge:alsace", "gateways:discovery", "tools:trip-a:trip-control",
                         "tools:trip-intake:interview", "tools:trip-monitor:fleet", "companion-connected:trip-a"} <= ids, ids)
        for where in (baseline.read_text(), (self.tmp / "state/history.tsv").read_text(), self.calls.read_text(),
                      done.stdout, done.stderr):
            self.assertNotIn(KEY, where)

    def test_a_preexisting_bridge_failure_does_not_fail_the_upgrade(self):
        self.fleet(bridge="site-401")
        done = self.release("upgrade", self.new_rev)
        self.assertEqual(done.returncode, 0, done.stdout + done.stderr)
        self.assertEqual(self.history()[-1]["result"], "ok")
        self.assertIn("already failing before this upgrade", done.stdout)
        self.assertIn("bridge:alsace", done.stdout)
        self.assertIn("restart-bridges", done.stdout, "the repair is named")
        self.assertTrue([l for l in self.calls_text() if l.startswith("install ")], "install_tool_files ran")

    def test_a_bridge_the_upgrade_broke_fails_it(self):
        self.fleet(bridge="ok", bridge_after="site-401")
        done = self.release("upgrade", self.new_rev)
        self.assertEqual(done.returncode, 2, done.stdout + done.stderr)
        self.assertEqual(self.history()[-1]["result"], "verify-failed")
        self.assertIn("[caused by this change]", done.stdout)
        self.assertFalse([l for l in self.calls_text() if l.startswith("install ")], "the tool does not update itself on a failed verify")

    def test_a_bridge_that_fails_differently_is_caused(self):
        self.fleet(bridge="site-401", bridge_after="unreachable")
        done = self.release("upgrade", self.new_rev)
        self.assertEqual(done.returncode, 2, done.stdout + done.stderr)
        self.assertIn("ECONNREFUSED", done.stdout)

    def test_a_gateway_whose_restart_failed_is_stale_and_the_rest_are_restarted(self):
        self.fleet(restart_fails=["trip-a"])
        done = self.release("upgrade", self.new_rev)
        self.assertEqual(done.returncode, 2, done.stdout + done.stderr)
        self.assertEqual(sorted(self.restarts()), ["trip-a", "trip-intake", "trip-monitor"], "all three were tried")
        self.assertIn("trip-a: the restart FAILED", done.stdout)
        self.assertIn("STALE", done.stdout.upper())
        self.assertIn("compose up -d --wait relay", self.calls_text(), "the relay still started")

    def test_a_rollback_restarts_every_gateway_too(self):
        self.fleet()
        self.assertEqual(self.release("upgrade", self.new_rev).returncode, 0)
        done = self.release("rollback")
        self.assertEqual(done.returncode, 0, done.stdout + done.stderr)
        self.assertEqual(sorted(self.restarts()), ["trip-a"] * 2 + ["trip-intake"] * 2 + ["trip-monitor"] * 2)
        self.assertEqual(self.history()[-1]["action"], "rollback")
        self.assertTrue(Path(self.history()[-1]["baseline"]).exists())

    def test_the_target_s_own_tool_runs_from_a_throwaway_copy(self):
        # The first upgrade that carries this runs the OLD switch, because the tool installs itself
        # only after a green verify. So the target's tool is run from a worktree of the target:
        # it must not care where it lives, only which checkout and deploy root it is pointed at.
        self.fleet()
        throwaway = self.tmp / "throwaway-worktree" / "control-plane" / "deployment"
        throwaway.mkdir(parents=True)
        shutil.copy(TOOL, throwaway / "vm-release.py")
        dry = subprocess.run(["python3", str(throwaway / "vm-release.py"), "upgrade", self.new_rev, "--dry-run"],
                             capture_output=True, text=True, env=self.env, timeout=600)
        self.assertEqual(dry.returncode, 0, dry.stdout + dry.stderr)
        self.assertEqual(self.restarts(), [], "the dry run restarts nothing")
        self.assertEqual(self.vm_env()["KINERARY_REV"], self.old_rev)
        done = subprocess.run(["python3", str(throwaway / "vm-release.py"), "upgrade", self.new_rev],
                              capture_output=True, text=True, env=self.env, timeout=600)
        self.assertEqual(done.returncode, 0, done.stdout + done.stderr)
        self.assertEqual(sorted(self.restarts()), ["trip-a", "trip-intake", "trip-monitor"])
        self.assertEqual(self.vm_env()["KINERARY_REV"], self.new_rev)

    def test_a_rollback_whose_migrate_fails_undoes_itself(self):
        self.assertEqual(self.release("upgrade", self.new_rev).returncode, 0)
        self.sql("INSERT INTO control_plane.trips VALUES ('trip_bbbbbbbb', 'after-upgrade', 'draft')")
        self.fail_migrate()

        done = self.release("rollback", "--restore-db")
        self.assertNotEqual(done.returncode, 0, done.stdout)
        self.assertIn("the rollback was undone", done.stdout)
        self.assertEqual(self.sql("SELECT count(*) FROM control_plane.trips"), "2",
                         "the database is the one the rollback started from, trip and all")
        self.assertEqual(self.vm_env()["KINERARY_REV"], self.new_rev, "and the version it started from")
        self.assertEqual(self.history()[-1]["result"], "undone")
        running = json.loads(self.state.read_text())["running"]
        for service in ("api", "worker", "interview-mcp", "companion-mcp"):
            self.assertIn(f"kinerary-cp-{service}-1", running, "the bot and signups are back up")
        self.assertEqual(self.sql("SELECT count(*) FROM pg_database WHERE datname LIKE '%_restore_failed_%'"), "1",
                         "the copy it had restored is kept for inspection")


class BridgeHandler(BaseHTTPRequestHandler):
    """A trip-mcp bridge's /health. What it says is whatever its mode file says, so a test can
    change it between the baseline and the verify."""
    mode_file, key = None, ""

    def do_GET(self):
        mode = self.mode_file.read_text().strip()
        if self.path != "/health" or mode == "no-route":
            return self.reply(404, "<pre>Cannot GET /health</pre>")
        if self.headers.get("X-API-Key") != self.key:
            return self.reply(401, '{"error":"unauthorized"}')
        if mode == "ok":
            return self.reply(200, '{"ok":true,"site":"reachable"}')
        if mode == "site-401":
            return self.reply(503, '{"ok":false,"site":"refused","code":"HTTP_401"}')
        return self.reply(503, '{"ok":false,"site":"unreachable","code":"ECONNREFUSED"}')

    def reply(self, status, body):
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(body.encode())

    def log_message(self, *args):
        pass


class ReadyzHandler(BaseHTTPRequestHandler):
    def do_GET(self):
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(b'{"status":"ready"}')

    def log_message(self, *args):
        pass


if __name__ == "__main__":
    unittest.main()
