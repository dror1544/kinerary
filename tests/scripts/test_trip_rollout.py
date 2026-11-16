"""scripts/trip-rollout.py — one command brings a release to named trips (#568, slices R1 and R2).

What is pinned here, by the spec's acceptance criteria (docs/specs/sprint-9/568-trip-rollout.md):

  AC-1  `plan` prints and writes current release, target and commit, ordered steps — and changes nothing
  AC-2  a release that is not available, or whose data-schema range misses the trip, is refused for that trip
  AC-3  a trip that no longer runs what the plan recorded is refused, and no step runs for it
  AC-4  a `running` row exists before the first step; `ok` after the last; `failed` + step name; later steps did not run
  AC-5  columns move to the target on success, previous = what it ran; a failed site step moves neither
  AC-6  config, participants and data are byte-identical; the deploy is never given the flag that overwrites config
  AC-7  no approval, no notification, no lifecycle change
  AC-8  a bridge that cannot reach its trip fails the step with the bridge's health code
  AC-9  unset deployment values are refused by name, and nothing is defaulted
  AC-11 a plan file that is missing, unreadable or changed (digest mismatch) is refused
  AC-12 rolling to the previous release is the same command and swaps the two columns
  (AC-10, the approval hook, is in test_match_command.py and test_claude_hooks_bash.py.)

Slice R2 adds, in the classes at the end:

  AC-13 a release's seal covers mcp/ and profile-templates/; one built before them is refused for the bridge and
        companion steps with a clear message, and stays valid for the site step
  AC-14 the profile's SOUL.md and skills equal a fresh render from the release for that trip; history and memory
        untouched; a profile edited in place is reported and not overwritten unless the plan says so
  AC-15 a conversation turn in flight is waited for, boundedly, and the step fails rather than cut it
  AC-16 every tool the release's bridge declares is registered on the gateway, read from the gateway's own log
  Decision 5: the trip's own previous release is accepted for a rollback even when it is no longer available,
        with a warning; any other release that is not available is still refused

The companion tests run the REAL installer and prompt-refresh scripts, in a sandboxed HOME, behind a wrapper (as the
deployment's own wrapper would be), with a stand-in `hermes`, `launchctl` and `uname`: a rollout here changes a real
profile directory and a real SQLite state.db, and starts nothing.

NOTHING REAL IS CONTACTED. The deploy command, the bridge restart and the hostname check are fake programs
that log what they were given; the site and the bridge are fake HTTP servers on loopback; the topology is a
fixture; the release trees come from a throwaway git repository. The control plane database is the scratch
database named by CONTROL_PLANE_TEST_DATABASE_URL (its name must say it is for tests; the schema is DROPPED
and rebuilt from the migrations). Without it the database-backed tests are skipped, never failed.

    CONTROL_PLANE_TEST_DATABASE_URL=postgres://postgres:test@127.0.0.1:5434/cptest_rollout \\
        python3 -m unittest tests.scripts.test_trip_rollout
"""
from __future__ import annotations

import contextlib
import hashlib
import importlib.util
import io
import json
import os
import re
import secrets
import shlex
import shutil
import signal
import socket
import stat
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import unquote, urlparse

ROOT = Path(__file__).resolve().parents[2]
SCRIPT = ROOT / "scripts" / "trip-rollout.py"
MIGRATIONS = ROOT / "control-plane" / "db" / "migrations"
RELEASE_SOURCE = ROOT / "control-plane" / "worker" / "control_plane_worker" / "release_source.py"

BRIDGE_SOURCE = {
    "v1": "const mcp = guardTools(new McpServer({ name: 'trip-mcp' }));\nmcp.tool('get_config', 'c', {}, h);\nmcp.tool('get_today', 't', {}, h);\n",
    "v2": "const mcp = guardTools(new McpServer({ name: 'trip-mcp' }));\nmcp.tool('get_config', 'c', {}, h);\nmcp.tool('get_today', 't', {}, h);\n"
          "mcp.tool(\n  'set_things', 's', {}, h);\n",
}
TOOLS_V1 = ["get_config", "get_today"]
TOOLS_V2 = ["get_config", "get_today", "set_things"]


def _load(path: Path, name: str):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module      # a dataclass resolves its own module by name
    spec.loader.exec_module(module)
    return module


rt = _load(SCRIPT, "trip_rollout")
release_source = _load(RELEASE_SOURCE, "release_source_under_test")

PYTHON = sys.executable
KEY = "KEY-" + "9f8e7d6c5b4a" * 3          # the bridge's key: it must never appear in any output or argument
SECRET_IN_OUTPUT = "SECRET123XYZ"          # what a failing deploy command prints; it must be redacted when shown
CANARY = "RELAY_PROVIDER_KEY_CANARY"      # a variable of the parent that no child may inherit
ORGANIZER_PRIVATE = "ORGANIZER-PRIVATE-STANDING-ORDER"   # organizer-only interview text: it must never be printed or stored


# ── the scratch database, reached the way the script reaches the real one: a psql command ──────────────

def database_url() -> str | None:
    url = os.environ.get("CONTROL_PLANE_TEST_DATABASE_URL")
    if not url:
        return None
    name = unquote((urlparse(url).path or "").lstrip("/"))
    if "test" not in name.lower():
        # The same rule as control-plane/api/test/support/test-database.ts: this suite DROPS the schema.
        raise RuntimeError(f"CONTROL_PLANE_TEST_DATABASE_URL names {name!r}, which does not look like a scratch "
                           "database; refusing to drop its schema")
    return url


def psql_command(url: str) -> tuple[list[str], dict[str, str]] | None:
    """(argv, extra env) for a psql into `url`: a host psql if there is one, otherwise `docker exec` into the
    container that publishes the URL's port. None when neither exists."""
    parsed = urlparse(url)
    user, db = unquote(parsed.username or "postgres"), unquote(parsed.path.lstrip("/"))
    host, port = parsed.hostname or "127.0.0.1", str(parsed.port or 5432)
    if shutil.which("psql"):
        env = {"PGPASSWORD": unquote(parsed.password)} if parsed.password else {}
        return ["psql", "-h", host, "-p", port, "-U", user, "-d", db], env
    docker = shutil.which("docker")
    if docker:
        out = subprocess.run([docker, "ps", "--filter", f"publish={port}", "--format", "{{.Names}}"],
                             capture_output=True, text=True)
        names = out.stdout.split()
        if out.returncode == 0 and len(names) == 1:
            return [docker, "exec", "-i", names[0], "psql", "-U", user, "-d", db], {}
    return None


class Sql:
    def __init__(self, argv: list[str], env: dict[str, str]) -> None:
        self.argv, self.env = argv, {**os.environ, **env}

    def run(self, text: str, **values: str) -> str:
        args = self.argv + ["-X", "-q", "-v", "ON_ERROR_STOP=1", "-A", "-t"]
        for k, v in values.items():
            args += ["-v", f"{k}={v}"]
        out = subprocess.run(args, input=text, capture_output=True, text=True, env=self.env, timeout=120)
        if out.returncode != 0:
            raise AssertionError(f"sql failed: {out.stderr.strip()[-500:]}")
        return out.stdout.strip()

    def rows(self, text: str, **values: str) -> list[dict]:
        return [json.loads(line) for line in self.run(text, **values).splitlines() if line.strip()]

    def one(self, text: str, **values: str):
        return self.run(text, **values)


# ── fake programs: the deploy command, the bridge restart, the hostname check ─────────────────────────

FAKE_DEPLOY = r'''
import json, os, sys, time
d = os.environ["FAKE_DIR"]
argv = sys.argv[1:]
slug = argv[0]
repo_root = os.environ.get("REPO_ROOT")
try:
    app_js = open(os.path.join(repo_root, "site", "app.js")).read()
except Exception:
    app_js = None
with open(os.path.join(d, "deploy.log"), "a") as f:
    f.write(json.dumps({"argv": argv, "repo_root": repo_root, "env": sorted(os.environ), "app_js": app_js,
                        "has_mcp": os.path.exists(os.path.join(repo_root or "", "mcp")),
                        "has_templates": os.path.exists(os.path.join(repo_root or "", "profile-templates"))}) + "\n")
if os.path.exists(os.path.join(d, "block-deploy")):
    open(os.path.join(d, "deploy-started"), "w").close()
    while not os.path.exists(os.path.join(d, "go")):
        time.sleep(0.05)
trip_dir = argv[argv.index("--trip-dir") + 1]
if "--sync-config" in argv:
    open(os.path.join(trip_dir, "trip.config.json"), "w").write("OVERWRITTEN")
if os.path.exists(os.path.join(d, "mutate-config")):
    open(os.path.join(trip_dir, "trip.config.json"), "a").write(" ")
if os.path.exists(os.path.join(d, "fail-deploy-" + slug)):
    print("deploying " + slug + " token=SECRET123XYZ went wrong")
    sys.exit(7)
'''

FAKE_BRIDGE_RESTART = r'''
import json, os, re, sys
d = os.environ["FAKE_DIR"]
repo_root = os.environ.get("REPO_ROOT")
try:
    mcp_js = open(os.path.join(repo_root, "mcp", "mcp.js")).read()
except Exception:
    mcp_js = None
with open(os.path.join(d, "bridge.log"), "a") as f:
    f.write(json.dumps({"argv": sys.argv[1:], "env": sorted(os.environ), "repo_root": repo_root, "mcp_js": mcp_js,
                        "commit": os.environ.get("KINERARY_ROLLOUT_RELEASE_COMMIT")}) + "\n")
if os.path.exists(os.path.join(d, "fail-bridge-restart")):
    print("restart failed")
    sys.exit(3)
# The bridge that is now running serves the tools its source declares: what a gateway will register when it connects.
tools = re.findall(r"mcp\.(?:tool|registerTool)\(\s*['\"]([a-z_]+)['\"]", " ".join((mcp_js or "").split()))
drop = os.path.join(d, "bridge-drops-tool")
if os.path.exists(drop):
    tools = [t for t in tools if t != open(drop).read().strip()]
open(os.path.join(d, "bridge-tools.txt"), "w").write("\n".join(tools) + "\n")
'''

# What the host's own wrapper does: point the installer and the prompt refresh at the Hermes profiles' home and give
# them the platform tools they need. The rollout hands the release's tree over in KINERARY_RELEASE_TREE.
FAKE_COMPANION_WRAPPER = r'''
import os, sys
env = dict(os.environ)
env["HOME"] = os.environ["RIG_HERMES_HOME"]
env["PATH"] = os.environ["RIG_FAKE_BIN"] + ":/usr/bin:/bin"
env["KINERARY_REFRESH_POLL_SECONDS"] = "1"
env["KINERARY_ARCHITECTURE_PROFILE"] = os.path.join(os.environ["RIG_HERMES_HOME"], "none.json")
import json
open(os.path.join(os.environ["FAKE_DIR"], "companion-env.log"), "a").write(json.dumps({"kind": sys.argv[1], "env": sorted(os.environ)}) + "\n")
script = {"install": "companion-install-host.sh", "refresh": "companion-refresh-prompts.sh"}[sys.argv[1]]
os.execvpe("bash", ["bash", os.path.join(os.environ["RIG_REPO"], "scripts", script)] + sys.argv[2:], env)
'''

# `launchctl kickstart` restarts a gateway, which writes the line Hermes writes when it registers a server's tools.
FAKE_LAUNCHCTL = r'''#!PYTHON
import os, sys
d, home = os.environ["FAKE_DIR"], os.environ["HOME"]
open(os.path.join(d, "launchctl.log"), "a").write(" ".join(sys.argv[1:]) + "\n")
if sys.argv[1] == "kickstart":
    profile = sys.argv[-1].rsplit("ai.hermes.gateway-", 1)[1]
    if os.path.exists(os.path.join(d, "gateway-no-register")):
        sys.exit(0)
    try:
        tools = open(os.path.join(d, "bridge-tools.txt")).read().split()
    except OSError:
        tools = []
    log = os.path.join(home, ".hermes", "profiles", profile, "logs", "agent.log")
    names = ", ".join("mcp__trip_mcp__" + t for t in tools)
    with open(log, "a") as f:
        f.write(f"2026-11-16 10:00:00,001 INFO [20261116_100000_abcd1234] tools.mcp_tool: MCP server 'trip-mcp' (HTTP): "
                f"registered {len(tools)} tool(s): {names}\n")
'''

FAKE_HOSTNAME = r'''
import json, os, sys
names = json.load(open(os.path.join(os.environ["FAKE_DIR"], "hostnames.json")))
name = names.get(sys.argv[1])
if name is None:
    sys.exit(1)
print(name)
'''


class Serve(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True


def free_port(low: int = 1024, high: int = 65000) -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def serve(handler_factory, port: int) -> Serve:
    server = Serve(("127.0.0.1", port), handler_factory)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server


class SiteHandler(BaseHTTPRequestHandler):
    healthy = True

    def do_GET(self):  # noqa: N802
        if self.path == "/api/health" and type(self).healthy:
            body, status = b'{"ok": true}', 200
        else:
            body, status = b'{"ok": false}', 503
        self.send_response(status)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *a):
        pass


def bridge_handler(mode: str):
    class H(BaseHTTPRequestHandler):
        def do_GET(self):  # noqa: N802
            if self.path != "/health":
                status, body = 404, b"Cannot GET " + self.path.encode()
            elif self.headers.get("X-API-Key") != KEY:
                status, body = 401, b'{"error":"unauthorized"}'
            elif mode == "ok":
                status, body = 200, b'{"ok":true,"site":"reachable"}'
            elif mode == "timeout":
                status, body = 503, b'{"ok":false,"site":"unreachable","code":"ETIMEDOUT"}'
            elif mode == "refused":
                status, body = 503, b'{"ok":false,"site":"refused","code":"HTTP_401"}'
            elif mode == "noroute":
                status, body = 404, b"<pre>Cannot GET /health</pre>"
            else:
                status, body = 200, b"<html>something else</html>"
            self.send_response(status)
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def log_message(self, *a):
            pass
    return H


def sha(path: Path) -> str | None:
    try:
        return hashlib.sha256(path.read_bytes()).hexdigest()
    except OSError:
        return None


# ── everything one rollout needs, in a temp directory ────────────────────────────────────────────────

