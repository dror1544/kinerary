"""The organizer portal and the runtime gateway on the control-plane VM: dark by default.

What is pinned here, and why each is a way this could fail without anyone noticing:

- web/nginx.conf is a template the nginx image renders. Its asset-cache location
  regex has a `{8,}` in it, and unquoted nginx reads the brace as a block opening
  and refuses to start (issue #441) - a portal that never came up, found on the
  VM. The /v1 target is a variable, not a host name hard-coded in the image.
- compose.vm.yml parses with and without the `web` profile, and switching the
  profile on ADDS the two services and changes nothing else: "dark by default"
  means the existing stack is byte-for-byte what it was.
- the release tool follows the same switch: images, compose commands, verify and
  the pre-switch configuration guard all key off COMPOSE_PROFILES in the env
  files, and do nothing at all when it is off.
- architecture.vm-web.example.json is the VM's existing example plus a `web`
  block, so it cannot drift from the profile the stack actually mounts.

The compose and nginx checks use docker and say so when it is not there. A
compose older than 2.24 does not know `env_file: - path:`, which compose.vm.yml
has used since before this change, so the file is rendered through a copy with
those two entries replaced by plain ones (the paths are /opt/... on the VM and
do not exist anywhere else); everything else in it is read as written.
"""
from __future__ import annotations

import importlib.util
import io
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
DEPLOYMENT = ROOT / "control-plane" / "deployment"
COMPOSE = DEPLOYMENT / "compose.vm.yml"
NGINX_TEMPLATE = ROOT / "web" / "nginx.conf"
WEB_DOCKERFILE = ROOT / "web" / "Dockerfile"
GATEWAY_DOCKERFILE = ROOT / "control-plane" / "runtime-gateway" / "Dockerfile"
VM_WEB_PROFILE = DEPLOYMENT / "architecture.vm-web.example.json"
LOCAL_PROFILE = ROOT / "control-plane" / "config" / "architecture.local.example.json"
NGINX_IMAGE = "nginx:stable-alpine"
DOCKER = shutil.which("docker")

_tmp = Path(tempfile.mkdtemp(prefix="vm-web-test-"))
for key, sub in (("KINERARY_CP_STATE_DIR", "state"), ("KINERARY_CP_BACKUP_DIR", "backups"), ("KINERARY_CP_LOG_DIR", "log")):
    os.environ[key] = str(_tmp / sub)
_spec = importlib.util.spec_from_file_location("vm_release_web", DEPLOYMENT / "vm-release.py")
vr = importlib.util.module_from_spec(_spec)
sys.modules["vm_release_web"] = vr
_spec.loader.exec_module(vr)


def docker_works(*args: str) -> bool:
    if not DOCKER:
        return False
    return subprocess.run([DOCKER, *args], capture_output=True, timeout=60).returncode == 0


HAVE_COMPOSE = docker_works("compose", "version")
HAVE_NGINX = docker_works("image", "inspect", NGINX_IMAGE)

# What a VM's vm.env must hold for compose.vm.yml to parse at all (the `:?` ones).
BASE_ENV = {
    "KINERARY_REV": "abc1234", "HERMES_REV": "def5678", "INTERPRET_PATH_DEFAULT": "1",
    "INTERPRET_RUNNER": "claude", "EXTRACT_RUNNER": "claude", "INTERVIEW_MCP_KEY": "k-interview",
    "CONTROL_PLANE_INTERVIEW_AGENT_KEY": "k-agent",
}
WEB_ENV = {
    "COMPOSE_PROFILES": "web", "PORTAL_ORIGIN": "https://portal.example.com", "RUNTIME_ORIGIN": "https://runtime.example.com",
    "RUNTIME_EXCHANGE_KEY": "exchange-key-value", "RUNTIME_COOKIE_SECRET": "cookie-secret-value",
}


def shimmed_compose(workdir: Path) -> Path:
    """compose.vm.yml with its two `env_file: - path:` entries made plain and local."""
    text = COMPOSE.read_text()
    for name in ("claude.env", "openrouter.env"):
        (workdir / name).write_text("")
    text = re.sub(r"(?m)^(\s+)- path: /opt/agent-auth/(\S+)\n(?:\s+required: false\n)?",
                  lambda m: f"{m.group(1)}- {workdir / m.group(2)}\n", text)
    path = workdir / "compose.vm.yml"
    path.write_text(text)
    return path


