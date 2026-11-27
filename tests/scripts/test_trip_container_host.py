"""scripts/trip-container-host.sh: the forced command that runs trip-site containers on the host.

AC-4 (docs/specs/sprint-9/x-trip-vm-container-placement.md): a request that is not one of the seven
verbs, or whose slug or trip id fails validation, or that names a container whose `kinerary.trip_id`
label differs, is refused, changes nothing and exits non-zero; `docker run` is always issued with no
`--privileged`, `--cap-drop ALL`, `no-new-privileges`, a memory limit, the fixed uid,
`--restart unless-stopped`, the trip network and its `--ip`.

AC-5: `ensure` creates `.env` 0600 owned by the container uid with secrets generated on the host or
read from stdin, never from argv; an existing `.env` is never rewritten.

The script takes its settings from one configuration file and never from its environment, and runs
docker by an absolute path from that file. These tests write a temp configuration file the test user
owns (the path override and the docker override are honoured only when the script is NOT root) and
point it at a fake `docker`: it keeps its containers and networks in a JSON file, records every argv
and environment it was called with, and exits 99 on any subcommand the script is not expected to use
(so a new, unreviewed docker call is a red test, not a silent pass). Nothing here talks to a real
docker. The trip store is a temp directory; ownership assertions use the test's own uid, so the whole
suite skips under root. The branch that chowns to another uid is therefore never executed here.
"""
from __future__ import annotations

import json
import os
import shutil
import stat
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
SCRIPT = REPO / "scripts/trip-container-host.sh"

FAKE_DOCKER = r'''#!__PYTHON__
import json, os, sys, time
state_dir = "__STATE__"
argv = sys.argv[1:]
with open(os.path.join(state_dir, "calls.jsonl"), "a") as fh:
    fh.write(json.dumps(argv) + "\n")
with open(os.path.join(state_dir, "env.jsonl"), "a") as fh:
    fh.write(json.dumps(dict(os.environ)) + "\n")
path = os.path.join(state_dir, "state.json")
state = json.load(open(path))
def save():
    json.dump(state, open(path, "w"))
def fail(msg, code=1):
    sys.stderr.write(msg + "\n"); sys.exit(code)
def container(name):
    return state["containers"].get(name)
def arg_after(flag):
    return argv[argv.index(flag) + 1]
def dump(c):
    return {"Name": "/" + c["name"], "Config": {"Labels": c["labels"], "Image": c["image"]},
            "State": {"Running": c["running"]}, "Mounts": c.get("mounts", [])}
if state.get("hang_on") == argv[0]:
    time.sleep(60)
_sb = state.get("sleep_before", {})
if argv[0] in _sb and not state.get("slept_" + argv[0]):
    state["slept_" + argv[0]] = True
    save()
    time.sleep(_sb[argv[0]])

if argv[:2] == ["container", "inspect"]:
    c = container(argv[-1])
    if c is None:
        fail("Error: No such container: " + argv[-1])
    print(json.dumps([dump(c)]))
elif argv[:2] == ["ps", "-a"]:
    flt = arg_after("--filter")
    assert flt.startswith("label="), flt
    key, eq, value = flt[len("label="):].partition("=")
    for c in state["containers"].values():
        if (c["labels"].get(key) == value) if eq else (key in c["labels"]):
            print(c["name"])
elif argv[:2] == ["network", "ls"]:
    for n in state["networks"]:
        print(n["Id"])
elif argv[:2] == ["network", "inspect"]:
    wanted = argv[2:]
    found = [n for n in state["networks"] if n["Name"] in wanted or n["Id"] in wanted]
    if len(found) != len(wanted):
        fail("Error: No such network")
    print(json.dumps(found))
elif argv[:2] == ["network", "create"]:
    if state.get("on_network_create"):
        os.system(state["on_network_create"])
    name = argv[-1]
    state["networks"].append({"Name": name, "Id": "id" + name,
                              "IPAM": {"Config": [{"Subnet": arg_after("--subnet")}]}})
    save()
elif argv[:2] == ["image", "inspect"]:
    if argv[-1] not in state["images"]:
        fail("Error: No such image: " + argv[-1])
    print("[]")
elif argv[0] == "run":
    if state.get("run_fails"):
        fail("docker: Error response from daemon: boom")
    labels = {}
    for i, a in enumerate(argv):
        if a == "--label":
            k, _, v = argv[i + 1].partition("=")
            labels[k] = v
    name = arg_after("--name")
    parts = dict(p.split("=", 1) for p in arg_after("--mount").split(","))
    source = state.get("mount_source_override") or parts["source"]
    mounts = [{"Type": parts["type"], "Source": source, "Destination": parts["target"], "RW": True}]
    if state.get("extra_mount"):
        mounts.append({"Type": "bind", "Source": "/", "Destination": "/host", "RW": True})
    state["containers"][name] = {"name": name, "labels": labels, "image": argv[-1], "running": True,
                                 "ip": arg_after("--ip"), "mounts": mounts}
    save()
    if state.get("after_run_hook"):
        os.system(state["after_run_hook"])
    if state.get("sleep_after_run"):
        time.sleep(state["sleep_after_run"])
    print("0123456789abcdef")
elif argv[0] in ("start", "stop"):
    if argv[0] == "stop" and state.get("on_stop"):
        os.system(state["on_stop"])
    if argv[0] == "start" and state.get("start_fails"):
        fail("Error: cannot start")
    c = container(argv[-1]) or fail("Error: No such container")
    c["running"] = argv[0] == "start"
    if argv[0] == "start" and state.get("start_changes_mount"):
        c["mounts"][0]["Source"] = "/"
    save()
    print(argv[-1])
elif argv[0] == "rm":
    state["containers"].pop(argv[-1], None)
    save()
    print(argv[-1])
elif argv[0] == "rename":
    if state.get("rename_back_fails") and argv[2] == state["rename_back_fails"]:
        fail("Error: cannot rename")
    c = state["containers"].pop(argv[1])
    c["name"] = argv[2]
    state["containers"][argv[2]] = c
    save()
elif argv[0] == "exec":
    if "curl" in argv:
        sys.stdout.write(str(state.get("health_code", "200")))
    elif "sh" in argv:
        print(state.get("bridge_result", "result=answered status=200 curl_exit=0"))
    else:
        sys.exit(99)
else:
    sys.stderr.write("fake docker: unmodelled subcommand %r\n" % (argv,))
    sys.exit(99)
'''

FAKE_MOUNT = r'''#!__PYTHON__
import fcntl, json, os, sys
state_dir = "__STATE__"
mountinfo = "__MOUNTINFO__"
argv = sys.argv[1:]
cfg_path = os.path.join(state_dir, "mount_state.json")
cfg = json.load(open(cfg_path)) if os.path.exists(cfg_path) else {}
entry = {"tool": "mount", "argv": argv}
if not (len(argv) == 4 and argv[:2] == ["--no-canonicalize", "--bind"] and argv[2].startswith("/proc/self/fd/")):
    open(os.path.join(state_dir, "mount_calls.jsonl"), "a").write(json.dumps(entry) + "\n")
    sys.stderr.write("fake mount: unexpected arguments\n")
    sys.exit(99)
fd = int(argv[2].rsplit("/", 1)[1])
st = os.fstat(fd)          # the descriptor the script passed down: this is what a real bind would take
entry["fd_ident"] = [st.st_dev, st.st_ino]
try:
    target = os.readlink(argv[2])
except OSError:
    target = fcntl.fcntl(fd, 50, bytes(1024)).split(b"\0")[0].decode()      # macOS F_GETPATH
open(os.path.join(state_dir, "mount_calls.jsonl"), "a").write(json.dumps(entry) + "\n")
if cfg.get("mount_fails"):
    sys.stderr.write("mount: permission denied\n")
    sys.exit(32)
point = argv[3]
if cfg.get("wrong_target"):
    target = cfg["wrong_target"]
os.rmdir(point)
os.symlink(target, point)          # a stand-in for the bind: stat() of the mount point shows the target
open(mountinfo, "a").write("99 1 0:99 / %s rw - tmpfs none rw\n" % point)
'''

FAKE_UMOUNT = r'''#!__PYTHON__
import json, os, sys
state_dir = "__STATE__"
mountinfo = "__MOUNTINFO__"
argv = sys.argv[1:]
cfg_path = os.path.join(state_dir, "mount_state.json")
cfg = json.load(open(cfg_path)) if os.path.exists(cfg_path) else {}
open(os.path.join(state_dir, "mount_calls.jsonl"), "a").write(json.dumps({"tool": "umount", "argv": argv}) + "\n")
if cfg.get("umount_fails"):
    sys.stderr.write("umount: target is busy\n")
    sys.exit(32)
point = argv[0]
if os.path.islink(point):
    os.unlink(point)
    os.mkdir(point)
lines = [l for l in open(mountinfo).read().split("\n") if l and (" %s " % point) not in l]
open(mountinfo, "w").write("".join(l + "\n" for l in lines))
'''

MUTATING = {("run",), ("start",), ("stop",), ("rm",), ("rename",), ("build",), ("network", "create")}

# The uid the container runs as in these tests: ours, so ownership is assertable without root. (The script
# honours its test overrides only when it is NOT root, so the whole suite skips under root.)
CONTAINER_UID = os.getuid()
SUBNET = "10.250.0.0/24"
NETWORK = "tripnet"
DIGEST = "ab" * 32
TRIP_ID = "trip_0123456789abcdef0123456789abcdef"
OTHER_ID = "trip_ffffffffffffffffffffffffffffffff"
SLUG = "alsace-2026"
NAME = f"trip-{SLUG}"
IP = "10.250.0.10"
SECRET_PASSWORD = "k7mq-x3ra-pw9d-hn4t"
SECRET_KEY = "ek" + "9" * 30
CONF_KEYS = ("TRIP_CONTAINER_NETWORK", "TRIP_CONTAINER_SUBNET", "TRIP_CONTAINER_UID", "TRIP_CONTAINER_MEMORY",
             "KINERARY_NFS_ROOT", "TRIP_CONTAINER_DOCKER", "TRIP_CONTAINER_LOCK_FILE", "TRIP_CONTAINER_TIMEOUT",
             "TRIP_CONTAINER_MOUNT_ROOT", "TRIP_CONTAINER_MOUNT", "TRIP_CONTAINER_UMOUNT", "TRIP_CONTAINER_MOUNTINFO",
             "TRIP_CONTAINER_BRIDGE_URL")


def is_mutating(call: list[str]) -> bool:
    return any(tuple(call[: len(m)]) == m for m in MUTATING)