class Rig:
    """A deployment root, a git repository with two releases, fake programs, and (when a database is given)
    the rows: two available releases and any number of trips running the first."""

    def __init__(self, sql: Sql | None, psql: tuple[list[str], dict[str, str]] | None) -> None:
        self.sql, self.psql = sql, psql
        self.dir = Path(tempfile.mkdtemp(prefix="rollout-test-"))
        self.tag = secrets.token_hex(4)
        self.root = self.dir / "deploy-root"
        (self.root / "trips").mkdir(parents=True)
        self.fake = self.dir / "fake"
        self.fake.mkdir()
        self.servers: list[Serve] = []
        self.addCleanup_dirs: list[str] = []
        self.trips: dict[str, dict] = {}
        self.hostnames: dict[str, str] = {}
        for name, body in (("deploy.py", FAKE_DEPLOY), ("bridge.py", FAKE_BRIDGE_RESTART), ("hostname.py", FAKE_HOSTNAME),
                           ("companion_wrapper.py", FAKE_COMPANION_WRAPPER)):
            (self.dir / name).write_text(body)
        self._hermes_sandbox()
        self._git_repo()
        self.r1, self.r2 = f"rls_{self.tag}r1", f"rls_{self.tag}r2"
        if sql:
            self._releases()

    # -- the Hermes host's home, with the platform commands the installer and the refresh call replaced

    def _hermes_sandbox(self) -> None:
        self.hermes_home = self.dir / "hermes-home"
        self.fake_bin = self.dir / "fake-bin"
        for d in (self.hermes_home / ".hermes" / "profiles", self.fake_bin):
            d.mkdir(parents=True)

        def exe(path: Path, body: str) -> None:
            path.write_text(body)
            path.chmod(0o755)
        exe(self.fake_bin / "uname", "#!/bin/sh\necho Darwin\n")
        # `hermes profile create` makes the directory; a gateway command is recorded and does nothing.
        exe(self.fake_bin / "hermes",
            f'#!/bin/sh\ncase "$*" in *gateway*) echo "hermes $*" >> "{self.fake}/hermes.log";; esac\n'
            '[ "$1 $2" = "profile create" ] && mkdir -p "$HOME/.hermes/profiles/$3"\nexit 0\n')
        exe(self.fake_bin / "launchctl", FAKE_LAUNCHCTL.replace("#!PYTHON", f"#!{PYTHON}"))
        (self.fake_bin / "python3").symlink_to(PYTHON)       # PyYAML for the overlay merge

    def install_companion(self, slug: str) -> str:
        """What a provision leaves behind: a companion profile, installed by the real installer from the handoff the
        control plane builds, marked as this system's, with a conversation history. Returns the profile's name."""
        trip = self.trips[slug]
        handoff = trip["handoff"]()
        name = handoff["profile"]["name"]
        env = {"HOME": str(self.hermes_home), "PATH": f"{self.fake_bin}:/usr/bin:/bin",
               "KINERARY_ARCHITECTURE_PROFILE": str(self.hermes_home / "none.json")}
        done = subprocess.run(["bash", str(ROOT / "scripts" / "companion-install-host.sh")], input=json.dumps(handoff),
                              capture_output=True, text=True, env=env, timeout=120)
        assert done.returncode == 0 and done.stdout.strip() == f"INSTALLED {name}", done.stdout + done.stderr
        profile = self.hermes_home / ".hermes" / "profiles" / name
        (profile / "logs").mkdir(exist_ok=True)
        (profile / "logs" / "agent.log").write_text("gateway started\n")
        (profile / "memories").mkdir(exist_ok=True)
        (profile / "memories" / "MEMORY.md").write_text("the organizer prefers mornings\n")
        (profile / ".env").write_text("GATEWAY_RELAY_SECRET=untouchable\n")
        import sqlite3
        db = sqlite3.connect(profile / "state.db")
        db.executescript("""
            CREATE TABLE sessions (id TEXT PRIMARY KEY, title TEXT, system_prompt TEXT, system_prompt_hash TEXT, ended_at REAL);
            CREATE TABLE system_prompts (hash TEXT PRIMARY KEY, body TEXT);
            CREATE TABLE session_turn_leases (session_id TEXT, expires_at TEXT);
            CREATE TABLE messages (id INTEGER PRIMARY KEY, session_id TEXT, content TEXT);
            INSERT INTO system_prompts VALUES ('h1', 'the soul as it was');
            INSERT INTO sessions VALUES ('group', 'family group', 'the soul as it was', 'h1', NULL);
            INSERT INTO messages(session_id, content) VALUES ('group', 'where is dinner?'), ('group', 'remember the allergy');
        """)
        db.commit()
        db.close()
        venv = self.hermes_home / ".hermes" / "hermes-agent" / "venv" / "bin"     # after the install: it would start a gateway
        venv.mkdir(parents=True, exist_ok=True)
        if not (venv / "python").exists():
            (venv / "python").symlink_to(PYTHON)
        return name

    def profile_dir(self, slug: str) -> Path:
        return self.hermes_home / ".hermes" / "profiles" / self.trips[slug]["profile"]

    def profile_state(self, slug: str) -> dict:
        """The parts of a profile a re-render must leave alone, as bytes; plus what a prompt refresh may change."""
        import sqlite3
        profile = self.profile_dir(slug)
        db = sqlite3.connect(profile / "state.db")
        try:
            history = db.execute("SELECT session_id, content FROM messages ORDER BY id").fetchall()
            prompts = db.execute("SELECT id, system_prompt FROM sessions ORDER BY id").fetchall()
        finally:
            db.close()
        return {"history": history, "prompts": prompts,
                "files": {rel: (profile / rel).read_bytes() for rel in
                          ("memories/MEMORY.md", ".env", "logs/agent.log", "kinerary-managed")}}

    def lease(self, slug: str, seconds_from_now: float) -> None:
        import sqlite3
        db = sqlite3.connect(self.profile_dir(slug) / "state.db")
        db.execute("INSERT INTO session_turn_leases VALUES ('group', ?)", (str(time.time() + seconds_from_now),))
        db.commit()
        db.close()

    def fresh_render(self, slug: str, rev: str, digest: str) -> Path:
        """A fresh render of this trip's companion from the release at `rev`: what the profile must equal."""
        tree = release_source.materialize_release_source(str(self.repo), rev, digest)
        self.addCleanup_dirs.append(tree)
        handoff = self.trips[slug]["handoff"]()
        inp = self.dir / f"fresh-{slug}.json"
        inp.write_text(json.dumps(handoff))
        out = self.dir / f"fresh-{slug}-{rev[:8]}"
        done = subprocess.run([PYTHON, str(Path(tree) / "profile-templates" / "familytrip-companion" / "render_profile.py"),
                               "--input", str(inp), "--output", str(out)], capture_output=True, text=True)
        assert done.returncode == 0, done.stderr
        return out

    # -- release trees: a real git repository, so the digest check is the real one

    def _git_repo(self) -> None:
        self.repo = self.dir / "repo"
        self.repo.mkdir()

        def git(*a):
            return subprocess.run(["git", "-C", str(self.repo), "-c", "user.name=t", "-c", "user.email=t@example.invalid", *a],
                                  check=True, capture_output=True, text=True).stdout.strip()
        git("init", "-q")
        revs = []
        for version in ("v1", "v2"):
            files = {"site/app.js": version, "server/server.js": f"// {version}\n", "shared/s.js": f"{self.tag}\n",
                     # The bridge: v2 declares one tool more than v1, one of them wrapped onto its own line.
                     "mcp/mcp.js": BRIDGE_SOURCE[version]}
            for rel, body in files.items():
                p = self.repo / rel
                p.parent.mkdir(parents=True, exist_ok=True)
                p.write_text(body)
            # The companion templates: the real ones, with the release named in the SOUL so a re-render shows which.
            tpl = self.repo / "profile-templates" / "familytrip-companion"
            if tpl.exists():
                shutil.rmtree(tpl)
            shutil.copytree(ROOT / "profile-templates" / "familytrip-companion", tpl,
                            ignore=shutil.ignore_patterns("tests", "eval", "__pycache__"))
            soul = tpl / "templates" / "SOUL.md.tpl"
            soul.write_text(soul.read_text() + f"\nRELEASE-MARK-{version}\n")
            if version == "v2":
                extra = tpl / "templates" / "skills" / "travel" / "a-v2-skill" / "SKILL.md"
                extra.parent.mkdir(parents=True)
                extra.write_text("---\nname: a-v2-skill\n---\nOnly release two has this skill.\n")
            git("add", "-A")
            git("commit", "-qm", version)
            revs.append(git("rev-parse", "HEAD"))
        self.rev1, self.rev2 = revs
        self.digest1 = release_source.tree_digest(str(self.repo), self.rev1)
        self.digest2 = release_source.tree_digest(str(self.repo), self.rev2)
        # What a release sealed BEFORE the bridge and the companion templates were part of it recorded.
        self.legacy_digest1 = release_source.tree_digest(str(self.repo), self.rev1, release_source.SITE_ROOTS)
        self.legacy_digest2 = release_source.tree_digest(str(self.repo), self.rev2, release_source.SITE_ROOTS)

    def release(self, rid: str, rev: str, digest: str, status: str = "available", lo: int = 1, hi: int = 1,
                manifest: bool = True, runtime: bool = True) -> None:
        """`runtime=False` is a release sealed before releases carried mcp/ and profile-templates/: its manifest lists
        the site only (pair it with a legacy digest, or the tree will not verify)."""
        sealed = status in ("verified", "available")
        files = [{"path": "site/app.js", "sha": "x"}]
        if runtime:
            files += [{"path": "mcp/mcp.js", "sha": "x"},
                      {"path": "profile-templates/familytrip-companion/render_profile.py", "sha": "x"}]
        self.sql.run(
            f"""INSERT INTO control_plane.releases(id, source_revision, artifact_digest, application_schema,
                    data_schema_min, data_schema_max, status, promoted_to_available_at, promoted_by, manifest, sanitation_passed)
                VALUES (:'id', :'rev', :'digest', 1, {int(lo)}, {int(hi)}, :'status',
                    CASE WHEN :'status' = 'available' THEN now() END, CASE WHEN :'status' = 'available' THEN 'test:fixture' END,
                    NULLIF(:'manifest', '')::jsonb, {'true' if sealed else 'false'})""",
            id=rid, rev=rev, digest=digest, status=status,
            manifest=json.dumps({"files": files}) if manifest else "")

    def _releases(self) -> None:
        self.release(self.r1, self.rev1, self.digest1)
        self.release(self.r2, self.rev2, self.digest2)

    # -- trips

    def trip(self, name: str, current: str | None = "r1", state: str = "active", vmid: int | None = None,
             bridge: str | None = "ok", site_ok: bool = True, schema: int | None = 1, companion: bool = False) -> str:
        slug = f"ro-{self.tag}-{name}"
        vmid = vmid or self._free_vmid()
        site_port = free_port()
        handler = type("H", (SiteHandler,), {"healthy": site_ok})
        self.servers.append(serve(handler, site_port))
        if bridge is not None:
            self.servers.append(serve(bridge_handler(bridge), 3000 + vmid))
        tdir = self.root / "trips" / slug
        (tdir / "mcp").mkdir(parents=True)
        (tdir / "mcp" / ".env").write_text(f'PORT=1\nMCP_API_KEY="{KEY}"\n')
        config = {"participants": [{"username": "ana"}], "slug": slug}
        if companion:
            # What transform_intake leaves for a trip whose organizer named an assistant: enough for build_companion_handoff.
            config = {"slug": slug, "meta": {"title": f"Trip {name}", "defaultLang": "en"},
                      "participants": [{"username": "ana", "name": "Ana", "needs": [
                          {"type": "dietary", "severity": "allergy", "visibility": "organizer",
                           "text": {"he": "בוטנים", "en": "peanut allergy"}}]}],
                      "agent": {"name": "Robin", "gender": "neutral", "tone": "warm", "timezone": "Europe/Paris",
                                "organizers": ["ana"], "standing_instructions": ORGANIZER_PRIVATE}}
        (tdir / "trip.config.json").write_text(json.dumps(config))
        (tdir / "data.sqlite").write_bytes(b"SQLite format 3\x00 participants and everything travellers wrote")
        (tdir / "topology.yaml").write_text(
            "# fixture\nversion: 1\n"
            f"name: {slug}\nproxmox:\n  node: pve\n  vmid: '{vmid}'\n  lxc:\n    name: trip-{slug}\n    ipv4: 127.0.0.1/24\n"
            f"npm:\n  hostname: {slug}.example.invalid\n  forward_port: {site_port}\n")
        self.hostnames[str(vmid)] = f"trip-{slug}"
        (self.fake / "hostnames.json").write_text(json.dumps(self.hostnames))
        if self.sql:
            trip_id = "trip_" + secrets.token_hex(16)
            self.sql.run(
                """INSERT INTO control_plane.trips(id, slug, lifecycle_state, current_release_id)
                   VALUES (:'id', :'slug', :'state', NULLIF(:'cur', ''))""",
                id=trip_id, slug=slug, state=state, cur={"r1": self.r1, "r2": self.r2, None: ""}[current])
            if schema is not None:
                self.sql.run(
                    """INSERT INTO control_plane.intake_versions(id, trip_id, version, artifact_ref, digest, confirmed_at, schema_version, data)
                       VALUES (:'id', :'trip', 1, 'intake:fixture', :'digest', now(), :'schema', '{}'::jsonb)""",
                    id="intk_" + secrets.token_hex(8), trip=trip_id, digest="sha256:" + secrets.token_hex(32), schema=str(schema))
        else:
            trip_id = ""
        self.trips[slug] = {"id": trip_id, "dir": tdir, "vmid": vmid, "port": 3000 + vmid}
        if companion:
            assert self.sql, "a companion trip needs the database"
            self.sql.run(
                """WITH p AS (INSERT INTO control_plane.plans(id, trip_id, release_id, kind, digest, status, desired)
                              VALUES ('plan_' || :'n', :'trip', :'rel', 'provision', 'sha256:' || :'dig', 'executed', '{}'::jsonb)
                              RETURNING id)
                   INSERT INTO control_plane.jobs(id, trip_id, plan_id, job_type, idempotency_key, correlation_id, state, result)
                   SELECT 'job_' || :'n', :'trip', id, 'provision', 'idem-' || :'n', 'corr_' || :'n', 'succeeded',
                          json_build_object('private_url', :'url')::jsonb FROM p""",
                n=secrets.token_hex(6), trip=trip_id, rel=self.r1, dig=secrets.token_hex(32), url=f"http://{slug}.example.invalid")

            def handoff(slug=slug):
                row = self.sql.rows(rt.HANDOFF_SQL, slug=slug)[0]
                return rt.load_companion_profile().build_companion_handoff(
                    trip_id=row["trip_id"], slug=slug, config=json.loads((self.trips[slug]["dir"] / "trip.config.json").read_text()),
                    intake_version_id=row["intake_version_id"], intake_schema_version=row["schema_version"],
                    intake_digest=row["digest"], confirmed_at=row["confirmed_at"], canonical_site_url=row["private_url"])
            self.trips[slug]["handoff"] = handoff
            self.trips[slug]["profile"] = handoff()["profile"]["name"]
            self.install_companion(slug)
        return slug

    @staticmethod
    def _free_vmid() -> int:
        for _ in range(200):
            vmid = 100 + secrets.randbelow(800)
            with socket.socket() as s:
                try:
                    s.bind(("127.0.0.1", 3000 + vmid))
                except OSError:
                    continue
            return vmid
        raise RuntimeError("no free bridge port")

    # -- running the command

    def env(self, **overrides: str) -> dict[str, str]:
        base = {
            "PATH": os.environ.get("PATH", "/usr/bin:/bin"),
            "HOME": os.environ.get("HOME", str(self.dir)),   # docker finds its socket through it
            **{k: os.environ[k] for k in ("DOCKER_HOST", "DOCKER_CONTEXT", "DOCKER_CONFIG") if k in os.environ},
            "KINERARY_DEPLOY_ROOT": str(self.root),
            "KINERARY_TRIP_DEPLOY_CMD": shlex.join([PYTHON, str(self.dir / "deploy.py")]),
            "KINERARY_BRIDGE_RESTART_CMD": shlex.join([PYTHON, str(self.dir / "bridge.py")]),
            "KINERARY_CONTAINER_HOSTNAME_CMD": shlex.join([PYTHON, str(self.dir / "hostname.py")]),
            "KINERARY_ROLLOUT_PSQL_CMD": shlex.join(self.psql[0]) if self.psql else "false",
            "KINERARY_ROLLOUT_REPO_ROOT": str(self.repo),
            "KINERARY_ROLLOUT_CHILD_ENV": "FAKE_DIR,RIG_HERMES_HOME,RIG_FAKE_BIN,RIG_REPO",
            "FAKE_DIR": str(self.fake),
            "RIG_HERMES_HOME": str(self.hermes_home),
            "RIG_FAKE_BIN": str(self.fake_bin),
            "RIG_REPO": str(ROOT),
            "KINERARY_COMPANION_INSTALL_CMD": shlex.join([PYTHON, str(self.dir / "companion_wrapper.py"), "install"]),
            "KINERARY_COMPANION_REFRESH_CMD": shlex.join([PYTHON, str(self.dir / "companion_wrapper.py"), "refresh"]),
            "KINERARY_ROLLOUT_TURN_WAIT_SECONDS": "3",
            "KINERARY_ROLLOUT_REGISTRATION_WAIT_SECONDS": "3",
            "KINERARY_ROLLOUT_SITE_WAIT_SECONDS": "2",
            "KINERARY_ROLLOUT_BRIDGE_WAIT_SECONDS": "1",
            CANARY: "must-not-reach-a-child",
        }
        if self.psql:
            base.update(self.psql[1])
        base.update(overrides)
        return {k: v for k, v in base.items() if v is not None}

    def run(self, argv: list[str], env: dict[str, str] | None = None) -> tuple[int, str, str]:
        out, err = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            code = rt.main(argv, env if env is not None else self.env())
        return code, out.getvalue(), err.getvalue()

    def plan(self, release: str, slugs: list[str], steps: str | None = None, name: str = "plan.json"):
        path = self.dir / name
        argv = ["plan", "--release", release, "--trip", ",".join(slugs), "--plan-file", str(path)]
        if steps:
            argv += ["--steps", steps]
        code, out, err = self.run(argv)
        digest = (re.search(r"^digest\s+(sha256:[a-f0-9]{64})$", out, re.M) or [None, None])[1]
        return code, out, err, path, digest

    def execute(self, path: Path, digest: str | None, *extra: str):
        argv = ["execute", "--plan-file", str(path)]
        if digest:
            argv += ["--plan-digest", digest]
        return self.run(argv + list(extra))

    def log(self, name: str) -> list[dict]:
        p = self.fake / name
        return [json.loads(line) for line in p.read_text().splitlines()] if p.exists() else []

    def trip_state(self, slug: str) -> dict:
        return self.sql.rows(
            """SELECT row_to_json(x) FROM (SELECT lifecycle_state, current_release_id, previous_release_id
                 FROM control_plane.trips WHERE slug = :'slug') x""", slug=slug)[0]

    def rollouts(self, slug: str) -> list[dict]:
        return self.sql.rows(
            """SELECT row_to_json(x) FROM (SELECT r.id, r.result, r.failed_step, r.from_release_id, r.to_release_id,
                    r.steps, r.plan_digest, r.actor, r.finished_at IS NOT NULL AS finished
                 FROM control_plane.trip_rollouts r JOIN control_plane.trips t ON t.id = r.trip_id
                WHERE t.slug = :'slug' ORDER BY r.started_at) x""", slug=slug)

    def counts(self) -> dict:
        return json.loads(self.sql.run(
            """SELECT json_build_object(
                 'approvals', (SELECT count(*) FROM control_plane.plan_approvals),
                 'notifications', (SELECT count(*) FROM control_plane.notification_outbox),
                 'plans', (SELECT count(*) FROM control_plane.plans),
                 'jobs', (SELECT count(*) FROM control_plane.jobs),
                 'rollouts', (SELECT count(*) FROM control_plane.trip_rollouts))"""))

    def trip_files(self, slug: str) -> dict[str, str | None]:
        d = self.trips[slug]["dir"]
        return {n: sha(d / n) for n in ("trip.config.json", "data.sqlite")}

    def close(self) -> None:
        for s in self.servers:
            s.shutdown()
            s.server_close()
        for d in self.addCleanup_dirs:
            shutil.rmtree(d, ignore_errors=True)
        shutil.rmtree(self.dir, ignore_errors=True)