def compose_json(env: dict, *, profile_flag: bool = False) -> dict:
    """`docker compose config` of compose.vm.yml under a dummy env file, as parsed JSON."""
    workdir = Path(tempfile.mkdtemp(prefix="vm-web-compose-"))
    try:
        compose = shimmed_compose(workdir)
        (workdir / "vm.env").write_text("".join(f"{k}={v}\n" for k, v in env.items()))
        (workdir / "provisioning.env").write_text("UNRELATED=1\n")
        argv = [DOCKER, "compose", "--project-directory", str(DEPLOYMENT), "-f", str(compose),
                "--env-file", str(workdir / "provisioning.env"), "--env-file", str(workdir / "vm.env"),
                *(["--profile", "web"] if profile_flag else []), "config", "--format", "json"]
        proc = subprocess.run(argv, capture_output=True, timeout=120)
        if proc.returncode != 0:
            raise AssertionError(f"docker compose config failed: {proc.stderr.decode()[-600:]}")
        return json.loads(proc.stdout)
    finally:
        shutil.rmtree(workdir, ignore_errors=True)


class NginxTemplate(unittest.TestCase):
    def test_the_asset_location_regex_is_quoted(self):
        # Issue #441: unquoted, `{8,}` ends the pattern and nginx will not start.
        lines = [l for l in NGINX_TEMPLATE.read_text().splitlines() if re.match(r"\s*location\s+~", l)]
        self.assertTrue(lines, "no regex location found - did the asset cache block move?")
        for line in lines:
            pattern = re.match(r"\s*location\s+~\*?\s+(.*?)\s*\{\s*$", line)
            self.assertIsNotNone(pattern, line)
            pattern = pattern.group(1)
            self.assertTrue(pattern.startswith('"') and pattern.endswith('"') or pattern.startswith("'") and pattern.endswith("'"),
                            f"regex location is not quoted: {line.strip()}")

    def test_the_api_target_is_configuration_not_a_host_name(self):
        text = NGINX_TEMPLATE.read_text()
        self.assertIn("${CONTROL_PLANE_API_ORIGIN}", text)
        self.assertNotRegex(text, r"proxy_pass\s+https?://", "a literal proxy_pass is resolved once and goes stale when the api is recreated")
        self.assertIn("resolver ${NGINX_LOCAL_RESOLVERS}", text)

    def test_the_image_renders_the_template_and_substitutes_only_what_it_names(self):
        dockerfile = WEB_DOCKERFILE.read_text()
        self.assertIn("/etc/nginx/templates/default.conf.template", dockerfile)
        self.assertNotIn("/etc/nginx/conf.d/default.conf", dockerfile)
        # Unfiltered, envsubst would also eat any nginx $variable that shares a name with an env var.
        self.assertRegex(dockerfile, r"NGINX_ENVSUBST_FILTER=.*CONTROL_PLANE_API_ORIGIN.*NGINX_LOCAL_RESOLVERS")
        self.assertIn("NGINX_ENTRYPOINT_LOCAL_RESOLVERS=1", dockerfile)

    def test_the_image_builds_from_the_repository_root_and_brings_what_the_stylesheet_imports(self):
        # `docker build web/` fails at `npm run build`: styles.css imports ../../shared/brand-tokens.css.
        dockerfile = WEB_DOCKERFILE.read_text()
        for css in (ROOT / "web" / "src").rglob("*.css"):
            for target in re.findall(r'@import\s+["\']((?:\.\./)+shared/[^"\']+)["\']', css.read_text()):
                name = target.split("shared/", 1)[1]
                self.assertIn(f"COPY shared/{name} ", dockerfile, f"{css.name} imports {target}")
        self.assertIn("COPY web/ ", dockerfile)
        compose = COMPOSE.read_text()
        block = compose[compose.index("  portal:"):compose.index("  runtime-gateway:")]
        self.assertRegex(block, r"context: \.\./\.\.\s+dockerfile: web/Dockerfile")

    def nginx_t(self, template_text: str) -> subprocess.CompletedProcess:
        workdir = Path(tempfile.mkdtemp(prefix="vm-web-nginx-"))
        try:
            template = workdir / "default.conf.template"
            template.write_text(template_text)
            env = ["-e", "CONTROL_PLANE_API_ORIGIN=http://api:4310", "-e", "NGINX_ENTRYPOINT_LOCAL_RESOLVERS=1",
                   "-e", "NGINX_ENVSUBST_FILTER=^(CONTROL_PLANE_API_ORIGIN|NGINX_LOCAL_RESOLVERS)$"]
            return subprocess.run(
                [DOCKER, "run", "--rm", *env, "-v", f"{template}:/etc/nginx/templates/default.conf.template:ro",
                 "--entrypoint", "/docker-entrypoint.sh", NGINX_IMAGE, "nginx", "-t"],
                capture_output=True, timeout=120)
        finally:
            shutil.rmtree(workdir, ignore_errors=True)

    @unittest.skipUnless(HAVE_NGINX, f"docker with the {NGINX_IMAGE} image is not available - `nginx -t` NOT run")
    def test_nginx_accepts_the_rendered_template_and_still_refuses_the_unquoted_one(self):
        good = self.nginx_t(NGINX_TEMPLATE.read_text())
        self.assertEqual(good.returncode, 0, good.stderr.decode()[-800:])
        # The check can fail: put the old line back and the same command refuses it.
        unquoted = re.sub(r'location ~\* "(.*)" \{', r"location ~* \1 {", NGINX_TEMPLATE.read_text())
        self.assertNotEqual(unquoted, NGINX_TEMPLATE.read_text())
        bad = self.nginx_t(unquoted)
        self.assertNotEqual(bad.returncode, 0)
        self.assertIn("unknown directive", bad.stderr.decode())