class HostCase(unittest.TestCase):
    def setUp(self) -> None:
        if os.geteuid() == 0:
            self.skipTest("the script ignores its test overrides as root: run this suite as an ordinary user")
        self.work = Path(os.path.realpath(tempfile.mkdtemp(prefix="trip-container-host-")))
        self.addCleanup(shutil.rmtree, self.work, ignore_errors=True)
        self.nfs = self.work / "nfs"
        self.nfs.mkdir()
        self.state_dir = self.work / "state"
        self.state_dir.mkdir()
        self.bin = self.work / "bin"
        self.bin.mkdir()
        self.fake = self.bin / "docker"
        self.fake.write_text(FAKE_DOCKER.replace("__PYTHON__", sys.executable).replace("__STATE__", str(self.state_dir)))
        self.fake.chmod(0o755)
        self.mount_root = self.work / "mnt"
        self.mount_root.mkdir()
        self.mountinfo = self.work / "mountinfo"
        self.mountinfo.write_text("1 0 8:1 / / rw - ext4 /dev/root rw\n")
        self.fake_mount = self.bin / "mount"
        self.fake_umount = self.bin / "umount"
        for path, body in ((self.fake_mount, FAKE_MOUNT), (self.fake_umount, FAKE_UMOUNT)):
            path.write_text(body.replace("__PYTHON__", sys.executable).replace("__STATE__", str(self.state_dir))
                            .replace("__MOUNTINFO__", str(self.mountinfo)))
            path.chmod(0o755)
        self.state = {
            "containers": {},
            "networks": [{"Name": "bridge", "Id": "idbridge", "IPAM": {"Config": [{"Subnet": "172.17.0.0/16"}]}}],
            "images": [f"trip-site:{DIGEST}"],
        }
        self.save_state()
        # the host's configuration file, which is where the script gets everything (never its environment)
        self.conf = {
            "TRIP_CONTAINER_NETWORK": NETWORK,
            "TRIP_CONTAINER_SUBNET": SUBNET,
            "TRIP_CONTAINER_UID": str(CONTAINER_UID),
            "TRIP_CONTAINER_MEMORY": "512m",
            "KINERARY_NFS_ROOT": str(self.nfs),
            "TRIP_CONTAINER_DOCKER": str(self.fake),
            "TRIP_CONTAINER_LOCK_FILE": str(self.work / "host.lock"),
            "TRIP_CONTAINER_TIMEOUT": "60",
            "TRIP_CONTAINER_MOUNT_ROOT": str(self.mount_root),
            "TRIP_CONTAINER_MOUNT": str(self.fake_mount),
            "TRIP_CONTAINER_UMOUNT": str(self.fake_umount),
            "TRIP_CONTAINER_MOUNTINFO": str(self.mountinfo),
            "TRIP_CONTAINER_BRIDGE_URL": "http://bridge.internal:4310",
        }
        self.conf_path = self.work / "host.conf"
        self.proc_env = {"PATH": "/usr/bin:/bin", "HOME": str(self.work)}
        self.trip_dir = self.nfs / TRIP_ID

    def point(self, trip_id: str = TRIP_ID) -> Path:
        """Where the daemon is told to mount the trip: the root-owned mount point, never a path on the store."""
        return self.mount_root / trip_id

    def mount_calls(self) -> list[dict]:
        path = self.state_dir / "mount_calls.jsonl"
        return [json.loads(line) for line in path.read_text().splitlines()] if path.exists() else []

    def set_mount_state(self, **kw) -> None:
        (self.state_dir / "mount_state.json").write_text(json.dumps(kw))

    def follow_inode(self, new_path, trip_id: str = TRIP_ID) -> None:
        """A real bind follows the inode when its directory is renamed; the fake's symlink has to be told."""
        p = self.point(trip_id)
        p.unlink()
        os.symlink(new_path, p)

    def simulate_reboot_unmount(self, trip_id: str = TRIP_ID) -> None:
        """What a reboot does to the binds: they are gone, the empty mount points stay."""
        p = self.point(trip_id)
        if p.is_symlink():
            p.unlink()
            p.mkdir()
        lines = [l for l in self.mountinfo.read_text().split("\n") if l and f" {p} " not in l]
        self.mountinfo.write_text("".join(l + "\n" for l in lines))

    # -- fake docker state ----------------------------------------------------------------
    def save_state(self) -> None:
        (self.state_dir / "state.json").write_text(json.dumps(self.state))

    def load_state(self) -> dict:
        return json.loads((self.state_dir / "state.json").read_text())

    def add_container(self, trip_id: str = TRIP_ID, name: str = NAME, running: bool = True, labels: dict | None = None,
                      source: str | None = None) -> None:
        self.state["containers"][name] = {
            "name": name, "running": running, "image": f"trip-site:{DIGEST}", "ip": IP,
            "labels": {"kinerary.trip_id": trip_id, "kinerary.slug": SLUG} if labels is None else labels,
            "mounts": [{"Type": "bind", "Source": source or str(self.point(trip_id)), "Destination": "/trip-store", "RW": True}],
        }
        self.save_state()

    def make_store(self, trip_id: str = TRIP_ID, slug: str = SLUG, env: bool = True) -> Path:
        """A trip directory as `ensure` leaves it, made by hand (for the verbs that only use one)."""
        d = self.nfs / trip_id
        for sub in ("", "trip", "server-data", "documents", "media"):
            (d / sub).mkdir(exist_ok=True)
        (d / "TRIP.txt").write_text(f"trip: {slug}\ntrip_id: {trip_id}\nslug: {slug}\ndata: {d}\ncontainer: trip-{slug}\n")
        if env:
            (d / ".env").write_text(f"SEED_PASSWORD={SECRET_PASSWORD}\nCONTROL_PLANE_EXCHANGE_KEY={SECRET_KEY}\n"
                                    f"JWT_SECRET={'1' * 64}\nHERMES_API_KEY={'2' * 64}\n")
            (d / ".env").chmod(0o600)
        return d

    def calls(self) -> list[list[str]]:
        path = self.state_dir / "calls.jsonl"
        return [json.loads(line) for line in path.read_text().splitlines()] if path.exists() else []

    def docker_envs(self) -> list[dict]:
        path = self.state_dir / "env.jsonl"
        return [json.loads(line) for line in path.read_text().splitlines()] if path.exists() else []

    def mutating_calls(self) -> list[list[str]]:
        return [c for c in self.calls() if is_mutating(c)]

    # -- running the script --------------------------------------------------------------
    def request(self, verb: str, **fields) -> dict:
        body = {"record_type": "trip_container_request", "verb": verb, "trip_id": TRIP_ID, "slug": SLUG}
        body.update(fields)
        return body

    def ensure_fields(self, **over) -> dict:
        fields = {"ip": IP, "image": DIGEST, "seed_password": SECRET_PASSWORD, "exchange_key": SECRET_KEY,
                  "hermes_url": "http://bridge.internal:4310", "public_origin": "https://alsace-2026.trips.example",
                  "trip_mcp_enabled": True}
        fields.update(over)
        return fields

    def write_conf(self, conf: dict) -> None:
        if self.conf_path.is_symlink() or self.conf_path.exists():
            self.conf_path.unlink()
        self.conf_path.write_text("# host configuration for the tests\n" + "".join(f"{k}={v}\n" for k, v in conf.items()))
        self.conf_path.chmod(0o600)

    def run_host(self, request, drop: tuple[str, ...] = (), extra_env: dict | None = None, args: tuple[str, ...] = (),
                 proc_env: dict | None = None, timeout: int = 60):
        """`drop` and the CONF_KEYS in `extra_env` edit the host configuration file; `proc_env` (and any other
        key of `extra_env`) is the process environment the script is started with."""
        conf = {k: v for k, v in self.conf.items() if k not in drop}
        env = dict(self.proc_env)
        for key, value in (extra_env or {}).items():
            (conf if key in CONF_KEYS else env)[key] = value
        env.update(proc_env or {})
        self.write_conf(conf)
        if getattr(self, "conf_hook", None):
            self.conf_hook(self.conf_path)
        env["TRIP_CONTAINER_HOST_CONFIG"] = str(self.conf_path)
        data = request if isinstance(request, bytes) else json.dumps(request).encode()
        proc = subprocess.run([str(SCRIPT), *args], input=data, capture_output=True, env=env, timeout=timeout,
                              cwd=str(self.work))
        out, err = proc.stdout.decode(), proc.stderr.decode()
        answer = None
        lines = [line for line in out.splitlines() if line.strip()]
        if len(lines) == 1:
            try:
                answer = json.loads(lines[0])
            except ValueError:
                answer = None
        return proc.returncode, out, err, answer

    def tree_snapshot(self) -> list:
        entries = []
        for p in sorted(self.nfs.rglob("*")):
            st = p.lstat()
            entries.append((str(p.relative_to(self.nfs)), st.st_mode, st.st_ino, st.st_mtime_ns,
                            p.read_bytes() if p.is_file() and not p.is_symlink() else None))
        return entries

    def assert_refused(self, request, **kw):
        before = self.tree_snapshot()
        code, out, err, answer = self.run_host(request, **kw)
        self.assertEqual(code, 2, f"expected a refusal (exit 2), got {code}: {out!r} {err!r}")
        self.assertIsNotNone(answer, f"a refusal still answers one JSON line: {out!r}")
        self.assertIs(answer.get("ok"), False)
        self.assertEqual(self.mutating_calls(), [], "a refusal must not run a mutating docker command")
        self.assertEqual(self.tree_snapshot(), before, "a refusal must not change the trip store")
        return answer


class Refusals(HostCase):
    """AC-4, first half: a request outside the contract changes nothing and exits non-zero."""

    def test_unknown_verbs(self):
        for verb in ("exec", "ENSURE", "Ensure", "", "ensure ", "ensure;ls", "restart", "logs", "run", None, 7, ["ensure"]):
            with self.subTest(verb=verb):
                self.assert_refused(self.request(verb))
        self.assertEqual(self.calls(), [], "an unknown verb must not reach docker at all")

    def test_bad_record_type_and_shape(self):
        bad = self.request("stop")
        bad["record_type"] = "trip_mcp_bridge_request"
        self.assert_refused(bad)
        missing = self.request("stop")
        del missing["record_type"]
        self.assert_refused(missing)
        for raw in (b"", b"not json", b"[]", b'"stop"', b"null", b"{", b'{"verb": "stop"} trailing'):
            with self.subTest(raw=raw):
                self.assert_refused(raw)
        dup = (b'{"record_type":"trip_container_request","verb":"stop","verb":"remove",'
               b'"trip_id":"' + TRIP_ID.encode() + b'","slug":"' + SLUG.encode() + b'"}')
        self.assert_refused(dup)

    def test_oversize_request_is_refused_not_truncated(self):
        big = self.request("stop")
        big["slug"] = SLUG
        raw = json.dumps(big).encode()[:-1] + b',"pad":"' + b"x" * 70000 + b'"}'
        self.assert_refused(raw)

    def test_unknown_and_foreign_fields(self):
        self.assert_refused(self.request("stop", extra="x"))
        self.assert_refused(self.request("stop", docker_args=["--privileged"]))
        # a field that belongs to another verb is as unknown as a made-up one
        self.assert_refused(self.request("stop", ip=IP))
        self.assert_refused(self.request("check", image=DIGEST))
        self.assert_refused(self.request("remove", seed_password=SECRET_PASSWORD))
        self.assert_refused(self.request("start", fields=["seed_password"]))
        self.assert_refused(self.request("read", ip=IP, fields=["seed_password"]))
        self.assert_refused(self.request("deploy", seed_password=SECRET_PASSWORD, ip=IP, image=DIGEST))
        self.assertEqual(self.calls(), [])

    def test_missing_required_fields(self):
        self.assert_refused(self.request("ensure", ip=IP))
        self.assert_refused(self.request("ensure", image=DIGEST))
        self.assert_refused(self.request("deploy", ip=IP))
        self.assert_refused(self.request("deploy", image=DIGEST))
        self.assert_refused(self.request("read"))
        self.assertEqual(self.calls(), [])

    def test_bad_slugs(self):
        for slug in ("../x", "x/../y", "Up", "a b", "a--b", "-a", "a-", "a;rm", "a\nb", "a" * 81, "", "a_b", "é", "a.b",
                     "$(id)", "mcp ", 5, None, ["a"]):
            with self.subTest(slug=slug):
                self.assert_refused(self.request("stop", slug=slug))
        self.assertEqual(self.calls(), [])

    def test_bad_trip_ids(self):
        for trip_id in ("trip_", "trip_xyz", "trip_abc", "../trip_0123456789abcdef", "trip_0123456789abcdef\n",
                        "TRIP_0123456789ABCDEF", "trip_" + "a" * 65, "trip-0123456789abcdef", SLUG, "", 5, None,
                        "trip_0123456789abcdef/../../x"):
            with self.subTest(trip_id=trip_id):
                self.assert_refused(self.request("stop", trip_id=trip_id))
        self.assertEqual(self.calls(), [])

    def test_bad_ensure_fields(self):
        cases = {
            "ip outside the subnet": {"ip": "10.251.0.10"},
            "ip is the network address": {"ip": "10.250.0.0"},
            "ip is the gateway": {"ip": "10.250.0.1"},
            "ip is the broadcast address": {"ip": "10.250.0.255"},
            "ip with a leading zero": {"ip": "10.250.0.010"},
            "ip not an address": {"ip": "10.250.0.10; id"},
            "ip v6": {"ip": "::1"},
            "ip with a suffix": {"ip": "10.250.0.10/24"},
            "ip not a string": {"ip": 5},
            "image latest": {"image": "latest"},
            "image upper case hex": {"image": "AB" * 32},
            "image 32 hex only": {"image": "ab" * 16},
            "image 63 hex": {"image": "a" * 63},
            "image 65 hex": {"image": "a" * 65},
            "image with a registry": {"image": "evil.example/x:" + DIGEST},
            "image too short": {"image": "abc"},
            "image with colon": {"image": "sha256:" + DIGEST},
            "password with a space": {"seed_password": "a b c d e f g h"},
            "password with a newline": {"seed_password": "abcd1234\nJWT_SECRET=x"},
            "password with a dollar": {"seed_password": "abcd$(id)1234"},
            "password too short": {"seed_password": "abc"},
            "password not a string": {"seed_password": ["x"]},
            "exchange key with a quote": {"exchange_key": "abc'def" + "x" * 20},
            "exchange key with a newline": {"exchange_key": "a" * 20 + "\nX=1"},
            "hermes url with a path": {"hermes_url": "http://bridge.internal:4310/x"},
            "hermes url with a newline": {"hermes_url": "http://bridge.internal\nX=1"},
            "hermes url with credentials": {"hermes_url": "http://u:p@bridge.internal"},
            "public origin http": {"public_origin": "http://alsace.example"},
            "public origin with a path": {"public_origin": "https://alsace.example/x"},
            "public origin with a dollar": {"public_origin": "https://al$sace.example"},
            "mcp flag not a bool": {"trip_mcp_enabled": "1"},
            "mcp enabled with no origin": {"trip_mcp_enabled": True, "public_origin": None},
        }
        for label, over in cases.items():
            with self.subTest(label):
                fields = self.ensure_fields()
                for key, value in over.items():
                    if value is None:
                        del fields[key]
                    else:
                        fields[key] = value
                self.assert_refused(self.request("ensure", **fields))
        self.assertEqual(self.calls(), [], "field validation happens before any docker call")

    def test_a_new_env_needs_a_seed_password(self):
        fields = self.ensure_fields()
        del fields["seed_password"]
        self.assert_refused(self.request("ensure", **fields))
        self.assertFalse(self.trip_dir.exists())

    def test_read_field_names(self):
        for fields in ([], ["jwt_secret"], ["seed_password", "hermes_api_key"], "seed_password", ["seed_password", "seed_password"],
                       ["exchange_key_kind"], ["site_to_bridge"], ["*"], [5]):
            with self.subTest(fields=fields):
                self.assert_refused(self.request("read", fields=fields))
        self.assert_refused(self.request("read", fields=["seed_password"], exchange_key_candidates={"shared": SECRET_KEY}))
        self.assert_refused(self.request("read", fields=["exchange_key_kind"], exchange_key_candidates={"other": SECRET_KEY}))
        self.assert_refused(self.request("read", fields=["site_to_bridge"], bridge_url="http://x.example/path"))
        self.assertEqual(self.calls(), [])

    def test_host_configuration_unset_or_unusable(self):
        for name in ("TRIP_CONTAINER_NETWORK", "TRIP_CONTAINER_SUBNET", "TRIP_CONTAINER_MEMORY", "KINERARY_NFS_ROOT"):
            with self.subTest(unset=name):
                self.assert_refused(self.request("stop"), drop=(name,))
                self.assert_refused(self.request("ensure", **self.ensure_fields()), drop=(name,))
        bad = {
            "TRIP_CONTAINER_NETWORK": ("a b", "-x", "x;y", "../x", ""),
            "TRIP_CONTAINER_SUBNET": ("10.250.0.0/33", "10.250.0.5/24", "8.8.8.0/24", "10.250.0.0/8", "fd00::/64", "x", ""),
            "TRIP_CONTAINER_MEMORY": ("lots", "0m", "512", "-1m", "512m --privileged", ""),
            "TRIP_CONTAINER_UID": ("0", "root", "-1", "10001 ", "99999999", ""),
            "KINERARY_NFS_ROOT": ("relative/path", "/a/../b", "/a,b", "/a b", "/"),
            "TRIP_CONTAINER_LOCK_FILE": ("relative", "/a/../b", "/"),
            "TRIP_CONTAINER_TIMEOUT": ("0", "601", "-1", "x", "", "1e3"),
        }
        for name, values in bad.items():
            for value in values:
                with self.subTest(name=name, value=value):
                    self.assert_refused(self.request("stop"), extra_env={name: value})
        self.assertEqual(self.calls(), [])

    def test_uid_unset_means_the_documented_default(self):
        # An unset uid is the one variable with a default (10001). Not being that user (and not root), the
        # script refuses to do file work rather than write files the container could not own.
        if os.getuid() in (0, 10001):
            self.skipTest("running as the default uid or root")
        self.assert_refused(self.request("ensure", **self.ensure_fields()), drop=("TRIP_CONTAINER_UID",))

    def test_arguments_and_ssh_original_command(self):
        self.assert_refused(self.request("stop"), args=("--privileged",))
        self.assert_refused(self.request("stop"), args=("stop",))
        self.add_container()
        code, out, err, answer = self.run_host(self.request("stop"), extra_env={"SSH_ORIGINAL_COMMAND": "rm -rf / ; docker rm -f x"})
        self.assertEqual(code, 0, err)
        self.assertEqual([c for c in self.mutating_calls()], [["stop", NAME]])
        self.assertNotIn("rm -rf", out + err)

    def test_a_docker_that_is_not_where_the_configuration_says_refuses(self):
        self.assert_refused(self.request("stop"), extra_env={"TRIP_CONTAINER_DOCKER": str(self.work / "no-docker-here")})
        self.assert_refused(self.request("stop"), extra_env={"TRIP_CONTAINER_DOCKER": "relative/docker"})