# ── no database needed ───────────────────────────────────────────────────────────────────────────────

class Configuration(unittest.TestCase):
    """AC-9. The script names no host, address, container or path: unset means refused, and the refusal says which."""

    def setUp(self):
        self.rig = Rig(None, None)
        self.addCleanup(self.rig.close)

    def refused_without(self, name: str):
        env = self.rig.env()
        del env[name]
        plan = self.rig.dir / "p.json"
        return self.rig.run(["plan", "--release", "x", "--trip", "ro-a", "--plan-file", str(plan)], env)

    def test_each_deployment_value_is_refused_by_name_when_unset(self):
        for name in ("KINERARY_DEPLOY_ROOT", "KINERARY_TRIP_DEPLOY_CMD", "KINERARY_BRIDGE_RESTART_CMD",
                     "KINERARY_CONTAINER_HOSTNAME_CMD", "KINERARY_ROLLOUT_PSQL_CMD"):
            with self.subTest(name):
                code, out, err = self.refused_without(name)
                self.assertEqual(2, code)
                self.assertIn(name, err)
                self.assertEqual("", out)

    def test_an_empty_environment_names_every_missing_value_at_once_and_defaults_none(self):
        plan = self.rig.dir / "p.json"
        code, out, err = self.rig.run(["execute", "--plan-file", str(plan), "--plan-digest", "sha256:" + "0" * 64], {"PATH": os.environ["PATH"]})
        self.assertEqual(2, code)
        for name in ("KINERARY_DEPLOY_ROOT", "KINERARY_TRIP_DEPLOY_CMD", "KINERARY_BRIDGE_RESTART_CMD",
                     "KINERARY_CONTAINER_HOSTNAME_CMD", "KINERARY_ROLLOUT_PSQL_CMD"):
            self.assertIn(name, err)
        self.assertFalse(plan.exists(), "a refusal writes nothing")

    def test_the_command_line_entry_point_refuses_the_same_way(self):
        out = subprocess.run([PYTHON, str(SCRIPT), "status"], capture_output=True, text=True,
                             env={"PATH": os.environ["PATH"]}, timeout=60)
        self.assertEqual(2, out.returncode)
        self.assertIn("KINERARY_ROLLOUT_PSQL_CMD", out.stderr)

    def test_a_deploy_command_that_carries_the_config_overwriting_flag_is_refused(self):
        env = self.rig.env(KINERARY_TRIP_DEPLOY_CMD=f"{PYTHON} {self.rig.dir / 'deploy.py'} --sync-config")
        code, _, err = self.rig.run(["plan", "--release", "x", "--trip", "ro-a", "--plan-file", str(self.rig.dir / "p.json")], env)
        self.assertEqual(2, code)
        self.assertIn("--sync-config", err)

    def test_a_deployment_root_that_is_not_a_directory_is_refused(self):
        env = self.rig.env(KINERARY_DEPLOY_ROOT=str(self.rig.dir / "nope"))
        code, _, err = self.rig.run(["plan", "--release", "x", "--trip", "ro-a", "--plan-file", str(self.rig.dir / "p.json")], env)
        self.assertEqual(2, code)
        self.assertIn("KINERARY_DEPLOY_ROOT", err)

    def test_the_script_source_names_no_deployment(self):
        text = SCRIPT.read_text()
        pattern = re.compile(r"/opt/(kinerary|kinerary-deploy|hermes-data|hermes-src|agent-auth)|kinerary-cp-[a-z]+-[0-9]|id_ed25519_[a-z]"
                             r"|debian@|192\.168\.[0-9]|172\.(1[6-9]|2[0-9]|3[01])\.[0-9]|kinerary-deploy")
        self.assertEqual([], pattern.findall(text))


class ThePlanFileIsTheApproval(unittest.TestCase):
    """AC-11, and the slice's refusals that need no database."""

    def setUp(self):
        self.rig = Rig(None, None)
        self.addCleanup(self.rig.close)
        self.good = {
            "format": rt.PLAN_FORMAT, "created_at": "2026-11-14T00:00:00Z",
            "release": {"id": "rls_abcdefgh", "source_revision": "a" * 40, "artifact_digest": "sha256:" + "b" * 64, "status": "available"},
            "steps": ["site", "bridge"],
            "trips": [{"slug": "ro-a", "trip_id": "trip_x", "from_release_id": None}],
            "refused": [], "notes": [],
        }

    def write(self, doc=None, raw: bytes | None = None) -> tuple[Path, str]:
        path = self.rig.dir / "plan.json"
        data = raw if raw is not None else (json.dumps(doc if doc is not None else self.good, indent=2, sort_keys=True) + "\n").encode()
        path.write_bytes(data)
        return path, "sha256:" + hashlib.sha256(data).hexdigest()

    def test_a_missing_plan_file_is_refused(self):
        code, _, err = self.rig.execute(self.rig.dir / "absent.json", "sha256:" + "0" * 64)
        self.assertEqual(2, code)
        self.assertIn("cannot be read", err)

    def test_an_unreadable_plan_file_is_refused(self):
        path, digest = self.write()
        os.chmod(path, 0)
        self.addCleanup(os.chmod, path, 0o600)
        if os.access(path, os.R_OK):
            self.skipTest("this user reads files regardless of mode")
        code, _, err = self.rig.execute(path, digest)
        self.assertEqual(2, code)
        self.assertIn("cannot be read", err)

    def test_a_plan_file_changed_since_plan_wrote_it_is_refused_whatever_the_edit(self):
        path, digest = self.write()
        for edit in (lambda d: d["trips"].append({"slug": "ro-b", "trip_id": "t", "from_release_id": None}),
                     lambda d: d["release"].update(source_revision="c" * 40),
                     lambda d: d.update(steps=["site"])):
            doc = json.loads(path.read_text())
            edit(doc)
            path.write_text(json.dumps(doc, indent=2, sort_keys=True) + "\n")
            code, _, err = self.rig.execute(path, digest)
            self.assertEqual(2, code)
            self.assertIn("changed since `plan` wrote it", err)
        # Even whitespace is a different file: the digest is over the bytes.
        path, digest = self.write()
        path.write_bytes(path.read_bytes() + b" ")
        self.assertEqual(2, self.rig.execute(path, digest)[0])

    def test_execute_without_the_digest_is_refused(self):
        path, _ = self.write()
        code, _, err = self.rig.execute(path, None)
        self.assertEqual(2, code)
        self.assertIn("--plan-digest is required", err)

    def test_a_malformed_digest_is_refused(self):
        path, _ = self.write()
        self.assertEqual(2, self.rig.execute(path, "sha256:abc")[0])

    def test_a_plan_that_is_not_a_rollout_plan_is_refused_even_with_the_right_digest(self):
        cases = {
            "not json": dict(raw=b"{nope"),
            "another format": dict(doc={**self.good, "format": "something/9"}),
            "no trips": dict(doc={**self.good, "trips": []}),
            "a path in a slug": dict(doc={**self.good, "trips": [{"slug": "../x", "trip_id": "t", "from_release_id": None}]}),
            "a step nobody built": dict(doc={**self.good, "steps": ["site", "rm"]}),
            "a bad commit": dict(doc={**self.good, "release": {**self.good["release"], "source_revision": "HEAD"}}),
            "the same trip twice": dict(doc={**self.good, "trips": self.good["trips"] * 2}),
            "a withdrawn target that is not the trip's previous release": dict(doc={**self.good, "trips": [
                {"slug": "ro-a", "trip_id": "trip_x", "from_release_id": None, "previous_release_id": "rls_other001", "target_status": "deprecated"}]}),
            "a withdrawn target of a status a rollback does not accept": dict(doc={**self.good, "trips": [
                {"slug": "ro-a", "trip_id": "trip_x", "from_release_id": None, "previous_release_id": "rls_abcdefgh", "target_status": "retired"}]}),
            "an overwrite permission that is a word": dict(doc={**self.good, "steps": ["site", "bridge", "companion"], "trips": [
                {"slug": "ro-a", "trip_id": "trip_x", "from_release_id": None, "overwrite_edited_companion": "yes"}]}),
            "an overwrite permission for a step the plan does not run": dict(doc={**self.good, "trips": [
                {"slug": "ro-a", "trip_id": "trip_x", "from_release_id": None, "overwrite_edited_companion": True}]}),
            "a malformed previous release": dict(doc={**self.good, "trips": [
                {"slug": "ro-a", "trip_id": "trip_x", "from_release_id": None, "previous_release_id": "a b"}]}),
        }
        for name, kwargs in cases.items():
            with self.subTest(name):
                path, digest = self.write(**kwargs)
                code, _, err = self.rig.execute(path, digest)
                self.assertEqual(2, code)
                self.assertRegex(err, "not valid JSON|is not a rollout plan")

    def test_a_step_that_is_not_built_in_this_slice_is_refused_with_the_reason(self):
        code, _, err = self.rig.run(["plan", "--release", "x", "--trip", "ro-a", "--steps", "switches",
                                     "--plan-file", str(self.rig.dir / "p.json")])
        self.assertEqual(2, code)
        self.assertIn("not in this slice", err)

    def test_the_companion_step_is_built_and_asks_for_the_deployments_commands_by_name_when_they_are_unset(self):
        for name in ("KINERARY_COMPANION_INSTALL_CMD", "KINERARY_COMPANION_REFRESH_CMD"):
            with self.subTest(name):
                env = self.rig.env()
                del env[name]
                code, out, err = self.rig.run(["plan", "--release", "x", "--trip", "ro-a", "--steps", "site,bridge,companion",
                                               "--plan-file", str(self.rig.dir / "p.json")], env)
                self.assertEqual(2, code)
                self.assertIn(name, err)
                self.assertNotIn("not in this slice", err)
                self.assertFalse((self.rig.dir / "p.json").exists())

    def test_without_the_companion_step_the_companion_commands_are_not_needed(self):
        # The default steps are site,bridge: a deployment configured for R1 is not broken by R2.
        env = self.rig.env()
        del env["KINERARY_COMPANION_INSTALL_CMD"], env["KINERARY_COMPANION_REFRESH_CMD"]
        code, _, err = self.rig.run(["plan", "--release", "x", "--trip", "ro-a", "--plan-file", str(self.rig.dir / "p.json")], env)
        self.assertNotEqual(0, code)
        self.assertNotIn("KINERARY_COMPANION", err, "it got as far as the database, which is not there")
        self.assertEqual(("site", "bridge"), rt.DEFAULT_STEPS)
        self.assertEqual(("site", "bridge", "companion"), rt.BUILT_STEPS, "R2 builds the third step; switches is #567 S2")

    def test_all_is_not_in_this_slice(self):
        code, _, err = self.rig.run(["plan", "--release", "x", "--all", "--plan-file", str(self.rig.dir / "p.json")])
        self.assertEqual(2, code)
        self.assertIn("not in this slice", err)

    def test_a_plan_naming_a_step_the_approval_does_not_cover_is_refused_at_execute(self):
        path, digest = self.write()
        code, _, err = self.rig.execute(path, digest, "--steps", "companion")
        self.assertEqual(2, code)
        self.assertIn("step companion is not in the plan", err)