@unittest.skipUnless(HAVE_COMPOSE, "docker compose is not available - compose.vm.yml NOT validated")
class ComposeProfile(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.without = compose_json(BASE_ENV)
        cls.with_env = compose_json({**BASE_ENV, **WEB_ENV})
        cls.with_flag = compose_json({**BASE_ENV, **{k: v for k, v in WEB_ENV.items() if k != "COMPOSE_PROFILES"}}, profile_flag=True)

    def test_off_by_default_the_two_services_do_not_exist(self):
        self.assertNotIn("portal", self.without["services"])
        self.assertNotIn("runtime-gateway", self.without["services"])

    def test_on_adds_exactly_the_two_services_and_nothing_else_moves(self):
        added = set(self.with_env["services"]) - set(self.without["services"])
        self.assertEqual(added, {"portal", "runtime-gateway"})
        # The only things that follow the web env are the api's three pass-through variables and
        # the worker's exchange key (both asserted below); every other service is untouched.
        def comparable(name, service):
            service = json.loads(json.dumps(service))
            env = service.get("environment", {})
            if name == "api":
                for key in vr.WEB_API_ENV:
                    env.pop(key, None)
            if name == "worker":
                env.pop("CONTROL_PLANE_EXCHANGE_KEY", None)
            return service
        for name, service in self.without["services"].items():
            self.assertEqual(comparable(name, self.with_env["services"][name]), comparable(name, service),
                             f"{name} changed when the profile came on")

    def test_the_profile_flag_and_the_env_file_agree(self):
        # The release tool passes `--profile web`; a person running compose by hand relies on COMPOSE_PROFILES.
        self.assertEqual(set(self.with_flag["services"]), set(self.with_env["services"]))

    def test_the_worker_gets_the_exchange_key_only_when_one_is_set(self):
        self.assertEqual(self.without["services"]["worker"]["environment"]["CONTROL_PLANE_EXCHANGE_KEY"], "")
        self.assertEqual(self.with_env["services"]["worker"]["environment"]["CONTROL_PLANE_EXCHANGE_KEY"], WEB_ENV["RUNTIME_EXCHANGE_KEY"])

    def test_the_gateway_is_configured_from_env_alone(self):
        env = self.with_env["services"]["runtime-gateway"]["environment"]
        self.assertEqual(env["PORTAL_ORIGIN"], WEB_ENV["PORTAL_ORIGIN"])
        self.assertEqual(env["RUNTIME_ORIGIN"], WEB_ENV["RUNTIME_ORIGIN"])
        self.assertEqual(env["RUNTIME_EXCHANGE_KEY"], WEB_ENV["RUNTIME_EXCHANGE_KEY"])
        self.assertEqual(env["RUNTIME_COOKIE_SECRET"], WEB_ENV["RUNTIME_COOKIE_SECRET"])
        self.assertEqual(env["BIND_HOST"], "0.0.0.0")  # inside its container, for the published port
        self.assertEqual(env["CONTROL_PLANE_INTERNAL_ORIGIN"], "http://api:4310")

    def test_the_portal_proxies_to_the_api_by_service_name(self):
        env = self.with_env["services"]["portal"]["environment"]
        self.assertEqual(env["CONTROL_PLANE_API_ORIGIN"], "http://api:4310")

    def test_both_publish_on_loopback_unless_told_otherwise(self):
        for name in ("portal", "runtime-gateway"):
            ports = self.with_env["services"][name]["ports"]
            self.assertEqual([p["host_ip"] for p in ports], ["127.0.0.1"], name)
        moved = compose_json({**BASE_ENV, **WEB_ENV, "WEB_BIND_IP": "10.9.8.7", "PORTAL_PORT": "9001", "RUNTIME_GATEWAY_PORT": "9002"})
        published = {name: (p["host_ip"], str(p["published"])) for name in ("portal", "runtime-gateway")
                     for p in moved["services"][name]["ports"]}
        self.assertEqual(published, {"portal": ("10.9.8.7", "9001"), "runtime-gateway": ("10.9.8.7", "9002")})

    def test_both_wait_for_the_api_and_are_health_checked(self):
        for name in ("portal", "runtime-gateway"):
            service = self.with_env["services"][name]
            self.assertEqual(service["depends_on"]["api"]["condition"], "service_healthy")
            self.assertIn("healthcheck", service)
            self.assertEqual(service["restart"], "unless-stopped")

    def test_the_images_follow_the_release_revision(self):
        self.assertEqual(self.with_env["services"]["portal"]["image"], "kinerary-cp/portal:abc1234")
        self.assertEqual(self.with_env["services"]["runtime-gateway"]["image"], "kinerary-cp/runtime-gateway:abc1234")

    def test_the_architecture_profile_is_the_repository_example_unless_vm_env_names_another(self):
        default = self.without["configs"]["architecture_profile"]["file"]
        self.assertEqual(Path(default).resolve(), LOCAL_PROFILE.resolve())
        other = compose_json({**BASE_ENV, "KINERARY_ARCHITECTURE_PROFILE": "/srv/profile.json"})
        self.assertEqual(other["configs"]["architecture_profile"]["file"], "/srv/profile.json")

    def test_the_api_receives_what_the_web_block_may_reference(self):
        env = self.with_env["services"]["api"]["environment"]
        for name in vr.WEB_API_ENV:
            self.assertIn(name, env)
        self.assertEqual(env["RUNTIME_EXCHANGE_KEY"], WEB_ENV["RUNTIME_EXCHANGE_KEY"])

    def test_the_web_services_name_nothing_of_this_deployment(self):
        text = COMPOSE.read_text()
        block = text[text.index("  portal:"):text.index("  worker:")]
        body = "\n".join(l for l in block.splitlines() if not l.lstrip().startswith("#"))
        self.assertNotRegex(body, r"/opt/|/Users/|\.local\b|\.lan\b|kinerary-cp-[a-z]+-[0-9]")
        # Fixed addresses are the loopback default and the in-container wildcard only.
        for ip in re.findall(r"\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b", body):
            self.assertIn(ip, ("127.0.0.1", "0.0.0.0"))


class ArchitectureProfile(unittest.TestCase):
    def test_the_vm_web_example_is_the_local_example_plus_a_web_block(self):
        base = json.loads(LOCAL_PROFILE.read_text())
        web = json.loads(VM_WEB_PROFILE.read_text())
        self.assertIn("web", web)
        self.assertEqual({k: v for k, v in web.items() if k != "web"}, base,
                         "the VM's profile and its web variant have drifted - change both together")

    def test_its_secret_references_are_ones_the_stack_provides(self):
        web = json.loads(VM_WEB_PROFILE.read_text())["web"]
        for key, ref in web.items():
            if key.endswith("_secret_ref"):
                self.assertIn(ref.removeprefix("env://") if hasattr(ref, "removeprefix") else ref[len("env://"):], vr.WEB_API_ENV, key)
        self.assertEqual(vr.web_config_problems(
            {**{k: "x" for k in vr.WEB_REQUIRED_ENV}, "PORTAL_ORIGIN": web["public_origin"], "RUNTIME_ORIGIN": web["runtime_origin"]},
            json.loads(VM_WEB_PROFILE.read_text())), [])

    def test_the_example_is_valid_against_the_apis_own_schema(self):
        api = ROOT / "control-plane" / "api"
        if not (api / "node_modules" / "zod").exists() or not shutil.which("node"):
            self.skipTest("control-plane/api has no node_modules (npm ci) - schema NOT checked")
        script = ("import { readFileSync } from 'node:fs';"
                  "import { validateArchitectureProfile } from './src/config.ts';"
                  f"const p = validateArchitectureProfile(JSON.parse(readFileSync({json.dumps(str(VM_WEB_PROFILE))}, 'utf8')));"
                  "if (!p.web) throw new Error('no web block'); console.log('valid');")
        proc = subprocess.run(["node", "--import", "tsx", "--input-type=module", "-e", script], cwd=str(api), capture_output=True, timeout=120)
        self.assertEqual(proc.returncode, 0, proc.stderr.decode()[-800:])
        self.assertIn(b"valid", proc.stdout)


class ReleaseToolFollowsTheProfile(unittest.TestCase):
    def setUp(self):
        self.dir = Path(tempfile.mkdtemp(prefix="vm-web-tool-"))
        self.saved = (vr.PROVISIONING_ENV, vr.VM_ENV, vr.DEPLOYMENT_DIR)
        vr.PROVISIONING_ENV, vr.VM_ENV = self.dir / "provisioning.env", self.dir / "vm.env"
        vr.PROVISIONING_ENV.write_text("UNRELATED=1\n")
        vr.VM_ENV.write_text("KINERARY_REV=abc1234\n")
        self.cp = vr.ControlPlane(vr.Report(io.StringIO(), color=False))

    def tearDown(self):
        vr.PROVISIONING_ENV, vr.VM_ENV, vr.DEPLOYMENT_DIR = self.saved
        shutil.rmtree(self.dir, ignore_errors=True)

    def enable(self, value="web"):
        vr.VM_ENV.write_text(f"KINERARY_REV=abc1234\nCOMPOSE_PROFILES={value}\n")

    def test_profiles_are_read_like_compose_reads_them(self):
        self.assertEqual(vr.compose_profiles("COMPOSE_PROFILES=a,web"), ["a", "web"])
        self.assertEqual(vr.compose_profiles("COMPOSE_PROFILES=web", "COMPOSE_PROFILES="), [], "the later file wins, even when empty")
        self.assertEqual(vr.compose_profiles("COMPOSE_PROFILES=web", "OTHER=1"), ["web"])
        self.assertEqual(vr.compose_profiles(""), [])

    def test_off_means_the_commands_are_exactly_what_they_were(self):
        self.assertFalse(self.cp.web_enabled())
        self.assertNotIn("--profile", self.cp.compose("up", "-d"))
        self.assertEqual(self.cp.web_services(), [])
        self.assertEqual(self.cp.kinerary_images("abc1234", "f" * 40),
                         ["kinerary-cp/api:abc1234", "kinerary-cp/worker:abc1234", "kinerary-cp/agent-runtime:abc1234"])

    def test_a_different_profile_does_not_switch_it_on(self):
        self.enable("debug")
        self.assertFalse(self.cp.web_enabled())
        self.assertNotIn("--profile", self.cp.compose("ps"))

    def test_on_passes_the_profile_to_every_compose_command(self):
        self.enable()
        argv = self.cp.compose("up", "-d", "--wait", "api")
        self.assertEqual(argv[argv.index("--profile") + 1], "web")
        self.assertLess(argv.index("--profile"), argv.index("up"))

    def test_compose_files_are_recognised_by_their_services(self):
        self.assertTrue(vr.compose_defines_web(COMPOSE.read_text()))
        self.assertFalse(vr.compose_defines_web("services:\n  api:\n    image: x\n"))
        self.assertFalse(vr.compose_defines_web("services:\n  portal:\n    image: x\n"), "both services, not one")

    def test_services_to_start_are_those_this_versions_compose_defines(self):
        self.enable()
        vr.DEPLOYMENT_DIR = self.dir
        (self.dir / "compose.vm.yml").write_text("services:\n  api:\n    image: x\n")
        self.assertEqual(self.cp.web_services(), [])
        self.assertIn("no portal or runtime gateway", self.cp.r.stream.getvalue())
        (self.dir / "compose.vm.yml").write_text(COMPOSE.read_text())
        self.assertEqual(self.cp.web_services(), ["portal", "runtime-gateway"])

    def test_a_dry_run_asks_git_about_the_target_because_it_never_checks_it_out(self):
        self.enable()
        self.cp.dry_run = True
        vr.DEPLOYMENT_DIR = self.dir
        (self.dir / "compose.vm.yml").write_text("services:\n  api:\n    image: x\n")  # the OLD checkout still on disk
        self.cp.target_full = "a" * 40
        self.cp.web_in_compose = lambda full: full == "a" * 40
        self.assertEqual(self.cp.web_services(), ["portal", "runtime-gateway"])
        self.cp.web_in_compose = lambda full: False
        self.assertEqual(self.cp.web_services(), [])

    def test_images_join_the_release_only_when_on_and_the_target_has_them(self):
        full = "a" * 40
        has = {"value": True}
        self.cp.web_in_compose = lambda f: has["value"]
        self.assertEqual(len(self.cp.kinerary_images("abc1234", full)), 3)
        self.enable()
        self.assertEqual(self.cp.kinerary_images("abc1234", full)[3:],
                         ["kinerary-cp/portal:abc1234", "kinerary-cp/runtime-gateway:abc1234"])
        has["value"] = False  # a rollback target from before the portal existed
        self.assertEqual(len(self.cp.kinerary_images("abc1234", full)), 3)
        self.assertEqual(len(self.cp.kinerary_images("abc1234")), 3, "no revision, no web images")

    def test_the_web_images_are_built_with_the_contexts_their_dockerfiles_need(self):
        self.enable()
        built = []

        class Quiet:
            def read(self, argv, **kwargs):
                return subprocess.CompletedProcess(argv, 0, b"", b"")
            act = read

        self.cp.sh = Quiet()
        self.cp.git_argv = lambda *a: ["git", *a]
        self.cp.image_exists = lambda tag: False
        self.cp.web_in_compose = lambda full: True
        real_run = vr.subprocess.run
        vr.subprocess.run = lambda argv, **kw: built.append(list(argv)) or subprocess.CompletedProcess(argv, 0, b"", b"")
        try:
            self.cp.build_images("a" * 40, "abc1234")
        finally:
            vr.subprocess.run = real_run
        by_tag = {argv[argv.index("-t") + 1]: argv for argv in built}
        self.assertEqual(sorted(by_tag), ["kinerary-cp/agent-runtime:abc1234", "kinerary-cp/api:abc1234", "kinerary-cp/portal:abc1234",
                                          "kinerary-cp/runtime-gateway:abc1234", "kinerary-cp/worker:abc1234"])
        self.assertEqual((by_tag["kinerary-cp/portal:abc1234"][3], by_tag["kinerary-cp/portal:abc1234"][-1]), ("web/Dockerfile", "."))
        self.assertEqual((by_tag["kinerary-cp/runtime-gateway:abc1234"][3], by_tag["kinerary-cp/runtime-gateway:abc1234"][-1]),
                         ("control-plane/runtime-gateway/Dockerfile", "control-plane/runtime-gateway"))

    def test_with_the_profile_off_nothing_but_the_three_images_is_built(self):
        built = []

        class Quiet:
            def read(self, argv, **kwargs):
                return subprocess.CompletedProcess(argv, 0, b"", b"")
            act = read

        self.cp.sh = Quiet()
        self.cp.git_argv = lambda *a: ["git", *a]
        self.cp.image_exists = lambda tag: False
        real_run = vr.subprocess.run
        vr.subprocess.run = lambda argv, **kw: built.append(list(argv)) or subprocess.CompletedProcess(argv, 0, b"", b"")
        try:
            self.cp.build_images("a" * 40, "abc1234")
        finally:
            vr.subprocess.run = real_run
        self.assertEqual(len(built), 3)

    def test_pruning_covers_the_web_images_and_keeps_the_running_revision(self):
        tags = ["kinerary-cp/portal:aaaaaaa", "kinerary-cp/runtime-gateway:aaaaaaa", "kinerary-cp/portal:bbbbbbb",
                "kinerary-cp/runtime-gateway:bbbbbbb", "kinerary-cp/hermes:ccccccc", "nginx:stable-alpine"]
        self.assertEqual(vr.images_to_prune(tags, ["bbbbbbb"]), ["kinerary-cp/portal:aaaaaaa", "kinerary-cp/runtime-gateway:aaaaaaa"])

    def verify_with(self, outputs: dict, running: dict, rev="abc1234") -> vr.Report:
        calls = []

        class FakeShell:
            def read(self, argv, **kwargs):
                calls.append(list(argv))
                code, out = outputs.get(argv[2], (1, ""))
                return subprocess.CompletedProcess(argv, code, out.encode(), b"")

        self.cp.sh = FakeShell()
        self.cp.verify_web(running, rev)
        self.calls = calls
        return self.cp.r

    def web_tree(self):
        vr.DEPLOYMENT_DIR = self.dir
        (self.dir / "compose.vm.yml").write_text(COMPOSE.read_text())

    def test_verify_does_nothing_when_off_and_nothing_runs(self):
        report = self.verify_with({}, {})
        self.assertEqual((report.failures, self.calls, report.stream.getvalue()), (0, [], ""))

    def test_verify_says_so_when_off_but_the_pair_is_still_running(self):
        report = self.verify_with({}, {"kinerary-cp-portal-1": "kinerary-cp/portal:abc1234"})
        self.assertEqual((report.failures, self.calls), (0, []))
        self.assertIn("still running", report.stream.getvalue())

    def test_verify_passes_when_both_answer_through_their_own_services(self):
        self.enable(); self.web_tree()
        report = self.verify_with(
            {"kinerary-cp-portal-1": (0, '{"google":false,"emailPassword":true}'), "kinerary-cp-runtime-gateway-1": (0, '{"ok":true}')},
            {"kinerary-cp-portal-1": "kinerary-cp/portal:abc1234", "kinerary-cp-runtime-gateway-1": "kinerary-cp/runtime-gateway:abc1234"})
        self.assertEqual(report.failures, 0, report.stream.getvalue())
        self.assertIn("/v1/auth/capabilities", " ".join(" ".join(c) for c in self.calls))
        self.assertIn("/health", " ".join(" ".join(c) for c in self.calls))

    def test_verify_fails_for_a_missing_container_a_stale_image_and_a_dead_proxy(self):
        self.enable(); self.web_tree()
        report = self.verify_with({}, {"kinerary-cp-portal-1": "kinerary-cp/portal:0000000"})
        out = report.stream.getvalue()
        self.assertEqual(report.failures, 4, out)  # portal image, gateway not running, capabilities, health
        self.assertIn("NOT RUNNING", out)
        self.assertIn("did not answer through its proxy", out)

    def test_an_answer_that_is_not_the_capabilities_json_is_not_a_pass(self):
        self.enable(); self.web_tree()
        report = self.verify_with(
            {"kinerary-cp-portal-1": (0, "<html>502 Bad Gateway</html>"), "kinerary-cp-runtime-gateway-1": (0, "OK")},
            {"kinerary-cp-portal-1": "kinerary-cp/portal:abc1234", "kinerary-cp-runtime-gateway-1": "kinerary-cp/runtime-gateway:abc1234"})
        self.assertEqual(report.failures, 2, report.stream.getvalue())

    def test_verify_after_a_rollback_to_a_version_without_the_portal_notes_instead_of_failing(self):
        self.enable()
        vr.DEPLOYMENT_DIR = self.dir
        (self.dir / "compose.vm.yml").write_text("services:\n  api:\n    image: x\n")
        report = self.verify_with({}, {})
        self.assertEqual((report.failures, self.calls), (0, []))
        self.assertIn("has no portal or runtime gateway", report.stream.getvalue())


class ConfigurationIsCheckedBeforeTheSwitch(unittest.TestCase):
    GOOD_ENV = {**{k: "set" for k in vr.WEB_REQUIRED_ENV}, "PORTAL_ORIGIN": "https://portal.example.com",
                "RUNTIME_ORIGIN": "https://runtime.example.com"}

    def profile(self, **web):
        data = json.loads(VM_WEB_PROFILE.read_text())
        data["web"] = {**data["web"], **web}
        return data

    def test_a_complete_configuration_has_no_problems(self):
        self.assertEqual(vr.web_config_problems(self.GOOD_ENV, self.profile()), [])

    def test_each_missing_value_is_named_and_no_value_is_printed(self):
        env = {**self.GOOD_ENV, "RUNTIME_COOKIE_SECRET": ""}
        env["RUNTIME_EXCHANGE_KEY"] = "do-not-print-this"
        problems = vr.web_config_problems(env, self.profile())
        self.assertEqual(problems, ["RUNTIME_COOKIE_SECRET is not set in vm.env"])
        self.assertNotIn("do-not-print-this", " ".join(problems))

    def test_origins_that_disagree_with_the_profile_are_a_problem(self):
        problems = vr.web_config_problems({**self.GOOD_ENV, "PORTAL_ORIGIN": "https://elsewhere.example.com"}, self.profile())
        self.assertEqual(problems, ["PORTAL_ORIGIN differs from the profile's web.public_origin"])
        self.assertEqual(vr.web_config_problems({**self.GOOD_ENV, "PORTAL_ORIGIN": "https://portal.example.com/"}, self.profile()), [])

    def test_origins_on_different_sites_are_a_problem_unless_overridden(self):
        cross = {**self.GOOD_ENV, "RUNTIME_ORIGIN": "https://runtime.example.org"}
        problems = vr.web_config_problems(cross, self.profile(runtime_origin="https://runtime.example.org"))
        self.assertEqual(len(problems), 1)
        self.assertIn("not the same site", problems[0])
        self.assertEqual(vr.web_config_problems({**cross, "RUNTIME_SAME_SITE_OK": "1"}, self.profile(runtime_origin="https://runtime.example.org")), [])

    def test_a_public_suffix_moves_the_site_boundary_like_the_gateway_does(self):
        env = {**self.GOOD_ENV, "PORTAL_ORIGIN": "https://a.example.co.uk", "RUNTIME_ORIGIN": "https://b.other.co.uk"}
        profile = self.profile(public_origin="https://a.example.co.uk", runtime_origin="https://b.other.co.uk")
        # Unlisted, both read as "co.uk" and look like one site - the wrong guess the suffix list exists to correct.
        self.assertEqual(vr.web_config_problems(env, profile), [])
        listed = vr.web_config_problems({**env, "RUNTIME_PUBLIC_SUFFIXES": "co.uk"}, profile)
        self.assertEqual(len(listed), 1)
        self.assertIn("not the same site", listed[0])
        self.assertEqual(vr.registrable_domain("a.example.co.uk", ["co.uk"]), "example.co.uk")
        self.assertEqual(vr.registrable_domain("a.example.co.uk"), "co.uk")
        self.assertEqual(vr.registrable_domain("192.0.2.7"), "192.0.2.7")
        self.assertEqual(vr.registrable_domain("localhost"), "localhost")

    def test_a_profile_without_a_web_block_is_a_problem(self):
        profile = self.profile()
        del profile["web"]
        self.assertEqual(vr.web_config_problems(self.GOOD_ENV, profile), ["the architecture profile has no `web` block, so the api would serve no portal routes"])

    def test_an_unreadable_profile_is_a_problem(self):
        self.assertIn("does not name a readable JSON file", " ".join(vr.web_config_problems(self.GOOD_ENV, None)))

    def test_an_env_reference_the_api_is_never_given_is_a_problem(self):
        problems = vr.web_config_problems(self.GOOD_ENV, self.profile(telegram_bot_token_secret_ref="env://TELEGRAM_BOT_TOKEN"))
        self.assertEqual(len(problems), 1)
        self.assertIn("env://TELEGRAM_BOT_TOKEN", problems[0])
        # A file reference to a secret the api already mounts is fine.
        self.assertEqual(vr.web_config_problems(self.GOOD_ENV, self.profile(telegram_bot_token_secret_ref="file:///run/secrets/telegram_creds")), [])

    def test_google_is_a_pair_the_api_is_given_only_if_set(self):
        both = self.profile(google_client_id_secret_ref="env://GOOGLE_WEB_CLIENT_ID", google_client_secret_ref="env://GOOGLE_WEB_CLIENT_SECRET")
        self.assertEqual(len(vr.web_config_problems(self.GOOD_ENV, both)), 2)
        self.assertEqual(vr.web_config_problems({**self.GOOD_ENV, "GOOGLE_WEB_CLIENT_ID": "i", "GOOGLE_WEB_CLIENT_SECRET": "s"}, both), [])

    def test_the_email_api_key_is_a_variable_the_api_is_given(self):
        email = self.profile(email_provider="resend", email_api_key_secret_ref="env://PORTAL_EMAIL_API_KEY", email_from="noreply@mail.example.test")
        # Named by the profile but unset in vm.env: a refused plan, not an api that dies at boot.
        problems = vr.web_config_problems(self.GOOD_ENV, email)
        self.assertEqual(len(problems), 1)
        self.assertIn("env://PORTAL_EMAIL_API_KEY", problems[0])
        self.assertIn("not set in vm.env", problems[0])
        self.assertEqual(vr.web_config_problems({**self.GOOD_ENV, "PORTAL_EMAIL_API_KEY": "key-value"}, email), [])
        # Left out of the profile, the variable is not required.
        self.assertEqual(vr.web_config_problems(self.GOOD_ENV, self.profile()), [])
        # And vm.env.example documents it.
        self.assertIn("PORTAL_EMAIL_API_KEY=", (ROOT / "control-plane" / "deployment" / "vm.env.example").read_text())


if __name__ == "__main__":
    unittest.main()
