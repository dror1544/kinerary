"""scripts/trip-rollout.py — one command brings a release to named trips (#568, slice R1).

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
    f.write(json.dumps({"argv": argv, "repo_root": repo_root, "env": sorted(os.environ), "app_js": app_js}) + "\n")
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
import json, os, sys
d = os.environ["FAKE_DIR"]
with open(os.path.join(d, "bridge.log"), "a") as f:
    f.write(json.dumps({"argv": sys.argv[1:], "env": sorted(os.environ),
                        "commit": os.environ.get("KINERARY_ROLLOUT_RELEASE_COMMIT")}) + "\n")
if os.path.exists(os.path.join(d, "fail-bridge-restart")):
    print("restart failed")
    sys.exit(3)
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
        self.trips: dict[str, dict] = {}
        self.hostnames: dict[str, str] = {}
        for name, body in (("deploy.py", FAKE_DEPLOY), ("bridge.py", FAKE_BRIDGE_RESTART), ("hostname.py", FAKE_HOSTNAME)):
            (self.dir / name).write_text(body)
        self._git_repo()
        self.r1, self.r2 = f"rls_{self.tag}r1", f"rls_{self.tag}r2"
        if sql:
            self._releases()

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
            for rel, body in {"site/app.js": version, "server/server.js": f"// {version}\n", "shared/s.js": f"{self.tag}\n"}.items():
                p = self.repo / rel
                p.parent.mkdir(parents=True, exist_ok=True)
                p.write_text(body)
            git("add", "-A")
            git("commit", "-qm", version)
            revs.append(git("rev-parse", "HEAD"))
        self.rev1, self.rev2 = revs
        self.digest1 = release_source.tree_digest(str(self.repo), self.rev1)
        self.digest2 = release_source.tree_digest(str(self.repo), self.rev2)

    def release(self, rid: str, rev: str, digest: str, status: str = "available", lo: int = 1, hi: int = 1,
                manifest: bool = True) -> None:
        sealed = status in ("verified", "available")
        self.sql.run(
            f"""INSERT INTO control_plane.releases(id, source_revision, artifact_digest, application_schema,
                    data_schema_min, data_schema_max, status, promoted_to_available_at, promoted_by, manifest, sanitation_passed)
                VALUES (:'id', :'rev', :'digest', 1, {int(lo)}, {int(hi)}, :'status',
                    CASE WHEN :'status' = 'available' THEN now() END, CASE WHEN :'status' = 'available' THEN 'test:fixture' END,
                    NULLIF(:'manifest', '')::jsonb, {'true' if sealed else 'false'})""",
            id=rid, rev=rev, digest=digest, status=status,
            manifest='{"files": [{"path": "site/app.js", "sha": "x"}]}' if manifest else "")

    def _releases(self) -> None:
        self.release(self.r1, self.rev1, self.digest1)
        self.release(self.r2, self.rev2, self.digest2)

    # -- trips

    def trip(self, name: str, current: str | None = "r1", state: str = "active", vmid: int | None = None,
             bridge: str | None = "ok", site_ok: bool = True, schema: int | None = 1) -> str:
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
        (tdir / "trip.config.json").write_text(json.dumps({"participants": [{"username": "ana"}], "slug": slug}))
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
            "KINERARY_ROLLOUT_CHILD_ENV": "FAKE_DIR",
            "FAKE_DIR": str(self.fake),
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
        }
        for name, kwargs in cases.items():
            with self.subTest(name):
                path, digest = self.write(**kwargs)
                code, _, err = self.rig.execute(path, digest)
                self.assertEqual(2, code)
                self.assertRegex(err, "not valid JSON|is not a rollout plan")

    def test_steps_that_are_not_built_in_this_slice_are_refused_with_the_reason(self):
        for step in ("companion", "switches"):
            code, _, err = self.rig.run(["plan", "--release", "x", "--trip", "ro-a", "--steps", step,
                                         "--plan-file", str(self.rig.dir / "p.json")])
            self.assertEqual(2, code)
            self.assertIn("not in this slice", err)

    def test_all_is_not_in_this_slice(self):
        code, _, err = self.rig.run(["plan", "--release", "x", "--all", "--plan-file", str(self.rig.dir / "p.json")])
        self.assertEqual(2, code)
        self.assertIn("not in this slice", err)

    def test_a_plan_naming_a_step_the_approval_does_not_cover_is_refused_at_execute(self):
        path, digest = self.write()
        code, _, err = self.rig.execute(path, digest, "--steps", "companion")
        self.assertEqual(2, code)
        self.assertIn("not in this slice", err)


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
        self.assertEqual([{"slug": slug, "trip_id": self.rig.trips[slug]["id"], "from_release_id": self.rig.r1}], doc["trips"])
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


if __name__ == "__main__":
    unittest.main()