class Pieces(unittest.TestCase):
    def test_topology_is_read_without_yaml_from_the_shape_compute_py_writes(self):
        topo = rt.parse_topology("# c\nversion: 1\nname: t\nproxmox:\n  node: n\n  vmid: '123'\n  lxc:\n    name: trip-t\n"
                                 "    ipv4: 127.0.0.1/24\nnpm:\n  forward_port: 8080\n")
        self.assertEqual("123", topo["proxmox"]["vmid"])
        self.assertEqual("trip-t", topo["proxmox"]["lxc"]["name"])
        self.assertEqual("8080", topo["npm"]["forward_port"])

    def test_scrub_removes_control_characters_and_secret_assignments_and_keeps_only_the_tail(self):
        text = "\n".join(f"line {i}" for i in range(40)) + "\nPASSWORD=hunter2 and token: abc\x1b[31m red\n"
        shown = rt.scrub(text)
        self.assertNotIn("hunter2", shown)
        self.assertNotIn("abc", shown)
        self.assertNotIn("\x1b", shown)
        self.assertNotIn("line 3\n", shown)
        self.assertIn("line 39", shown)

    def test_the_child_environment_is_an_allow_list(self):
        cfg = rt.load_config({"KINERARY_DEPLOY_ROOT": tempfile.gettempdir(), "KINERARY_TRIP_DEPLOY_CMD": "a",
                              "KINERARY_BRIDGE_RESTART_CMD": "b", "KINERARY_CONTAINER_HOSTNAME_CMD": "c",
                              "KINERARY_ROLLOUT_PSQL_CMD": "d", "PATH": "/bin", "HOME": "/h", CANARY: "x",
                              "ANTHROPIC_API_KEY": "k", "KINERARY_ROLLOUT_CHILD_ENV": "WANTED", "WANTED": "w"})
        env = cfg.child_env({"REPO_ROOT": "/tree"})
        self.assertEqual({"PATH", "HOME", "KINERARY_DEPLOY_ROOT", "WANTED", "REPO_ROOT"}, set(env))
        self.assertNotIn("PGPASSWORD", env)


# ── against a database ───────────────────────────────────────────────────────────────────────────────

URL = database_url()
PSQL = psql_command(URL) if URL else None
SKIP_DB = None if PSQL else "CONTROL_PLANE_TEST_DATABASE_URL is unset, or there is neither psql nor a container publishing its port"