class LabelCheck(HostCase):
    """AC-4, second half: a container whose label differs from the request is never touched."""

    def requests(self):
        yield "ensure", self.request("ensure", **self.ensure_fields())
        yield "deploy", self.request("deploy", ip=IP, image=DIGEST)
        yield "start", self.request("start")
        yield "stop", self.request("stop")
        yield "remove", self.request("remove")
        yield "check", self.request("check")
        yield "read", self.request("read", fields=["seed_password"])

    def test_label_of_another_trip_is_refused_for_every_verb(self):
        self.add_container(trip_id=OTHER_ID)
        for verb, request in self.requests():
            with self.subTest(verb=verb):
                answer = self.assert_refused(request)
                self.assertIn("label", answer.get("reason", ""))
        # only reads were run: no exec either
        self.assertTrue(all(c[:2] == ["container", "inspect"] for c in self.calls()), self.calls())
        self.assertFalse(self.trip_dir.exists())

    def test_absent_label_is_a_mismatch(self):
        self.add_container(labels={})
        for verb, request in self.requests():
            with self.subTest(verb=verb):
                self.assert_refused(request)

    def test_another_trips_container_under_the_same_name_survives_a_remove(self):
        self.add_container(trip_id=OTHER_ID)
        self.assert_refused(self.request("remove"))
        self.assertIn(NAME, self.load_state()["containers"])

    def test_the_trip_id_label_on_a_container_with_another_name_is_refused(self):
        self.add_container(name="trip-other-slug")
        self.assert_refused(self.request("ensure", **self.ensure_fields()))
        self.assertFalse(self.trip_dir.exists())


class RunArguments(HostCase):
    """AC-4, the `docker run` line, for both ensure and deploy."""

    EXPECTED_RUN = [
        "run", "--detach", "--pull", "never", "--name", NAME, "--restart", "unless-stopped",
        "--network", NETWORK, "--ip", IP, "--user", "UID:UID",
        "--memory", "512m", "--memory-swap", "512m", "--pids-limit", "512",
        "--cap-drop", "ALL", "--security-opt", "no-new-privileges",
        "--label", f"kinerary.trip_id={TRIP_ID}", "--label", f"kinerary.slug={SLUG}",
        "--mount", "type=bind,source=MOUNTPOINT,target=/trip-store",
        f"trip-site:{DIGEST}",
    ]

    def expected_run(self):
        uid = CONTAINER_UID
        return [a.replace("UID", str(uid)).replace("MOUNTPOINT", str(self.point())) for a in self.EXPECTED_RUN]

    def assert_hardened(self, run_call):
        for bad in ("--privileged", "--env", "--env-file", "-e", "--volume", "-v", "--publish", "-p", "--device",
                    "--pid", "--ipc", "--userns", "--cap-add", "--net", "--volumes-from", "--add-host",
                    "--entrypoint", "--security-opt=seccomp=unconfined", "--cap-add=ALL"):
            self.assertNotIn(bad, run_call)
        self.assertEqual(run_call[run_call.index("--network") + 1], NETWORK)
        self.assertEqual(run_call.count("--security-opt"), 1)
        self.assertEqual(run_call.count("--mount"), 1, "exactly one mount, the trip's own directory")
        self.assertEqual(run_call.count("--user"), 1)
        self.assertRegex(run_call[-1], r"^trip-site:[0-9a-f]{64}$")
        self.assertNotEqual(run_call[run_call.index("--user") + 1].split(":")[0], "0")

    def test_ensure_runs_exactly_this(self):
        code, out, err, answer = self.run_host(self.request("ensure", **self.ensure_fields()))
        self.assertEqual(code, 0, f"{out!r} {err!r}")
        runs = [c for c in self.calls() if c[0] == "run"]
        self.assertEqual(runs, [self.expected_run()])
        self.assert_hardened(runs[0])
        self.assertTrue(self.calls(), "the fake docker was really exercised")

    def test_deploy_runs_exactly_this(self):
        self.run_host(self.request("ensure", **self.ensure_fields()))
        new_digest = "cd" * 32
        self.state = self.load_state()
        self.state["images"].append(f"trip-site:{new_digest}")
        self.save_state()
        (self.state_dir / "calls.jsonl").unlink()
        code, out, err, answer = self.run_host(self.request("deploy", ip=IP, image=new_digest))
        self.assertEqual(code, 0, f"{out!r} {err!r}")
        runs = [c for c in self.calls() if c[0] == "run"]
        expected = self.expected_run()[:-1] + [f"trip-site:{new_digest}"]
        self.assertEqual(runs, [expected])
        self.assert_hardened(runs[0])
        self.assertEqual(answer["previous_image"], f"trip-site:{DIGEST}")
        # the old container is stopped and set aside before the new one takes its name and address, and
        # discarded only once the new one is running
        verbs = [c[0] for c in self.mutating_calls()]
        self.assertEqual(verbs, ["stop", "rename", "run", "rm"])
        self.assertEqual(list(self.load_state()["containers"]), [NAME])
        self.assertEqual(self.load_state()["containers"][NAME]["image"], f"trip-site:{new_digest}")

    def test_a_failed_deploy_puts_the_old_container_back(self):
        self.run_host(self.request("ensure", **self.ensure_fields()))
        self.state = self.load_state()
        self.state["run_fails"] = True
        self.save_state()
        code, out, err, answer = self.run_host(self.request("deploy", ip=IP, image=DIGEST))
        self.assertEqual(code, 1)
        self.assertIs(answer["ok"], False)
        containers = self.load_state()["containers"]
        self.assertEqual(list(containers), [NAME])
        self.assertTrue(containers[NAME]["running"], "the previous container serves again")

    def test_a_failed_rollback_says_which_state_the_trip_is_in(self):
        self.run_host(self.request("ensure", **self.ensure_fields()))
        self.state = self.load_state()
        self.state["run_fails"] = True
        self.state["rename_back_fails"] = NAME
        self.save_state()
        code, out, err, answer = self.run_host(self.request("deploy", ip=IP, image=DIGEST))
        self.assertEqual(code, 1)
        self.assertIn("NOT restored", answer["reason"])
        self.assertEqual(list(self.load_state()["containers"]), [NAME + ".prev"])
        # the rename back works now, the start does not: the deploy settles the leftover, fails to run, and says so
        self.state = self.load_state()
        self.state["rename_back_fails"] = None
        self.state["start_fails"] = True
        self.state["containers"][NAME + ".prev"]["running"] = True
        self.save_state()
        code, out, err, answer = self.run_host(self.request("deploy", ip=IP, image=DIGEST))
        self.assertEqual(code, 1)
        self.assertIn("NOT running", answer["reason"])

    def test_a_leftover_prev_is_put_back_when_nothing_holds_the_name(self):
        self.run_host(self.request("ensure", **self.ensure_fields()))
        self.state = self.load_state()
        self.state["containers"][NAME + ".prev"] = self.state["containers"].pop(NAME)
        self.state["containers"][NAME + ".prev"]["name"] = NAME + ".prev"
        self.save_state()
        code, out, err, answer = self.run_host(self.request("deploy", ip=IP, image=DIGEST))
        self.assertEqual(code, 0, f"{out!r} {err!r}")
        self.assertEqual(list(self.load_state()["containers"]), [NAME])
        self.assertEqual(answer["previous_image"], f"trip-site:{DIGEST}")

    def test_a_leftover_prev_is_discarded_when_the_trips_container_exists(self):
        self.run_host(self.request("ensure", **self.ensure_fields()))
        self.add_container(name=NAME + ".prev", running=False)
        self.add_container()
        code, out, err, answer = self.run_host(self.request("deploy", ip=IP, image=DIGEST))
        self.assertEqual(code, 0, f"{out!r} {err!r}")
        self.assertEqual(list(self.load_state()["containers"]), [NAME])

    def test_a_leftover_prev_of_another_trip_is_refused(self):
        self.run_host(self.request("ensure", **self.ensure_fields()))
        self.add_container(trip_id=OTHER_ID, name=NAME + ".prev", running=False)
        (self.state_dir / "calls.jsonl").unlink()
        self.assert_refused(self.request("deploy", ip=IP, image=DIGEST))

    def test_deploy_needs_the_store_to_exist(self):
        self.assert_refused(self.request("deploy", ip=IP, image=DIGEST))

    def test_the_script_never_builds_and_an_absent_image_is_refused_before_anything_changes(self):
        self.state["images"] = []
        self.save_state()
        answer = self.assert_refused(self.request("ensure", **self.ensure_fields()))
        self.assertIn("image", answer["reason"])
        self.assertFalse(self.trip_dir.exists())
        self.assertFalse(any(c[0] == "build" for c in self.calls()))
        # a deploy to an image the host lacks changes nothing either
        self.state["images"] = [f"trip-site:{DIGEST}"]
        self.save_state()
        self.run_host(self.request("ensure", **self.ensure_fields()))
        (self.state_dir / "calls.jsonl").unlink()
        self.assert_refused(self.request("deploy", ip=IP, image="cd" * 32))
        self.assertFalse(any(c[0] == "build" for c in self.calls()))
        self.assertEqual(list(self.load_state()["containers"]), [NAME])

    def test_there_is_no_build_path_and_no_releases_setting(self):
        text = (REPO / "scripts/trip-container-host.py").read_text()
        for gone in ('"build"', "RELEASES", "--pull=false", "Dockerfile"):
            self.assertNotIn(gone, text, f"{gone} came back into the boundary script")

    def test_an_unknown_config_key_for_a_releases_root_is_refused(self):
        # KINERARY_RELEASES_ROOT is not a setting any more; a stale config line is a refusal, not ignored
        self.conf["KINERARY_RELEASES_ROOT"] = str(self.work)
        self.assert_refused(self.request("stop"))


class Network(HostCase):
    def test_network_is_created_when_absent(self):
        code, out, err, _ = self.run_host(self.request("ensure", **self.ensure_fields()))
        self.assertEqual(code, 0, err)
        creates = [c for c in self.calls() if c[:2] == ["network", "create"]]
        self.assertEqual(creates, [["network", "create", "--driver", "bridge", "--subnet", SUBNET, NETWORK]])

    def test_existing_network_with_the_right_subnet_is_left_alone(self):
        self.state["networks"].append({"Name": NETWORK, "Id": "idx", "IPAM": {"Config": [{"Subnet": SUBNET}]}})
        self.save_state()
        code, out, err, _ = self.run_host(self.request("ensure", **self.ensure_fields()))
        self.assertEqual(code, 0, err)
        self.assertEqual([c for c in self.calls() if c[:2] == ["network", "create"]], [])

    def test_existing_network_with_another_subnet_is_refused(self):
        self.state["networks"].append({"Name": NETWORK, "Id": "idx", "IPAM": {"Config": [{"Subnet": "10.99.0.0/24"}]}})
        self.save_state()
        self.assert_refused(self.request("ensure", **self.ensure_fields()))
        self.assertFalse(self.trip_dir.exists())

    def test_a_subnet_that_overlaps_another_network_is_refused(self):
        for other in ("10.250.0.0/16", "10.250.0.128/25", "10.250.0.0/24"):
            with self.subTest(other=other):
                self.state["networks"] = [{"Name": "compose_default", "Id": "idc", "IPAM": {"Config": [{"Subnet": other}]}}]
                self.save_state()
                answer = self.assert_refused(self.request("ensure", **self.ensure_fields()))
                self.assertIn("overlap", answer["reason"])
                self.assertFalse(self.trip_dir.exists())


