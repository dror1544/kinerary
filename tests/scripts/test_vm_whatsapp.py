"""WhatsApp on the control-plane VM: an optional overlay, off by default (issue #625, the bridge on the VM).

What is pinned here, and why each is a way this could fail without anyone noticing:

- compose.vm.yml is untouched by the feature: with WhatsApp off, `compose config` needs no WhatsApp file,
  secret or variable, and renders exactly the stack it always did. With it on, the overlay ADDS the bridge
  and two secrets on the relay and changes nothing else.
- the bridge's compose service has the properties a credential holder needs: loopback host network, the
  secret as a FILE (never an argument or an environment variable), a read-write session mount that does not
  invent a missing host path, no ports, no capabilities, and a restart policy that stops after five failures.
- every command that can recreate the relay uses ONE file set. A relay recreated without the overlay has no
  WhatsApp secrets, logs relay.whatsapp_disabled and Telegram looks fine: the release tool, the relay restart
  script and the other scripts that call compose must agree, and the shell and Python answers are compared on
  the same env files.
- the release tool: disabled = no bridge image, build, up or verify line, and the compose argv it has always had;
  enabled = the bridge is built, brought up BEFORE the relay restarts, verified with the number stripped, an
  unpaired / logged-out / missing bridge is a WARNING (never a failed check: a failed verify rolls the release
  back, and WhatsApp being down must not take Telegram with it), and a rollback brings the bridge back too.

The compose checks use docker and say so when it is not there. Every secret value in these tests is a
placeholder generated for the test.
"""
from __future__ import annotations

import http.server
import importlib.util
import io
import json
import os
import re
import secrets as pysecrets
import shutil
import subprocess
import sys
import tempfile
import threading
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[2]
DEPLOYMENT = ROOT / "control-plane" / "deployment"
COMPOSE = DEPLOYMENT / "compose.vm.yml"
OVERLAY = DEPLOYMENT / "compose.vm.whatsapp.yml"
HELPER = DEPLOYMENT / "vm-compose-files.sh"
PAIR = DEPLOYMENT / "vm-whatsapp-pair.sh"
DOCKERFILE = ROOT / "control-plane" / "whatsapp-bridge" / "Dockerfile"
DOCKER = shutil.which("docker")
BASH = shutil.which("bash")

_tmp = Path(tempfile.mkdtemp(prefix="vm-whatsapp-test-"))
for key, sub in (("KINERARY_CP_STATE_DIR", "state"), ("KINERARY_CP_BACKUP_DIR", "backups"), ("KINERARY_CP_LOG_DIR", "log")):
    os.environ[key] = str(_tmp / sub)
_spec = importlib.util.spec_from_file_location("vm_release_whatsapp", DEPLOYMENT / "vm-release.py")
vr = importlib.util.module_from_spec(_spec)
sys.modules["vm_release_whatsapp"] = vr
_spec.loader.exec_module(vr)


def docker_works(*args: str) -> bool:
    if not DOCKER:
        return False
    return subprocess.run([DOCKER, *args], capture_output=True, timeout=60).returncode == 0


HAVE_COMPOSE = docker_works("compose", "version")

# What a VM's vm.env must hold for compose.vm.yml to parse at all (the `:?` ones).
BASE_ENV = {
    "KINERARY_REV": "abc1234", "HERMES_REV": "def5678", "INTERPRET_PATH_DEFAULT": "1",
    "INTERPRET_RUNNER": "claude", "EXTRACT_RUNNER": "claude", "INTERVIEW_MCP_KEY": "k-interview",
    "CONTROL_PLANE_INTERVIEW_AGENT_KEY": "k-agent", "KINERARY_NFS_ROOT": "/srv/kinerary-nfs",
}


def shimmed_compose(workdir: Path) -> Path:
    """compose.vm.yml with its two `env_file: - path:` entries made plain and local (see test_vm_web_profile.py)."""
    text = COMPOSE.read_text()
    for name in ("claude.env", "openrouter.env"):
        (workdir / name).write_text("")
    text = re.sub(r"(?m)^(\s+)- path: /opt/agent-auth/(\S+)\n(?:\s+required: false\n)?",
                  lambda m: f"{m.group(1)}- {workdir / m.group(2)}\n", text)
    path = workdir / "compose.vm.yml"
    path.write_text(text)
    return path


def compose_run(env: dict, *, overlay: bool, args=("config", "--format", "json")) -> subprocess.CompletedProcess:
    workdir = Path(tempfile.mkdtemp(prefix="vm-whatsapp-compose-"))
    try:
        compose = shimmed_compose(workdir)
        (workdir / "vm.env").write_text("".join(f"{k}={v}\n" for k, v in env.items()))
        (workdir / "provisioning.env").write_text("UNRELATED=1\n")
        argv = [DOCKER, "compose", "--project-directory", str(DEPLOYMENT), "-f", str(compose),
                *(["-f", str(OVERLAY)] if overlay else []),
                "--env-file", str(workdir / "provisioning.env"), "--env-file", str(workdir / "vm.env"), *args]
        return subprocess.run(argv, capture_output=True, timeout=120)
    finally:
        shutil.rmtree(workdir, ignore_errors=True)


def compose_json(env: dict, *, overlay: bool) -> dict:
    proc = compose_run(env, overlay=overlay)
    if proc.returncode != 0:
        raise AssertionError(f"docker compose config failed: {proc.stderr.decode()[-600:]}")
    return json.loads(proc.stdout)