@unittest.skipIf(SKIP_DB, SKIP_DB or "")
class DatabaseCase(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.sql = Sql(*PSQL)
        # Each file in its own transaction, as applyMigrations runs it (some use ON COMMIT DROP temp tables).
        migrations = "\n".join(f"BEGIN;\n{p.read_text(encoding='utf-8')}\nCOMMIT;" for p in sorted(MIGRATIONS.glob("*.sql")))
        cls.sql.run("DROP SCHEMA IF EXISTS control_plane CASCADE; DROP TABLE IF EXISTS public.control_plane_schema_migrations;\n"
                    "CREATE TABLE public.control_plane_schema_migrations (version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now());\n"
                    + migrations)

    @classmethod
    def tearDownClass(cls):
        cls.sql.run("DROP SCHEMA IF EXISTS control_plane CASCADE; DROP TABLE IF EXISTS public.control_plane_schema_migrations;")

    def setUp(self):
        self.rig = Rig(self.sql, PSQL)
        self.addCleanup(self.rig.close)

    def planned(self, slugs, release=None, steps=None):
        code, out, err, path, digest = self.rig.plan(release or self.rig.r2, slugs, steps)
        self.assertEqual(0, code, out + err)
        return path, digest

    def assertRolloutRows(self, slug, *results):
        self.assertEqual(list(results), [r["result"] for r in self.rig.rollouts(slug)])


class PlanChangesNothing(DatabaseCase):
    def test_ac1_plan_shows_current_target_commit_and_ordered_steps_and_writes_the_same(self):
        slug = self.rig.trip("a")
        before = (self.rig.counts(), self.rig.trip_state(slug), self.rig.trip_files(slug))
        code, out, err, path, digest = self.rig.plan(self.rig.r2, [slug])
        self.assertEqual(0, code, err)
        self.assertIn(self.rig.r1, out)                       # what it runs now
        self.assertIn(self.rig.r2, out)                       # the target
        self.assertIn(self.rig.rev2, out)                     # its commit
        self.assertRegex(out, r"steps\s+site, bridge")        # the order
        doc = json.loads(path.read_text())
        self.assertEqual(self.rig.rev2, doc["release"]["source_revision"])
        self.assertEqual(["site", "bridge"], doc["steps"])
        self.assertEqual([{"slug": slug, "trip_id": self.rig.trips[slug]["id"], "from_release_id": self.rig.r1,
                           "previous_release_id": None}], doc["trips"])
        self.assertEqual(digest, "sha256:" + hashlib.sha256(path.read_bytes()).hexdigest(), "the digest printed is the file's")
        # Nothing changed: not the database, not a trip's files, and no deployment command ran.
        self.assertEqual(before, (self.rig.counts(), self.rig.trip_state(slug), self.rig.trip_files(slug)))
        self.assertEqual([], self.rig.log("deploy.log"))
        self.assertEqual([], self.rig.log("bridge.log"))

    def test_ac1_a_release_may_be_named_by_commit(self):
        slug = self.rig.trip("a")
        code, out, err, path, _ = self.rig.plan(self.rig.rev2, [slug])
        self.assertEqual(0, code, err)
        self.assertEqual(self.rig.r2, json.loads(path.read_text())["release"]["id"])

    def test_ac1_a_trip_with_no_recorded_release_is_unknown_and_the_plan_says_no_way_back(self):
        slug = self.rig.trip("a", current=None)
        code, out, err, path, _ = self.rig.plan(self.rig.r2, [slug])
        self.assertEqual(0, code, err)
        self.assertIn("unknown", out)
        self.assertIn("no way back is recorded", out)
        self.assertIsNone(json.loads(path.read_text())["trips"][0]["from_release_id"])

    def provisioned(self, slug: str, release: str, days_ago: int = 0, state: str = "succeeded", plan_status: str = "executed") -> None:
        """A provision of `slug` onto `release`, as the worker leaves one: an executed plan and a job."""
        n = secrets.token_hex(6)
        self.rig.sql.run(
            """WITH p AS (INSERT INTO control_plane.plans(id, trip_id, release_id, kind, digest, status, desired, created_at)
                          SELECT 'plan_' || :'n', id, :'rel', 'provision', 'sha256:' || :'dig', :'pstatus', '{}'::jsonb,
                                 now() - (:'days' || ' days')::interval
                            FROM control_plane.trips WHERE slug = :'slug' RETURNING id, trip_id)
               INSERT INTO control_plane.jobs(id, trip_id, plan_id, job_type, idempotency_key, correlation_id, state, safe_error_code, updated_at)
               SELECT 'job_' || :'n', trip_id, id, 'provision', 'idem-' || :'n', 'corr_' || :'n', :'jstate',
                      CASE WHEN :'jstate' = 'failed' THEN 'FAKE_FAILURE' END, now() - (:'days' || ' days')::interval FROM p""",
            n=n, rel=release, dig=(n * 6)[:64].ljust(64, "0"), pstatus=plan_status, days=str(days_ago), slug=slug, jstate=state)

    def test_a_record_that_disagrees_with_the_latest_provision_is_warned_about_in_the_output_and_the_plan_file(self):
        # Review round 1: a control-plane rollback followed by a re-provision leaves the record stale, and the
        # migration's backfill does not run again. A warning, never a refusal.
        slug = self.rig.trip("a")                       # the record says r1
        self.provisioned(slug, self.rig.r2)             # the trip was last provisioned onto r2
        code, out, err, path, _ = self.rig.plan(self.rig.r2, [slug])
        self.assertEqual(0, code, out + err)
        self.assertRegex(out, rf"WARNING  {slug}: .*{self.rig.r1}.*{self.rig.r2}")
        doc = json.loads(path.read_text())
        self.assertEqual([slug], [t["slug"] for t in doc["trips"]], "it is still planned")
        self.assertEqual([slug], [w["slug"] for w in doc["warnings"]])
        self.assertIn(self.rig.r1, doc["warnings"][0]["warning"])
        self.assertIn(self.rig.r2, doc["warnings"][0]["warning"])
        self.assertEqual([], doc["refused"])

    def test_no_warning_when_the_record_agrees_or_the_provision_did_not_succeed_or_a_rollout_came_after(self):
        agree = self.rig.trip("agree")
        self.provisioned(agree, self.rig.r1)
        failed = self.rig.trip("failed")
        self.provisioned(failed, self.rig.r2, state="failed")
        unexecuted = self.rig.trip("unexec")
        self.provisioned(unexecuted, self.rig.r2, plan_status="approved")
        never = self.rig.trip("never")                  # no provision on record at all
        # A trip provisioned onto r1 three days ago and rolled out to r2 since: current r2 differs from its
        # provision's r1 on purpose, and is not stale.
        rolled = self.rig.trip("rolled")
        self.provisioned(rolled, self.rig.r1, days_ago=3)
        plan_path, plan_digest = self.planned([rolled], release=self.rig.r2)
        self.assertEqual(0, self.rig.execute(plan_path, plan_digest)[0])
        self.assertEqual(self.rig.r2, self.rig.trip_state(rolled)["current_release_id"])
        for name, slug in (("agree", agree), ("failed", failed), ("unexec", unexecuted), ("never", never), ("rolled", rolled)):
            with self.subTest(name):
                # (planned onto the release it does not run, so the plan has something to say)
                target = self.rig.r1 if name == "rolled" else self.rig.r2
                code, out, err, path, _ = self.rig.plan(target, [slug], name=f"w-{name}.json")
                self.assertEqual(0, code, out + err)
                self.assertNotIn("WARNING", out)
                self.assertEqual([], json.loads(path.read_text())["warnings"])

    def test_status_reports_the_record_and_changes_nothing(self):
        slug = self.rig.trip("a")
        before = self.rig.counts()
        code, out, err = self.rig.run(["status", "--trip", slug], {"KINERARY_ROLLOUT_PSQL_CMD": shlex.join(PSQL[0]), **PSQL[1],
                                                                   "PATH": os.environ["PATH"]})
        self.assertEqual(0, code, err)
        self.assertIn(self.rig.r1, out)
        self.assertIn("no rollout yet", out)
        self.assertEqual(before, self.rig.counts())


class Ac2Refusals(DatabaseCase):
    def refused(self, release_id):
        slug = self.rig.trip(f"t{len(self.rig.trips)}")
        code, out, err, path, _ = self.rig.plan(release_id, [slug], name=f"plan-{slug}.json")
        self.assertEqual(1, code)
        doc = json.loads(path.read_text())
        self.assertEqual([], doc["trips"])
        self.assertEqual(slug, doc["refused"][0]["slug"])
        return out, doc["refused"][0]["reason"]

    def test_a_release_that_is_not_available_is_refused_with_its_status(self):
        for status in ("candidate", "deprecated"):
            with self.subTest(status):
                rid = f"rls_{self.rig.tag}{status[:4]}"
                self.rig.release(rid, self.rig.rev2, "sha256:" + secrets.token_hex(32), status=status)
                out, reason = self.refused(rid)
                self.assertIn(status, reason)
                self.assertIn("not available", reason)

    def test_a_release_whose_data_schema_range_misses_the_trip_is_refused_with_both_numbers(self):
        rid = f"rls_{self.rig.tag}wide"
        self.rig.release(rid, self.rig.rev2, "sha256:" + secrets.token_hex(32), lo=2, hi=3)
        out, reason = self.refused(rid)
        self.assertIn("data schema 1", reason)
        self.assertIn("2..3", reason)

    def test_a_release_with_no_sealed_manifest_cannot_be_verified_and_is_refused(self):
        rid = f"rls_{self.rig.tag}bare"
        self.rig.release(rid, self.rig.rev2, "sha256:" + secrets.token_hex(32), manifest=False)
        self.assertIn("no sealed manifest", self.refused(rid)[1])

    def test_a_release_commit_that_this_checkout_does_not_hold_is_refused(self):
        rid = f"rls_{self.rig.tag}gone"
        self.rig.release(rid, "e" * 40, "sha256:" + secrets.token_hex(32))
        self.assertIn("not in this checkout", self.refused(rid)[1])

    def test_an_unknown_release_is_an_error_not_a_plan(self):
        slug = self.rig.trip("a")
        code, _, err, path, _ = self.rig.plan("rls_nosuchrelease", [slug])
        self.assertEqual(2, code)
        self.assertIn("no release", err)
        self.assertFalse(path.exists())

    def test_a_trip_that_has_no_running_site_or_is_gone_is_refused(self):
        for name, state in (("draft", "draft"), ("prov", "provisioning"), ("sealed", "sealed")):
            slug = self.rig.trip(name, state=state)
            code, out, err, path, _ = self.rig.plan(self.rig.r2, [slug])
            self.assertEqual(1, code, state)
            self.assertIn(state, json.loads(path.read_text())["refused"][0]["reason"])

    def test_active_trips_can_be_planned_and_so_can_the_others_in_the_same_plan(self):
        ok = self.rig.trip("ok")
        bad = self.rig.trip("bad", state="draft")
        code, out, _, path, _ = self.rig.plan(self.rig.r2, [ok, bad])
        self.assertEqual(1, code)
        doc = json.loads(path.read_text())
        self.assertEqual([ok], [t["slug"] for t in doc["trips"]])
        self.assertEqual([bad], [r["slug"] for r in doc["refused"]])

    def test_a_vmid_that_is_now_another_container_is_refused(self):
        slug = self.rig.trip("a")
        self.rig.hostnames[str(self.rig.trips[slug]["vmid"])] = "trip-someone-else"
        (self.rig.fake / "hostnames.json").write_text(json.dumps(self.rig.hostnames))
        code, out, _, path, _ = self.rig.plan(self.rig.r2, [slug])
        self.assertEqual(1, code)
        self.assertIn("not the one its topology names", json.loads(path.read_text())["refused"][0]["reason"])


class Execute(DatabaseCase):
    def test_a_complete_rollout_runs_site_then_bridge_from_the_releases_own_tree_and_records_it(self):
        slug = self.rig.trip("a")
        path, digest = self.planned([slug])
        before_files = self.rig.trip_files(slug)
        code, out, err = self.rig.execute(path, digest)
        self.assertEqual(0, code, out + err)
        deploys = self.rig.log("deploy.log")
        self.assertEqual(1, len(deploys))
        d = deploys[0]
        self.assertEqual([slug, str(self.rig.trips[slug]["vmid"]), "--restart", "--trip-dir", str(self.rig.trips[slug]["dir"])], d["argv"])
        self.assertEqual("v2", d["app_js"], "REPO_ROOT is the materialized release at the plan's commit, not a checkout")
        self.assertNotIn("--sync-config", d["argv"])
        bridges = self.rig.log("bridge.log")
        self.assertEqual(1, len(bridges))
        self.assertEqual(["--restart-only", "--trip-dir", str(self.rig.trips[slug]["dir"])], bridges[0]["argv"])
        # Site before bridge.
        self.assertLess(out.index("site ok"), out.index("bridge ok"))
        # AC-4/5: the row, and the record.
        rows = self.rig.rollouts(slug)
        self.assertEqual(1, len(rows))
        self.assertEqual("ok", rows[0]["result"])
        self.assertIsNone(rows[0]["failed_step"])
        self.assertTrue(rows[0]["finished"])
        self.assertEqual((self.rig.r1, self.rig.r2), (rows[0]["from_release_id"], rows[0]["to_release_id"]))
        self.assertEqual(["site", "bridge"], rows[0]["steps"])
        self.assertEqual(digest, rows[0]["plan_digest"])
        state = self.rig.trip_state(slug)
        self.assertEqual((self.rig.r2, self.rig.r1), (state["current_release_id"], state["previous_release_id"]))
        # AC-6 through the whole run.
        self.assertEqual(before_files, self.rig.trip_files(slug))
        # No temp tree is left behind.
        self.assertFalse(os.path.exists(d["repo_root"]))

    def test_ac4_the_running_row_exists_before_the_first_step_acts(self):
        slug = self.rig.trip("a")
        path, digest = self.planned([slug])
        (self.rig.fake / "block-deploy").write_text("")
        proc = subprocess.Popen([PYTHON, str(SCRIPT), "execute", "--plan-file", str(path), "--plan-digest", digest],
                                env=self.rig.env(), stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        try:
            deadline = time.time() + 60
            while not (self.rig.fake / "deploy-started").exists():
                if proc.poll() is not None:
                    self.fail("the command ended before the deploy started: " + proc.communicate()[1])
                self.assertLess(time.time(), deadline, "the deploy never started")
                time.sleep(0.05)
            # The deploy command is running right now. The row says so, and nothing has moved yet.
            rows = self.rig.rollouts(slug)
            self.assertEqual(["running"], [r["result"] for r in rows])
            self.assertFalse(rows[0]["finished"])
            self.assertEqual(self.rig.r1, self.rig.trip_state(slug)["current_release_id"])
            (self.rig.fake / "go").write_text("")
            try:
                out, err = proc.communicate(timeout=60)
            except subprocess.TimeoutExpired:
                proc.kill()
                out, err = proc.communicate()
                self.fail(f"the command did not finish after the deploy was released:\n{out}\n{err}")
        finally:
            if proc.poll() is None:
                proc.kill()
        self.assertEqual(0, proc.returncode, out + err)
        self.assertRolloutRows(slug, "ok")

    def test_ac4_a_failed_step_closes_the_row_failed_with_its_name_and_later_steps_do_not_run(self):
        slug = self.rig.trip("a")
        path, digest = self.planned([slug])
        (self.rig.fake / f"fail-deploy-{slug}").write_text("")
        code, out, err = self.rig.execute(path, digest)
        self.assertEqual(1, code)
        self.assertIn("FAILED at step site", out)
        self.assertEqual([], self.rig.log("bridge.log"), "the bridge step did not run")
        rows = self.rig.rollouts(slug)
        self.assertEqual(("failed", "site"), (rows[0]["result"], rows[0]["failed_step"]))
        self.assertTrue(rows[0]["finished"])
        # AC-5: a failed site step moved neither column.
        state = self.rig.trip_state(slug)
        self.assertEqual((self.rig.r1, None), (state["current_release_id"], state["previous_release_id"]))
        # What the failing command printed is shown scrubbed and is never stored.
        self.assertNotIn(SECRET_IN_OUTPUT, out + err)
        self.assertIn("redacted", out)
        self.assertNotIn(SECRET_IN_OUTPUT, json.dumps(rows))

    def test_ac5_a_failed_bridge_step_leaves_the_site_recorded_as_what_it_runs_and_the_row_failed_at_bridge(self):
        slug = self.rig.trip("a", bridge="timeout")
        path, digest = self.planned([slug])
        code, out, _ = self.rig.execute(path, digest)
        self.assertEqual(1, code)
        rows = self.rig.rollouts(slug)
        self.assertEqual(("failed", "bridge"), (rows[0]["result"], rows[0]["failed_step"]))
        state = self.rig.trip_state(slug)
        self.assertEqual((self.rig.r2, self.rig.r1), (state["current_release_id"], state["previous_release_id"]),
                         "the site step succeeded: the site does run the target")

    def test_ac3_a_trip_that_no_longer_runs_what_the_plan_recorded_is_refused_and_no_step_runs(self):
        slug = self.rig.trip("a")
        path, digest = self.planned([slug])
        self.rig.sql.run("UPDATE control_plane.trips SET current_release_id = :'r' WHERE slug = :'slug'",
                         r=self.rig.r2, slug=slug)
        code, out, err = self.rig.execute(path, digest)
        self.assertEqual(1, code)
        self.assertIn("REFUSED", out)
        self.assertIn("the plan recorded", out)
        self.assertEqual([], self.rig.log("deploy.log"))
        self.assertEqual([], self.rig.log("bridge.log"))
        self.assertEqual([], self.rig.rollouts(slug), "nothing ran, so there is no rollout to record")

    def test_ac3_a_trip_whose_release_was_unknown_at_plan_and_is_known_now_is_refused_too(self):
        slug = self.rig.trip("a", current=None)
        path, digest = self.planned([slug])
        self.rig.sql.run("UPDATE control_plane.trips SET current_release_id = :'r' WHERE slug = :'slug'", r=self.rig.r1, slug=slug)
        code, out, _ = self.rig.execute(path, digest)
        self.assertEqual(1, code)
        self.assertIn("recorded unknown", out)
        self.assertEqual([], self.rig.log("deploy.log"))

    def test_a_trip_with_no_recorded_release_rolls_out_and_has_no_previous(self):
        slug = self.rig.trip("a", current=None)
        path, digest = self.planned([slug])
        code, out, err = self.rig.execute(path, digest)
        self.assertEqual(0, code, out + err)
        state = self.rig.trip_state(slug)
        self.assertEqual((self.rig.r2, None), (state["current_release_id"], state["previous_release_id"]))

    def test_ac7_no_approval_no_notification_no_lifecycle_change_and_no_job(self):
        slug = self.rig.trip("a")
        path, digest = self.planned([slug])
        before = self.rig.counts()
        state = self.rig.trip_state(slug)["lifecycle_state"]
        self.assertEqual(0, self.rig.execute(path, digest)[0])
        after = self.rig.counts()
        for table in ("approvals", "notifications", "plans", "jobs"):
            self.assertEqual(before[table], after[table], table)
        self.assertEqual(before["rollouts"] + 1, after["rollouts"])
        self.assertEqual(state, self.rig.trip_state(slug)["lifecycle_state"])

    def test_ac6_the_config_participants_and_data_survive_even_a_deploy_that_overwrites_them_when_asked_to(self):
        # The fake deploy overwrites trip.config.json only when it is given --sync-config. It never is.
        slug = self.rig.trip("a")
        path, digest = self.planned([slug])
        before = self.rig.trip_files(slug)
        self.assertEqual(0, self.rig.execute(path, digest)[0])
        self.assertEqual(before, self.rig.trip_files(slug))
        self.assertTrue(all("--sync-config" not in d["argv"] for d in self.rig.log("deploy.log")))

    def test_ac6_a_deploy_that_changes_the_config_anyway_fails_the_site_step_loudly(self):
        slug = self.rig.trip("a")
        path, digest = self.planned([slug])
        (self.rig.fake / "mutate-config").write_text("")
        code, out, _ = self.rig.execute(path, digest)
        self.assertEqual(1, code)
        self.assertIn("trip.config.json changed", out)
        rows = self.rig.rollouts(slug)
        self.assertEqual(("failed", "site"), (rows[0]["result"], rows[0]["failed_step"]))
        self.assertEqual(self.rig.r1, self.rig.trip_state(slug)["current_release_id"])

    def test_ac8_a_bridge_that_cannot_reach_its_trip_fails_the_step_with_its_health_code(self):
        cases = {"timeout": "ETIMEDOUT", "refused": "HTTP_401", "noroute": "NO_HEALTH_ROUTE", "odd": "UNRECOGNIZED"}
        for mode, code in cases.items():
            with self.subTest(mode):
                slug = self.rig.trip(f"b{mode}", bridge=mode)
                path, digest = self.planned([slug])
                rc, out, err = self.rig.execute(path, digest)
                self.assertEqual(1, rc)
                self.assertIn(f"FAILED at step bridge: bridge health {code}", out)
                self.assertEqual("bridge", self.rig.rollouts(slug)[0]["failed_step"])

    def test_ac8_a_bridge_that_does_not_answer_at_all_is_none_after_its_wait(self):
        slug = self.rig.trip("down", bridge=None)
        path, digest = self.planned([slug])
        rc, out, _ = self.rig.execute(path, digest)
        self.assertEqual(1, rc)
        self.assertIn("bridge health none", out)

    def test_ac8_a_trip_with_no_key_beside_it_cannot_be_asked_and_fails(self):
        slug = self.rig.trip("nokey")
        (self.rig.trips[slug]["dir"] / "mcp" / ".env").write_text("PORT=1\n")
        path, digest = self.planned([slug])
        rc, out, _ = self.rig.execute(path, digest)
        self.assertEqual(1, rc)
        self.assertIn("NO_KEY", out)

    def test_a_bridge_restart_that_exits_nonzero_fails_the_bridge_step(self):
        slug = self.rig.trip("a")
        path, digest = self.planned([slug])
        (self.rig.fake / "fail-bridge-restart").write_text("")
        rc, out, _ = self.rig.execute(path, digest)
        self.assertEqual(1, rc)
        self.assertIn("FAILED at step bridge", out)

    def test_a_site_that_never_answers_its_own_health_check_fails_the_site_step_and_moves_nothing(self):
        slug = self.rig.trip("a", site_ok=False)
        path, digest = self.planned([slug])
        rc, out, _ = self.rig.execute(path, digest)
        self.assertEqual(1, rc)
        self.assertIn("/api/health did not answer ok", out)
        self.assertEqual(self.rig.r1, self.rig.trip_state(slug)["current_release_id"])
        self.assertEqual([], self.rig.log("bridge.log"))

    def test_the_bridge_key_is_never_printed_logged_stored_or_put_on_a_command_line(self):
        slug = self.rig.trip("a", bridge="timeout")
        path, digest = self.planned([slug])
        code, out, err = self.rig.execute(path, digest)
        everything = out + err + json.dumps(self.rig.log("deploy.log")) + json.dumps(self.rig.log("bridge.log")) \
            + json.dumps(self.rig.rollouts(slug)) + path.read_text()
        self.assertNotIn(KEY, everything)

    def test_children_run_with_an_allow_listed_environment(self):
        slug = self.rig.trip("a")
        path, digest = self.planned([slug])
        self.assertEqual(0, self.rig.execute(path, digest)[0])
        deploy_env = set(self.rig.log("deploy.log")[0]["env"])
        bridge_env = set(self.rig.log("bridge.log")[0]["env"])
        for env in (deploy_env, bridge_env):
            self.assertNotIn(CANARY, env)
            self.assertNotIn("PGPASSWORD", env)
            self.assertIn("FAKE_DIR", env, "a variable the deployment asked to be forwarded is forwarded")
            self.assertIn("KINERARY_DEPLOY_ROOT", env)
        self.assertIn("REPO_ROOT", deploy_env)
        self.assertEqual(self.rig.rev2, self.rig.log("bridge.log")[0]["commit"])

    def test_a_release_whose_tree_does_not_match_its_digest_is_not_deployed(self):
        # The release row says rev2, but the digest recorded is rev1's: the tree must be refused, not shipped.
        rid = f"rls_{self.rig.tag}lies"
        self.rig.release(rid, self.rig.rev2, "sha256:" + secrets.token_hex(32))
        slug = self.rig.trip("a")
        code, out, err, path, digest = self.rig.plan(rid, [slug])
        self.assertEqual(0, code, out + err)
        rc, out, _ = self.rig.execute(path, digest)
        self.assertEqual(1, rc)
        self.assertIn("RELEASE_ARTIFACT_DIGEST_MISMATCH", out)
        self.assertEqual([], self.rig.log("deploy.log"))
        self.assertEqual("site", self.rig.rollouts(slug)[0]["failed_step"])
        self.assertEqual(self.rig.r1, self.rig.trip_state(slug)["current_release_id"])

    def test_a_release_withdrawn_between_plan_and_execute_is_refused_for_the_trip(self):
        slug = self.rig.trip("a")
        path, digest = self.planned([slug])
        self.rig.sql.run("UPDATE control_plane.releases SET status = 'deprecated' WHERE id = :'r'", r=self.rig.r2)
        rc, out, _ = self.rig.execute(path, digest)
        self.assertEqual(1, rc)
        self.assertIn("deprecated", out)
        self.assertEqual([], self.rig.log("deploy.log"))

    def test_ac12_the_way_back_is_the_same_command_naming_the_previous_release_and_the_columns_swap(self):
        slug = self.rig.trip("a")
        path, digest = self.planned([slug])
        self.assertEqual(0, self.rig.execute(path, digest)[0])
        state = self.rig.trip_state(slug)
        self.assertEqual((self.rig.r2, self.rig.r1), (state["current_release_id"], state["previous_release_id"]))
        code, out, err, back, back_digest = self.rig.plan(state["previous_release_id"], [slug], name="back.json")
        self.assertEqual(0, code, err)
        self.assertIn("rollback: this is the trip's recorded previous release", out)
        self.assertEqual(0, self.rig.execute(back, back_digest)[0])
        state = self.rig.trip_state(slug)
        self.assertEqual((self.rig.r1, self.rig.r2), (state["current_release_id"], state["previous_release_id"]))
        self.assertEqual("v1", self.rig.log("deploy.log")[-1]["app_js"], "the way back deployed the previous release's own tree")
        self.assertRolloutRows(slug, "ok", "ok")

    def test_running_the_same_release_again_repeats_the_steps_and_does_not_move_the_record(self):
        slug = self.rig.trip("a")
        path, digest = self.planned([slug])
        self.assertEqual(0, self.rig.execute(path, digest)[0])
        code, out, err, again, again_digest = self.rig.plan(self.rig.r2, [slug], name="again.json")
        self.assertEqual(0, code, err)
        self.assertIn("already on this release", out)
        self.assertEqual(0, self.rig.execute(again, again_digest)[0])
        state = self.rig.trip_state(slug)
        self.assertEqual((self.rig.r2, self.rig.r1), (state["current_release_id"], state["previous_release_id"]))

    def test_steps_may_narrow_the_plan_and_never_widen_it(self):
        slug = self.rig.trip("a")
        path, digest = self.planned([slug])
        code, out, err = self.rig.execute(path, digest, "--steps", "bridge")
        self.assertEqual(0, code, out + err)
        self.assertEqual([], self.rig.log("deploy.log"))
        self.assertEqual(1, len(self.rig.log("bridge.log")))
        self.assertEqual(["bridge"], self.rig.rollouts(slug)[0]["steps"])
        # With the site step not run the record does not move.
        self.assertEqual(self.rig.r1, self.rig.trip_state(slug)["current_release_id"])

    def test_the_first_failure_stops_the_remaining_trips_untouched(self):
        a, b = self.rig.trip("a"), self.rig.trip("b")
        path, digest = self.planned([a, b])
        (self.rig.fake / f"fail-deploy-{a}").write_text("")
        code, out, _ = self.rig.execute(path, digest)
        self.assertEqual(1, code)
        self.assertIn(f"stopped: {b} not touched", out)
        self.assertEqual([a], [d["argv"][0] for d in self.rig.log("deploy.log")])
        self.assertEqual([], self.rig.rollouts(b))
        self.assertEqual(self.rig.r1, self.rig.trip_state(b)["current_release_id"])

    def test_trips_run_one_at_a_time_in_the_planned_order(self):
        a, b = self.rig.trip("a"), self.rig.trip("b")
        path, digest = self.planned([a, b])
        self.assertEqual(0, self.rig.execute(path, digest)[0])
        self.assertEqual([a, b], [d["argv"][0] for d in self.rig.log("deploy.log")])
        self.assertEqual([a, b], [json.loads(l)["argv"][-1].rsplit("/", 1)[-1] for l in (self.rig.fake / "bridge.log").read_text().splitlines()])

    def test_a_rollout_that_is_still_running_blocks_another_for_the_same_trip(self):
        slug = self.rig.trip("a")
        path, digest = self.planned([slug])
        self.rig.sql.run(
            """INSERT INTO control_plane.trip_rollouts(id, trip_id, from_release_id, to_release_id, steps, result, actor, plan_digest)
               SELECT 'rollout_' || :'tag', id, current_release_id, :'to', '["site"]'::jsonb, 'running', 'cli:other', :'digest'
                 FROM control_plane.trips WHERE slug = :'slug'""",
            tag=secrets.token_hex(6), to=self.rig.r2, digest="sha256:" + "a" * 64, slug=slug)
        code, out, _ = self.rig.execute(path, digest)
        self.assertEqual(1, code)
        self.assertIn("another rollout of this trip is still running", out)
        self.assertEqual([], self.rig.log("deploy.log"))

    def test_a_rollout_row_left_running_by_a_dead_process_is_closed_as_abandoned_and_does_not_block_forever(self):
        slug = self.rig.trip("a")
        path, digest = self.planned([slug])
        self.rig.sql.run(
            """INSERT INTO control_plane.trip_rollouts(id, trip_id, from_release_id, to_release_id, steps, result, actor, plan_digest, started_at)
               SELECT 'rollout_' || :'tag', id, current_release_id, :'to', '["site"]'::jsonb, 'running', 'cli:other', :'digest', now() - interval '9 hours'
                 FROM control_plane.trips WHERE slug = :'slug'""",
            tag=secrets.token_hex(6), to=self.rig.r2, digest="sha256:" + "a" * 64, slug=slug)
        self.assertEqual(0, self.rig.execute(path, digest)[0])
        rows = self.rig.rollouts(slug)
        self.assertEqual([("failed", "abandoned"), ("ok", None)], [(r["result"], r["failed_step"]) for r in rows])

    def test_a_termination_signal_mid_step_closes_the_row_failed_instead_of_leaving_it_running(self):
        slug = self.rig.trip("a")
        path, digest = self.planned([slug])
        (self.rig.fake / "block-deploy").write_text("")
        proc = subprocess.Popen([PYTHON, str(SCRIPT), "execute", "--plan-file", str(path), "--plan-digest", digest],
                                env=self.rig.env(), stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        try:
            deadline = time.time() + 60
            while not (self.rig.fake / "deploy-started").exists():
                self.assertLess(time.time(), deadline)
                time.sleep(0.05)
            proc.send_signal(signal.SIGTERM)
            proc.communicate(timeout=60)
        finally:
            (self.rig.fake / "go").write_text("")
            if proc.poll() is None:
                proc.kill()
        rows = self.rig.rollouts(slug)
        self.assertEqual(("failed", "site"), (rows[0]["result"], rows[0]["failed_step"]))
        self.assertEqual(self.rig.r1, self.rig.trip_state(slug)["current_release_id"])

    def test_the_actor_is_recorded_and_no_command_output_ever_is(self):
        slug = self.rig.trip("a")
        path, digest = self.planned([slug])
        self.assertEqual(0, self.rig.execute(path, digest)[0])
        self.assertRegex(self.rig.rollouts(slug)[0]["actor"], r"^cli:[A-Za-z0-9_.-]+$")


# ── slice R2: the release carries the bridge and the companion; the companion step; the way back ──────────────────

STEPS3 = "site,bridge,companion"


class ReleaseCarriesTheBridgeAndTheCompanion(DatabaseCase):
    """AC-13, and the claim retired from step_bridge: the bridge runs the RELEASE's mcp/, not whatever the host holds."""

    def legacy(self, rev=None, digest=None, status="available"):
        rid = f"rls_{self.rig.tag}old{secrets.token_hex(2)}"
        self.rig.release(rid, rev or self.rig.rev2, digest or self.rig.legacy_digest2, status=status, runtime=False)
        return rid

    def test_the_bridge_step_runs_from_the_releases_own_mcp_tree_not_the_hosts_checkout(self):
        slug = self.rig.trip("a")
        path, digest = self.planned([slug])
        self.assertEqual(0, self.rig.execute(path, digest)[0])
        bridge = self.rig.log("bridge.log")[0]
        self.assertEqual(BRIDGE_SOURCE["v2"], bridge["mcp_js"], "the restart was handed the release's mcp/mcp.js")
        self.assertNotEqual(str(self.rig.repo), bridge["repo_root"], "REPO_ROOT is a materialized tree, not a checkout")
        self.assertEqual(self.rig.log("deploy.log")[0]["repo_root"], bridge["repo_root"], "site and bridge came from one tree")
        self.assertFalse(os.path.exists(bridge["repo_root"]), "and the tree is removed afterwards")
        self.assertTrue(self.rig.log("deploy.log")[0]["has_mcp"])

    def test_the_way_back_runs_the_previous_releases_bridge(self):
        slug = self.rig.trip("a")
        path, digest = self.planned([slug])
        self.assertEqual(0, self.rig.execute(path, digest)[0])
        code, out, err, back, back_digest = self.rig.plan(self.rig.r1, [slug], name="back.json")
        self.assertEqual(0, code, err)
        self.assertEqual(0, self.rig.execute(back, back_digest)[0])
        self.assertEqual([BRIDGE_SOURCE["v2"], BRIDGE_SOURCE["v1"]], [b["mcp_js"] for b in self.rig.log("bridge.log")])

    def test_ac13_a_release_built_before_them_is_refused_for_the_bridge_and_companion_steps_with_a_clear_message(self):
        old = self.legacy()
        for steps in (None, "site,bridge", "bridge", STEPS3, "companion"):
            with self.subTest(steps):
                slug = self.rig.trip(f"t{len(self.rig.trips)}")
                code, out, err, path, _ = self.rig.plan(old, [slug], steps, name=f"p-{len(self.rig.trips)}.json")
                self.assertEqual(1, code, out + err)
                reason = json.loads(path.read_text())["refused"][0]["reason"]
                self.assertIn("built before releases carried the bridge (mcp/) and the companion templates (profile-templates/)", reason)
                self.assertIn("--steps site", reason, "the message says what is still possible")
                self.assertIn(old, reason)

    def test_ac13_the_same_release_is_valid_for_the_site_step(self):
        old = self.legacy()
        slug = self.rig.trip("a")
        code, out, err, path, digest = self.rig.plan(old, [slug], "site")
        self.assertEqual(0, code, out + err)
        self.assertEqual(["site"], json.loads(path.read_text())["steps"])
        self.assertEqual(0, self.rig.execute(path, digest)[0])
        deploy = self.rig.log("deploy.log")[0]
        self.assertEqual("v2", deploy["app_js"])
        self.assertFalse(deploy["has_mcp"], "the old seal covers the site only, so only the site is shipped")
        self.assertFalse(deploy["has_templates"])
        self.assertEqual([], self.rig.log("bridge.log"))
        self.assertEqual(old, self.rig.trip_state(slug)["current_release_id"])

    def test_ac13_a_release_built_now_is_valid_for_every_step(self):
        slug = self.rig.trip("a", companion=True)
        code, out, err, path, _ = self.rig.plan(self.rig.r2, [slug], STEPS3)
        self.assertEqual(0, code, out + err)
        self.assertEqual(["site", "bridge", "companion"], json.loads(path.read_text())["steps"])

    def test_ac13_the_trees_actual_contents_are_checked_at_execute_not_only_the_manifest(self):
        # A manifest that claims mcp/ over a digest sealed before it: the plan believes the row, the tree says no.
        liar = f"rls_{self.rig.tag}liar"
        self.rig.release(liar, self.rig.rev2, self.rig.legacy_digest2, runtime=True)
        slug = self.rig.trip("a")
        code, out, err, path, digest = self.rig.plan(liar, [slug])
        self.assertEqual(0, code, out + err)
        rc, out, _ = self.rig.execute(path, digest)
        self.assertEqual(1, rc)
        self.assertIn("FAILED at step bridge", out)
        self.assertIn("does not carry mcp/", out)
        rows = self.rig.rollouts(slug)
        self.assertEqual(("failed", "bridge"), (rows[0]["result"], rows[0]["failed_step"]))
        self.assertEqual([], self.rig.log("bridge.log"), "the bridge was not restarted from a tree that has no bridge")

    def test_the_companion_step_is_refused_at_execute_too_when_the_release_row_has_changed_to_one_without_the_templates(self):
        slug = self.rig.trip("a", companion=True)
        path, digest = self.planned([slug], steps=STEPS3)
        self.rig.sql.run("UPDATE control_plane.releases SET manifest = '{\"files\": [{\"path\": \"site/app.js\"}]}'::jsonb WHERE id = :'r'",
                         r=self.rig.r2)
        rc, out, _ = self.rig.execute(path, digest)
        self.assertEqual(1, rc)
        self.assertIn("built before releases carried", out)
        self.assertEqual([], self.rig.log("deploy.log"))


class CompanionStep(DatabaseCase):
    """AC-14, AC-15 and AC-16: the companion is rendered from the same release as its site and bridge."""

    def go(self, slug, release=None, steps=STEPS3, plan_args=(), name="plan.json", env=None):
        argv = ["plan", "--release", release or self.rig.r2, "--trip", slug, "--steps", steps, "--plan-file", str(self.rig.dir / name),
                *plan_args]
        code, out, err = self.rig.run(argv)
        self.assertEqual(0, code, out + err)
        digest = re.search(r"^digest\s+(sha256:[a-f0-9]{64})$", out, re.M)[1]
        argv = ["execute", "--plan-file", str(self.rig.dir / name), "--plan-digest", digest]
        return self.rig.run(argv, env) + (self.rig.dir / name, digest)

    def soul(self, slug):
        return (self.rig.profile_dir(slug) / "SOUL.md").read_text()

    def kickstarts(self):
        p = self.rig.fake / "launchctl.log"
        return [ln for ln in p.read_text().splitlines() if ln.startswith("kickstart")] if p.exists() else []

    # -- AC-14

    def test_ac14_the_soul_and_skills_equal_a_fresh_render_from_the_release_and_history_and_memory_are_untouched(self):
        slug = self.rig.trip("a", companion=True)
        before = self.rig.profile_state(slug)
        files_before = self.rig.trip_files(slug)
        self.assertNotIn("RELEASE-MARK-v", self.soul(slug), "installed from the host's own templates, not a release's")
        code, out, err, path, digest = self.go(slug)
        self.assertEqual(0, code, out + err)
        self.assertIn("companion ok", out)
        self.assertIn("RELEASE-MARK-v2", self.soul(slug))
        fresh = self.rig.fresh_render(slug, self.rig.rev2, self.rig.digest2)
        rendered = [p for p in sorted(fresh.rglob("*")) if p.is_file()]
        self.assertTrue(any(p.name == "SOUL.md" for p in rendered))
        self.assertTrue(any("a-v2-skill" in p.parts for p in rendered), "the new release's skill is in the render")
        for p in rendered:
            self.assertEqual(p.read_bytes(), (self.rig.profile_dir(slug) / p.relative_to(fresh)).read_bytes(),
                             f"{p.relative_to(fresh)} is not what a fresh render of the release produces")
        after = self.rig.profile_state(slug)
        self.assertEqual(before["history"], after["history"], "conversation history untouched")
        for rel in ("memories/MEMORY.md", ".env", "kinerary-managed"):
            self.assertEqual(before["files"][rel], after["files"][rel], rel)
        self.assertTrue(after["files"]["logs/agent.log"].startswith(before["files"]["logs/agent.log"]), "the log only grew")
        self.assertEqual([("group", None)], after["prompts"], "the saved prompt was cleared so the conversation follows the new SOUL")
        self.assertEqual(files_before, self.rig.trip_files(slug), "AC-6: the trip's own config and data are byte-identical")
        self.assertEqual(["site", "bridge", "companion"], self.rig.rollouts(slug)[0]["steps"])
        self.assertRolloutRows(slug, "ok")

    def test_ac14_the_way_back_renders_the_previous_releases_companion(self):
        slug = self.rig.trip("a", companion=True)
        self.assertEqual(0, self.go(slug)[0])
        self.assertTrue((self.rig.profile_dir(slug) / "skills/travel/a-v2-skill/SKILL.md").is_file())
        code, out, err, _, _ = self.go(slug, release=self.rig.r1, name="back.json")
        self.assertEqual(0, code, out + err)
        self.assertIn("RELEASE-MARK-v1", self.soul(slug))
        self.assertNotIn("RELEASE-MARK-v2", self.soul(slug))
        self.assertFalse((self.rig.profile_dir(slug) / "skills/travel/a-v2-skill").exists(),
                         "a skill the earlier release never had is gone, as the earlier release would have it")
        self.assertEqual(self.rig.r1, self.rig.trip_state(slug)["current_release_id"])

    def test_ac14_a_profile_edited_in_place_is_reported_and_not_overwritten(self):
        slug = self.rig.trip("a", companion=True)
        self.assertEqual(0, self.go(slug)[0])                 # now rendered from release two, and recorded
        soul = self.rig.profile_dir(slug) / "SOUL.md"
        edited = soul.read_text() + "\nThe organizer's own rule: always say shalom.\n"
        soul.write_text(edited)
        before = self.rig.profile_state(slug)
        code, out, err, _, _ = self.go(slug, release=self.rig.r1, name="back.json")
        self.assertEqual(1, code)
        self.assertIn("FAILED at step companion", out)
        self.assertIn("was edited in place; nothing was overwritten", out)
        self.assertIn("SOUL.md", out, "the file is named")
        self.assertIn(f"--overwrite-edited-companion {slug}", out, "and so is the way to allow it")
        self.assertEqual(edited, soul.read_text(), "not one byte of the edit was lost")
        self.assertEqual(before, self.rig.profile_state(slug))
        self.assertEqual([], self.kickstarts()[1:], "the gateway was not restarted for a profile that was not changed")
        row = self.rig.rollouts(slug)[-1]
        self.assertEqual(("failed", "companion"), (row["result"], row["failed_step"]))

    def test_ac14_a_profile_installed_before_the_record_existed_is_refused_as_unknown_provenance(self):
        slug = self.rig.trip("a", companion=True)
        (self.rig.profile_dir(slug) / ".kinerary-render.json").unlink()
        before = self.rig.profile_state(slug)
        soul_before = self.soul(slug)
        code, out, err, _, _ = self.go(slug)
        self.assertEqual(1, code)
        self.assertIn("installed before the record of what was rendered existed", out)
        self.assertEqual(soul_before, self.soul(slug))
        self.assertEqual(before, self.rig.profile_state(slug))
        self.assertEqual([], self.kickstarts())

    def test_ac14_when_the_plan_says_so_the_edited_profile_is_overwritten_and_its_edits_are_copied_aside_first(self):
        slug = self.rig.trip("a", companion=True)
        soul = self.rig.profile_dir(slug) / "SOUL.md"
        edited = soul.read_text() + "\nThe organizer's own rule.\n"
        soul.write_text(edited)
        code, out, err, path, digest = self.go(slug, plan_args=("--overwrite-edited-companion", slug))
        self.assertEqual(0, code, out + err)
        plan = json.loads(path.read_text())
        self.assertTrue(plan["trips"][0]["overwrite_edited_companion"], "the permission is in the plan file the approval covers")
        self.assertIn("RELEASE-MARK-v2", soul.read_text())
        self.assertNotIn("organizer's own rule", soul.read_text())
        saved = list((self.rig.hermes_home / ".hermes" / "profile-backups").glob("*/*/SOUL.md"))
        self.assertEqual(1, len(saved))
        self.assertEqual(edited, saved[0].read_text(), "captured before it was replaced")
        self.assertIn("copied to", out)

    def test_ac14_the_permission_is_named_in_the_plan_output_and_is_per_trip(self):
        a, b = self.rig.trip("a", companion=True), self.rig.trip("b", companion=True)
        for slug in (a, b):
            (self.rig.profile_dir(slug) / "SOUL.md").write_text("edited by hand")
        code, out, err = self.rig.run(["plan", "--release", self.rig.r2, "--trip", f"{a},{b}", "--steps", STEPS3,
                                       "--overwrite-edited-companion", a, "--plan-file", str(self.rig.dir / "p.json")])
        self.assertEqual(0, code, err)
        self.assertRegex(out, rf"{a}: runs .*\n\s+a companion edited in place WILL BE OVERWRITTEN")
        digest = re.search(r"^digest\s+(sha256:[a-f0-9]{64})$", out, re.M)[1]
        rc, out, _ = self.rig.execute(self.rig.dir / "p.json", digest)
        self.assertEqual(1, rc)
        self.assertIn("RELEASE-MARK-v2", self.soul(a), "the trip the plan named was overwritten")
        self.assertEqual("edited by hand", self.soul(b), "the one it did not name was not")
        self.assertIn(f"FAILED at step companion: the companion profile {self.rig.trips[b]['profile']} was edited in place", out)

    def test_ac14_the_permission_cannot_be_added_to_an_approved_plan(self):
        slug = self.rig.trip("a", companion=True)
        (self.rig.profile_dir(slug) / "SOUL.md").write_text("edited by hand")
        path, digest = self.planned([slug], steps=STEPS3)
        doc = json.loads(path.read_text())
        doc["trips"][0]["overwrite_edited_companion"] = True
        path.write_text(json.dumps(doc, indent=2, sort_keys=True) + "\n")
        code, _, err = self.rig.execute(path, digest)
        self.assertEqual(2, code)
        self.assertIn("changed since `plan` wrote it", err)
        self.assertEqual("edited by hand", self.soul(slug))

    def test_the_permission_flag_is_refused_when_it_means_nothing(self):
        slug = self.rig.trip("a", companion=True)
        other = self.rig.trip("b", companion=True)
        for label, argv in {
            "a trip not in the plan": ["--steps", STEPS3, "--overwrite-edited-companion", other],
            "no companion step": ["--steps", "site,bridge", "--overwrite-edited-companion", slug],
        }.items():
            with self.subTest(label):
                code, _, err = self.rig.run(["plan", "--release", self.rig.r2, "--trip", slug, "--plan-file", str(self.rig.dir / "x.json"), *argv])
                self.assertEqual(2, code)
                self.assertIn("overwrite-edited-companion", err)

    def test_a_profile_that_is_not_on_the_host_fails_the_step_and_says_so(self):
        slug = self.rig.trip("a", companion=True)
        shutil.rmtree(self.rig.profile_dir(slug))
        code, out, err, _, _ = self.go(slug)
        self.assertEqual(1, code)
        self.assertIn("FAILED at step companion", out)
        self.assertIn("no companion profile", out)

    def test_a_trip_with_no_companion_is_skipped_visibly_not_failed(self):
        slug = self.rig.trip("a")              # its config names no assistant
        code, out, err, _, _ = self.go(slug)
        self.assertEqual(0, code, out + err)
        self.assertRegex(out, r"companion skipped: this trip has no companion")
        self.assertNotIn("companion ok", out)
        self.assertRolloutRows(slug, "ok")

    # -- AC-15

    def test_ac15_a_conversation_turn_in_flight_is_waited_for_and_the_step_fails_rather_than_cut_it(self):
        slug = self.rig.trip("a", companion=True)
        self.rig.lease(slug, 600)
        before = self.rig.profile_state(slug)
        started = time.time()
        code, out, err, _, _ = self.go(slug)
        elapsed = time.time() - started
        self.assertEqual(1, code)
        self.assertIn("FAILED at step companion", out)
        self.assertIn("a conversation turn was still in flight after waiting 3s", out)
        self.assertIn("nothing was cut", out)
        self.assertGreaterEqual(elapsed, 3, "it waited the bounded time it was given")
        self.assertLess(elapsed, 60, "and not longer")
        self.assertEqual([], self.kickstarts(), "the gateway was not restarted under the turn")
        self.assertEqual(before["prompts"], self.rig.profile_state(slug)["prompts"], "the saved prompt was not cleared")
        self.assertEqual(before["history"], self.rig.profile_state(slug)["history"])
        row = self.rig.rollouts(slug)[0]
        self.assertEqual(("failed", "companion"), (row["result"], row["failed_step"]))

    def test_ac15_a_turn_that_ends_within_the_wait_lets_the_step_finish(self):
        slug = self.rig.trip("a", companion=True)
        self.rig.lease(slug, 5)
        code, out, err, _, _ = self.go(slug, env=self.rig.env(KINERARY_ROLLOUT_TURN_WAIT_SECONDS="40"))
        self.assertEqual(0, code, out + err)
        self.assertEqual(1, len(self.kickstarts()))
        self.assertEqual([("group", None)], self.rig.profile_state(slug)["prompts"])

    # -- AC-16

    def test_ac16_every_tool_the_releases_bridge_declares_is_registered_on_the_gateway_read_from_its_log(self):
        slug = self.rig.trip("a", companion=True)
        code, out, err, _, _ = self.go(slug)
        self.assertEqual(0, code, out + err)
        self.assertIn("3 bridge tool(s) registered", out, "release two's bridge declares three")
        log = (self.rig.profile_dir(slug) / "logs" / "agent.log").read_text()
        for tool in TOOLS_V2:
            self.assertIn(f"mcp__trip_mcp__{tool}", log.splitlines()[-1], "the gateway's own log says it")
        self.assertEqual(1, len(self.kickstarts()))
        self.assertLess(out.index("bridge ok"), out.index("companion ok"), "the bridge was restarted before the gateway was")

    def test_ac16_the_way_back_expects_the_previous_releases_smaller_set(self):
        slug = self.rig.trip("a", companion=True)
        self.assertEqual(0, self.go(slug)[0])
        code, out, err, _, _ = self.go(slug, release=self.rig.r1, name="back.json")
        self.assertEqual(0, code, out + err)
        self.assertIn("2 bridge tool(s) registered", out)

    def test_ac16_a_gateway_that_comes_back_without_one_of_the_tools_fails_the_step_and_names_it(self):
        slug = self.rig.trip("a", companion=True)
        (self.rig.fake / "bridge-drops-tool").write_text("set_things")
        code, out, err, _, _ = self.go(slug)
        self.assertEqual(1, code)
        self.assertIn("FAILED at step companion", out)
        self.assertIn("did not register every tool the release's bridge declares", out)
        self.assertIn("set_things", out)
        row = self.rig.rollouts(slug)[0]
        self.assertEqual(("failed", "companion"), (row["result"], row["failed_step"]))

    def test_ac16_a_gateway_that_registers_nothing_fails_the_step(self):
        slug = self.rig.trip("a", companion=True)
        (self.rig.fake / "gateway-no-register").write_text("")
        code, out, err, _, _ = self.go(slug)
        self.assertEqual(1, code)
        self.assertIn("did not register every tool", out)
        self.assertIn("no registration line", out)

    def test_ac16_the_names_are_read_from_the_release_not_from_the_host(self):
        # A bridge source with no tool names at all is refused before anything is touched: it must not read as "nothing
        # is missing". (The release's own mcp.js is what is read; the host's checkout is never opened.)
        slug = self.rig.trip("a", companion=True)
        bare = f"rls_{self.rig.tag}bare2"
        repo = self.rig.repo

        def git(*a):
            return subprocess.run(["git", "-C", str(repo), "-c", "user.name=t", "-c", "user.email=t@example.invalid", *a],
                                  check=True, capture_output=True, text=True).stdout.strip()
        (repo / "mcp" / "mcp.js").write_text("const nothing = 1;\n")
        git("add", "-A")
        git("commit", "-qm", "a bridge that declares nothing")
        rev = git("rev-parse", "HEAD")
        self.rig.release(bare, rev, release_source.tree_digest(str(repo), rev))
        before = self.rig.profile_state(slug)
        code, out, err, _, _ = self.go(slug, release=bare)
        self.assertEqual(1, code)
        self.assertIn("FAILED at step companion", out)
        self.assertIn("the release's bridge source could not be read for its tool names", out)
        self.assertEqual(before["prompts"], self.rig.profile_state(slug)["prompts"], "nothing was cleared")
        self.assertEqual([], self.kickstarts())

    def test_a_rollback_to_a_release_whose_renderer_refuses_the_handoffs_shape_fails_the_step_naming_the_cause(self):
        # Review round 1: the handoff is built by the host's current builder; an older release's renderer may refuse a key
        # it does not know. That is a clear failure with the cause, never a traceback, and nothing is changed.
        slug = self.rig.trip("a", companion=True)
        old = f"rls_{self.rig.tag}picky"
        repo = self.rig.repo

        def git(*a):
            return subprocess.run(["git", "-C", str(repo), "-c", "user.name=t", "-c", "user.email=t@example.invalid", *a],
                                  check=True, capture_output=True, text=True).stdout.strip()
        (repo / "profile-templates" / "familytrip-companion" / "render_profile.py").write_text(
            "import sys\nprint(\"ERROR: unknown top-level keys: ['a_key_this_release_does_not_know']\", file=sys.stderr)\nraise SystemExit(2)\n")
        git("add", "-A")
        git("commit", "-qm", "a renderer that predates the handoff's shape")
        rev = git("rev-parse", "HEAD")
        self.rig.release(old, rev, release_source.tree_digest(str(repo), rev))
        before = self.rig.profile_state(slug)
        soul = self.soul(slug)
        code, out, err, _, _ = self.go(slug, release=old)
        self.assertEqual(1, code)
        self.assertIn("FAILED at step companion", out)
        self.assertIn("render_profile.py refused this trip's handoff", out)
        self.assertIn("unknown top-level keys", out)
        self.assertIn("roll the companion forward", out)
        self.assertNotIn("Traceback", out + err)
        self.assertEqual(soul, self.soul(slug))
        self.assertEqual(before, self.rig.profile_state(slug))
        self.assertEqual([], self.kickstarts())
        row = self.rig.rollouts(slug)[0]
        self.assertEqual(("failed", "companion"), (row["result"], row["failed_step"]))

    def test_what_an_apply_deleted_was_copied_aside_first(self):
        slug = self.rig.trip("a", companion=True)
        self.assertEqual(0, self.go(slug)[0])           # release two: has a skill release one lacks
        code, out, err, _, _ = self.go(slug, release=self.rig.r1, name="back.json")
        self.assertEqual(0, code, out + err)
        saved = list((self.rig.hermes_home / ".hermes" / "profile-backups").glob("*/*/skills/travel/a-v2-skill/SKILL.md"))
        self.assertEqual(1, len(saved), "the skill the older release does not render was copied aside before it was deleted")

    # -- the rest of the contract

    def test_the_organizer_private_handoff_is_never_printed_logged_or_stored_by_the_rollout(self):
        slug = self.rig.trip("a", companion=True)
        code, out, err, path, digest = self.go(slug)
        self.assertEqual(0, code, out + err)
        everything = out + err + path.read_text() + json.dumps(self.rig.rollouts(slug)) + json.dumps(self.rig.log("deploy.log")) \
            + json.dumps(self.rig.log("bridge.log"))
        self.assertNotIn(ORGANIZER_PRIVATE, everything)
        self.assertNotIn("peanut", everything)
        # it did reach the profile, which is where it belongs: the private context file, as in a fresh provision
        private = (self.rig.profile_dir(slug) / "references" / "interview-context.private.json").read_text()
        self.assertIn(ORGANIZER_PRIVATE, private)
        self.assertEqual(0, stat.S_IMODE((self.rig.profile_dir(slug) / "references" / "interview-context.private.json").stat().st_mode) & 0o077)

    def test_a_failed_bridge_step_means_the_companion_step_does_not_run(self):
        slug = self.rig.trip("a", companion=True, bridge="timeout")
        before = self.soul(slug)
        code, out, err, _, _ = self.go(slug)
        self.assertEqual(1, code)
        self.assertIn("FAILED at step bridge", out)
        self.assertEqual(before, self.soul(slug))
        self.assertEqual([], self.kickstarts())

    def test_steps_may_narrow_a_plan_to_the_companion_step_alone(self):
        slug = self.rig.trip("a", companion=True)
        path, digest = self.planned([slug], steps=STEPS3)
        # The bridge was restarted by hand beforehand, so the gateway will find release two's tools when it connects.
        (self.rig.fake / "bridge-tools.txt").write_text("\n".join(TOOLS_V2) + "\n")
        code, out, err = self.rig.execute(path, digest, "--steps", "companion")
        self.assertEqual(0, code, out + err)
        self.assertEqual([], self.rig.log("deploy.log"))
        self.assertEqual([], self.rig.log("bridge.log"))
        self.assertIn("RELEASE-MARK-v2", self.soul(slug))
        self.assertEqual(["companion"], self.rig.rollouts(slug)[0]["steps"])
        self.assertEqual(self.rig.r1, self.rig.trip_state(slug)["current_release_id"], "the site step did not run, so the record did not move")

    def test_the_companion_commands_run_with_an_allow_listed_environment_and_only_the_installer_gets_the_tree(self):
        slug = self.rig.trip("a", companion=True)
        code, out, err, _, _ = self.go(slug, env=self.rig.env(UNLISTED_SECRET="must-not-reach-a-child"))
        self.assertEqual(0, code, out + err)
        calls = self.rig.log("companion-env.log")
        self.assertEqual(["install", "refresh", "install", "refresh"], [c["kind"] for c in calls],
                         "check, dry run, apply, refresh: in that order")
        for c in calls:
            for name in (CANARY, "UNLISTED_SECRET", "PGPASSWORD"):
                self.assertNotIn(name, c["env"], f"{c['kind']} inherited {name}")
            self.assertIn("KINERARY_DEPLOY_ROOT", c["env"])
        self.assertEqual([True, True], [("KINERARY_RELEASE_TREE" in c["env"]) for c in calls if c["kind"] == "install"])
        self.assertEqual([False, False], [("KINERARY_RELEASE_TREE" in c["env"]) for c in calls if c["kind"] == "refresh"],
                         "the refresh has no use for the tree and is not handed it")
        # The installer rendered from the release's tree: only that tree holds the release's mark.
        self.assertIn("RELEASE-MARK-v2", self.soul(slug))

    def test_the_command_that_installs_is_not_run_when_the_plan_never_names_the_step(self):
        slug = self.rig.trip("a", companion=True)
        env = self.rig.env(KINERARY_COMPANION_INSTALL_CMD="false", KINERARY_COMPANION_REFRESH_CMD="false")
        path, digest = self.planned([slug])
        code, out, err = self.rig.run(["execute", "--plan-file", str(path), "--plan-digest", digest], env)
        self.assertEqual(0, code, out + err)
        self.assertNotIn("companion", out)


class RollingBackToAWithdrawnRelease(DatabaseCase):
    """Decision 5: the way back stays open after the release was withdrawn from new builds — for the trip that ran it."""

    def rolled(self, slug):
        path, digest = self.planned([slug])
        self.assertEqual(0, self.rig.execute(path, digest)[0])
        state = self.rig.trip_state(slug)
        self.assertEqual((self.rig.r2, self.rig.r1), (state["current_release_id"], state["previous_release_id"]))

    def withdraw(self, release, status="deprecated"):
        self.rig.sql.run(f"UPDATE control_plane.releases SET status = '{status}' WHERE id = :'r'", r=release)

    def test_the_trips_own_previous_release_is_accepted_when_deprecated_with_a_warning_in_the_output_and_the_plan(self):
        slug = self.rig.trip("a")
        self.rolled(slug)
        self.withdraw(self.rig.r1)
        code, out, err, path, digest = self.rig.plan(self.rig.r1, [slug], name="back.json")
        self.assertEqual(0, code, out + err)
        self.assertRegex(out, rf"WARNING  {slug}: release {self.rig.r1} is deprecated, no longer available for new builds")
        self.assertIn("accepted because it is this trip's own recorded previous release", out)
        doc = json.loads(path.read_text())
        self.assertEqual([slug], [t["slug"] for t in doc["trips"]])
        self.assertEqual("deprecated", doc["trips"][0]["target_status"], "recorded as data, which the approval prompt reads")
        self.assertEqual(self.rig.r1, doc["trips"][0]["previous_release_id"])
        self.assertEqual([slug], [w["slug"] for w in doc["warnings"]])
        self.assertIn("deprecated", doc["warnings"][0]["warning"])
        self.assertEqual([], doc["refused"])
        self.assertEqual("deprecated", doc["release"]["status"])
        # and it goes
        self.assertEqual(0, self.rig.execute(path, digest)[0])
        state = self.rig.trip_state(slug)
        self.assertEqual((self.rig.r1, self.rig.r2), (state["current_release_id"], state["previous_release_id"]))
        self.assertEqual("v1", self.rig.log("deploy.log")[-1]["app_js"])
        self.assertEqual(BRIDGE_SOURCE["v1"], self.rig.log("bridge.log")[-1]["mcp_js"])

    def test_an_available_target_carries_no_such_warning_or_field(self):
        slug = self.rig.trip("a")
        code, out, err, path, _ = self.rig.plan(self.rig.r2, [slug])
        self.assertEqual(0, code, err)
        self.assertNotIn("no longer available", out)
        self.assertNotIn("target_status", path.read_text())

    def test_any_other_release_that_is_not_available_is_still_refused(self):
        slug = self.rig.trip("a")
        self.rolled(slug)                                   # previous is r1
        other = f"rls_{self.rig.tag}other"
        self.rig.release(other, self.rig.rev1, "sha256:" + secrets.token_hex(32), status="deprecated")
        code, out, err, path, _ = self.rig.plan(other, [slug], name="other.json")
        self.assertEqual(1, code)
        self.assertIn("deprecated, not available", json.loads(path.read_text())["refused"][0]["reason"])

    def test_a_deprecated_release_is_refused_for_a_trip_that_never_ran_it(self):
        slug = self.rig.trip("a")                           # no previous recorded
        self.withdraw(self.rig.r2)
        code, out, err, path, _ = self.rig.plan(self.rig.r2, [slug])
        self.assertEqual(1, code)
        self.assertIn("deprecated, not available", json.loads(path.read_text())["refused"][0]["reason"])

    def test_the_exception_is_per_trip_not_per_release(self):
        ran, never = self.rig.trip("ran"), self.rig.trip("never")
        self.rolled(ran)
        self.withdraw(self.rig.r1)
        code, out, err, path, _ = self.rig.plan(self.rig.r1, [ran, never], name="both.json")
        self.assertEqual(1, code, "one of the two is refused")
        doc = json.loads(path.read_text())
        self.assertEqual([ran], [t["slug"] for t in doc["trips"]])
        self.assertEqual([never], [r["slug"] for r in doc["refused"]])

    def test_a_retired_release_was_pulled_on_purpose_and_is_not_a_way_back(self):
        slug = self.rig.trip("a")
        self.rolled(slug)
        self.withdraw(self.rig.r1)
        self.withdraw(self.rig.r1, "retired")
        code, out, err, path, _ = self.rig.plan(self.rig.r1, [slug], name="back.json")
        self.assertEqual(1, code)
        self.assertIn("retired, not available", json.loads(path.read_text())["refused"][0]["reason"])

    def test_the_rule_is_applied_again_at_execute_against_what_the_plan_recorded(self):
        slug = self.rig.trip("a")
        self.rolled(slug)
        self.withdraw(self.rig.r1)
        code, out, err, path, digest = self.rig.plan(self.rig.r1, [slug], name="back.json")
        self.assertEqual(0, code, out + err)
        # Something moved the trip's recorded previous release since the plan: it is no longer the way back.
        self.rig.sql.run("UPDATE control_plane.trips SET previous_release_id = NULL WHERE slug = :'slug'", slug=slug)
        before = len(self.rig.log("deploy.log"))
        rc, out, _ = self.rig.execute(path, digest)
        self.assertEqual(1, rc)
        self.assertIn("deprecated, not available", out)
        self.assertEqual(before, len(self.rig.log("deploy.log")), "no step ran")

    def test_a_plan_that_does_not_record_the_rollback_cannot_use_the_exception_at_execute(self):
        slug = self.rig.trip("a")
        self.rolled(slug)
        self.withdraw(self.rig.r1)
        code, out, err, path, _ = self.rig.plan(self.rig.r1, [slug], name="back.json")
        doc = json.loads(path.read_text())
        del doc["trips"][0]["previous_release_id"], doc["trips"][0]["target_status"]
        path.write_text(json.dumps(doc, indent=2, sort_keys=True) + "\n")
        digest = "sha256:" + hashlib.sha256(path.read_bytes()).hexdigest()
        before = len(self.rig.log("deploy.log"))
        rc, out, _ = self.rig.execute(path, digest)
        self.assertEqual(1, rc)
        self.assertIn("deprecated, not available", out)
        self.assertEqual(before, len(self.rig.log("deploy.log")))

    def test_a_release_deprecated_after_it_was_planned_as_available_is_refused_at_execute(self):
        # Review round 1: the plan said "available" (no target_status), so the approval never saw a warning. The
        # exception exists only for a plan that recorded the withdrawn status the approval displayed.
        slug = self.rig.trip("a")
        self.rolled(slug)
        code, out, err, path, digest = self.rig.plan(self.rig.r1, [slug], name="back.json")
        self.assertEqual(0, code, out + err)
        self.assertNotIn("target_status", path.read_text())
        self.withdraw(self.rig.r1)
        before = len(self.rig.log("deploy.log"))
        rc, out, _ = self.rig.execute(path, digest)
        self.assertEqual(1, rc)
        self.assertIn("deprecated, not available", out)
        self.assertEqual(before, len(self.rig.log("deploy.log")), "no step ran")

    def test_a_plan_edited_to_drop_only_the_target_status_is_refused_even_with_a_matching_digest(self):
        slug = self.rig.trip("a")
        self.rolled(slug)
        self.withdraw(self.rig.r1)
        code, out, err, path, _ = self.rig.plan(self.rig.r1, [slug], name="back.json")
        doc = json.loads(path.read_text())
        del doc["trips"][0]["target_status"]
        path.write_text(json.dumps(doc, indent=2, sort_keys=True) + "\n")
        digest = "sha256:" + hashlib.sha256(path.read_bytes()).hexdigest()
        before = len(self.rig.log("deploy.log"))
        rc, out, _ = self.rig.execute(path, digest)
        self.assertEqual(1, rc)
        self.assertIn("deprecated, not available", out)
        self.assertEqual(before, len(self.rig.log("deploy.log")))

    def test_a_recorded_status_that_is_not_the_releases_status_now_is_refused(self):
        slug = self.rig.trip("a")
        self.rolled(slug)
        self.withdraw(self.rig.r1)
        code, out, err, path, digest = self.rig.plan(self.rig.r1, [slug], name="back.json")
        self.withdraw(self.rig.r1, "retired")
        rc, out, _ = self.rig.execute(path, digest)
        self.assertEqual(1, rc)
        self.assertIn("retired, not available", out)

    def test_a_plan_written_by_the_first_slice_is_still_a_valid_plan(self):
        slug = self.rig.trip("a")
        path, _ = self.planned([slug])
        doc = json.loads(path.read_text())
        for t in doc["trips"]:
            t.pop("previous_release_id", None)
        doc.pop("warnings", None)
        path.write_text(json.dumps(doc, indent=2, sort_keys=True) + "\n")
        digest = "sha256:" + hashlib.sha256(path.read_bytes()).hexdigest()
        self.assertEqual(0, self.rig.execute(path, digest)[0])
        self.assertEqual(self.rig.r2, self.rig.trip_state(slug)["current_release_id"])


if __name__ == "__main__":
    unittest.main()