class EnsureFiles(HostCase):
    """AC-5."""

    def ensure(self, **over):
        return self.run_host(self.request("ensure", **self.ensure_fields(**over)))

    def read_env(self) -> dict:
        out = {}
        for line in (self.trip_dir / ".env").read_text().splitlines():
            key, _, value = line.partition("=")
            out[key] = value
        return out

    def test_layout_marker_and_env_for_a_new_trip(self):
        code, out, err, answer = self.ensure()
        self.assertEqual(code, 0, f"{out!r} {err!r}")
        self.assertIs(answer["ok"], True)
        uid = CONTAINER_UID
        for sub in ("", "trip", "server-data", "documents", "media"):
            st = (self.trip_dir / sub).lstat()
            self.assertTrue(stat.S_ISDIR(st.st_mode), sub)
            self.assertEqual(st.st_uid, uid, sub)
            self.assertEqual(stat.S_IMODE(st.st_mode) & 0o007, 0, f"{sub or 'trip dir'} is not world accessible")
        marker = (self.trip_dir / "TRIP.txt").read_text()
        self.assertIn(f"trip: {SLUG}\n", marker)
        self.assertIn(f"trip_id: {TRIP_ID}\n", marker)
        self.assertIn(f"slug: {SLUG}\n", marker)
        self.assertIn(f"container: {NAME}\n", marker)
        env_stat = (self.trip_dir / ".env").lstat()
        self.assertEqual(stat.S_IMODE(env_stat.st_mode), 0o600)
        self.assertEqual(env_stat.st_uid, uid)
        env = self.read_env()
        self.assertEqual(env["SEED_PASSWORD"], SECRET_PASSWORD)
        self.assertEqual(env["CONTROL_PLANE_EXCHANGE_KEY"], SECRET_KEY)
        self.assertEqual(env["HERMES_URL"], "http://bridge.internal:4310")
        self.assertEqual(env["PUBLIC_ORIGIN"], "https://alsace-2026.trips.example")
        self.assertEqual(env["TRIP_MCP_ENABLED"], "1")
        for generated in ("JWT_SECRET", "HERMES_API_KEY"):
            self.assertRegex(env[generated], r"^[0-9a-f]{64}$", generated)
        self.assertNotEqual(env["JWT_SECRET"], env["HERMES_API_KEY"])

    def test_generated_secrets_differ_between_trips(self):
        self.ensure()
        first = self.read_env()
        other_id, other_slug = "trip_" + "1" * 32, "second-trip"
        request = self.request("ensure", **self.ensure_fields(ip="10.250.0.11"))
        request.update(trip_id=other_id, slug=other_slug)
        code, out, err, _ = self.run_host(request)
        self.assertEqual(code, 0, err)
        second = {}
        for line in (self.nfs / other_id / ".env").read_text().splitlines():
            key, _, value = line.partition("=")
            second[key] = value
        self.assertNotEqual(first["JWT_SECRET"], second["JWT_SECRET"])
        self.assertNotEqual(first["HERMES_API_KEY"], second["HERMES_API_KEY"])

    def test_secrets_never_reach_argv_or_output(self):
        code, out, err, _ = self.ensure()
        self.assertEqual(code, 0, err)
        env = self.read_env()
        secrets = [SECRET_PASSWORD, SECRET_KEY, env["JWT_SECRET"], env["HERMES_API_KEY"]]
        argv_text = json.dumps(self.calls())
        self.assertTrue(self.calls())
        for secret in secrets:
            self.assertNotIn(secret, argv_text)
            self.assertNotIn(secret, out)
            self.assertNotIn(secret, err)
        # and the script never mentions a .env file to docker at all
        self.assertNotIn(".env", argv_text)

    def test_an_existing_env_is_never_rewritten(self):
        self.ensure()
        env_path = self.trip_dir / ".env"
        before = (env_path.read_bytes(), env_path.stat().st_ino, env_path.stat().st_mtime_ns)
        os.utime(env_path, ns=(1_000_000_000, 1_000_000_000))
        before = (env_path.read_bytes(), env_path.stat().st_ino, env_path.stat().st_mtime_ns)
        code, out, err, answer = self.ensure(seed_password="a-different-password", exchange_key="z" * 30)
        self.assertEqual(code, 0, err)
        self.assertEqual((env_path.read_bytes(), env_path.stat().st_ino, env_path.stat().st_mtime_ns), before)
        self.assertEqual(answer["env"], "kept")
        self.assertNotIn(b"a-different-password", env_path.read_bytes())

    def test_an_existing_env_needs_no_secrets_in_the_request(self):
        self.ensure()
        fields = {"ip": IP, "image": DIGEST}
        code, out, err, answer = self.run_host(self.request("ensure", **fields))
        self.assertEqual(code, 0, err)
        self.assertEqual(answer["env"], "kept")

    def test_a_failed_run_does_not_cost_the_env_and_a_retry_keeps_it(self):
        self.state["run_fails"] = True
        self.save_state()
        code, out, err, answer = self.ensure()
        self.assertEqual(code, 1)
        self.assertIs(answer["ok"], False)
        env_path = self.trip_dir / ".env"
        before = (env_path.read_bytes(), env_path.stat().st_ino, env_path.stat().st_mtime_ns)
        self.assertEqual(stat.S_IMODE(env_path.stat().st_mode), 0o600)
        self.state["run_fails"] = False
        self.save_state()
        code, out, err, _ = self.ensure(seed_password="another-password-1")
        self.assertEqual(code, 0, err)
        self.assertEqual((env_path.read_bytes(), env_path.stat().st_ino, env_path.stat().st_mtime_ns), before)

    def test_no_temp_file_is_left_behind(self):
        self.ensure()
        self.assertEqual(sorted(p.name for p in self.trip_dir.iterdir()),
                         [".env", "TRIP.txt", "documents", "media", "server-data", "trip"])

    def test_an_env_that_is_a_symlink_is_refused_and_not_followed(self):
        self.trip_dir.mkdir()
        target = self.work / "victim"
        target.write_text("precious\n")
        os.symlink(target, self.trip_dir / ".env")
        code, out, err, answer = self.ensure()
        self.assertNotEqual(code, 0)
        self.assertEqual(target.read_text(), "precious\n")
        self.assertEqual(self.mutating_calls(), [])

    def test_a_trip_dir_that_is_a_symlink_is_refused(self):
        elsewhere = self.work / "elsewhere"
        elsewhere.mkdir()
        os.symlink(elsewhere, self.trip_dir)
        code, out, err, _ = self.ensure()
        self.assertNotEqual(code, 0)
        self.assertEqual(list(elsewhere.iterdir()), [])
        self.assertEqual(self.mutating_calls(), [])

    def test_an_env_with_the_wrong_mode_is_reported_not_repaired(self):
        self.ensure()
        env_path = self.trip_dir / ".env"
        env_path.chmod(0o644)
        before = env_path.read_bytes()
        code, out, err, answer = self.ensure()
        self.assertEqual(code, 2)
        self.assertIs(answer["ok"], False)
        self.assertEqual(env_path.read_bytes(), before)
        self.assertEqual(stat.S_IMODE(env_path.stat().st_mode), 0o644)

    def test_an_unmounted_store_is_not_created(self):
        shutil.rmtree(self.nfs)
        self.assert_refused_no_snapshot(self.request("ensure", **self.ensure_fields()))
        self.assertFalse(self.nfs.exists())

    def assert_refused_no_snapshot(self, request):
        code, out, err, answer = self.run_host(request)
        self.assertNotEqual(code, 0)
        self.assertIs(answer["ok"], False)
        self.assertEqual(self.mutating_calls(), [])

    def test_building_a_new_env_without_a_seed_password_fails_loudly(self):
        # The .env can vanish between the preflight and the write (the container user owns the directory).
        import importlib.util
        from types import SimpleNamespace
        spec = importlib.util.spec_from_file_location("trip_container_host_impl", REPO / "scripts/trip-container-host.py")
        impl = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(impl)
        host_env = impl.HostEnv({k: v for k, v in self.conf.items() if k != "TRIP_CONTAINER_LOCK_FILE"}, False)
        req = SimpleNamespace(trip_id=TRIP_ID, slug=SLUG, name=NAME, seed_password=None, exchange_key=None,
                              hermes_url=None, public_origin=None, trip_mcp_enabled=False)
        with self.assertRaises(impl.Failure):
            impl.build_store(host_env, req)
        self.assertFalse((self.trip_dir / ".env").exists())

    def test_a_second_ensure_does_not_run_a_second_container(self):
        self.ensure()
        code, out, err, answer = self.ensure()
        self.assertEqual(code, 0, err)
        self.assertEqual(len([c for c in self.calls() if c[0] == "run"]), 1)
        self.assertEqual(answer["container"], "existing")

    def test_ensure_starts_an_existing_stopped_container(self):
        self.ensure()
        self.state = self.load_state()
        self.state["containers"][NAME]["running"] = False
        self.save_state()
        code, out, err, answer = self.ensure()
        self.assertEqual(code, 0, err)
        self.assertEqual(self.load_state()["containers"][NAME]["running"], True)
        self.assertEqual(len([c for c in self.calls() if c[0] == "run"]), 1)

    def test_not_root_and_not_the_container_uid_refuses_before_writing(self):
        other = "10001" if CONTAINER_UID != 10001 else "10002"
        self.conf["TRIP_CONTAINER_UID"] = other
        self.assert_refused(self.request("ensure", **self.ensure_fields()))
        self.assertFalse(self.trip_dir.exists())

    def test_the_container_uid_may_not_be_the_ssh_users_own(self):
        # sudo says who invoked the script; the container's uid is never that user's (the user could then read
        # and replace the files the container owns)
        for verb_request in (self.request("stop"), self.request("ensure", **self.ensure_fields())):
            self.assert_refused(verb_request, proc_env={"SUDO_UID": str(CONTAINER_UID)})
        code, out, err, answer = self.run_host(self.request("remove"), proc_env={"SUDO_UID": "0"})
        self.assertEqual(code, 0, err)


class OtherVerbs(HostCase):
    def test_start_stop(self):
        self.make_store()
        self.add_container(running=False)
        code, out, err, answer = self.run_host(self.request("start"))
        self.assertEqual((code, answer["ok"]), (0, True), err)
        self.assertEqual(self.mutating_calls(), [["start", NAME]])
        self.assertTrue(self.load_state()["containers"][NAME]["running"])
        code, out, err, answer = self.run_host(self.request("stop"))
        self.assertEqual((code, answer["ok"]), (0, True), err)
        self.assertEqual(self.mutating_calls()[-1], ["stop", NAME])
        self.assertFalse(self.load_state()["containers"][NAME]["running"])

    def test_start_stop_of_an_absent_container_fail_without_touching_anything(self):
        for verb in ("start", "stop"):
            code, out, err, answer = self.run_host(self.request(verb))
            self.assertEqual(code, 1)
            self.assertIs(answer["ok"], False)
        self.assertEqual(self.mutating_calls(), [])

    def test_remove_keeps_the_store(self):
        self.run_host(self.request("ensure", **self.ensure_fields()))
        before = self.tree_snapshot()
        code, out, err, answer = self.run_host(self.request("remove"))
        self.assertEqual((code, answer["ok"]), (0, True), err)
        self.assertEqual(self.mutating_calls()[-1], ["rm", "--force", NAME])
        self.assertNotIn("--volumes", " ".join(self.mutating_calls()[-1]))
        self.assertEqual(self.load_state()["containers"], {})
        self.assertEqual(self.tree_snapshot(), before, "the trip's directory is untouched")

    def test_remove_takes_a_deploy_leftover_too(self):
        self.add_container()
        self.add_container(name=NAME + ".prev", running=False)
        code, out, err, answer = self.run_host(self.request("remove"))
        self.assertEqual((code, answer["removed"]), (0, True), err)
        self.assertEqual(self.load_state()["containers"], {})

    def test_remove_refuses_a_leftover_with_another_trips_label(self):
        self.add_container(trip_id=OTHER_ID, name=NAME + ".prev", running=False)
        self.assert_refused(self.request("remove"))
        self.assertIn(NAME + ".prev", self.load_state()["containers"])

    def test_remove_of_an_absent_container_is_a_noop_success(self):
        code, out, err, answer = self.run_host(self.request("remove"))
        self.assertEqual((code, answer["ok"], answer["removed"]), (0, True, False))
        self.assertEqual(self.mutating_calls(), [])

    def test_check_healthy(self):
        self.make_store()
        self.add_container()
        code, out, err, answer = self.run_host(self.request("check"))
        self.assertEqual(code, 0, err)
        self.assertEqual((answer["ok"], answer["running"], answer["healthy"]), (True, True, True))
        execs = [c for c in self.calls() if c[0] == "exec"]
        self.assertEqual(len(execs), 1)
        self.assertEqual(execs[0][:2], ["exec", NAME])
        self.assertIn("curl", execs[0])
        self.assertIn("http://127.0.0.1:8080/api/health", execs[0])

    def test_check_unhealthy_and_stopped(self):
        self.make_store()
        self.add_container()
        self.state = self.load_state()
        self.state["health_code"] = "503"
        self.save_state()
        code, out, err, answer = self.run_host(self.request("check"))
        self.assertEqual(code, 1)
        self.assertEqual((answer["ok"], answer["running"], answer["healthy"]), (False, True, False))
        self.add_container(running=False)
        (self.state_dir / "calls.jsonl").unlink()
        code, out, err, answer = self.run_host(self.request("check"))
        self.assertEqual(code, 1)
        self.assertEqual((answer["ok"], answer["running"], answer["healthy"]), (False, False, False))
        self.assertEqual([c for c in self.calls() if c[0] == "exec"], [], "no exec into a stopped container")

    def test_check_absent_container(self):
        code, out, err, answer = self.run_host(self.request("check"))
        self.assertEqual(code, 1)
        self.assertIs(answer["ok"], False)