@unittest.skipUnless(HAVE_COMPOSE, "docker compose is not available - the overlay NOT validated")
class ComposeOverlay(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.session = tempfile.mkdtemp(prefix="vm-whatsapp-session-")
        cls.env_on = {**BASE_ENV, "WHATSAPP_SESSION_DIR": cls.session}
        cls.without = compose_json(BASE_ENV, overlay=False)
        cls.with_overlay = compose_json(cls.env_on, overlay=True)

    @classmethod
    def tearDownClass(cls):
        shutil.rmtree(cls.session, ignore_errors=True)

    def test_off_needs_no_whatsapp_file_secret_or_variable(self):
        # BASE_ENV names nothing WhatsApp, and no .local-secrets file for it exists in the tree.
        self.assertNotIn("whatsapp-bridge", self.without["services"])
        self.assertFalse([s for s in self.without.get("secrets", {}) if "whatsapp" in s])
        for name, service in self.without["services"].items():
            self.assertFalse([s for s in service.get("secrets", []) if "whatsapp" in s.get("source", "")], name)
        self.assertNotIn("whatsapp", COMPOSE.read_text().lower().replace("compose.vm.whatsapp.yml", "").replace("vm-compose-files", ""),
                         "compose.vm.yml must not mention WhatsApp at all: the feature is the overlay's")

    def test_on_adds_exactly_the_bridge_and_two_secrets_on_the_relay(self):
        self.assertEqual(set(self.with_overlay["services"]) - set(self.without["services"]), {"whatsapp-bridge"})
        for name, service in self.without["services"].items():
            now = json.loads(json.dumps(self.with_overlay["services"][name]))
            if name == "relay":
                added = [s for s in now["secrets"] if s["source"].startswith("whatsapp_")]
                self.assertEqual(sorted(s["source"] for s in added), ["whatsapp_bridge_secret", "whatsapp_sender_id_key"])
                now["secrets"] = [s for s in now["secrets"] if not s["source"].startswith("whatsapp_")]
            self.assertEqual(now, service, f"{name} changed when the overlay came on")

    def test_only_the_relay_and_the_bridge_get_secrets_and_the_key_is_the_relays_alone(self):
        holders = {name: {s["source"] for s in service.get("secrets", [])} for name, service in self.with_overlay["services"].items()}
        self.assertEqual({n for n, s in holders.items() if "whatsapp_bridge_secret" in s}, {"relay", "whatsapp-bridge"})
        self.assertEqual({n for n, s in holders.items() if "whatsapp_sender_id_key" in s}, {"relay"})

    def test_the_bridge_is_a_loopback_host_network_sidecar_with_no_ports(self):
        bridge = self.with_overlay["services"]["whatsapp-bridge"]
        self.assertEqual(bridge["network_mode"], "host")
        self.assertNotIn("ports", bridge)
        self.assertEqual(bridge["image"], "kinerary-cp/whatsapp-bridge:abc1234")
        self.assertEqual(bridge["cap_drop"], ["ALL"])
        self.assertTrue(bridge["read_only"])
        self.assertIn("no-new-privileges:true", bridge["security_opt"])
        self.assertEqual(bridge["user"], "1000:1000")
        self.assertEqual(bridge["command"][:4], ["--session", "/session", "--port", "4340"])

    def test_the_secret_is_a_file_never_an_argument_or_an_environment_variable(self):
        bridge = self.with_overlay["services"]["whatsapp-bridge"]
        self.assertEqual(bridge["command"][-2:], ["--secret-file", "/run/secrets/whatsapp_bridge_secret"])
        self.assertEqual([s["source"] for s in bridge["secrets"]], ["whatsapp_bridge_secret"])
        env = bridge.get("environment", {})
        self.assertFalse([k for k in env if "SECRET" in k.upper() or "KEY" in k.upper()], env)
        self.assertNotIn("env_file", bridge)

    def test_the_session_is_a_read_write_bind_that_does_not_invent_a_missing_host_path(self):
        volume = self.with_overlay["services"]["whatsapp-bridge"]["volumes"]
        self.assertEqual(len(volume), 1)
        self.assertEqual((volume[0]["type"], volume[0]["target"]), ("bind", "/session"))
        self.assertEqual(Path(volume[0]["source"]).resolve(), Path(self.session).resolve())
        self.assertFalse(volume[0].get("read_only"))
        self.assertIs(volume[0]["bind"]["create_host_path"], False)

    def test_it_restarts_on_a_crash_but_stops_after_five_failures(self):
        self.assertEqual(self.with_overlay["services"]["whatsapp-bridge"]["restart"], "unless-stopped")
        self.assertEqual(self.with_overlay["services"]["relay"]["restart"], "unless-stopped", "the relay's own policy is untouched")

    def test_no_depends_on_in_either_direction(self):
        # A bridge that is down must not hold the relay down, and the relay must not be what starts the bridge.
        self.assertNotIn("whatsapp-bridge", self.with_overlay["services"]["relay"].get("depends_on", {}))
        self.assertNotIn("depends_on", self.with_overlay["services"]["whatsapp-bridge"])

    def test_the_session_directory_is_required_when_the_overlay_is_on(self):
        proc = compose_run(BASE_ENV, overlay=True)
        self.assertNotEqual(proc.returncode, 0)
        self.assertIn("WHATSAPP_SESSION_DIR", proc.stderr.decode())

    def test_the_port_comes_from_vm_env(self):
        moved = compose_json({**self.env_on, "WHATSAPP_BRIDGE_PORT": "4999"}, overlay=True)
        self.assertEqual(moved["services"]["whatsapp-bridge"]["command"][3], "4999")

    def test_the_overlay_names_nothing_of_this_deployment(self):
        body = "\n".join(l for l in OVERLAY.read_text().splitlines() if not l.lstrip().startswith("#"))
        self.assertNotRegex(body, r"/opt/|/Users/|\.local\b(?!-secrets)|\.lan\b|kinerary-cp-[a-z]+-[0-9]")
        for ip in re.findall(r"\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b", body):
            self.assertEqual(ip, "127.0.0.1")


class Dockerfile(unittest.TestCase):
    def test_production_dependencies_only_non_root_and_no_session_in_the_image(self):
        text = DOCKERFILE.read_text()
        code = "\n".join(l for l in text.splitlines() if not l.lstrip().startswith("#"))
        self.assertIn("npm ci --omit=dev", code)
        self.assertRegex(code, r"(?m)^USER node$")
        self.assertRegex(code, r'ENTRYPOINT \["node", "src/bridge.js"\]')
        self.assertNotRegex(code, r"(?i)session|COPY \. ")
        ignore = (DOCKERFILE.parent / ".dockerignore").read_text().split()
        for name in ("node_modules", "test"):
            self.assertIn(name, ignore)


# ------------------------------------------------------------------------- the shared file set --
def shell_files(dir_: Path, *env_texts: str, readable=True) -> list:
    """What vm-compose-files.sh decides, on the same env texts."""
    files = []
    for i, text in enumerate(env_texts):
        path = _tmp / f"env-{i}-{pysecrets.token_hex(3)}"
        path.write_text(text)
        files.append(str(path))
    script = f'. "{HELPER}"; vm_compose_files_init "{dir_}" {" ".join(files)} || exit 7; printf "%s\\n" "${{VM_COMPOSE_FILES[@]}}"'
    proc = subprocess.run([BASH, "-c", script], capture_output=True, text=True, env={**os.environ, "VM_COMPOSE_READ": "cat"})
    if proc.returncode != 0:
        raise AssertionError(proc.stderr)
    return proc.stdout.split("\n")[:-1]


class SharedFileSet(unittest.TestCase):
    CASES = [
        (("", ""), False),
        (("WHATSAPP_BRIDGE_ENABLED=1\n", ""), True),
        (("WHATSAPP_BRIDGE_ENABLED=1\n", "WHATSAPP_BRIDGE_ENABLED=0\n"), False),          # vm.env wins
        (("WHATSAPP_BRIDGE_ENABLED=1\n", "WHATSAPP_BRIDGE_ENABLED=\n"), False),           # later file wins, even empty
        (("", "WHATSAPP_BRIDGE_ENABLED=true\n"), True),
        (("", 'WHATSAPP_BRIDGE_ENABLED="on"\n'), True),
        (("", "WHATSAPP_BRIDGE_ENABLED= Yes \n"), True),
        (("", "  WHATSAPP_BRIDGE_ENABLED=1\n"), True),
        (("", "# WHATSAPP_BRIDGE_ENABLED=1\n"), False),                                    # commented out
        (("", "WHATSAPP_BRIDGE_ENABLED=0\nWHATSAPP_BRIDGE_ENABLED=1\n"), True),            # the last line in a file wins
        (("", "WHATSAPP_BRIDGE_ENABLED=1   # on, filled in over the example's own line\n"), True),
        (("", "WHATSAPP_BRIDGE_ENABLED=0 # off\n"), False),
        (("", "WHATSAPP_BRIDGE_ENABLED=maybe\n"), False),
        (("", "NOT_WHATSAPP_BRIDGE_ENABLED=1\n"), False),
    ]

    def setUp(self):
        self.dir = Path(tempfile.mkdtemp(prefix="vm-whatsapp-files-"))
        self.addCleanup(shutil.rmtree, self.dir, ignore_errors=True)
        (self.dir / "compose.vm.yml").write_text("services: {}\n")

    def python_files(self, texts, overlay_present=True) -> list:
        if overlay_present:
            (self.dir / vr.WHATSAPP_OVERLAY).write_text(OVERLAY.read_text())
        env = self.dir / "env"
        prov, vm = self.dir / "provisioning.env", self.dir / "vm.env"
        prov.write_text(texts[0])
        vm.write_text(texts[1])
        with mock.patch.object(vr, "DEPLOYMENT_DIR", self.dir), mock.patch.object(vr, "PROVISIONING_ENV", prov), \
                mock.patch.object(vr, "VM_ENV", vm):
            argv = vr.ControlPlane(vr.Report(io.StringIO(), color=False)).compose("config")
        return [a for a in argv if a.endswith(".yml")]

    @unittest.skipUnless(BASH, "no bash")
    def test_shell_and_python_choose_the_same_files_from_the_same_env_files(self):
        for texts, on in self.CASES:
            with self.subTest(texts=texts):
                (self.dir / vr.WHATSAPP_OVERLAY).write_text(OVERLAY.read_text())
                shell = [a for a in shell_files(self.dir, *texts) if a.endswith(".yml")]
                python = self.python_files(texts)
                self.assertEqual([Path(a).name for a in shell], [Path(a).name for a in python])
                self.assertEqual(len(shell), 2 if on else 1)
                self.assertEqual(vr.whatsapp_flag(*texts), on)

    @unittest.skipUnless(BASH, "no bash")
    def test_a_checkout_without_the_overlay_never_gets_a_missing_file_in_its_argv(self):
        # A rollback to a version from before the overlay, with the flag still on: `-f <missing>` would fail
        # every compose call, the relay's and Telegram's included.
        texts = ("", "WHATSAPP_BRIDGE_ENABLED=1\n")
        self.assertFalse((self.dir / vr.WHATSAPP_OVERLAY).exists())
        self.assertEqual([Path(a).name for a in shell_files(self.dir, *texts) if a.endswith(".yml")], ["compose.vm.yml"])
        self.assertEqual([Path(a).name for a in self.python_files(texts, overlay_present=False)], ["compose.vm.yml"])

    @unittest.skipUnless(BASH, "no bash")
    def test_an_env_file_that_cannot_be_read_is_an_error_not_off(self):
        script = f'. "{HELPER}"; VM_COMPOSE_READ=false vm_compose_files_init "{self.dir}" "{self.dir / "compose.vm.yml"}"; echo "status=$?"'
        proc = subprocess.run([BASH, "-c", script], capture_output=True, text=True)
        self.assertIn("status=1", proc.stdout)
        self.assertIn("cannot read", proc.stderr)

    def test_every_script_that_calls_compose_on_the_stack_takes_its_files_from_the_helper(self):
        # The silent failure this prevents: a relay recreated from compose.vm.yml alone has no WhatsApp secrets.
        offenders = []
        for root in ("control-plane/deployment", "scripts", ".agents"):
            for path in sorted((ROOT / root).rglob("*")):
                if path.suffix not in (".sh", ".py") or not path.is_file() or "node_modules" in path.parts:
                    continue
                text = path.read_text(errors="replace")
                # An actual compose invocation on the stack's file, not a comment that names it.
                invokes = (re.search(r'-f\s+"?[^\s"]*compose\.vm\.yml', text) if path.suffix == ".sh"
                           else re.search(r'"docker",\s*"compose"', text) and "compose.vm.yml" in text)
                if not invokes:
                    continue
                if path.name in ("vm-release.py", "vm-compose-files.sh"):
                    continue    # the release tool builds every argv through ControlPlane.compose(), pinned below
                if "vm-compose-files.sh" not in text:
                    offenders.append(str(path.relative_to(ROOT)))
        self.assertEqual(offenders, [], "these call compose on compose.vm.yml without the shared file set")

    def test_the_release_tool_has_no_compose_argv_of_its_own(self):
        # Every `docker compose` the tool runs must come from compose(); validate_compose is the one
        # exception and builds the same set from the target's own files.
        source = (DEPLOYMENT / "vm-release.py").read_text()
        builders = [m.start() for m in re.finditer(r'\["docker", "compose"', source)]
        self.assertEqual(len(builders), 2, "a new hand-built compose argv: give it the overlay (see validate_compose / compose())")

    def test_the_relay_restart_script_recreates_the_relay_with_the_set(self):
        text = (DEPLOYMENT / "vm-relay-restart.sh").read_text()
        self.assertIn('docker compose "${VM_COMPOSE_FILES[@]}"', text)
        self.assertNotRegex(text, r'docker compose -f "\$DIR/compose\.vm\.yml"')


# ----------------------------------------------------------------------------- the release tool --
class Quiet:
    """A shell that records what was read and run; `fail` is a set of command words that return 1."""

    def __init__(self, *, fail=(), dry_run=False, report=None):
        self.executed, self.reads, self.fail, self.dry_run, self.report = [], [], set(fail), dry_run, report

    def _rc(self, argv):
        return 1 if any(word in " ".join(argv) for word in self.fail) else 0

    def read(self, argv, **kwargs):
        argv = [str(a) for a in argv]
        self.reads.append(argv)
        return subprocess.CompletedProcess(argv, self._rc(argv), b"", b"boom" if self._rc(argv) else b"")

    def text(self, argv, **kwargs):
        return self.read(argv).stdout.decode()

    def act(self, argv, *, describe="", check=True, **kwargs):
        argv = [str(a) for a in argv]
        if self.dry_run:
            self.report.step(f"would run: {describe or ' '.join(argv)}")
            return subprocess.CompletedProcess(argv, 0, b"", b"")
        self.executed.append(argv)
        self.report.step(describe or " ".join(argv))
        rc = self._rc(argv)
        if check and rc:
            raise vr.Refused(f"{' '.join(argv)} exited {rc}")
        return subprocess.CompletedProcess(argv, rc, b"", b"boom" if rc else b"")


class ReleaseWorld(unittest.TestCase):
    """A scratch deploy root and checkout, patched in, with a ControlPlane over a Quiet shell."""

    def setUp(self):
        self.dir = Path(tempfile.mkdtemp(prefix="vm-whatsapp-tool-"))
        self.addCleanup(shutil.rmtree, self.dir, ignore_errors=True)
        self.deploy = self.dir / "deploy"
        self.checkout = self.dir / "repo" / "control-plane" / "deployment"
        self.secrets = self.checkout / ".local-secrets"
        self.session = self.dir / "session"
        for d in (self.deploy, self.checkout, self.secrets, self.session):
            d.mkdir(parents=True)
        os.chmod(self.session, 0o700)
        (self.checkout / "compose.vm.yml").write_text(COMPOSE.read_text())
        (self.checkout / vr.WHATSAPP_OVERLAY).write_text(OVERLAY.read_text())
        self.prov, self.vm = self.deploy / "provisioning.env", self.deploy / "vm.env"
        self.prov.write_text("UNRELATED=1\n")
        self.set_env("KINERARY_REV=abc1234")
        for name, value in (("DEPLOYMENT_DIR", self.checkout), ("PROVISIONING_ENV", self.prov), ("VM_ENV", self.vm),
                            ("SECRETS_DIR", self.secrets)):
            patcher = mock.patch.object(vr, name, value)
            patcher.start()
            self.addCleanup(patcher.stop)
        sleeper = mock.patch.object(vr.time, "sleep", lambda _s: None)
        sleeper.start()
        self.addCleanup(sleeper.stop)
        self.out = io.StringIO()
        self.cp = vr.ControlPlane(vr.Report(self.out, color=False))
        self.sh = Quiet(report=self.cp.r)
        self.cp.sh = self.sh
        self.cp.git_argv = lambda *a: ["git", *a]

    def set_env(self, *lines: str):
        self.vm.write_text("\n".join(lines) + "\n")

    def enable(self, *extra: str):
        self.set_env("KINERARY_REV=abc1234", "WHATSAPP_BRIDGE_ENABLED=1", f"WHATSAPP_SESSION_DIR={self.session}", *extra)

    def said(self) -> str:
        return self.out.getvalue()

    def write_secrets(self, mode=0o600):
        for name in vr.WHATSAPP_SECRET_NAMES:
            path = self.secrets / name
            path.write_text(pysecrets.token_hex(32))
            os.chmod(path, mode)


class ReleaseToolOff(ReleaseWorld):
    def test_the_compose_argv_is_what_it_always_was(self):
        self.assertFalse(self.cp.whatsapp_enabled())
        argv = self.cp.compose("up", "-d", "--wait", "api")
        self.assertEqual(argv, ["docker", "compose", "-f", str(self.checkout / "compose.vm.yml"),
                                "--env-file", str(self.prov), "--env-file", str(self.vm), "up", "-d", "--wait", "api"])

    def test_no_bridge_image_build_up_or_verify_line(self):
        self.cp.web_in_compose = lambda full: False
        self.assertEqual(self.cp.kinerary_images("abc1234", "f" * 40),
                         ["kinerary-cp/api:abc1234", "kinerary-cp/worker:abc1234", "kinerary-cp/agent-runtime:abc1234"])
        self.cp.start_whatsapp()
        self.assertEqual(self.sh.executed, [])
        findings = vr.Findings()
        self.cp.verify_whatsapp(findings, {"kinerary-cp-whatsapp-bridge-1": "kinerary-cp/whatsapp-bridge:abc1234"}, "abc1234",
                                [{"event": "relay.whatsapp", "configured": False}])
        self.assertEqual((findings.items, self.sh.reads, self.sh.executed), ([], [], []))
        self.cp.guard_whatsapp("f" * 40)
        self.assertEqual((self.said(), self.sh.reads), ("", []), "guard_whatsapp must not even ask git while it is off")

    def test_only_the_three_images_are_built(self):
        self.cp.image_exists = lambda tag: False
        built = []
        real = vr.subprocess.run
        vr.subprocess.run = lambda argv, **kw: built.append(list(argv)) or subprocess.CompletedProcess(argv, 0, b"", b"")
        try:
            self.cp.build_images("a" * 40, "abc1234")
        finally:
            vr.subprocess.run = real
        self.assertEqual(len(built), 3)

    def test_an_enabled_flag_in_another_spelling_of_off_stays_off(self):
        for text in ("WHATSAPP_BRIDGE_ENABLED=0", "WHATSAPP_BRIDGE_ENABLED=", "WHATSAPP_BRIDGE_ENABLED=no", "#WHATSAPP_BRIDGE_ENABLED=1"):
            self.set_env("KINERARY_REV=abc1234", text)
            self.assertFalse(self.cp.whatsapp_enabled(), text)
            self.assertNotIn(vr.WHATSAPP_OVERLAY, " ".join(self.cp.compose("up")))

    def test_the_pruning_regex_knows_the_bridge_image(self):
        tags = ["kinerary-cp/whatsapp-bridge:aaaaaaa", "kinerary-cp/whatsapp-bridge:bbbbbbb", "kinerary-cp/api:aaaaaaa"]
        self.assertEqual(vr.images_to_prune(tags, ["bbbbbbb"]), ["kinerary-cp/api:aaaaaaa", "kinerary-cp/whatsapp-bridge:aaaaaaa"])


class ReleaseToolOn(ReleaseWorld):
    def setUp(self):
        super().setUp()
        self.enable()
        self.cp.web_in_compose = lambda full: False
        self.cp.whatsapp_in_compose = lambda full: True

    def test_every_compose_call_carries_the_overlay_right_after_the_main_file(self):
        for args in (("up", "-d", "--wait", "--remove-orphans", "api"), ("stop", "relay"), ("run", "--rm", "--no-deps", "migrate"),
                     ("config", "-q"), ("up", "-d", "--wait", "hermes")):
            argv = self.cp.compose(*args)
            self.assertEqual(argv[3:7], [str(self.checkout / "compose.vm.yml"), "-f", str(self.checkout / vr.WHATSAPP_OVERLAY), "--env-file"], argv)
            self.assertEqual(argv[-len(args):], list(args))

    def test_the_overlay_is_left_out_when_the_checkout_has_none(self):
        (self.checkout / vr.WHATSAPP_OVERLAY).unlink()
        self.assertNotIn("-f " + str(self.checkout / vr.WHATSAPP_OVERLAY), " ".join(self.cp.compose("up")))
        self.assertEqual(self.cp.compose("up").count("-f"), 1)

    def test_a_dry_run_asks_git_about_the_target_because_it_never_checks_it_out(self):
        (self.checkout / vr.WHATSAPP_OVERLAY).unlink()          # the OLD checkout still on disk
        self.cp.dry_run = True
        self.cp.target_full = "a" * 40
        self.assertEqual(self.cp.compose("up").count("-f"), 2)
        self.cp.whatsapp_in_compose = lambda full: False
        self.assertEqual(self.cp.compose("up").count("-f"), 1)

    def test_the_bridge_image_joins_the_release_only_when_the_target_has_the_overlay(self):
        full = "a" * 40
        self.assertEqual(self.cp.kinerary_images("abc1234", full)[-1], "kinerary-cp/whatsapp-bridge:abc1234")
        self.cp.whatsapp_in_compose = lambda f: False      # a rollback target from before the overlay
        self.assertEqual(len(self.cp.kinerary_images("abc1234", full)), 3)
        self.assertEqual(len(self.cp.kinerary_images("abc1234")), 3, "no revision, no bridge image")

    def build(self, **kwargs):
        built = []
        real = vr.subprocess.run
        vr.subprocess.run = lambda argv, **kw: built.append(list(argv)) or subprocess.CompletedProcess(argv, 0, b"", b"")
        self.cp.image_exists = kwargs.pop("exists", lambda tag: False)
        try:
            self.cp.build_images("a" * 40, "abc1234", **kwargs)
        finally:
            vr.subprocess.run = real
        return {argv[argv.index("-t") + 1]: argv for argv in built}

    def test_the_bridge_is_built_from_its_own_directory(self):
        by_tag = self.build()
        argv = by_tag["kinerary-cp/whatsapp-bridge:abc1234"]
        self.assertEqual((argv[3], argv[-1]), ("control-plane/whatsapp-bridge/Dockerfile", "control-plane/whatsapp-bridge"))
        self.assertEqual(len(by_tag), 4)

    def test_a_rollback_builds_only_the_bridge_when_it_alone_is_missing(self):
        self.cp.image_exists = lambda tag: "whatsapp-bridge" not in tag
        required, build = self.cp.rollback_image_plan("abc1234", "a" * 40)
        self.assertEqual(build, ["kinerary-cp/whatsapp-bridge:abc1234"])
        self.assertEqual(len(required), 3)
        by_tag = self.build(only=build, exists=lambda tag: "whatsapp-bridge" not in tag)
        self.assertEqual(list(by_tag), ["kinerary-cp/whatsapp-bridge:abc1234"])

    def test_a_missing_core_image_still_refuses_a_rollback(self):
        self.cp.image_exists = lambda tag: "worker" not in tag
        required, build = self.cp.rollback_image_plan("abc1234", "a" * 40)
        self.assertIn("kinerary-cp/worker:abc1234", required)
        self.assertEqual(build, [])

    def test_a_present_bridge_image_is_required_like_any_other(self):
        self.cp.image_exists = lambda tag: True
        required, build = self.cp.rollback_image_plan("abc1234", "a" * 40)
        self.assertEqual((len(required), build), (4, []))

    # ---- the order of the switch ----
    def switch(self, *, restart_hermes: bool, fail=()):
        self.sh.fail = set(fail)
        self.cp.running_gateways = lambda: vr.Gateways([], [], [], [], None)
        self.cp.restart_gateways = lambda found: None
        self.cp.record_gateway_offsets = lambda: None
        self.cp.expected_profiles = lambda: []
        self.cp.wait_for_registrations = lambda profiles: None
        self.cp.start_switched("def5678" if restart_hermes else None, restart_hermes=restart_hermes)
        return [" ".join(a) for a in self.sh.executed]

    def test_the_bridge_comes_up_after_the_core_services_and_before_the_relay_either_way(self):
        for hermes in (False, True):
            self.sh.executed.clear()
            executed = self.switch(restart_hermes=hermes)
            up = next(i for i, a in enumerate(executed) if "up -d --wait" in a and "companion-mcp" in a)
            bridge = next(i for i, a in enumerate(executed) if a.endswith("up -d --no-deps whatsapp-bridge"))
            relay = next(i for i, a in enumerate(executed) if "vm-relay-restart.sh" in a)
            self.assertLess(up, bridge, executed)
            self.assertLess(bridge, relay, executed)
            if not hermes:
                self.assertLess(bridge, next(i for i, a in enumerate(executed) if a.endswith(" stop relay")), executed)
            # the bridge is NOT in the --wait list: an unpaired bridge exits 3 and --wait would fail the release.
            self.assertFalse([a for a in executed if "--wait" in a and "whatsapp-bridge" in a], executed)
            self.assertIn(vr.WHATSAPP_OVERLAY, executed[bridge])

    def test_a_bridge_that_will_not_start_is_a_warning_and_the_release_goes_on(self):
        executed = self.switch(restart_hermes=False, fail=("whatsapp-bridge",))
        self.assertTrue(any("vm-relay-restart.sh" in a for a in executed), "the relay still restarts")
        self.assertIn("WARNING: the WhatsApp bridge did not start", self.said())

    def test_a_dry_run_says_what_it_would_do_to_the_bridge(self):
        self.cp.dry_run = True
        self.sh.dry_run = True
        self.cp.target_full = "a" * 40
        self.cp.start_whatsapp()
        self.assertIn("would run: compose up -d --no-deps whatsapp-bridge  (downtime: WhatsApp pauses while it restarts; Telegram is untouched)",
                      self.said())
        self.assertEqual(self.sh.executed, [])

    def test_the_overlay_is_validated_with_the_target_s_own_compose_file(self):
        seen = []

        class Git(Quiet):
            def read(inner, argv, **kwargs):
                argv = [str(a) for a in argv]
                seen.append(argv)
                if argv[:2] == ["git", "show"]:
                    path = argv[2].split(":", 1)[1]
                    return subprocess.CompletedProcess(argv, 0, (self.checkout / Path(path).name).read_bytes(), b"")
                return subprocess.CompletedProcess(argv, 0, b"", b"")

        self.cp.sh = Git(report=self.cp.r)
        self.cp.validate_compose("a" * 40)
        config = next(a for a in seen if a[:2] == ["docker", "compose"])
        self.assertEqual(config.count("-f"), 2, config)
        self.assertEqual(config[-2:], ["config", "-q"])
        self.assertTrue(any(a[:2] == ["git", "show"] and a[2].endswith(vr.WHATSAPP_OVERLAY) for a in seen))
        self.assertTrue(any(l.startswith("  ✓ the target's compose.vm.yml validates") for l in self.said().splitlines()), self.said())


class GuardBeforeTheSwitch(ReleaseWorld):
    def setUp(self):
        super().setUp()
        self.enable()
        self.cp.whatsapp_in_compose = lambda full: True
        self.profile = self.dir / "profile.json"
        self.write_profile()
        self.set_env("KINERARY_REV=abc1234", "WHATSAPP_BRIDGE_ENABLED=1", f"WHATSAPP_SESSION_DIR={self.session}",
                     f"KINERARY_ARCHITECTURE_PROFILE={self.profile}")
        patcher = mock.patch.object(vr, "WHATSAPP_BRIDGE_UID", os.getuid())
        patcher.start()
        self.addCleanup(patcher.stop)

    def write_profile(self, **block):
        base = {"bridge_url": "http://127.0.0.1:4340", "bridge_secret_ref": "file:///run/secrets/whatsapp_bridge_secret",
                "sender_id_secret_ref": "file:///run/secrets/whatsapp_sender_id_key", "number": "15555550123"}
        self.profile.write_text(json.dumps({"relay": {"whatsapp": {**base, **block}}}))

    def test_a_whole_configuration_passes_and_prints_no_value(self):
        self.write_secrets()
        self.cp.guard_whatsapp("f" * 40)
        self.assertEqual(self.cp.r.failures, 0, self.said())
        self.assertIn("the two secrets and the session directory are in place", self.said())
        for name in vr.WHATSAPP_SECRET_NAMES:
            self.assertNotIn((self.secrets / name).read_text(), self.said())
        self.assertIn("not paired yet", self.said())          # no creds.json: a warning, never a refusal

    def test_a_paired_session_says_nothing_about_pairing(self):
        self.write_secrets()
        (self.session / "creds.json").write_text("{}")
        self.cp.guard_whatsapp("f" * 40)
        self.assertNotIn("not paired", self.said())

    def test_a_missing_or_loose_or_short_or_equal_secret_refuses_the_plan_by_name(self):
        self.cp.guard_whatsapp("f" * 40)
        self.assertEqual(self.cp.r.failures, 2, self.said())
        self.assertIn("whatsapp_bridge_secret is missing or unreadable", self.said())
        self.write_secrets(mode=0o644)
        self.cp.r.failures = 0
        self.cp.guard_whatsapp("f" * 40)
        self.assertEqual(self.cp.r.failures, 2)
        self.assertIn("readable by group or others", self.said())
        for name in vr.WHATSAPP_SECRET_NAMES:
            (self.secrets / name).write_text("short")
            os.chmod(self.secrets / name, 0o600)
        self.cp.r.failures = 0
        self.cp.guard_whatsapp("f" * 40)
        self.assertIn("at least 32", self.said())
        for name in vr.WHATSAPP_SECRET_NAMES:
            (self.secrets / name).write_text("x" * 40)
        self.cp.r.failures = 0
        self.cp.guard_whatsapp("f" * 40)
        self.assertIn("hold the same value", self.said())
        self.assertNotIn("x" * 40, self.said())

    def test_a_session_directory_that_is_unset_missing_or_inside_a_work_tree_refuses_the_plan(self):
        self.write_secrets()
        for env, expect in ((["KINERARY_REV=abc1234", "WHATSAPP_BRIDGE_ENABLED=1"], "WHATSAPP_SESSION_DIR is not set"),
                            (["KINERARY_REV=abc1234", "WHATSAPP_BRIDGE_ENABLED=1", f"WHATSAPP_SESSION_DIR={self.dir}/nope"], "does not exist"),
                            (["KINERARY_REV=abc1234", "WHATSAPP_BRIDGE_ENABLED=1", "WHATSAPP_SESSION_DIR=relative/dir"], "absolute")):
            self.set_env(*env)
            self.out.truncate(0); self.out.seek(0)
            self.cp.r.failures = 0
            self.cp.guard_whatsapp("f" * 40)
            self.assertEqual(self.cp.r.failures, 1, self.said())
            self.assertIn(expect, self.said())
        tree = self.dir / "work"
        (tree / ".git").mkdir(parents=True)
        inside = tree / "state"
        inside.mkdir()
        os.chmod(inside, 0o700)
        self.set_env("KINERARY_REV=abc1234", "WHATSAPP_BRIDGE_ENABLED=1", f"WHATSAPP_SESSION_DIR={inside}")
        self.out.truncate(0); self.out.seek(0)
        self.cp.r.failures = 0
        self.cp.guard_whatsapp("f" * 40)
        self.assertIn("inside a git work tree", self.said())
        self.assertGreaterEqual(self.cp.r.failures, 1)

    def test_a_session_directory_open_to_others_or_owned_by_another_uid_refuses_the_plan(self):
        self.write_secrets()
        os.chmod(self.session, 0o755)
        self.cp.guard_whatsapp("f" * 40)
        self.assertIn("readable by group or others", self.said())
        os.chmod(self.session, 0o700)
        with mock.patch.object(vr, "WHATSAPP_BRIDGE_UID", os.getuid() + 1):
            self.out.truncate(0); self.out.seek(0)
            self.cp.r.failures = 0
            self.cp.guard_whatsapp("f" * 40)
        self.assertIn("not " + str(os.getuid() + 1), self.said())

    def test_a_profile_that_leaves_the_bridge_unused_is_a_warning_not_a_refusal(self):
        self.write_secrets()
        for block, expect in (({"bridge_url": "http://127.0.0.1:4999"}, "bridge_url is not http://127.0.0.1:4340"),
                              ({"bridge_secret_ref": "file:///run/secrets/other"}, "bridge_secret_ref"),
                              ({"number": "+1 555"}, "number is not digits only")):
            self.write_profile(**block)
            self.out.truncate(0); self.out.seek(0)
            self.cp.r.failures = 0
            self.cp.guard_whatsapp("f" * 40)
            self.assertEqual(self.cp.r.failures, 0, self.said())
            self.assertIn(expect, self.said())
            self.assertIn("Telegram is unaffected", self.said())
        self.profile.write_text(json.dumps({"relay": {}}))
        self.out.truncate(0); self.out.seek(0)
        self.cp.guard_whatsapp("f" * 40)
        self.assertIn("no relay.whatsapp block", self.said())

    def test_a_rollback_refuses_for_a_missing_secret_but_only_warns_about_the_session(self):
        # The relay is recreated WITH the secrets on the way back, so a missing file must stop it before the switch;
        # a session directory problem affects the bridge alone and must not hold Telegram's rollback.
        self.cp.guard_whatsapp("f" * 40, rollback=True)
        self.assertGreaterEqual(self.cp.r.failures, 2, self.said())
        self.write_secrets()
        os.chmod(self.session, 0o755)
        self.cp.r.failures = 0
        self.out.truncate(0); self.out.seek(0)
        self.cp.guard_whatsapp("f" * 40, rollback=True)
        self.assertEqual(self.cp.r.failures, 0, self.said())
        self.assertIn("Telegram's rollback goes on", self.said())
        source = (DEPLOYMENT / "vm-release.py").read_text()
        self.assertIn("cp.guard_whatsapp(full, rollback=True)", source)

    def test_the_relay_restart_script_looks_for_the_two_secrets_before_it_removes_the_running_relay(self):
        text = (DEPLOYMENT / "vm-relay-restart.sh").read_text()
        self.assertLess(text.index("whatsapp_bridge_secret whatsapp_sender_id_key"), text.index("up -d --force-recreate"))

    def test_the_example_profile_block_in_the_runbook_passes_the_profile_check(self):
        # The snippet in docs/control-plane-vm-deployment.md is what an operator copies; it must satisfy this check.
        text = (ROOT / "docs" / "control-plane-vm-deployment.md").read_text()
        section = text[text.index("## WhatsApp (optional)"):]
        block = json.loads(re.search(r"```json\n(\{\s*\"relay\".*?\n\})\n```", section, re.S).group(1))
        self.assertEqual(vr.whatsapp_profile_problems({}, block), [])
        self.assertEqual(block["relay"]["whatsapp"]["number"], "15555550123")


class RunbookBlockAgainstTheRealSchema(unittest.TestCase):
    def test_the_runbook_block_merged_into_the_local_example_is_accepted_and_not_set_aside(self):
        api = ROOT / "control-plane" / "api"
        if not (api / "node_modules" / "zod").exists() or not shutil.which("node"):
            self.skipTest("control-plane/api has no node_modules (npm ci) - schema NOT checked")
        text = (ROOT / "docs" / "control-plane-vm-deployment.md").read_text()
        section = text[text.index("## WhatsApp (optional)"):]
        snippet = json.loads(re.search(r"```json\n(\{\s*\"relay\".*?\n\})\n```", section, re.S).group(1))
        profile = json.loads((ROOT / "control-plane" / "config" / "architecture.local.example.json").read_text())
        profile["relay"] = {**profile.get("relay", {}), **snippet["relay"]}
        path = _tmp / "profile-with-whatsapp.json"
        path.write_text(json.dumps(profile))
        script = ("import { readFileSync } from 'node:fs';"
                  "import { validateArchitectureProfile, whatsappPortalSettings } from './src/config.ts';"
                  f"const p = validateArchitectureProfile(JSON.parse(readFileSync({json.dumps(str(path))}, 'utf8')));"
                  "if (p.relay.whatsapp_invalid) throw new Error('block set aside: ' + JSON.stringify(p.relay.whatsapp_invalid));"
                  "if (!p.relay.whatsapp) throw new Error('no block');"
                  "console.log(JSON.stringify({ bridge: p.relay.whatsapp.bridge_url, settings: whatsappPortalSettings(p) }));")
        proc = subprocess.run(["node", "--import", "tsx", "--input-type=module", "-e", script], cwd=str(api), capture_output=True, timeout=120)
        self.assertEqual(proc.returncode, 0, proc.stderr.decode()[-800:])
        self.assertIn(b"http://127.0.0.1:4340", proc.stdout)


class BridgeServer:
    """A loopback server that answers /health like the bridge does (with `own`, the bot's full number)."""

    NUMBER = "15555550123"

    def __init__(self, state="connected", status=200, secret=None):
        outer = self
        self.seen = []
        self.state, self.status, self.secret = state, status, secret

        class Handler(http.server.BaseHTTPRequestHandler):
            def do_GET(self):
                outer.seen.append((self.path, self.headers.get("Authorization")))
                if outer.secret and self.headers.get("Authorization") != f"Bearer {outer.secret}":
                    self.send_response(401)
                    self.end_headers()
                    return
                body = json.dumps({"state": outer.state, "own": {"lid": f"{BridgeServer.NUMBER}@lid", "phone": f"{BridgeServer.NUMBER}@s.whatsapp.net"},
                                   "epoch": "e", "lastSeq": 3, "buffered": 0}).encode()
                self.send_response(outer.status)
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                self.wfile.write(body)

            def log_message(self, *args):
                pass

        self.server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.port = self.server.server_address[1]
        threading.Thread(target=self.server.serve_forever, daemon=True).start()

    def close(self):
        self.server.shutdown()
        self.server.server_close()


class VerifyWithTheBridge(ReleaseWorld):
    RUNNING = {"kinerary-cp-whatsapp-bridge-1": "kinerary-cp/whatsapp-bridge:abc1234"}
    GOOD = [{"event": "relay.whatsapp", "configured": True}, {"event": "whatsapp.bridge_state", "state": "connected"}]

    def start(self, **kwargs) -> BridgeServer:
        self.write_secrets()
        secret = (self.secrets / vr.WHATSAPP_SECRET_NAMES[0]).read_text().strip()
        server = BridgeServer(secret=secret, **kwargs)
        self.addCleanup(server.close)
        self.enable(f"WHATSAPP_BRIDGE_PORT={server.port}")
        self.secret = secret
        return server

    def verify(self, running=None, events=None):
        findings = vr.Findings()
        self.cp.verify_whatsapp(findings, self.RUNNING if running is None else running, "abc1234", self.GOOD if events is None else events)
        return findings

    @staticmethod
    def text(findings):
        return "\n".join(i if isinstance(i, str) else i.text for i in findings.items)

    def test_a_connected_bridge_is_reported_with_the_state_and_the_relay_lines(self):
        server = self.start()
        findings = self.verify()
        text = self.text(findings)
        self.assertEqual(findings.checks, [], "bridge findings are notes, never checks")
        self.assertIn("bridge kinerary-cp/whatsapp-bridge:abc1234 is connected", text)
        self.assertIn("relay.whatsapp configured:true", text)
        self.assertIn("whatsapp.bridge_state connected", text)
        self.assertNotIn("WARNING", text)
        self.assertEqual(server.seen, [("/health", f"Bearer {self.secret}")])

    def test_the_bots_number_and_the_secret_are_in_nothing_that_is_printed_or_kept(self):
        self.start()
        findings = self.verify()
        everything = self.text(findings) + self.said() + repr(findings.items)
        self.assertNotIn(BridgeServer.NUMBER, everything)
        self.assertNotIn(self.secret, everything)

    def test_the_state_is_taken_from_an_allow_list_and_nothing_else_is_echoed(self):
        self.start(state="<script>do not echo me</script>")
        text = self.text(self.verify())
        self.assertIn("state is unrecognised", text)
        self.assertNotIn("do not echo", text)

    def test_an_unpaired_bridge_is_a_loud_warning_and_not_a_failed_check(self):
        self.start(state="unpaired", status=503)
        findings = self.verify()
        self.assertEqual([c for c in findings.checks if not c.ok], [])
        self.assertIn("WARNING: the WhatsApp bridge is unpaired", self.text(findings))
        self.assertIn("Telegram is not", self.text(findings))

    def test_a_logged_out_bridge_is_a_warning_too(self):
        self.start(state="logged_out")
        findings = self.verify()
        self.assertEqual(findings.checks, [])
        self.assertIn("WARNING: the WhatsApp bridge is LOGGED OUT", self.text(findings))

    def test_a_connecting_bridge_is_given_time_and_then_reported(self):
        server = self.start(state="connecting")
        text = self.text(self.verify())
        self.assertEqual(len(server.seen), 1 + vr.WHATSAPP_STATE_POLLS, "bounded")
        self.assertIn("state is connecting", text)

    def test_a_wrong_secret_is_named_without_showing_either(self):
        self.start()
        (self.secrets / vr.WHATSAPP_SECRET_NAMES[0]).write_text("w" * 40)
        text = self.text(self.verify())
        self.assertIn("refused the bearer secret", text)
        self.assertNotIn("w" * 40, text)
        self.assertNotIn(self.secret, text)

    def test_a_bridge_that_is_not_running_or_not_answering_is_a_warning(self):
        self.start()
        text = self.text(self.verify(running={}))
        self.assertIn("WARNING: the WhatsApp bridge is NOT RUNNING", text)
        self.enable("WHATSAPP_BRIDGE_PORT=1")
        text = self.text(self.verify())
        self.assertIn("WARNING: the WhatsApp bridge is up but /health did not answer", text)

    def test_a_relay_without_whatsapp_is_a_warning_naming_the_field_never_a_value(self):
        self.start()
        events = [{"event": "relay.whatsapp", "configured": False},
                  {"event": "relay.whatsapp_disabled", "field": "relay.whatsapp.bridge_secret_ref", "reason": "could not be resolved"}]
        findings = self.verify(events=events)
        self.assertEqual(findings.checks, [])
        self.assertIn("WARNING: the relay did not log relay.whatsapp configured:true (relay.whatsapp.bridge_secret_ref could not be resolved)",
                      self.text(findings))

    def test_a_relay_that_has_not_reached_the_bridge_is_a_warning(self):
        self.start()
        findings = self.verify(events=[{"event": "relay.whatsapp", "configured": True}])
        self.assertIn("has not logged whatsapp.bridge_state yet", self.text(findings))
        findings = self.verify(events=[{"event": "relay.whatsapp", "configured": True}, {"event": "whatsapp.bridge_state", "state": "unavailable"}])
        self.assertIn("last whatsapp.bridge_state is unavailable", self.text(findings))

    def test_a_stale_image_is_a_warning_and_a_version_without_the_overlay_is_noted(self):
        self.start()
        self.assertIn("runs kinerary-cp/whatsapp-bridge:0000000, not revision abc1234",
                      self.text(self.verify(running={"kinerary-cp-whatsapp-bridge-1": "kinerary-cp/whatsapp-bridge:0000000"})))
        (self.checkout / vr.WHATSAPP_OVERLAY).unlink()
        self.assertIn("this version has no WhatsApp bridge", self.text(self.verify()))

    def test_core_checks_call_it_and_off_it_adds_nothing(self):
        # verify_whatsapp is wired into the verify run, and a stack without WhatsApp prints nothing about it.
        source = (DEPLOYMENT / "vm-release.py").read_text()
        self.assertIn("self.verify_whatsapp(f, running, rev, events)", source)
        self.set_env("KINERARY_REV=abc1234")
        findings = self.verify()
        self.assertEqual(findings.items, [])


class PairingScript(unittest.TestCase):
    def test_it_refuses_without_the_env_files_named(self):
        proc = subprocess.run([BASH, str(PAIR)], capture_output=True, text=True, env={"PATH": os.environ["PATH"]})
        self.assertNotEqual(proc.returncode, 0)
        self.assertIn("KINERARY_PROVISIONING_ENV", proc.stderr)

    @unittest.skipUnless(BASH, "no bash")
    def test_it_refuses_when_whatsapp_is_not_switched_on_or_the_session_dir_is_unset(self):
        work = Path(tempfile.mkdtemp(prefix="vm-whatsapp-pair-"))
        self.addCleanup(shutil.rmtree, work, ignore_errors=True)
        for name in ("provisioning.env", "vm.env"):
            (work / name).write_text("UNRELATED=1\n")
        env = {"PATH": os.environ["PATH"], "KINERARY_PROVISIONING_ENV": str(work / "provisioning.env"),
               "KINERARY_VM_ENV": str(work / "vm.env"), "VM_COMPOSE_READ": "cat"}
        off = subprocess.run([BASH, str(PAIR)], capture_output=True, text=True, env=env)
        self.assertEqual(off.returncode, 1)
        self.assertIn("WhatsApp is not switched on", off.stderr)
        (work / "vm.env").write_text("WHATSAPP_BRIDGE_ENABLED=1\n")
        unset = subprocess.run([BASH, str(PAIR)], capture_output=True, text=True, env=env)
        self.assertEqual(unset.returncode, 1)
        self.assertIn("WHATSAPP_SESSION_DIR is not set", unset.stderr)
        (work / "vm.env").write_text(f"WHATSAPP_BRIDGE_ENABLED=1\nWHATSAPP_SESSION_DIR={work}\n")
        (work / ".git").mkdir()
        tree = subprocess.run([BASH, str(PAIR)], capture_output=True, text=True, env=env)
        self.assertEqual(tree.returncode, 1)
        self.assertIn("inside a git work tree", tree.stderr)

    def test_it_stops_the_serving_bridge_first_and_starts_it_again_even_when_pairing_fails(self):
        text = PAIR.read_text()
        self.assertLess(text.index('compose stop "$SERVICE"'), text.index('compose run --rm --no-deps "$SERVICE"'))
        self.assertIn("restore failed", text)
        self.assertIn("--pair-only", text)
        self.assertIn("unlink", text)


if __name__ == "__main__":
    unittest.main()