class Read(HostCase):
    def setUp(self) -> None:
        super().setUp()
        code, out, err, _ = self.run_host(self.request("ensure", **self.ensure_fields()))
        self.assertEqual(code, 0, err)
        self.env_values = {}
        for line in (self.trip_dir / ".env").read_text().splitlines():
            key, _, value = line.partition("=")
            self.env_values[key] = value

    def test_seed_password_only(self):
        code, out, err, answer = self.run_host(self.request("read", fields=["seed_password"]))
        self.assertEqual(code, 0, err)
        self.assertEqual(answer, {"ok": True, "verb": "read", "seed_password": SECRET_PASSWORD})
        for other in ("JWT_SECRET", "HERMES_API_KEY", "CONTROL_PLANE_EXCHANGE_KEY"):
            self.assertNotIn(self.env_values[other], out + err)

    def test_exchange_key_kind_reports_the_kind_never_the_key(self):
        candidates = {"derived": "d" * 30, "shared": SECRET_KEY}
        code, out, err, answer = self.run_host(
            self.request("read", fields=["exchange_key_kind"], exchange_key_candidates=candidates))
        self.assertEqual(code, 0, err)
        self.assertEqual(answer, {"ok": True, "verb": "read", "exchange_key_kind": "shared"})
        self.assertNotIn(SECRET_KEY, out + err)
        code, out, err, answer = self.run_host(
            self.request("read", fields=["exchange_key_kind"], exchange_key_candidates={"derived": "q" * 30}))
        self.assertEqual(answer["exchange_key_kind"], None)

    def test_site_to_bridge_runs_inside_the_container_and_carries_no_secret(self):
        code, out, err, answer = self.run_host(
            self.request("read", fields=["site_to_bridge"], bridge_url="http://bridge.internal:4310"))
        self.assertEqual(code, 0, err)
        self.assertIs(answer["site_to_bridge"]["ok"], True)
        self.assertIn("evidence", answer["site_to_bridge"])
        execs = [c for c in self.calls() if c[0] == "exec"]
        self.assertEqual(len(execs), 1)
        self.assertEqual(execs[0][:4], ["exec", NAME, "sh", "-c"])
        text = json.dumps(execs)
        self.assertIn("/trip-store/.env", text)
        for secret in (SECRET_PASSWORD, SECRET_KEY, self.env_values["HERMES_API_KEY"]):
            self.assertNotIn(secret, text + out + err)

    def test_site_to_bridge_failures_are_reported_as_evidence(self):
        self.state = self.load_state()
        self.state["bridge_result"] = "result=answered status=401 curl_exit=0"
        self.save_state()
        code, out, err, answer = self.run_host(
            self.request("read", fields=["site_to_bridge"], bridge_url="http://bridge.internal:4310"))
        self.assertIs(answer["site_to_bridge"]["ok"], False)
        self.assertIn("401", answer["site_to_bridge"]["evidence"])

    def test_all_three_fields_and_nothing_else(self):
        code, out, err, answer = self.run_host(self.request(
            "read", fields=["seed_password", "exchange_key_kind", "site_to_bridge"],
            exchange_key_candidates={"shared": SECRET_KEY}, bridge_url="http://bridge.internal:4310"))
        self.assertEqual(sorted(answer), ["exchange_key_kind", "ok", "seed_password", "site_to_bridge", "verb"])

    def test_values_in_the_env_are_validated_before_they_are_echoed(self):
        env_path = self.trip_dir / ".env"
        content = env_path.read_text().replace(f"SEED_PASSWORD={SECRET_PASSWORD}", 'SEED_PASSWORD=bad value"; x')
        env_path.write_text(content)
        env_path.chmod(0o600)
        code, out, err, answer = self.run_host(self.request("read", fields=["seed_password"]))
        self.assertEqual(code, 0, err)
        self.assertIsNone(answer["seed_password"])
        self.assertNotIn("bad value", out)

    def test_an_env_that_is_not_ours_is_not_read(self):
        env_path = self.trip_dir / ".env"
        env_path.chmod(0o644)
        code, out, err, answer = self.run_host(self.request("read", fields=["seed_password"]))
        self.assertEqual(code, 2)
        self.assertIs(answer["ok"], False)
        self.assertNotIn(SECRET_PASSWORD, out + err)

    def test_a_missing_env_reads_as_none(self):
        (self.trip_dir / ".env").unlink()
        code, out, err, answer = self.run_host(self.request("read", fields=["seed_password"]))
        self.assertEqual(code, 0, err)
        self.assertIsNone(answer["seed_password"])

    def test_an_env_that_is_a_symlink_is_not_followed(self):
        env_path = self.trip_dir / ".env"
        target = self.work / "victim"
        target.write_text(f"SEED_PASSWORD={SECRET_PASSWORD}\n")
        env_path.unlink()
        os.symlink(target, env_path)
        code, out, err, answer = self.run_host(self.request("read", fields=["seed_password"]))
        self.assertEqual(code, 2)
        self.assertNotIn(SECRET_PASSWORD, out + err)


class AnswerShape(HostCase):
    def test_every_answer_is_one_json_line_with_ok(self):
        self.add_container()
        for request in (self.request("check"), self.request("stop"), self.request("exec"), b"junk"):
            code, out, err, answer = self.run_host(request)
            self.assertEqual(len(out.strip().splitlines()), 1, out)
            self.assertIn("ok", answer)

    def test_refusals_never_echo_request_values(self):
        marker = "ZZ-NOT-ECHOED-ZZ"
        for request in (self.request("stop", slug=marker), self.request(marker), self.request("stop", **{marker: 1}),
                        self.request("ensure", **self.ensure_fields(seed_password=marker + " bad"))):
            code, out, err, answer = self.run_host(request)
            self.assertEqual(code, 2)
            self.assertNotIn(marker, out + err)



class Configuration(HostCase):
    """The host's settings come from one root-owned file, never from the environment (reviewer F3, F4)."""

    def test_the_process_environment_configures_nothing(self):
        self.add_container()
        poisoned = {"TRIP_CONTAINER_NETWORK": "evilnet", "TRIP_CONTAINER_SUBNET": "10.99.0.0/24", "TRIP_CONTAINER_UID": "4242",
                    "TRIP_CONTAINER_MEMORY": "99g", "KINERARY_NFS_ROOT": str(self.work / "elsewhere"),
                    "TRIP_CONTAINER_DOCKER": "/bin/false", "KINERARY_RELEASES_ROOT": "/"}
        code, out, err, answer = self.run_host(self.request("ensure", **self.ensure_fields()), proc_env=poisoned)
        self.assertEqual(code, 0, f"{out!r} {err!r}")
        run = [c for c in self.calls() if c[0] == "run"]
        self.assertEqual(run, [], "the container existed: ensure only inspected it")
        self.assertTrue((self.nfs / TRIP_ID / ".env").exists(), "the configured store was used")
        self.assertEqual([c for c in self.calls() if c[:2] == ["network", "create"]], [[
            "network", "create", "--driver", "bridge", "--subnet", SUBNET, NETWORK]])
        self.assertFalse((self.work / "elsewhere").exists())

    def test_every_docker_child_gets_a_scrubbed_environment(self):
        hostile = {"DOCKER_HOST": "tcp://203.0.113.9:2375", "DOCKER_CONFIG": str(self.work / "cfg"), "DOCKER_CONTEXT": "evil",
                   "LC_EVIL": "x", "SSH_AUTH_SOCK": "/tmp/agent", "SUDO_COMMAND": "x"}
        code, out, err, _ = self.run_host(self.request("ensure", **self.ensure_fields()), proc_env=hostile)
        self.assertEqual(code, 0, err)
        envs = self.docker_envs()
        self.assertTrue(envs, "the fake docker was run")
        for seen in envs:
            # (the interpreter running the fake adds its own locale variables; nothing else may be there)
            self.assertEqual(sorted(set(seen) - {"LC_CTYPE", "__CF_USER_TEXT_ENCODING"}), ["HOME", "LANG", "PATH"], seen)
            self.assertEqual(seen["PATH"], "/usr/bin:/bin")
            self.assertNotEqual(seen["HOME"], str(self.work), "the caller's HOME is not passed on")

    def test_a_docker_earlier_on_the_callers_path_is_never_run(self):
        evil = self.work / "evilbin"
        evil.mkdir()
        proof = self.work / "pwned.log"
        (evil / "docker").write_text(f"#!/bin/sh\necho pwned >> {proof}\nexit 1\n")
        (evil / "docker").chmod(0o755)
        (self.work / "docker").write_text(f"#!/bin/sh\necho pwned-cwd >> {proof}\nexit 1\n")
        (self.work / "docker").chmod(0o755)
        for path in (f"{evil}:/usr/bin:/bin", "", f".:{evil}", f"{evil}"):
            with self.subTest(path=path):
                self.add_container()
                code, out, err, answer = self.run_host(self.request("stop"), proc_env={"PATH": path})
                self.assertEqual(code, 0, f"{out!r} {err!r}")
        self.assertFalse(proof.exists(), "a docker named by the caller's PATH or the working directory ran")

    def test_bash_env_and_env_are_not_run(self):
        proof = self.work / "be.log"
        (self.work / "be.sh").write_text(f"echo ran >> {proof}\n")
        self.add_container()
        code, out, err, _ = self.run_host(self.request("stop"), proc_env={"BASH_ENV": str(self.work / "be.sh"),
                                                                           "ENV": str(self.work / "be.sh")})
        self.assertEqual(code, 0, err)
        self.assertFalse(proof.exists(), "BASH_ENV/ENV ran before the script's first line")

    def test_ssh_original_command_is_not_read(self):
        self.add_container()
        code, out, err, _ = self.run_host(self.request("stop"), proc_env={"SSH_ORIGINAL_COMMAND": "docker run --privileged -v /:/h x"})
        self.assertEqual(code, 0, err)
        self.assertEqual(self.mutating_calls(), [["stop", NAME]])

    def test_a_missing_config_file_refuses(self):
        self.conf_hook = lambda path: path.unlink()
        self.assert_refused(self.request("stop"))

    def test_a_config_file_others_can_write_refuses(self):
        for mode in (0o666, 0o620, 0o602, 0o660):
            with self.subTest(mode=oct(mode)):
                self.conf_hook = lambda path, mode=mode: path.chmod(mode)
                self.assert_refused(self.request("stop"))

    def test_a_config_directory_others_can_write_refuses(self):
        def widen(path):
            path.parent.chmod(0o777)
        self.conf_hook = widen
        self.assert_refused(self.request("stop"))

    def test_a_config_file_that_is_a_symlink_refuses(self):
        def link(path):
            real = path.with_name("real.conf")
            path.rename(real)
            os.symlink(real, path)
        self.conf_hook = link
        self.assert_refused(self.request("stop"))

    def test_a_hard_linked_config_file_refuses(self):
        self.conf_hook = lambda path: os.link(path, path.with_name("second.conf"))
        self.assert_refused(self.request("stop"))

    def test_unknown_repeated_and_malformed_config_lines_refuse(self):
        for line in ("SOMETHING_ELSE=1", "TRIP_CONTAINER_MEMORY=1g", "no equals sign", "KINERARY_RELEASES_ROOT=/x"):
            with self.subTest(line=line):
                def add(path, line=line):
                    with open(path, "a") as fh:
                        fh.write(line + "\n")
                self.conf_hook = add
                self.assert_refused(self.request("stop"))

    def test_comments_and_blank_lines_are_fine(self):
        def add(path):
            with open(path, "a") as fh:
                fh.write("\n   # a comment\n\n")
        self.conf_hook = add
        self.add_container()
        code, out, err, _ = self.run_host(self.request("stop"))
        self.assertEqual(code, 0, err)

    def test_no_config_path_means_the_fixed_product_path_which_is_not_here(self):
        # without the override (the sudo case) the script looks at its fixed path; on this machine it is absent
        if os.path.exists("/etc/kinerary/trip-container-host.conf"):
            self.skipTest("this machine has a real host configuration")
        env = {"PATH": "/usr/bin:/bin"}
        proc = subprocess.run([str(SCRIPT)], input=json.dumps(self.request("stop")).encode(), capture_output=True, env=env,
                              timeout=60)
        self.assertEqual(proc.returncode, 2, proc.stderr)
        self.assertEqual(self.calls(), [])


class StoreTrust(HostCase):
    """The document store is written by the worker: nothing under it is believed (reviewer F1, F6, F7)."""

    def test_deploy_on_a_trip_dir_that_is_a_symlink_to_another_trip_is_refused(self):
        self.run_host(self.request("ensure", **self.ensure_fields()))
        os.symlink(self.trip_dir, self.nfs / OTHER_ID)
        (self.state_dir / "calls.jsonl").unlink()
        self.assert_refused(self.request("deploy", trip_id=OTHER_ID, slug="evil", ip="10.250.0.20", image=DIGEST))
        self.assertEqual(list(self.load_state()["containers"]), [NAME])

    def test_verbs_on_a_trip_dir_that_is_a_symlink_out_of_the_store_are_refused(self):
        outside = self.work / "host-home"
        outside.mkdir()
        (outside / "TRIP.txt").write_text("x")
        (outside / ".env").write_text("x")
        os.symlink(outside, self.nfs / OTHER_ID)
        self.add_container(trip_id=OTHER_ID, name="trip-evil", source=str(self.nfs / OTHER_ID))
        self.state["containers"]["trip-evil"]["labels"]["kinerary.slug"] = "evil"
        self.save_state()
        for verb, extra in (("deploy", {"ip": "10.250.0.20", "image": DIGEST}), ("start", {}), ("check", {}),
                            ("read", {"fields": ["seed_password"]})):
            with self.subTest(verb=verb):
                self.assert_refused(self.request(verb, trip_id=OTHER_ID, slug="evil", **extra))

    def test_a_symlink_inside_the_trip_dir_is_never_written_through(self):
        for inner in ("media", "trip", "documents"):
            with self.subTest(inner=inner):
                shutil.rmtree(self.nfs)
                self.nfs.mkdir()
                self.trip_dir.mkdir()
                target = self.work / f"HOSTDIR-{inner}"
                target.mkdir(exist_ok=True)
                os.symlink(target, self.trip_dir / inner)
                code, out, err, answer = self.run_host(self.request("ensure", **self.ensure_fields()))
                self.assertNotEqual(code, 0)
                self.assertEqual(list(target.iterdir()), [], "files were written through a symlink")
                self.assertEqual(self.mutating_calls(), [])

    def test_a_trip_txt_that_is_a_symlink_is_refused_and_not_followed(self):
        self.run_host(self.request("ensure", **self.ensure_fields()))
        (self.state_dir / "calls.jsonl").unlink()
        txt = self.trip_dir / "TRIP.txt"
        content = txt.read_text()
        txt.unlink()
        real = self.work / "real-trip.txt"
        real.write_text(content)
        os.symlink(real, txt)
        for verb, extra in (("ensure", self.ensure_fields()), ("deploy", {"ip": IP, "image": DIGEST}), ("start", {}),
                            ("check", {}), ("read", {"fields": ["seed_password"]})):
            with self.subTest(verb=verb):
                self.assert_refused(self.request(verb, **extra))

    def test_the_store_root_itself_may_not_be_a_symlink(self):
        real = self.work / "realnfs"
        real.mkdir()
        shutil.rmtree(self.nfs)
        os.symlink(real, self.nfs)
        self.assert_refused(self.request("ensure", **self.ensure_fields()))
        self.assertEqual(list(real.iterdir()), [])

    def test_an_env_that_is_a_fifo_does_not_hang_any_verb(self):
        self.run_host(self.request("ensure", **self.ensure_fields()))
        env_path = self.trip_dir / ".env"
        env_path.unlink()
        os.mkfifo(env_path, 0o600)
        started = time.monotonic()
        for verb, extra in (("read", {"fields": ["seed_password"]}), ("deploy", {"ip": IP, "image": DIGEST}),
                            ("start", {}), ("check", {}), ("ensure", self.ensure_fields())):
            with self.subTest(verb=verb):
                code, out, err, answer = self.run_host(self.request(verb, **extra), timeout=20)
                self.assertEqual(code, 2, f"{out!r} {err!r}")
        self.assertLess(time.monotonic() - started, 40)

    def test_a_trip_txt_that_is_a_fifo_does_not_hang(self):
        self.run_host(self.request("ensure", **self.ensure_fields()))
        txt = self.trip_dir / "TRIP.txt"
        txt.unlink()
        os.mkfifo(txt, 0o644)
        code, out, err, answer = self.run_host(self.request("read", fields=["seed_password"]), timeout=20)
        self.assertEqual(code, 2, f"{out!r} {err!r}")

    def test_an_env_with_two_links_is_not_read(self):
        self.run_host(self.request("ensure", **self.ensure_fields()))
        os.link(self.trip_dir / ".env", self.work / "second-name")
        code, out, err, answer = self.run_host(self.request("read", fields=["seed_password"]))
        self.assertEqual(code, 2)
        self.assertNotIn(SECRET_PASSWORD, out + err)

    def test_trip_txt_must_name_this_trip_for_every_verb_that_uses_the_store(self):
        cases = {
            "another slug": f"trip: other\ntrip_id: {TRIP_ID}\nslug: other\n",
            "another trip id": f"trip: {SLUG}\ntrip_id: {OTHER_ID}\nslug: {SLUG}\n",
            "the old format with no ids": f"trip: {SLUG}\ndata: x\ncontainer: {NAME}\n",
            "a repeated id line": f"trip_id: {TRIP_ID}\ntrip_id: {TRIP_ID}\nslug: {SLUG}\n",
            "empty": "",
        }
        for label, text in cases.items():
            with self.subTest(label):
                self.make_store(slug=SLUG)
                (self.trip_dir / "TRIP.txt").write_text(text)
                self.add_container()
                for verb, extra in (("ensure", self.ensure_fields()), ("deploy", {"ip": IP, "image": DIGEST}), ("start", {}),
                                    ("check", {}), ("read", {"fields": ["seed_password"]})):
                    answer = self.assert_refused(self.request(verb, **extra))
                    self.assertNotIn(SECRET_PASSWORD, json.dumps(answer))

    def test_a_victims_trip_id_with_a_slug_that_has_no_container_cannot_be_read(self):
        # reviewer A5d: read asked for the victim's seed password under a made-up slug
        self.run_host(self.request("ensure", **self.ensure_fields()))
        (self.state_dir / "calls.jsonl").unlink()
        answer = self.assert_refused(self.request("read", slug="never-existed", fields=["seed_password"]))
        self.assertNotIn(SECRET_PASSWORD, json.dumps(answer))

    def test_a_removed_victims_directory_cannot_be_adopted_under_a_new_slug(self):
        # reviewer A5e: teardown keeps the directory; ensure of the same trip id under another slug
        self.run_host(self.request("ensure", **self.ensure_fields()))
        self.run_host(self.request("remove"))
        (self.state_dir / "calls.jsonl").unlink()
        self.assert_refused(self.request("ensure", slug="squatter", **self.ensure_fields(ip="10.250.0.31")))

    def test_a_victims_slug_under_another_trip_id_touches_nothing(self):
        self.run_host(self.request("ensure", **self.ensure_fields()))
        (self.state_dir / "calls.jsonl").unlink()
        for verb, extra in (("stop", {}), ("remove", {}), ("start", {}), ("check", {}),
                            ("deploy", {"ip": IP, "image": DIGEST})):
            with self.subTest(verb=verb):
                self.assert_refused(self.request(verb, trip_id=OTHER_ID, **extra))
        self.assertEqual(list(self.load_state()["containers"]), [NAME])
        self.assertTrue(self.load_state()["containers"][NAME]["running"])


class MountReadBack(HostCase):
    """After every run the daemon's own record of the mounts is checked (reviewer F1)."""

    def test_a_mount_that_is_not_the_trips_directory_removes_the_container_and_fails(self):
        self.state["mount_source_override"] = "/"
        self.save_state()
        code, out, err, answer = self.run_host(self.request("ensure", **self.ensure_fields()))
        self.assertEqual(code, 1, f"{out!r} {err!r}")
        self.assertIs(answer["ok"], False)
        self.assertIn(["rm", "--force", NAME], self.calls())
        self.assertEqual(self.load_state()["containers"], {})

    def test_a_second_mount_is_refused_the_same_way(self):
        self.state["extra_mount"] = True
        self.save_state()
        code, out, err, answer = self.run_host(self.request("ensure", **self.ensure_fields()))
        self.assertEqual(code, 1)
        self.assertEqual(self.load_state()["containers"], {})

    def test_deploy_with_a_wrong_mount_puts_the_previous_container_back(self):
        self.run_host(self.request("ensure", **self.ensure_fields()))
        self.state = self.load_state()
        self.state["mount_source_override"] = "/"
        self.save_state()
        code, out, err, answer = self.run_host(self.request("deploy", ip=IP, image=DIGEST))
        self.assertEqual(code, 1)
        containers = self.load_state()["containers"]
        self.assertEqual(list(containers), [NAME])
        self.assertTrue(containers[NAME]["running"])
        self.assertEqual(containers[NAME]["mounts"][0]["Source"], str(self.point()))

    def test_start_check_and_ensure_refuse_an_existing_container_that_mounts_something_else(self):
        self.make_store()
        self.add_container(running=False, source="/")
        for verb, extra in (("start", {}), ("check", {}), ("ensure", self.ensure_fields())):
            with self.subTest(verb=verb):
                self.assert_refused(self.request(verb, **extra))
        self.assertFalse(self.load_state()["containers"][NAME]["running"])

    def test_the_rollback_only_removes_containers_that_are_the_trips_own(self):
        import importlib.util
        spec = importlib.util.spec_from_file_location("trip_container_host_impl2", REPO / "scripts/trip-container-host.py")
        impl = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(impl)
        self.add_container(trip_id=OTHER_ID)           # something else holds the trip's name
        req = impl.Request(self.request("stop"), impl.HostEnv(dict(self.conf), False))
        impl.remove_if_ours(impl.Docker(str(self.fake), impl.HostEnv(dict(self.conf), False)), req, NAME)
        self.assertIn(NAME, self.load_state()["containers"], "a foreign container was removed")
        self.assertFalse(any(c[0] == "rm" for c in self.calls()))
        self.add_container()
        impl.remove_if_ours(impl.Docker(str(self.fake), impl.HostEnv(dict(self.conf), False)), req, NAME)
        self.assertNotIn(NAME, self.load_state()["containers"])


class SwapDuringTheRequest(HostCase):
    """The worker can replace the trip's directory at any moment. The daemon is never given that path any more: it
    is given a root-owned mount point that is bound to the directory the walk opened (reviewer F1, A2).

    The fake mount can only stand a symlink in for the bind, so what these tests pin is what the script controls:
    the descriptor it hands to mount, the path it hands to docker, and that it refuses afterwards. That the bind
    really survives a swap is proved against the kernel in test_trip_container_host_root."""

    def swap_command(self) -> str:
        host = self.work / "HOSTROOT"
        host.mkdir(exist_ok=True)
        d = str(self.trip_dir)
        return f"mv '{d}' '{d}.moved' && ln -s '{host}' '{d}'"

    def mounted_ident(self) -> list:
        return [c for c in self.mount_calls() if c["tool"] == "mount"][0]["fd_ident"]

    def test_a_swap_during_network_create_cannot_redirect_the_container(self):
        self.state["on_network_create"] = self.swap_command()
        self.save_state()
        code, out, err, answer = self.run_host(self.request("ensure", **self.ensure_fields()))
        self.assertEqual(code, 0, f"{out!r} {err!r}")
        moved = Path(str(self.trip_dir) + ".moved")
        st = os.stat(moved)
        self.assertEqual(self.mounted_ident(), [st.st_dev, st.st_ino], "mount was handed the directory the walk opened")
        self.assertEqual(list((self.work / "HOSTROOT").iterdir()), [])
        run = [c for c in self.calls() if c[0] == "run"][0]
        self.assertIn(f"type=bind,source={self.point()},target=/trip-store", run)
        self.assertNotIn(str(self.nfs), " ".join(run))

    def test_a_swap_after_the_run_cannot_redirect_a_later_start(self):
        # the live fact: the daemon re-resolves a bind source on every start. The source is now the mount point,
        # and every verb that would start something redoes the walk and refuses a link.
        self.run_host(self.request("ensure", **self.ensure_fields()))
        host = self.work / "HOSTROOT"
        host.mkdir()
        os.rename(self.trip_dir, str(self.trip_dir) + ".moved")
        os.symlink(host, self.trip_dir)
        (self.state_dir / "calls.jsonl").unlink()
        mounts_before = len(self.mount_calls())
        for verb, extra in (("start", {}), ("check", {}), ("deploy", {"ip": IP, "image": DIGEST}),
                            ("ensure", self.ensure_fields())):
            with self.subTest(verb=verb):
                self.assert_refused(self.request(verb, **extra))
        self.assertEqual(len(self.mount_calls()), mounts_before, "no remount, no unmount")

    def test_a_swap_during_a_deploys_stop_leaves_the_mount_alone(self):
        self.run_host(self.request("ensure", **self.ensure_fields()))
        self.state = self.load_state()
        self.state["on_stop"] = self.swap_command()
        self.save_state()
        mounts_before = len(self.mount_calls())
        code, out, err, answer = self.run_host(self.request("deploy", ip=IP, image=DIGEST))
        self.assertEqual(code, 0, f"{out!r} {err!r}")
        self.assertEqual(len(self.mount_calls()), mounts_before)
        self.assertEqual(self.load_state()["containers"][NAME]["mounts"][0]["Source"], str(self.point()))


class LockAndDeadline(HostCase):
    def lock_held(self):
        import fcntl
        fd = os.open(self.work / "host.lock", os.O_RDWR | os.O_CREAT, 0o600)
        self.addCleanup(os.close, fd)
        fcntl.flock(fd, fcntl.LOCK_EX)

    def test_a_mutating_verb_waits_for_the_host_lock_and_gives_up_at_the_deadline(self):
        self.add_container()
        self.lock_held()
        started = time.monotonic()
        code, out, err, answer = self.run_host(self.request("stop"), extra_env={"TRIP_CONTAINER_TIMEOUT": "2"}, timeout=30)
        self.assertEqual(code, 1, f"{out!r} {err!r}")
        self.assertIn("timed out", answer["reason"])
        self.assertLess(time.monotonic() - started, 20)
        self.assertEqual(self.mutating_calls(), [], "nothing ran while the lock was held")
        self.assertTrue(self.load_state()["containers"][NAME]["running"])

    def test_reads_do_not_take_the_lock(self):
        self.make_store()
        self.add_container()
        self.lock_held()
        code, out, err, answer = self.run_host(self.request("read", fields=["seed_password"]),
                                               extra_env={"TRIP_CONTAINER_TIMEOUT": "5"}, timeout=30)
        self.assertEqual(code, 0, f"{out!r} {err!r}")

    def test_after_a_request_the_lock_is_free_again(self):
        import fcntl
        self.add_container()
        self.run_host(self.request("stop"))
        fd = os.open(self.work / "host.lock", os.O_RDWR)
        self.addCleanup(os.close, fd)
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)

    def test_a_lock_file_that_is_a_symlink_is_not_followed(self):
        self.add_container()
        victim = self.work / "victim"
        victim.write_text("keep")
        os.symlink(victim, self.work / "host.lock")
        code, out, err, answer = self.run_host(self.request("stop"))
        self.assertEqual(code, 1)
        self.assertEqual(victim.read_text(), "keep")
        self.assertEqual(self.mutating_calls(), [])

    def test_a_docker_that_hangs_is_cut_off_at_the_deadline(self):
        self.state["hang_on"] = "container"
        self.save_state()
        started = time.monotonic()
        code, out, err, answer = self.run_host(self.request("stop"), extra_env={"TRIP_CONTAINER_TIMEOUT": "2"}, timeout=40)
        self.assertEqual(code, 1, f"{out!r} {err!r}")
        self.assertIn("timed out", answer["reason"])
        self.assertLess(time.monotonic() - started, 30)


class JsonEdges(HostCase):
    def test_deep_nesting_is_a_refusal_not_an_internal_error(self):
        deep = (b'{"record_type":"trip_container_request","verb":"stop","trip_id":"' + TRIP_ID.encode() +
                b'","slug":"a","x":' + b"[" * 30000 + b"]" * 30000 + b"}")
        answer = self.assert_refused(deep)
        self.assertEqual(answer["error"], "refused")

    def test_other_json_shapes_are_refusals(self):
        base = json.dumps(self.request("stop"))
        cases = {
            "bom": b"\xef\xbb\xbf" + base.encode(),
            "trailing object": (base + ' {"verb":"remove"}').encode(),
            "nan": base[:-1].encode() + b',"x":NaN}',
            "huge int": base[:-1].encode() + b',"x":' + b"9" * 5000 + b"}",
            "invalid utf8": b'{"verb":"\xff"}',
            "fullwidth numeral in the trip id": base.replace(TRIP_ID, TRIP_ID[:-1] + "１").encode(),
            "cyrillic a in the slug": base.replace("alsace", "аlsace").encode(),
            "nul in the trip id": base.replace(TRIP_ID, TRIP_ID + "\\u0000").encode(),
        }
        for label, raw in cases.items():
            with self.subTest(label):
                self.assert_refused(raw)
        self.assertEqual(self.calls(), [])



class Bind(HostCase):
    """The daemon is given a root-owned mount point, bound to the directory the walk opened (reviewer F1, round 2)."""

    def store_ident(self):
        st = os.stat(self.trip_dir)
        return [st.st_dev, st.st_ino]

    def test_ensure_binds_the_descriptor_it_walked_to_and_runs_on_the_mount_point(self):
        code, out, err, answer = self.run_host(self.request("ensure", **self.ensure_fields()))
        self.assertEqual(code, 0, f"{out!r} {err!r}")
        self.assertEqual(answer["bind"], "mounted")
        mounts = [c for c in self.mount_calls() if c["tool"] == "mount"]
        self.assertEqual(len(mounts), 1)
        argv = mounts[0]["argv"]
        self.assertEqual(argv[:2], ["--no-canonicalize", "--bind"])
        self.assertRegex(argv[2], r"^/proc/self/fd/[0-9]+$", "the source is a descriptor, not a path on the store")
        self.assertEqual(argv[3], str(self.point()))
        self.assertEqual(mounts[0]["fd_ident"], self.store_ident(), "the descriptor handed to mount is the trip's directory")
        self.assertIn(str(self.point()), self.mountinfo.read_text())
        run = [c for c in self.calls() if c[0] == "run"][0]
        self.assertEqual(run[run.index("--mount") + 1], f"type=bind,source={self.point()},target=/trip-store")
        self.assertNotIn(str(self.nfs), " ".join(run), "the daemon is never given a path on the worker-writable store")

    def test_a_second_ensure_does_not_mount_again(self):
        self.run_host(self.request("ensure", **self.ensure_fields()))
        code, out, err, answer = self.run_host(self.request("ensure", **self.ensure_fields()))
        self.assertEqual(code, 0, err)
        self.assertEqual(answer["bind"], "existing")
        self.assertEqual(len([c for c in self.mount_calls() if c["tool"] == "mount"]), 1)

    def test_start_check_and_deploy_rebind_a_bind_the_host_lost(self):
        self.run_host(self.request("ensure", **self.ensure_fields()))
        for verb, extra in (("start", {}), ("check", {}), ("deploy", {"ip": IP, "image": DIGEST})):
            with self.subTest(verb=verb):
                self.simulate_reboot_unmount()
                before = len([c for c in self.mount_calls() if c["tool"] == "mount"])
                code, out, err, answer = self.run_host(self.request(verb, **extra))
                self.assertEqual(code, 0, f"{out!r} {err!r}")
                self.assertEqual(len([c for c in self.mount_calls() if c["tool"] == "mount"]), before + 1)
                self.assertEqual(os.stat(self.point()).st_ino, os.stat(self.trip_dir).st_ino)

    def test_a_replaced_store_directory_is_refused_and_never_mounted_over(self):
        self.run_host(self.request("ensure", **self.ensure_fields()))
        os.rename(self.trip_dir, str(self.trip_dir) + ".old")
        self.follow_inode(str(self.trip_dir) + ".old")
        self.make_store()                            # a different directory with the same names and a matching TRIP.txt
        (self.state_dir / "calls.jsonl").unlink()
        mounts_before = len(self.mount_calls())
        for verb, extra in (("start", {}), ("check", {}), ("deploy", {"ip": IP, "image": DIGEST}),
                            ("ensure", self.ensure_fields())):
            with self.subTest(verb=verb):
                answer = self.assert_refused(self.request(verb, **extra))
                self.assertIn("different directory", answer["reason"])
        self.assertEqual(len(self.mount_calls()), mounts_before, "nothing was mounted or unmounted")
        self.assertEqual(os.stat(self.point()).st_ino, os.stat(str(self.trip_dir) + ".old").st_ino)

    def test_a_mount_point_with_something_in_it_is_refused(self):
        self.point().mkdir()
        (self.point() / "leftover").write_text("x")
        self.assert_refused(self.request("ensure", **self.ensure_fields()))
        self.assertEqual([c for c in self.mount_calls() if c["tool"] == "mount"], [])

    def test_a_failed_mount_fails_before_any_container_is_run(self):
        self.set_mount_state(mount_fails=True)
        code, out, err, answer = self.run_host(self.request("ensure", **self.ensure_fields()))
        self.assertEqual(code, 1, f"{out!r} {err!r}")
        self.assertFalse(any(c[0] == "run" for c in self.calls()))

    def test_a_bind_that_shows_another_directory_is_undone(self):
        self.set_mount_state(wrong_target=str(self.work))
        code, out, err, answer = self.run_host(self.request("ensure", **self.ensure_fields()))
        self.assertEqual(code, 1, f"{out!r} {err!r}")
        self.assertIn("undone", answer["reason"])
        self.assertTrue(any(c["tool"] == "umount" for c in self.mount_calls()))
        self.assertFalse(any(c[0] == "run" for c in self.calls()))

    def test_remove_unmounts_and_removes_the_mount_point_and_keeps_the_store(self):
        self.run_host(self.request("ensure", **self.ensure_fields()))
        store_before = self.tree_snapshot()
        code, out, err, answer = self.run_host(self.request("remove"))
        self.assertEqual(code, 0, f"{out!r} {err!r}")
        self.assertEqual([c["argv"] for c in self.mount_calls() if c["tool"] == "umount"], [[str(self.point())]])
        self.assertFalse(os.path.lexists(self.point()))
        self.assertNotIn(str(self.point()), self.mountinfo.read_text())
        self.assertEqual(self.tree_snapshot(), store_before)

    def test_remove_with_no_container_still_unbinds(self):
        self.run_host(self.request("ensure", **self.ensure_fields()))
        self.run_host(self.request("remove"))
        self.run_host(self.request("ensure", **self.ensure_fields()))
        self.state = self.load_state()
        self.state["containers"] = {}
        self.save_state()
        code, out, err, answer = self.run_host(self.request("remove"))
        self.assertEqual((code, answer["removed"]), (0, True), err)
        self.assertFalse(os.path.lexists(self.point()))

    def test_a_remove_whose_unmount_fails_says_so(self):
        self.run_host(self.request("ensure", **self.ensure_fields()))
        self.set_mount_state(umount_fails=True)
        code, out, err, answer = self.run_host(self.request("remove"))
        self.assertEqual(code, 1)
        self.assertIn("unmounted", answer["reason"])

    def test_the_mount_root_is_checked_before_a_remove_changes_anything(self):
        self.run_host(self.request("ensure", **self.ensure_fields()))
        self.mount_root.chmod(0o775)
        (self.state_dir / "calls.jsonl").unlink()
        self.assert_refused(self.request("remove"))
        self.assertIn(NAME, self.load_state()["containers"])

    def test_start_verifies_the_mounts_after_the_daemon_starts_it(self):
        # the daemon re-resolves the source on every start: a start is as much a mount as a run
        self.make_store()
        self.add_container(running=False)
        self.state["start_changes_mount"] = True
        self.save_state()
        code, out, err, answer = self.run_host(self.request("start"))
        self.assertEqual(code, 1, f"{out!r} {err!r}")
        self.assertIn("stopped", answer["reason"])
        self.assertFalse(self.load_state()["containers"][NAME]["running"])

    def test_ensure_restarting_a_stopped_container_verifies_it_too(self):
        self.run_host(self.request("ensure", **self.ensure_fields()))
        self.state = self.load_state()
        self.state["containers"][NAME]["running"] = False
        self.state["start_changes_mount"] = True
        self.save_state()
        code, out, err, answer = self.run_host(self.request("ensure", **self.ensure_fields()))
        self.assertEqual(code, 1)
        self.assertFalse(self.load_state()["containers"][NAME]["running"])


class MountRootAndBinaries(HostCase):
    def test_a_mount_root_that_is_not_the_hosts_own_is_refused(self):
        def loosen(mode):
            return lambda path: self.mount_root.chmod(mode)
        for mode in (0o777, 0o775, 0o757, 0o1777):
            with self.subTest(mode=oct(mode)):
                self.conf_hook = loosen(mode)
                self.assert_refused(self.request("ensure", **self.ensure_fields()))
        self.conf_hook = None
        self.mount_root.chmod(0o755)

    def test_a_mount_root_that_is_missing_or_a_symlink_or_not_canonical_is_refused(self):
        real = self.work / "real-mnt"
        real.mkdir()
        link = self.work / "link-mnt"
        os.symlink(real, link)
        for value in (str(self.work / "nope"), str(link), str(self.work / "mnt/../mnt"), "relative/mnt", "/"):
            with self.subTest(value=value):
                self.assert_refused(self.request("ensure", **self.ensure_fields()), extra_env={"TRIP_CONTAINER_MOUNT_ROOT": value})

    def test_a_mount_root_on_nfs_is_refused(self):
        self.mountinfo.write_text(f"1 0 8:1 / / rw - ext4 /dev/root rw\n40 1 0:40 / {self.work} rw - nfs4 server:/export rw\n")
        answer = self.assert_refused(self.request("ensure", **self.ensure_fields()))
        self.assertIn("NFS", answer["reason"])

    def test_the_mount_root_setting_is_required(self):
        self.assert_refused(self.request("ensure", **self.ensure_fields()), drop=("TRIP_CONTAINER_MOUNT_ROOT",))

    def test_binaries_others_can_write_are_refused(self):
        for label, path in (("docker", self.fake), ("mount", self.fake_mount), ("umount", self.fake_umount)):
            with self.subTest(binary=label):
                path.chmod(0o775)
                try:
                    code, out, err, answer = self.run_host(self.request("ensure", **self.ensure_fields()))
                    if label == "umount":
                        self.assertEqual(code, 0)      # umount is only looked at when it is used
                    else:
                        self.assertEqual(code, 2, f"{out!r} {err!r}")
                finally:
                    path.chmod(0o755)
                shutil.rmtree(self.nfs)
                self.nfs.mkdir()
                self.state = self.load_state()
                self.state["containers"] = {}
                self.save_state()
                self.simulate_reboot_unmount()

    def test_test_only_keys_are_not_for_a_root_config(self):
        # (as root the script refuses a config that sets them; here, as a plain user, they are the test hooks)
        import importlib.util
        spec = importlib.util.spec_from_file_location("trip_container_host_impl3", REPO / "scripts/trip-container-host.py")
        impl = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(impl)
        with self.assertRaises(impl.Refusal):
            impl.HostEnv(dict(self.conf), True)
        impl.HostEnv(dict(self.conf), False)


class TripTxtLines(HostCase):
    def test_only_a_newline_ends_a_line(self):
        cases = {
            "carriage return": f"trip_id: {TRIP_ID}\r\nslug: {SLUG}\n",
            "line separator inside the value": f"trip_id: {TRIP_ID}\nslug: other slug: {SLUG}\n",
            "form feed": f"trip_id: {TRIP_ID}\nslug: other\x0cslug: {SLUG}\n",
        }
        for label, text in cases.items():
            with self.subTest(label):
                self.make_store()
                (self.trip_dir / "TRIP.txt").write_text(text, encoding="utf-8")
                self.add_container()
                for verb, extra in (("start", {}), ("read", {"fields": ["seed_password"]})):
                    self.assert_refused(self.request(verb, **extra))


class BootRebind(HostCase):
    def trip(self, n: int):
        return "trip_" + str(n) * 32, f"trip-number-{n}"

    @staticmethod
    def make_trip_for(case, n: int):
        trip_id, slug = "trip_" + str(n) * 32, f"trip-number-{n}"
        request = case.request("ensure", trip_id=trip_id, slug=slug, **case.ensure_fields(ip=f"10.250.0.{20 + n}"))
        code, out, err, answer = case.run_host(request)
        case.assertEqual(code, 0, f"{out!r} {err!r}")
        return trip_id, slug

    def make_trip(self, n: int):
        trip_id, slug = self.trip(n)
        request = self.request("ensure", trip_id=trip_id, slug=slug, **self.ensure_fields(ip=f"10.250.0.{20 + n}"))
        code, out, err, answer = self.run_host(request)
        self.assertEqual(code, 0, f"{out!r} {err!r}")
        return trip_id, slug

    def boot(self, **kw):
        return self.run_host(b"", args=("--boot",), **kw)

    def test_boot_rebinds_every_trip_whose_container_is_ours(self):
        trips = [self.make_trip(1), self.make_trip(2)]
        for trip_id, _ in trips:
            self.simulate_reboot_unmount(trip_id)
        code, out, err, answer = self.boot()
        self.assertEqual(code, 0, f"{out!r} {err!r}")
        self.assertEqual(sorted(answer["rebound"]), sorted(slug for _, slug in trips))
        for trip_id, _ in trips:
            self.assertEqual(os.stat(self.point(trip_id)).st_ino, os.stat(self.nfs / trip_id).st_ino)

    def test_boot_reports_a_trip_it_cannot_bind_and_still_binds_the_rest(self):
        good = self.make_trip(1)
        bad = self.make_trip(2)
        for trip_id, _ in (good, bad):
            self.simulate_reboot_unmount(trip_id)
        (self.nfs / bad[0] / "TRIP.txt").write_text(f"trip_id: {OTHER_ID}\nslug: {bad[1]}\n")
        code, out, err, answer = self.boot()
        self.assertEqual(code, 1)
        self.assertEqual(answer["rebound"], [good[1]])
        self.assertEqual(answer["failed"], [bad[1]])

    def test_boot_does_not_remount_a_good_bind_and_does_not_touch_foreign_containers(self):
        good = self.make_trip(1)
        self.state = self.load_state()
        self.add_container(trip_id=OTHER_ID, name="trip-not-ours", labels={})
        self.add_container(trip_id="x", name="somebody-else", labels={"kinerary.trip_id": "not-a-trip-id", "kinerary.slug": "x"})
        before = len([c for c in self.mount_calls() if c["tool"] == "mount"])
        code, out, err, answer = self.boot()
        self.assertEqual(code, 0, f"{out!r} {err!r}")
        self.assertEqual(len([c for c in self.mount_calls() if c["tool"] == "mount"]), before)
        self.assertEqual(answer["rebound"], [good[1]])
        self.assertEqual(self.mutating_calls()[-1][0], "run", "boot ran no container command")

    def test_boot_is_not_available_over_sudo_or_with_other_arguments(self):
        self.make_trip(1)
        code, out, err, answer = self.run_host(b"", args=("--boot",), proc_env={"SUDO_UID": "1234"})
        self.assertEqual(code, 2)
        for args in (("--boot", "extra"), ("boot",), ("--reboot",), ("--boot", "--boot")):
            with self.subTest(args=args):
                code, out, err, answer = self.run_host(b"", args=args)
                self.assertEqual(code, 2)

    def test_boot_takes_the_host_lock(self):
        import fcntl
        self.make_trip(1)
        fd = os.open(self.work / "host.lock", os.O_RDWR | os.O_CREAT, 0o600)
        self.addCleanup(os.close, fd)
        fcntl.flock(fd, fcntl.LOCK_EX)
        code, out, err, answer = self.boot(extra_env={"TRIP_CONTAINER_TIMEOUT": "2"})
        self.assertEqual(code, 1)
        self.assertIn("timed out", answer["reason"])


class DeadlineHalfWay(HostCase):
    """A deadline that fires half-way must not leave a half-made trip behind (reviewer N1, round 2)."""

    def test_a_deadline_after_the_run_removes_the_container_that_is_ours(self):
        self.state["sleep_after_run"] = 10
        self.save_state()
        started = time.monotonic()
        code, out, err, answer = self.run_host(self.request("ensure", **self.ensure_fields()),
                                               extra_env={"TRIP_CONTAINER_TIMEOUT": "2"}, timeout=40)
        self.assertEqual(code, 1, f"{out!r} {err!r}")
        self.assertIn("timed out", answer["reason"])
        self.assertEqual(self.load_state()["containers"], {}, "the container made just before the deadline is gone")
        self.assertLess(time.monotonic() - started, 30)

    def test_a_deadline_during_a_deploys_rename_puts_the_stopped_trip_back(self):
        self.run_host(self.request("ensure", **self.ensure_fields()))
        self.state = self.load_state()
        self.state["sleep_before"] = {"rename": 10}
        self.save_state()
        code, out, err, answer = self.run_host(self.request("deploy", ip=IP, image=DIGEST),
                                               extra_env={"TRIP_CONTAINER_TIMEOUT": "2"}, timeout=40)
        self.assertEqual(code, 1, f"{out!r} {err!r}")
        containers = self.load_state()["containers"]
        self.assertEqual(list(containers), [NAME])
        self.assertTrue(containers[NAME]["running"], "the trip is serving again, not left stopped")
        self.assertIn("put back", answer["reason"])



class RemoveMayOnlyUnbindItsOwn(HostCase):
    """Advisor/reviewer: a remove for another slug must not unmount a running trip's bind."""

    def test_the_victims_trip_id_with_another_slug_is_refused_and_nothing_is_unmounted(self):
        self.run_host(self.request("ensure", **self.ensure_fields()))
        (self.state_dir / "calls.jsonl").unlink()
        mounts_before = len(self.mount_calls())
        self.assert_refused(self.request("remove", slug="some-other-slug"))
        self.assertEqual(len(self.mount_calls()), mounts_before, "the victim's bind was touched")
        self.assertTrue(os.path.islink(self.point()) or os.path.isdir(self.point()))
        self.assertIn(str(self.point()), self.mountinfo.read_text())
        self.assertTrue(self.load_state()["containers"][NAME]["running"])

    def test_with_no_container_the_trip_txt_must_prove_the_request(self):
        self.run_host(self.request("ensure", **self.ensure_fields()))
        self.state = self.load_state()
        self.state["containers"] = {}
        self.save_state()
        mounts_before = len(self.mount_calls())
        code, out, err, answer = self.run_host(self.request("remove", slug="some-other-slug"))
        self.assertEqual((code, answer["removed"]), (0, False), f"{out!r} {err!r}")
        self.assertEqual(len(self.mount_calls()), mounts_before, "the victim's bind was touched")
        self.assertIn(str(self.point()), self.mountinfo.read_text())

    def test_a_remove_for_a_trip_with_no_store_and_no_container_does_nothing(self):
        code, out, err, answer = self.run_host(self.request("remove"))
        self.assertEqual((code, answer["removed"]), (0, False))
        self.assertEqual(self.mount_calls(), [])


class BridgePinnedByTheHost(HostCase):
    """Reviewer A7e: a site sends its host-generated bridge key to the HERMES_URL in its .env, so the caller must not
    be able to choose it."""

    def test_a_hermes_url_other_than_the_configured_bridge_is_refused(self):
        for url in ("http://localhost:51324", "http://bridge.internal:4311", "https://bridge.internal:4310",
                    "http://bridge.internal"):
            with self.subTest(url=url):
                self.assert_refused(self.request("ensure", **self.ensure_fields(hermes_url=url)))
        self.assertFalse(self.trip_dir.exists())

    def test_without_a_configured_bridge_no_hermes_url_is_accepted(self):
        self.assert_refused(self.request("ensure", **self.ensure_fields()), drop=("TRIP_CONTAINER_BRIDGE_URL",))
        fields = self.ensure_fields()
        del fields["hermes_url"]
        code, out, err, _ = self.run_host(self.request("ensure", **fields), drop=("TRIP_CONTAINER_BRIDGE_URL",))
        self.assertEqual(code, 0, f"{out!r} {err!r}")

    def test_the_bridge_url_of_a_read_must_be_the_configured_one(self):
        self.run_host(self.request("ensure", **self.ensure_fields()))
        (self.state_dir / "calls.jsonl").unlink()
        self.assert_refused(self.request("read", fields=["site_to_bridge"], bridge_url="http://localhost:51324"))
        self.assertFalse(any(c[0] == "exec" for c in self.calls()), "nothing was run in the container")


class ReviewerEdgeCases(HostCase):
    """tt.py and conf.py of the second review, as tests."""

    def test_trip_txt_variants_are_all_refused(self):
        T, S = TRIP_ID, SLUG
        cases = {
            "duplicate trip_id line": f"trip_id: {T}\ntrip_id: {T}\nslug: {S}\n".encode(),
            "duplicate slug line, second differs": f"trip_id: {T}\nslug: {S}\nslug: other\n".encode(),
            "CRLF": f"trip_id: {T}\r\nslug: {S}\r\n".encode(),
            "lone CR separators": f"trip_id: {T}\rslug: {S}\r".encode(),
            "one line with both": f"junk: x trip_id: {T} slug: {S}".encode(),
            "FS separator": f"junk: x\x1ctrip_id: {T}\x1cslug: {S}".encode(),
            "trailing space on a value": f"trip_id: {T} \nslug: {S}\n".encode(),
            "no space after the colon": f"trip_id:{T}\nslug:{S}\n".encode(),
            "fullwidth colon": f"trip_id： {T}\nslug: {S}\n".encode(),
            "BOM first": ("﻿" + f"trip_id: {T}\nslug: {S}\n").encode(),
            "invalid UTF-8 between the lines": f"trip_id: {T}\n".encode() + b"\xff\xfe\n" + f"slug: {S}\n".encode(),
            "5000 bytes": (f"trip_id: {T}\nslug: {S}\n" + "#" * 5000).encode(),
        }
        for label, content in cases.items():
            with self.subTest(label):
                self.make_store()
                (self.trip_dir / "TRIP.txt").write_bytes(content)
                self.assert_refused(self.request("read", fields=["seed_password"]))

    def test_config_text_variants_are_all_refused(self):
        good = "".join(f"{k}={v}\n" for k, v in self.conf.items())
        cases = {
            "duplicate key": good + "TRIP_CONTAINER_UID=4242\n",
            "CRLF lines": good.replace("\n", "\r\n"),
            "UTF-8 BOM": "﻿" + good,
            "unknown key DOCKER_HOST": good + "DOCKER_HOST=tcp://x\n",
            "key with a leading space": good + " TRIP_CONTAINER_TIMEOUT=5\n",
            "9 KiB of comments": good + ("#" * 9000) + "\n",
            "form feed inside a line": good.replace("TRIP_CONTAINER_MEMORY=512m\n", "TRIP_CONTAINER_MEMORY=512m\x0cTRIP_CONTAINER_UID=0\n"),
            "uid 0": good.replace(f"TRIP_CONTAINER_UID={CONTAINER_UID}", "TRIP_CONTAINER_UID=0"),
        }
        for label, text in cases.items():
            with self.subTest(label):
                def write(path, text=text):
                    path.write_text(text, encoding="utf-8")
                    path.chmod(0o600)
                self.conf_hook = write
                self.assert_refused(self.request("stop"))

    def test_a_config_file_that_is_a_fifo_or_in_a_directory_that_is_a_link_to_a_writable_one(self):
        def fifo(path):
            path.unlink()
            os.mkfifo(path, 0o600)
        self.conf_hook = fifo
        self.assert_refused(self.request("stop"))
        text = None

        def via_link(path):
            nonlocal text
            text = path.read_text()
            bad = self.work / "baddir"
            bad.mkdir(exist_ok=True)
            os.chmod(bad, 0o777)
            (bad / "host.conf").write_text(text)
            (bad / "host.conf").chmod(0o600)
            link = self.work / "linkdir"
            if not link.exists():
                os.symlink(bad, link)
        self.conf_hook = via_link
        env_path = self.work / "linkdir" / "host.conf"
        self.write_conf(self.conf)
        via_link(self.conf_path)
        proc = subprocess.run([str(SCRIPT)], input=json.dumps(self.request("stop")).encode(), capture_output=True,
                              env={"PATH": "/usr/bin:/bin", "TRIP_CONTAINER_HOST_CONFIG": str(env_path)}, timeout=60)
        self.assertEqual(proc.returncode, 2, proc.stderr)

    def test_boot_survives_an_oserror_on_one_trip(self):
        good = BootRebind.make_trip_for(self, 1)
        bad = BootRebind.make_trip_for(self, 2)
        for trip_id, _ in (good, bad):
            self.simulate_reboot_unmount(trip_id)
        os.chmod(self.nfs / bad[0], 0)             # what a stale handle looks like to the walk: the open fails with an OSError
        try:
            code, out, err, answer = self.run_host(b"", args=("--boot",))
        finally:
            os.chmod(self.nfs / bad[0], 0o750)
        self.assertEqual(code, 1, f"{out!r} {err!r}")
        self.assertEqual(answer["rebound"], [good[1]])
        self.assertEqual(answer["failed"], [bad[1]])


if __name__ == "__main__":
    unittest.main()
