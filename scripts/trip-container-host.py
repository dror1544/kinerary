"""The implementation behind scripts/trip-container-host.sh. Read that file's header first: it says
what this is (a forced command, a trust boundary), what the seven verbs are, what the host must
provide and how it is installed. Python 3.9, standard library only, run as `python3 -I` with the
request on stdin.

Shape: validate everything (the host's configuration file, then the whole request, then what the verb
needs from the host's own state) before the first thing is changed. A request that is outside the
contract, or a host state that is not what it must be, is a Refusal (exit 2, nothing changed); a fine
request whose work failed is a Failure (exit 1). Nothing a caller sent is ever echoed back in a
message, and no secret is ever on an argv, in a message or in an answer except the fields `read` is
asked for by name.

The mount (the one thing the daemon is given): a worker-writable path would be re-resolved by the daemon on
every start, so the container never mounts one. The trip's directory is bind-mounted, by open descriptor, onto
a root-owned mount point under TRIP_CONTAINER_MOUNT_ROOT, and the daemon is given that path. `ensure`,
`start`, `deploy` and `check` redo the walk and the identity check and refuse to remount over a different
directory; `--boot` (a root systemd unit, never ssh) re-establishes every trip's bind after the store mounts.

What is trusted, and what is not:
  - TRUSTED: the root-owned configuration file (CONFIG_PATH), this script, /usr/bin and /bin, the
    docker binary at a fixed path. The process environment is NOT trusted and is never read for
    configuration (one test-only exception, below); every subprocess gets a minimal environment of this
    script's own making.
  - NOT TRUSTED: the request, and everything on the document store. The worker can write the whole store
    (the export does not squash root), so every path component under it is opened with O_NOFOLLOW, every
    file is checked to be a regular file before it is read, and TRIP.txt must name the request's own
    trip id and slug.

The test-only exception: when this process is NOT root, the configuration file's path may come from
TRIP_CONTAINER_HOST_CONFIG, and its docker path may be any absolute path. A non-root process has no
privilege an override could lend it, and in production the script only ever runs as root, where both are
ignored.
"""
from __future__ import annotations

import errno
import fcntl
import hmac
import ipaddress
import json
import os
import pwd
import re
import signal
import stat
import subprocess
import sys

CONFIG_PATH = "/etc/kinerary/trip-container-host.conf"
CONFIG_OVERRIDE_ENV = "TRIP_CONTAINER_HOST_CONFIG"          # honoured only when this process is not root
DOCKER_FIXED = ("/usr/bin/docker", "/usr/local/bin/docker")  # the only docker paths a root process will run
DEFAULT_LOCK = "/run/trip-container-host.lock"
CHILD_PATH = "/usr/bin:/bin"

MAX_REQUEST = 65536
MAX_CONFIG = 8192
MOUNT = "/trip-store"           # where the image expects the trip's directory
SITE_PORT = 8080                # where the image answers /api/health (nginx in the container)
PIDS_LIMIT = "512"
IMAGE_REPO = "trip-site"
LABEL_TRIP = "kinerary.trip_id"
LABEL_SLUG = "kinerary.slug"
DOCKER_TIMEOUT = 120
ENV_MAX = 16384
TRIP_TXT_MAX = 4096
DEFAULT_TIMEOUT = 120
CLEANUP_SECONDS = 20            # a fresh, short deadline for putting things back after the request's own ran out
MOUNT_TIMEOUT = 30
MOUNT_FIXED = "/usr/bin/mount"
UMOUNT_FIXED = "/usr/bin/umount"
MOUNTINFO_FIXED = "/proc/self/mountinfo"

VERBS = ("ensure", "deploy", "start", "stop", "remove", "check", "read")
MUTATING = ("ensure", "deploy", "start", "stop", "remove", "check")    # check re-establishes the bind if it is missing
COMMON = {"record_type", "verb", "trip_id", "slug"}
REQUIRED = {
    "ensure": {"ip", "image"},
    "deploy": {"ip", "image"},
    "start": set(), "stop": set(), "remove": set(), "check": set(),
    "read": {"fields"},
}
OPTIONAL = {
    "ensure": {"seed_password", "exchange_key", "hermes_url", "public_origin", "trip_mcp_enabled"},
    "deploy": set(), "start": set(), "stop": set(), "remove": set(), "check": set(),
    "read": {"exchange_key_candidates", "bridge_url"},
}
READ_FIELDS = ("seed_password", "exchange_key_kind", "site_to_bridge")
KEY_KINDS = ("shared", "derived")
CONFIG_KEYS = ("TRIP_CONTAINER_NETWORK", "TRIP_CONTAINER_SUBNET", "TRIP_CONTAINER_UID", "TRIP_CONTAINER_MEMORY",
               "KINERARY_NFS_ROOT", "TRIP_CONTAINER_MOUNT_ROOT", "TRIP_CONTAINER_DOCKER", "TRIP_CONTAINER_LOCK_FILE",
               "TRIP_CONTAINER_TIMEOUT", "TRIP_CONTAINER_BRIDGE_URL",
               # honoured only when this process is not root (tests); a root process refuses a config that sets them
               "TRIP_CONTAINER_MOUNT", "TRIP_CONTAINER_UMOUNT", "TRIP_CONTAINER_MOUNTINFO")
TEST_ONLY_KEYS = ("TRIP_CONTAINER_MOUNT", "TRIP_CONTAINER_UMOUNT", "TRIP_CONTAINER_MOUNTINFO")

TRIP_ID_RE = re.compile(r"trip_[0-9a-f]{8,64}")
SLUG_RE = re.compile(r"[a-z0-9]+(-[a-z0-9]+)*")
DIGEST_RE = re.compile(r"[0-9a-f]{64}")           # the same shape as vm-release's TRIP_SITE_TAG
OCTET = r"(?:25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9]?[0-9])"
IPV4_RE = re.compile(rf"(?:{OCTET}\.){{3}}{OCTET}")
SECRET_RE = re.compile(r"[A-Za-z0-9._~+/=-]{8,256}")
HOST = r"[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?)*"
HERMES_URL_RE = re.compile(rf"https?://{HOST}(:[0-9]{{1,5}})?")
PUBLIC_ORIGIN_RE = re.compile(rf"https://{HOST}")
NETWORK_RE = re.compile(r"[A-Za-z0-9][A-Za-z0-9_.-]{0,62}")
MEMORY_RE = re.compile(r"[1-9][0-9]{1,5}[mg]")
UID_RE = re.compile(r"[1-9][0-9]{2,5}")      # 100..999999; 0 and the system range are refused
SUBNET_RE = re.compile(rf"(?:{OCTET}\.){{3}}{OCTET}/[0-9]{{1,2}}")
ABS_PATH_RE = re.compile(r"/[A-Za-z0-9_./-]+")
TIMEOUT_RE = re.compile(r"[1-9][0-9]{0,2}")
IMAGE_REF_RE = re.compile(rf"{IMAGE_REPO}:[0-9a-f]{{64}}")


class Refusal(Exception):
    """The request, or the host's configuration or state, is outside the contract. Nothing was changed."""


class Failure(Exception):
    """The request was fine and the work did not succeed."""


class Timeout(Failure):
    """The request's deadline ran out."""


def answer(obj: dict) -> None:
    sys.stdout.write(json.dumps(obj, separators=(",", ":"), ensure_ascii=True) + "\n")
    sys.stdout.flush()


def log(message: str) -> None:
    sys.stderr.write(f"trip-container-host: {message}\n")


# ----------------------------------------------------------------------------------------------
# the host's configuration: one root-owned file, never the process environment

class HostEnv:
    def __init__(self, values: dict, is_root: bool) -> None:
        self.network = self._need(values, "TRIP_CONTAINER_NETWORK", NETWORK_RE)
        subnet_text = self._need(values, "TRIP_CONTAINER_SUBNET", SUBNET_RE)
        try:
            subnet = ipaddress.IPv4Network(subnet_text, strict=True)
        except ValueError:
            raise Refusal("TRIP_CONTAINER_SUBNET is not an IPv4 network") from None
        if not subnet.is_private or not 16 <= subnet.prefixlen <= 28:
            raise Refusal("TRIP_CONTAINER_SUBNET must be a private IPv4 network between /16 and /28")
        self.subnet = subnet
        self.memory = self._need(values, "TRIP_CONTAINER_MEMORY", MEMORY_RE)
        uid_text = values.get("TRIP_CONTAINER_UID", "10001")      # absent only: the documented default
        if not UID_RE.fullmatch(uid_text) or int(uid_text) > 65533:
            raise Refusal("TRIP_CONTAINER_UID is not a usable non-root uid")
        self.uid = int(uid_text)
        sudo_uid = os.environ.get("SUDO_UID", "")
        if sudo_uid and sudo_uid == str(self.uid):
            raise Refusal("TRIP_CONTAINER_UID is the invoking user's own uid")
        self.nfs_root = self._path(values, "KINERARY_NFS_ROOT")
        self.lock_file = self._path(values, "TRIP_CONTAINER_LOCK_FILE") if "TRIP_CONTAINER_LOCK_FILE" in values else DEFAULT_LOCK
        timeout = values.get("TRIP_CONTAINER_TIMEOUT", str(DEFAULT_TIMEOUT))
        if not TIMEOUT_RE.fullmatch(timeout) or int(timeout) > 600:
            raise Refusal("TRIP_CONTAINER_TIMEOUT is unusable")
        self.timeout = int(timeout)
        docker = values.get("TRIP_CONTAINER_DOCKER")
        if docker is None:
            docker = next((p for p in DOCKER_FIXED if os.path.isfile(p)), DOCKER_FIXED[0])
        elif not ABS_PATH_RE.fullmatch(docker) or (is_root and docker not in DOCKER_FIXED):
            raise Refusal("TRIP_CONTAINER_DOCKER is not an allowed docker path")
        self.docker = docker
        self.is_root = is_root
        self.trusted = (0,) if is_root else (0, os.geteuid())
        if is_root and any(k in values for k in TEST_ONLY_KEYS):
            raise Refusal("the host configuration sets a key that is only for tests")
        self.mount_bin = values.get("TRIP_CONTAINER_MOUNT", MOUNT_FIXED)
        self.umount_bin = values.get("TRIP_CONTAINER_UMOUNT", UMOUNT_FIXED)
        self.mountinfo = values.get("TRIP_CONTAINER_MOUNTINFO", MOUNTINFO_FIXED)
        for path in (self.mount_bin, self.umount_bin, self.mountinfo):
            if not ABS_PATH_RE.fullmatch(path):
                raise Refusal("a tool path in the host configuration is unusable")
        self.mount_root = self._path(values, "TRIP_CONTAINER_MOUNT_ROOT")
        # The one shared-bridge origin a site may be pointed at. A request may only repeat it: a site sends its
        # host-generated bridge key to whatever HERMES_URL its .env names, so the caller must not choose it.
        bridge = values.get("TRIP_CONTAINER_BRIDGE_URL")
        if bridge is not None and not HERMES_URL_RE.fullmatch(bridge):
            raise Refusal("TRIP_CONTAINER_BRIDGE_URL is unusable")
        self.bridge_url = bridge

    @staticmethod
    def _need(values, name: str, pattern) -> str:
        value = values.get(name)
        if value is None or not pattern.fullmatch(value):
            raise Refusal(f"{name} is unset or unusable")
        return value

    @classmethod
    def _path(cls, values, name: str) -> str:
        value = cls._need(values, name, ABS_PATH_RE)
        if value != os.path.normpath(value) or value == "/":
            raise Refusal(f"{name} is unset or unusable")
        return value


def read_config() -> HostEnv:
    """The host's configuration. Root: the fixed path, a file root owns that nobody else can write, in a
    directory the same is true of. Not root (tests, a developer): the same rules with the invoking user
    standing where root does, and the path may be overridden."""
    euid = os.geteuid()
    is_root = euid == 0
    path = CONFIG_PATH if is_root else os.environ.get(CONFIG_OVERRIDE_ENV, CONFIG_PATH)
    try:
        parent = os.stat(os.path.dirname(path))
        fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    except OSError:
        raise Refusal("the host configuration file is missing or is not a plain file") from None
    try:
        st = os.fstat(fd)
        if not stat.S_ISREG(st.st_mode) or st.st_nlink != 1 or st.st_size > MAX_CONFIG:
            raise Refusal("the host configuration file is not a plain file of a sane size")
        for what, s in (("file", st), ("directory", parent)):
            if s.st_uid != euid or s.st_mode & 0o022:
                raise Refusal(f"the host configuration {what} is not owned by its trusted user or is writable by others")
        raw = os.read(fd, MAX_CONFIG + 1)
    finally:
        os.close(fd)
    values: dict = {}
    for line in raw.decode("utf-8", "replace").split("\n"):
        if not line.strip() or line.lstrip().startswith("#"):
            continue
        key, sep, value = line.partition("=")
        if not sep or key not in CONFIG_KEYS or key in values:
            raise Refusal("the host configuration file has an unknown, repeated or malformed line")
        values[key] = value
    return HostEnv(values, is_root)


# ----------------------------------------------------------------------------------------------
# the request

def _no_dupes(pairs):
    seen = {}
    for key, value in pairs:
        if key in seen:
            raise ValueError("duplicate key")
        seen[key] = value
    return seen


def _no_constants(_name):
    raise ValueError("not JSON")


def read_request() -> dict:
    raw = sys.stdin.buffer.read(MAX_REQUEST + 1)
    if not raw:
        raise Refusal("empty request")
    if len(raw) > MAX_REQUEST:
        raise Refusal("request larger than 64 KiB refused")
    try:
        data = json.loads(raw.decode("utf-8"), object_pairs_hook=_no_dupes, parse_constant=_no_constants)
    except (ValueError, UnicodeDecodeError, RecursionError):
        raise Refusal("request is not one valid JSON object") from None
    if not isinstance(data, dict):
        raise Refusal("request is not a JSON object")
    return data


def _text(value, pattern, what: str, maxlen: int = 256) -> str:
    if not isinstance(value, str) or len(value) > maxlen or not pattern.fullmatch(value):
        raise Refusal(f"{what} failed validation")
    return value


class Request:
    """A validated request. Every attribute was matched against a pattern; nothing else is kept."""

    def __init__(self, data: dict, env: HostEnv) -> None:
        if data.get("record_type") != "trip_container_request":
            raise Refusal("not a trip_container_request")
        verb = data.get("verb")
        if not isinstance(verb, str) or verb not in VERBS:
            raise Refusal("unknown verb")
        self.verb = verb
        allowed = COMMON | REQUIRED[verb] | OPTIONAL[verb]
        if set(data) - allowed:
            raise Refusal("unknown or foreign fields in the request")
        if (COMMON | REQUIRED[verb]) - set(data):
            raise Refusal("required fields are missing")
        self.trip_id = _text(data["trip_id"], TRIP_ID_RE, "trip_id")
        self.slug = _text(data["slug"], SLUG_RE, "slug", 80)
        self.name = f"trip-{self.slug}"
        self.ip = self.image = None
        self.seed_password = self.exchange_key = self.hermes_url = self.public_origin = None
        self.trip_mcp_enabled = False
        self.fields: list = []
        self.candidates: dict = {}
        self.bridge_url = None
        if verb in ("ensure", "deploy"):
            self.ip = self._ip(data["ip"], env)
            self.image = _text(data["image"], DIGEST_RE, "image", 64)
        if verb == "ensure":
            if "seed_password" in data:
                self.seed_password = _text(data["seed_password"], SECRET_RE, "seed_password")
            if "exchange_key" in data:
                self.exchange_key = _text(data["exchange_key"], SECRET_RE, "exchange_key")
            if "hermes_url" in data:
                self.hermes_url = self._bridge(_text(data["hermes_url"], HERMES_URL_RE, "hermes_url"), env, "hermes_url")
            if "public_origin" in data:
                self.public_origin = _text(data["public_origin"], PUBLIC_ORIGIN_RE, "public_origin")
            if "trip_mcp_enabled" in data:
                if type(data["trip_mcp_enabled"]) is not bool:
                    raise Refusal("trip_mcp_enabled failed validation")
                self.trip_mcp_enabled = data["trip_mcp_enabled"]
            if self.trip_mcp_enabled and not self.public_origin:
                raise Refusal("trip_mcp_enabled needs a public_origin")
        if verb == "read":
            self._read_fields(data, env)

    @staticmethod
    def _bridge(value: str, env: HostEnv, what: str) -> str:
        if env.bridge_url is None or value != env.bridge_url:
            raise Refusal(f"{what} is not the bridge origin this host is configured for")
        return value

    @staticmethod
    def _ip(value, env: HostEnv) -> str:
        text = _text(value, IPV4_RE, "ip", 15)
        addr = ipaddress.IPv4Address(text)
        subnet = env.subnet
        # network address, the gateway Docker takes (the first host) and the broadcast address are not for a trip
        if addr not in subnet or addr in (subnet.network_address, subnet.network_address + 1, subnet.broadcast_address):
            raise Refusal("ip is not an assignable address of the trip subnet")
        return text

    def _read_fields(self, data: dict, env: HostEnv) -> None:
        fields = data["fields"]
        if (not isinstance(fields, list) or not 1 <= len(fields) <= len(READ_FIELDS)
                or any(not isinstance(f, str) or f not in READ_FIELDS for f in fields)
                or len(set(fields)) != len(fields)):
            raise Refusal("fields must name some of seed_password, exchange_key_kind, site_to_bridge, once each")
        self.fields = fields
        has_candidates = "exchange_key_candidates" in data
        has_bridge = "bridge_url" in data
        if has_candidates != ("exchange_key_kind" in fields):
            raise Refusal("exchange_key_candidates go with exchange_key_kind, and only with it")
        if has_bridge != ("site_to_bridge" in fields):
            raise Refusal("bridge_url goes with site_to_bridge, and only with it")
        if has_candidates:
            cands = data["exchange_key_candidates"]
            if not isinstance(cands, dict) or not 1 <= len(cands) <= len(KEY_KINDS) or any(k not in KEY_KINDS for k in cands):
                raise Refusal("exchange_key_candidates failed validation")
            self.candidates = {k: _text(v, SECRET_RE, "exchange_key_candidates") for k, v in cands.items()}
        if has_bridge:
            self.bridge_url = self._bridge(_text(data["bridge_url"], HERMES_URL_RE, "bridge_url"), env, "bridge_url")


# ----------------------------------------------------------------------------------------------
# docker

def child_env() -> dict:
    """The only environment any subprocess gets: no DOCKER_*, nothing from the caller, not even its HOME."""
    try:
        home = pwd.getpwuid(os.geteuid()).pw_dir
    except KeyError:
        home = "/nonexistent"
    return {"PATH": CHILD_PATH, "HOME": home, "LANG": "C"}


def trusted_stat(st, env: HostEnv) -> bool:
    """Owned by the trusted user and writable by nobody else."""
    return st.st_uid in env.trusted and not st.st_mode & 0o022


def check_binary(path: str, env: HostEnv, what: str) -> None:
    """A tool this script runs by absolute path: a real executable that only the trusted user can replace."""
    try:
        st = os.stat(path)
    except OSError:
        raise Refusal(f"{what} is not installed where this host's configuration says") from None
    if not stat.S_ISREG(st.st_mode) or not os.access(path, os.X_OK):
        raise Refusal(f"{what} is not an executable file")
    if not trusted_stat(st, env):
        raise Refusal(f"{what} is not owned by root or is writable by others")


class Docker:
    def __init__(self, path: str, env: HostEnv) -> None:
        check_binary(path, env, "docker")
        self.path = path

    def run(self, argv: list, timeout: int = DOCKER_TIMEOUT) -> subprocess.CompletedProcess:
        try:
            return subprocess.run([self.path, *argv], stdin=subprocess.DEVNULL, capture_output=True,
                                  timeout=timeout, check=False, env=child_env())
        except subprocess.TimeoutExpired:
            raise Failure(f"docker {argv[0]} timed out") from None
        except OSError:
            raise Failure("docker could not be run") from None

    def must(self, argv: list, timeout: int = DOCKER_TIMEOUT) -> str:
        proc = self.run(argv, timeout)
        if proc.returncode != 0:
            log(f"docker {argv[0]} exited {proc.returncode}: " + tail(proc.stderr))
            raise Failure(f"docker {argv[0]} failed")
        return proc.stdout.decode("utf-8", "replace")


def tail(raw: bytes) -> str:
    # Diagnostics for the host's own log: docker's messages never carry a request value; bounded and flattened.
    return " ".join(raw.decode("utf-8", "replace").split())[-300:]


def inspect_container(docker: Docker, name: str):
    """The inspect record of the named container, or None when there is none."""
    proc = docker.run(["container", "inspect", name])
    if proc.returncode != 0:
        if b"no such container" in proc.stderr.lower():
            return None
        log("docker container inspect failed: " + tail(proc.stderr))
        raise Failure("docker container inspect failed")
    try:
        records = json.loads(proc.stdout.decode("utf-8", "replace"))
    except ValueError:
        raise Failure("docker container inspect gave an unreadable answer") from None
    if not isinstance(records, list) or len(records) != 1 or not isinstance(records[0], dict):
        raise Failure("docker container inspect gave an unexpected answer")
    return records[0]


def labels_of(record: dict) -> dict:
    labels = (record.get("Config") or {}).get("Labels")
    return labels if isinstance(labels, dict) else {}


def is_running(record: dict) -> bool:
    return (record.get("State") or {}).get("Running") is True


def checked_container(docker: Docker, req: Request, name: str | None = None):
    """The trip's container, or None; refuses a container that is not this trip's. An absent label is a mismatch."""
    name = name or req.name
    record = inspect_container(docker, name)
    if record is None:
        return None
    labels = labels_of(record)
    if labels.get(LABEL_TRIP) != req.trip_id or labels.get(LABEL_SLUG) != req.slug:
        raise Refusal("the container does not carry this trip's kinerary.trip_id label")
    return record


def remove_if_ours(docker: Docker, req: Request, name: str) -> None:
    """`docker rm --force`, but only of a container that carries this trip's labels. A foreign one is left alone."""
    record = inspect_container(docker, name)
    if record is None:
        return
    labels = labels_of(record)
    if labels.get(LABEL_TRIP) == req.trip_id and labels.get(LABEL_SLUG) == req.slug:
        docker.run(["rm", "--force", name])


def refuse_foreign_names(docker: Docker, req: Request) -> None:
    """No container other than this trip's own (and its deploy leftover) may carry this trip id."""
    out = docker.must(["ps", "-a", "--filter", f"label={LABEL_TRIP}={req.trip_id}", "--format", "{{.Names}}"])
    names = {line.strip() for line in out.splitlines() if line.strip()}
    if names - {req.name, req.name + ".prev"}:
        raise Refusal("another container already carries this trip's kinerary.trip_id label")


def mounts_ok(record: dict, source: str) -> bool:
    """Exactly one mount: a read-write bind of the trip's directory at the fixed path, nothing else."""
    mounts = record.get("Mounts")
    if not isinstance(mounts, list) or len(mounts) != 1 or not isinstance(mounts[0], dict):
        return False
    m = mounts[0]
    return (m.get("Type") == "bind" and m.get("Source") == source and m.get("Destination") == MOUNT
            and m.get("RW") is not False)


def network_subnets(record: dict) -> list:
    out = []
    for cfg in ((record.get("IPAM") or {}).get("Config") or []):
        try:
            out.append(ipaddress.ip_network(cfg.get("Subnet"), strict=False))
        except (ValueError, TypeError, AttributeError):
            continue
    return out


def plan_network(docker: Docker, env: HostEnv) -> bool:
    """Reads only. True when the network has to be created; refuses a subnet that differs or overlaps."""
    proc = docker.run(["network", "inspect", env.network])
    if proc.returncode == 0:
        try:
            records = json.loads(proc.stdout.decode("utf-8", "replace"))
            subnets = network_subnets(records[0])
        except (ValueError, IndexError, TypeError, KeyError):
            raise Failure("docker network inspect gave an unreadable answer") from None
        if subnets != [env.subnet]:
            raise Refusal("the trip network exists with a subnet other than TRIP_CONTAINER_SUBNET")
        return False
    if b"no such network" not in proc.stderr.lower() and b"not found" not in proc.stderr.lower():
        log("docker network inspect failed: " + tail(proc.stderr))
        raise Failure("docker network inspect failed")
    ids = docker.must(["network", "ls", "--quiet", "--no-trunc"]).split()
    if ids:
        try:
            records = json.loads(docker.must(["network", "inspect", *ids]))
        except ValueError:
            raise Failure("docker network inspect gave an unreadable answer") from None
        for record in records:
            for other in network_subnets(record):
                if other.version == 4 and other.overlaps(env.subnet):
                    raise Refusal("TRIP_CONTAINER_SUBNET overlaps an existing docker network")
    return True


def create_network(docker: Docker, env: HostEnv) -> None:
    docker.must(["network", "create", "--driver", "bridge", "--subnet", str(env.subnet), env.network])


def image_ref(req: Request) -> str:
    return f"{IMAGE_REPO}:{req.image}"


def require_image(docker: Docker, req: Request) -> None:
    """This script never builds. The image is built by the release tooling (vm-release) from a sealed tree;
    here it either exists or the request is refused."""
    if docker.run(["image", "inspect", image_ref(req)]).returncode != 0:
        raise Refusal("the image is not on this host: build it with the release tooling first")


def run_argv(env: HostEnv, req: Request, source: str) -> list:
    """The one `docker run` line, for ensure and deploy alike. Fixed flags, validated values, nothing else."""
    return [
        "run", "--detach", "--pull", "never",
        "--name", req.name,
        "--restart", "unless-stopped",
        "--network", env.network, "--ip", req.ip,
        "--user", f"{env.uid}:{env.uid}",
        "--memory", env.memory, "--memory-swap", env.memory, "--pids-limit", PIDS_LIMIT,
        "--cap-drop", "ALL", "--security-opt", "no-new-privileges",
        "--label", f"{LABEL_TRIP}={req.trip_id}", "--label", f"{LABEL_SLUG}={req.slug}",
        "--mount", f"type=bind,source={source},target={MOUNT}",
        image_ref(req),
    ]


def fresh_deadline(seconds: int = CLEANUP_SECONDS) -> None:
    """The request's own deadline may be what is unwinding the stack. Putting things back gets a short one of its own."""
    signal.alarm(seconds)


def start_and_verify(docker: Docker, req: Request, source: str) -> None:
    """`docker start`, then read back the mounts: the daemon re-resolves the source on every start, so a start is
    as much a mount as a run is. A container that does not mount exactly the trip's bind is stopped again."""
    docker.must(["start", req.name])
    try:
        record = inspect_container(docker, req.name)
        if record is None or not is_running(record) or not mounts_ok(record, source):
            raise Failure("the started container's mounts are not exactly the trip's directory; it was stopped")
    except BaseException:
        fresh_deadline()
        docker.run(["stop", req.name])
        raise


def run_and_verify(docker: Docker, env: HostEnv, req: Request, source: str) -> None:
    """Run the container, then read back what the daemon really mounted. Anything else (including a deadline
    that fires half-way) removes the container just made, if it is ours, under a deadline of its own."""
    try:
        docker.must(run_argv(env, req, source))
        record = inspect_container(docker, req.name)
        if record is None or not mounts_ok(record, source):
            raise Failure("the new container's mounts are not exactly the trip's directory; it was removed")
    except BaseException:
        fresh_deadline()
        remove_if_ours(docker, req, req.name)       # a half-created one must not be left holding the name
        raise


# ----------------------------------------------------------------------------------------------
# the trip's directory on the document store (not trusted: the worker can write all of it)

def need_file_privilege(env: HostEnv) -> None:
    if os.geteuid() != 0 and os.geteuid() != env.uid:
        raise Refusal("this script must run as root (or, for development, as TRIP_CONTAINER_UID) to work on the trip store")


def own(fd: int, env: HostEnv) -> None:
    st = os.fstat(fd)
    if st.st_uid == env.uid and (st.st_gid == env.uid or os.geteuid() != 0):
        return
    if os.geteuid() != 0:
        raise Failure("a trip store path is not owned by the container uid and cannot be changed")
    try:
        os.fchown(fd, env.uid, env.uid)
    except OSError:
        raise Failure("could not hand a trip store path to the container uid") from None


def store_source(env: HostEnv, req: Request) -> str:
    """What the daemon is told to mount: a root-owned mount point derived from the trip id, never a path on the
    worker-writable store (the daemon re-resolves a source on every start, so a path there can be re-pointed)."""
    return f"{env.mount_root}/{req.trip_id}"


def open_root(env: HostEnv) -> int:
    try:
        return os.open(env.nfs_root, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    except OSError:
        raise Refusal("the document store is not there, or is not a real directory") from None


class NoStore(Exception):
    pass


def open_dir(parent_fd: int, name: str, env: HostEnv, create: bool) -> int:
    flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW
    try:
        fd = os.open(name, flags, dir_fd=parent_fd)
    except FileNotFoundError:
        if not create:
            raise NoStore() from None
        os.mkdir(name, 0o750, dir_fd=parent_fd)
        fd = os.open(name, flags, dir_fd=parent_fd)
        os.fchmod(fd, 0o750)
    except OSError as exc:
        if exc.errno in (errno.ELOOP, errno.ENOTDIR):
            raise Refusal("a trip store path is not a real directory") from None
        raise
    if create:
        own(fd, env)
    return fd


def read_plain(dir_fd: int, name: str, limit: int):
    """The bytes of a small plain file under dir_fd, or None when it is absent. Opened without following a link
    and without blocking (a FIFO would otherwise hang the open), and refused unless fstat says regular."""
    try:
        fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=dir_fd)
    except FileNotFoundError:
        return None
    except OSError:
        raise Refusal(f"{name} is not a plain file") from None
    try:
        st = os.fstat(fd)
        if not stat.S_ISREG(st.st_mode) or st.st_size > limit:
            raise Refusal(f"{name} is not a plain file of a sane size")
        return os.read(fd, limit + 1), st
    finally:
        os.close(fd)


def check_env_stat(st, env: HostEnv) -> None:
    if st.st_nlink != 1:
        raise Refusal(".env is not a plain file; not touching it")
    if st.st_uid != env.uid or stat.S_IMODE(st.st_mode) != 0o600:
        raise Refusal(".env is not 0600 and owned by the container uid; not touching it")


def identity_text(env: HostEnv, req: Request) -> bytes:
    # Compatible with what provisioning writes for an LXC trip (`trip:`, `data:`, `container:`), plus the two
    # lines every verb checks: this directory belongs to exactly this trip id and slug.
    return (f"trip: {req.slug}\ntrip_id: {req.trip_id}\nslug: {req.slug}\n"
            f"data: {env.nfs_root}/{req.trip_id}\ncontainer: {req.name}\n").encode("ascii")


def check_identity(trip_fd: int, req: Request):
    """None when TRIP.txt is absent; True when it names this request's trip id and slug; Refusal otherwise."""
    got = read_plain(trip_fd, "TRIP.txt", TRIP_TXT_MAX)
    if got is None:
        return None
    raw, _st = got
    try:
        text = raw.decode("ascii")        # we write it, and it is ASCII: anything else was not written by us
    except UnicodeDecodeError:
        raise Refusal("TRIP.txt is not plain ASCII") from None
    found: dict = {}
    for line in text.split("\n"):        # "\n" only: CR, U+2028 and friends are not breaks
        key, sep, value = line.partition(": ")
        if sep and key in ("trip_id", "slug"):
            if key in found:
                raise Refusal("TRIP.txt repeats a line it is checked by")
            found[key] = value
    if found.get("trip_id") != req.trip_id or found.get("slug") != req.slug:
        raise Refusal("TRIP.txt does not name this trip: the directory belongs to another trip")
    return True


class StoreState:
    def __init__(self, exists: bool, identified: bool, has_env: bool, ident=None) -> None:
        self.exists, self.identified, self.has_env = exists, identified, has_env
        self.ident = ident          # (device, inode) of the trip's directory as opened without following a link


def inspect_store(env: HostEnv, req: Request) -> StoreState:
    """Reads only, every component without following a link. Refuses a store whose parts are not what they should be."""
    root_fd = open_root(env)
    try:
        try:
            trip_fd = open_dir(root_fd, req.trip_id, env, False)
        except NoStore:
            return StoreState(False, False, False)
        try:
            identified = check_identity(trip_fd, req) is True
            got = read_plain(trip_fd, ".env", ENV_MAX)
            if got is not None:
                check_env_stat(got[1], env)
            st = os.fstat(trip_fd)
            return StoreState(True, identified, got is not None, (st.st_dev, st.st_ino))
        finally:
            os.close(trip_fd)
    finally:
        os.close(root_fd)


def require_store(env: HostEnv, req: Request, need_env: bool = True) -> StoreState:
    state = inspect_store(env, req)
    if not state.exists or not state.identified or (need_env and not state.has_env):
        raise Refusal("the trip has no store yet: run ensure first")
    return state


def create_file(dir_fd: int, name: str, content: bytes, mode: int, env: HostEnv) -> bool:
    """Create `name` with `content` unless it exists; never rewrites. Atomic: the content is complete before the
    name appears. True when this call created it."""
    tmp = f".{name}.tmp-{os.urandom(6).hex()}"
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=dir_fd)
    try:
        try:
            os.fchmod(fd, mode)
            own(fd, env)
            view = memoryview(content)
            while view:
                view = view[os.write(fd, view):]
            os.fsync(fd)
        finally:
            os.close(fd)
        try:
            os.link(tmp, name, src_dir_fd=dir_fd, dst_dir_fd=dir_fd)
            return True
        except FileExistsError:
            return False
    finally:
        try:
            os.unlink(tmp, dir_fd=dir_fd)
        except OSError:
            pass


def env_file_content(env: HostEnv, req: Request) -> bytes:
    lines = [
        f"TRIP_DIR={MOUNT}/trip",
        f"DATA_DIR={MOUNT}/server-data",
        f"TRIP_DOCUMENTS_DIR={MOUNT}/documents",
        "PORT=3000",
        "TRIP_DESIGN_VARIANT=modern",
    ]
    if req.trip_mcp_enabled:
        lines.append("TRIP_MCP_ENABLED=1")
    if req.public_origin:
        lines.append(f"PUBLIC_ORIGIN={req.public_origin}")
    # Generated here, from the OS, never taken from the request: hex, so no consumer needs to quote it.
    lines.append(f"JWT_SECRET={os.urandom(32).hex()}")
    lines.append(f"HERMES_API_KEY={os.urandom(32).hex()}")
    lines.append(f"SEED_PASSWORD={req.seed_password}")
    if req.exchange_key:
        lines.append(f"CONTROL_PLANE_EXCHANGE_KEY={req.exchange_key}")
    if req.hermes_url:
        lines.append(f"HERMES_URL={req.hermes_url}")
    return ("\n".join(lines) + "\n").encode("ascii")


def build_store(env: HostEnv, req: Request) -> str:
    """Make the trip's layout, TRIP.txt and (only if absent) .env. Returns "created" or "kept" for .env."""
    root_fd = open_root(env)
    try:
        try:
            trip_fd = open_dir(root_fd, req.trip_id, env, True)
        except NoStore:
            raise Failure("the trip's directory could not be created") from None
        try:
            for sub in ("trip", "server-data", "documents", "media"):
                os.close(open_dir(trip_fd, sub, env, True))
            media_fd = open_dir(trip_fd, "media", env, True)
            try:
                os.close(open_dir(media_fd, "avatars", env, True))
            finally:
                os.close(media_fd)
            create_file(trip_fd, "TRIP.txt", identity_text(env, req), 0o644, env)
            if check_identity(trip_fd, req) is not True:
                raise Failure("TRIP.txt could not be written")
            existing = read_plain(trip_fd, ".env", ENV_MAX)
            if existing is not None:
                check_env_stat(existing[1], env)
                return "kept"
            if not req.seed_password:
                # .env vanished between the preflight and here: never write one without its seed password
                raise Failure("a new .env needs a seed_password")
            if create_file(trip_fd, ".env", env_file_content(env, req), 0o600, env):
                return "created"
            check_env_stat(read_plain(trip_fd, ".env", ENV_MAX)[1], env)
            return "kept"
        finally:
            os.close(trip_fd)
    finally:
        os.close(root_fd)


def read_env_file(env: HostEnv, req: Request) -> dict:
    """The trip's .env as a dict ({} when there is none), from a store that has been identified as this trip's."""
    root_fd = open_root(env)
    try:
        try:
            trip_fd = open_dir(root_fd, req.trip_id, env, False)
        except NoStore:
            raise Refusal("the trip has no store yet") from None
        try:
            if check_identity(trip_fd, req) is not True:
                raise Refusal("the trip has no store yet")
            got = read_plain(trip_fd, ".env", ENV_MAX)
        finally:
            os.close(trip_fd)
    finally:
        os.close(root_fd)
    if got is None:
        return {}
    raw, st = got
    check_env_stat(st, env)
    values = {}
    for line in raw.decode("utf-8", "replace").split("\n"):
        key, sep, value = line.partition("=")
        if sep and re.fullmatch(r"[A-Z][A-Z0-9_]*", key):
            values[key] = value
    return values


# ----------------------------------------------------------------------------------------------
# the bind: the one path the daemon is ever given

def read_mountinfo(env: HostEnv) -> list:
    """[(mount point, filesystem type)] from the kernel's own table."""
    try:
        with open(env.mountinfo, "rb") as fh:
            raw = fh.read(4 * 1024 * 1024).decode("utf-8", "replace")
    except OSError:
        raise Refusal("the mount table cannot be read") from None
    out = []
    for line in raw.split("\n"):
        left, sep, right = line.partition(" - ")
        fields = left.split(" ")
        if not sep or len(fields) < 5:
            continue
        point = re.sub(r"\\([0-7]{3})", lambda m: chr(int(m.group(1), 8)), fields[4])
        out.append((point, right.split(" ")[0]))
    return out


def check_mount_root(env: HostEnv) -> None:
    """The mount root is the host's own: a real directory only the trusted user can change (0755 or tighter),
    reached through directories the same is true of (checked when running as root), and not on NFS."""
    root = env.mount_root
    if os.path.realpath(root) != root:
        raise Refusal("the mount root is not a canonical path")
    try:
        st = os.lstat(root)
    except OSError:
        raise Refusal("the mount root is not there") from None
    if not stat.S_ISDIR(st.st_mode) or st.st_uid not in env.trusted or stat.S_IMODE(st.st_mode) & ~0o755:
        raise Refusal("the mount root is not a directory owned by root with mode 0755 or tighter")
    if env.is_root:
        parent = os.path.dirname(root)
        while True:
            pst = os.lstat(parent)
            if pst.st_uid != 0 or pst.st_mode & 0o022:
                raise Refusal("a directory above the mount root is not root-owned or is writable by others")
            if parent == "/":
                break
            parent = os.path.dirname(parent)
    best = ("", "")
    for point, fstype in read_mountinfo(env):
        if (root == point or root.startswith(point.rstrip("/") + "/") or point == "/") and len(point) >= len(best[0]):
            best = (point, fstype)
    if best[1].startswith("nfs"):
        raise Refusal("the mount root is on NFS")


def run_tool(env: HostEnv, path: str, argv: list, pass_fds=()) -> subprocess.CompletedProcess:
    check_binary(path, env, "mount tool")
    try:
        return subprocess.run([path, *argv], stdin=subprocess.DEVNULL, capture_output=True, timeout=MOUNT_TIMEOUT,
                              check=False, env=child_env(), pass_fds=pass_fds)
    except subprocess.TimeoutExpired:
        raise Failure("mount timed out") from None
    except OSError:
        raise Failure("mount could not be run") from None


def is_mounted(env: HostEnv, point: str) -> bool:
    return any(p == point for p, _ in read_mountinfo(env))


def ident_of_path(path: str):
    st = os.stat(path)
    return (st.st_dev, st.st_ino)


def open_mount_point(env: HostEnv, req: Request, create: bool):
    """(the mount root's fd, the mount point's fd or None). The mount point is an empty root-owned directory."""
    root_fd = os.open(env.mount_root, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        try:
            point_fd = os.open(req.trip_id, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=root_fd)
        except FileNotFoundError:
            if not create:
                return root_fd, None
            os.mkdir(req.trip_id, 0o755, dir_fd=root_fd)
            point_fd = os.open(req.trip_id, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=root_fd)
        except OSError:
            raise Refusal("the trip's mount point is not a real directory") from None
        return root_fd, point_fd
    except BaseException:
        os.close(root_fd)
        raise


def preflight_bind(env: HostEnv, req: Request, store_ident) -> None:
    """Reads only: everything bind_store would refuse, found before ensure changes anything."""
    point = store_source(env, req)
    if is_mounted(env, point):
        if store_ident is not None and ident_of_path(point) != store_ident:
            raise Refusal("the trip's mount point is bound to a different directory than the store's; not remounting")
        return
    check_binary(env.mount_bin, env, "mount tool")
    try:
        st = os.lstat(point)
    except FileNotFoundError:
        return
    if (not stat.S_ISDIR(st.st_mode) or st.st_uid not in env.trusted or st.st_mode & 0o022
            or os.listdir(point)):
        raise Refusal("the trip's mount point is not an empty directory owned by root")


def bind_fd(env: HostEnv, req: Request, trip_fd: int) -> str:
    """Make the trip's mount point a bind of the directory trip_fd holds. Idempotent. A mount point that is already
    bound to some other directory is refused, never mounted over."""
    check_mount_root(env)
    point = store_source(env, req)
    want = os.fstat(trip_fd)
    if is_mounted(env, point):
        if ident_of_path(point) != (want.st_dev, want.st_ino):
            raise Refusal("the trip's mount point is bound to a different directory than the store's; not remounting")
        return "existing"
    root_fd, point_fd = open_mount_point(env, req, True)
    try:
        pst = os.fstat(point_fd)
        if pst.st_uid not in env.trusted or pst.st_mode & 0o022 or os.listdir(point_fd):
            raise Refusal("the trip's mount point is not an empty directory owned by root")
        # The source is the open descriptor: the kernel binds that very directory, not whatever the path names a
        # moment later. -c (no canonicalisation) keeps libmount from turning /proc/self/fd/N back into a path.
        proc = run_tool(env, env.mount_bin, ["--no-canonicalize", "--bind", f"/proc/self/fd/{trip_fd}", point],
                        pass_fds=(trip_fd,))
        if proc.returncode != 0:
            log("mount exited %d: %s" % (proc.returncode, tail(proc.stderr)))
            raise Failure("the trip's directory could not be bound")
        if not is_mounted(env, point) or ident_of_path(point) != (want.st_dev, want.st_ino):
            run_tool(env, env.umount_bin, [point])
            raise Failure("the bind does not show the trip's directory; it was undone")
        return "mounted"
    finally:
        os.close(point_fd)
        os.close(root_fd)


def bind_store(env: HostEnv, req: Request) -> str:
    """Walk to the trip's directory without following a link, check it is this trip's, and bind THAT descriptor."""
    root_fd = open_root(env)
    try:
        try:
            trip_fd = open_dir(root_fd, req.trip_id, env, False)
        except NoStore:
            raise Refusal("the trip has no store yet: run ensure first") from None
        try:
            if check_identity(trip_fd, req) is not True:
                raise Refusal("the trip has no store yet: run ensure first")
            got = read_plain(trip_fd, ".env", ENV_MAX)
            if got is None:
                raise Refusal("the trip has no store yet: run ensure first")
            check_env_stat(got[1], env)
            return bind_fd(env, req, trip_fd)
        finally:
            os.close(trip_fd)
    finally:
        os.close(root_fd)


def unbind(env: HostEnv, req: Request) -> bool:
    """Unmount and remove the trip's (empty) mount point. True when there was something to do."""
    check_mount_root(env)
    point = store_source(env, req)
    mounted = is_mounted(env, point)
    if mounted:
        proc = run_tool(env, env.umount_bin, [point])
        if proc.returncode != 0 or is_mounted(env, point):
            log("umount exited %d: %s" % (proc.returncode, tail(proc.stderr)))
            raise Failure("the trip's mount point could not be unmounted")
    root_fd = os.open(env.mount_root, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        try:
            os.rmdir(req.trip_id, dir_fd=root_fd)
        except FileNotFoundError:
            return mounted
        except OSError:
            raise Failure("the trip's mount point could not be removed") from None
        return True
    finally:
        os.close(root_fd)


# ----------------------------------------------------------------------------------------------
# verbs

def ensure_container_mounts(record, source: str) -> None:
    if record is not None and not mounts_ok(record, source):
        raise Refusal("the existing container does not mount exactly this trip's directory")


def restore_previous(docker: Docker, req: Request, was_running: bool, source: str) -> str:
    """Put the previous container back under the trip's name and, if it was running, start it. Works from wherever a
    deploy was interrupted: before the rename (it never left the name), after it (set aside as .prev)."""
    prev_name = req.name + ".prev"
    if checked_container(docker, req, prev_name) is not None:
        remove_if_ours(docker, req, req.name)            # whatever half-exists under the name goes
        if docker.run(["rename", prev_name, req.name]).returncode != 0:
            return "the previous container was NOT restored: it is still set aside as the .prev container"
    if was_running:
        if docker.run(["start", req.name]).returncode != 0:
            return "the previous container is back under its name but is NOT running"
        record = inspect_container(docker, req.name)
        if record is None or not mounts_ok(record, source):
            docker.run(["stop", req.name])
            return "the previous container is back under its name but is NOT running (its mounts were wrong; it was stopped)"
        return "the previous container was put back and is running"
    return "the previous container was put back"


def verb_ensure(docker: Docker, env: HostEnv, req: Request) -> dict:
    need_file_privilege(env)
    check_mount_root(env)
    record = checked_container(docker, req)
    refuse_foreign_names(docker, req)
    source = store_source(env, req)
    ensure_container_mounts(record, source)
    state = inspect_store(env, req)
    if not state.has_env and not req.seed_password:
        raise Refusal("a new .env needs a seed_password")
    create_net = plan_network(docker, env)
    if record is None:
        require_image(docker, req)
    preflight_bind(env, req, state.ident)
    # -- everything is checked; from here on things change
    env_state = build_store(env, req)
    bind_state = bind_store(env, req)
    if create_net:
        create_network(docker, env)
    if record is None:
        run_and_verify(docker, env, req, source)
        container = "created"
    elif is_running(record):
        container = "existing"
    else:
        start_and_verify(docker, req, source)
        container = "started"
    return {"ok": True, "verb": "ensure", "name": req.name, "container": container, "env": env_state,
            "bind": bind_state, "network": "created" if create_net else "existing"}


def settle_leftover(docker: Docker, req: Request, record) -> None:
    """A `<name>.prev` left by a deploy that died half-way: label-checked, then either put back under the trip's
    name (nothing holds it) or discarded (the trip's container is there)."""
    prev_name = req.name + ".prev"
    leftover = checked_container(docker, req, prev_name)
    if leftover is None:
        return
    if record is None:
        docker.must(["rename", prev_name, req.name])
    else:
        docker.must(["rm", "--force", prev_name])


def verb_deploy(docker: Docker, env: HostEnv, req: Request) -> dict:
    check_mount_root(env)
    record = checked_container(docker, req)
    refuse_foreign_names(docker, req)
    require_store(env, req)
    source = store_source(env, req)
    ensure_container_mounts(record, source)
    checked_container(docker, req, req.name + ".prev")      # a foreign-labelled leftover refuses before anything moves
    create_net = plan_network(docker, env)
    require_image(docker, req)
    # -- everything is checked; from here on things change
    bind_store(env, req)
    settle_leftover(docker, req, record)
    record = checked_container(docker, req)
    if create_net:
        create_network(docker, env)
    if record is None:
        run_and_verify(docker, env, req, source)
        return {"ok": True, "verb": "deploy", "name": req.name, "previous_image": None}
    image = (record.get("Config") or {}).get("Image")
    previous = image if isinstance(image, str) and IMAGE_REF_RE.fullmatch(image) else None
    was_running = is_running(record)
    prev_name = req.name + ".prev"
    try:
        if was_running:
            docker.must(["stop", req.name])
        docker.must(["rename", req.name, prev_name])
        run_and_verify(docker, env, req, source)
    except BaseException:
        # Whatever stopped it (a docker failure, the request's deadline), the previous container is put back under a
        # deadline of its own, and the answer says which state the trip is really in.
        fresh_deadline()
        try:
            state = restore_previous(docker, req, was_running, source)
        except BaseException:
            raise Failure("the new container did not start and putting the previous one back failed") from None
        raise Failure("the new container did not start; " + state) from None
    docker.run(["rm", "--force", prev_name])      # best effort: a leftover is settled by the next deploy or remove
    return {"ok": True, "verb": "deploy", "name": req.name, "previous_image": previous}


def verb_start(docker: Docker, env: HostEnv, req: Request) -> dict:
    check_mount_root(env)
    record = checked_container(docker, req)
    if record is None:
        raise Failure("no such container")
    require_store(env, req)
    source = store_source(env, req)
    ensure_container_mounts(record, source)
    bind_store(env, req)
    if not is_running(record):
        start_and_verify(docker, req, source)
    return {"ok": True, "verb": "start", "name": req.name}


def verb_stop(docker: Docker, env: HostEnv, req: Request) -> dict:
    record = checked_container(docker, req)
    if record is None:
        raise Failure("no such container")
    if is_running(record):
        docker.must(["stop", req.name])
    return {"ok": True, "verb": "stop", "name": req.name}


def verb_remove(docker: Docker, env: HostEnv, req: Request) -> dict:
    check_mount_root(env)           # refuse before anything is removed, not after
    record = checked_container(docker, req)
    leftover = checked_container(docker, req, req.name + ".prev")
    refuse_foreign_names(docker, req)       # another slug's container on this trip id: not ours to unbind under
    if record is None and leftover is None:
        # No container proves the request is the trip's own. The store's TRIP.txt has to (a request that names this
        # trip id with another slug must not be able to unmount the bind of a trip that is running).
        try:
            proven = inspect_store(env, req).identified
        except Refusal:
            proven = False
        if not proven:
            return {"ok": True, "verb": "remove", "name": req.name, "removed": False}
    for name, found in ((req.name, record), (req.name + ".prev", leftover)):
        if found is not None:
            docker.must(["rm", "--force", name])      # never --volumes; the trip's directory is not the container's
    unbound = unbind(env, req)                         # the bind and its empty mount point; the store itself stays
    removed = record is not None or leftover is not None or unbound
    return {"ok": True, "verb": "remove", "name": req.name, "removed": removed}


def verb_check(docker: Docker, env: HostEnv, req: Request) -> dict:
    check_mount_root(env)
    record = checked_container(docker, req)
    if record is None:
        raise Failure("no such container")
    require_store(env, req)
    source = store_source(env, req)
    ensure_container_mounts(record, source)
    bind_store(env, req)
    if not is_running(record):
        return {"ok": False, "verb": "check", "running": False, "healthy": False, "status": None}
    proc = docker.run(["exec", req.name, "curl", "--silent", "--max-time", "5", "--output", "/dev/null",
                       "--write-out", "%{http_code}", f"http://127.0.0.1:{SITE_PORT}/api/health"])
    text = proc.stdout.decode("ascii", "replace").strip()
    status = int(text) if re.fullmatch(r"[0-9]{3}", text) and proc.returncode == 0 else None
    healthy = status == 200
    return {"ok": healthy, "verb": "check", "running": True, "healthy": healthy, "status": status}


# Run INSIDE the container. It reads the site's own HERMES_URL and key from its own .env and calls the bridge's
# /health with them, so what is proved is what the site will really do. The key goes to curl on stdin as a config
# line made by the shell's printf builtin: it is on no command line and in no file. Only the result of the request
# is printed, never the key and never the address. Plain POSIX sh.
BRIDGE_CHECK = r"""
ENVFILE=/trip-store/.env
EXPECT=@EXPECT@
val() { grep "^$1=" "$ENVFILE" 2>/dev/null | tail -n 1 | cut -d= -f2-; }
URL=$(val HERMES_URL)
KEY=$(val HERMES_API_KEY)
if [ -z "$URL" ]; then echo "result=no_hermes_url"; exit 0; fi
if [ "$URL" != "$EXPECT" ]; then echo "result=hermes_url_differs"; exit 0; fi
if [ -z "$KEY" ]; then echo "result=no_site_key"; exit 0; fi
case "$KEY" in *[!A-Za-z0-9._~+/=-]*) echo "result=site_key_unusable"; exit 0;; esac
CODE=$(printf 'header = "X-API-Key: %s"\n' "$KEY" | curl -sS --max-time 15 --config - -o /dev/null -w '%{http_code}' "$URL/health" 2>/dev/null)
RC=$?
echo "result=answered status=$CODE curl_exit=$RC"
"""

BRIDGE_REASONS = {
    "no_hermes_url": "the site's .env has no HERMES_URL: it is not pointed at the shared bridge",
    "hermes_url_differs": "the site's HERMES_URL is not the shared bridge address the worker was given",
    "no_site_key": "the site's .env has no HERMES_API_KEY",
    "site_key_unusable": "the site's HERMES_API_KEY has characters this check will not send",
}


def site_to_bridge(docker: Docker, req: Request, record, source: str) -> dict:
    if record is None:
        return {"ok": False, "evidence": "no such container"}
    if not is_running(record):
        return {"ok": False, "evidence": "the container is not running"}
    if not mounts_ok(record, source):
        raise Refusal("the existing container does not mount exactly this trip's directory")
    script = BRIDGE_CHECK.replace("@EXPECT@", "'" + req.bridge_url + "'")      # validated: no quote can be in it
    proc = docker.run(["exec", req.name, "sh", "-c", script])
    if proc.returncode != 0:
        return {"ok": False, "evidence": "the check could not run in the container"}
    fields: dict = {}
    for line in proc.stdout.decode("utf-8", "replace").splitlines():
        if line.startswith("result="):
            fields = dict(part.split("=", 1) for part in line.split() if "=" in part)
    result, status, curl_exit = fields.get("result"), fields.get("status", ""), fields.get("curl_exit", "")
    if result == "answered":
        if curl_exit == "0" and status == "200":
            return {"ok": True, "evidence": "health 200: the container reached the bridge, which knows this trip and reached its site"}
        if curl_exit == "0" and status == "401":
            return {"ok": False, "evidence": "health 401: the bridge does not recognise this site's key (no route for the trip, or a key mismatch)"}
        if curl_exit == "0" and status == "503":
            return {"ok": False, "evidence": "health 503: the bridge recognised the trip but cannot reach its site"}
        if curl_exit != "0":
            return {"ok": False, "evidence": f"the container could not reach the bridge (curl exit {curl_exit if re.fullmatch('[0-9]{1,3}', curl_exit) else 'unknown'})"}
        return {"ok": False, "evidence": "health answered an unexpected status"}
    return {"ok": False, "evidence": BRIDGE_REASONS.get(result or "", "the check printed no usable result")}


def verb_read(docker: Docker, env: HostEnv, req: Request) -> dict:
    need_file_privilege(env)
    record = checked_container(docker, req)
    out: dict = {"ok": True, "verb": "read"}
    # the store must be this trip's (TRIP.txt names the request's own trip id and slug) whichever field is asked for
    values = read_env_file(env, req)
    if "seed_password" in req.fields:
        held = values.get("SEED_PASSWORD", "")
        out["seed_password"] = held if SECRET_RE.fullmatch(held) else None
    if "exchange_key_kind" in req.fields:
        held = values.get("CONTROL_PLANE_EXCHANGE_KEY", "")
        found = None
        if SECRET_RE.fullmatch(held):
            for kind, candidate in req.candidates.items():
                # no short-circuit: every candidate is compared whatever the first one said
                if hmac.compare_digest(held.encode(), candidate.encode()) and found is None:
                    found = kind
        out["exchange_key_kind"] = found
    if "site_to_bridge" in req.fields:
        out["site_to_bridge"] = site_to_bridge(docker, req, record, store_source(env, req))
    return out


HANDLERS = {
    "ensure": verb_ensure, "deploy": verb_deploy, "start": verb_start, "stop": verb_stop,
    "remove": verb_remove, "check": verb_check, "read": verb_read,
}


# ----------------------------------------------------------------------------------------------
# boot: re-establish every trip's bind after the document store has mounted

class BootTrip:
    def __init__(self, trip_id: str, slug: str) -> None:
        self.trip_id, self.slug, self.name = trip_id, slug, f"trip-{slug}"


def boot(docker: Docker, env: HostEnv) -> dict:
    """Run by a root systemd unit after the document store mounts (see the header), never over ssh. For every
    container that carries our labels, redo the same walk and identity check as `ensure` and bind the result.
    A trip that fails is reported and skipped; the others are still bound."""
    check_mount_root(env)
    out = docker.must(["ps", "-a", "--filter", f"label={LABEL_TRIP}", "--format", "{{.Names}}"])
    rebound, failed = [], []
    for name in sorted({line.strip() for line in out.splitlines() if line.strip()}):
        record = inspect_container(docker, name)
        labels = labels_of(record) if record else {}
        trip_id, slug = labels.get(LABEL_TRIP), labels.get(LABEL_SLUG)
        if (not isinstance(trip_id, str) or not TRIP_ID_RE.fullmatch(trip_id) or not isinstance(slug, str)
                or not SLUG_RE.fullmatch(slug) or name != f"trip-{slug}"):
            continue                                    # not one of ours (or a .prev leftover): not this mode's business
        trip = BootTrip(trip_id, slug)
        try:
            bind_store(env, trip)
            rebound.append(slug)
        except Timeout:
            raise
        except (Refusal, Failure, OSError) as exc:        # OSError: a stale mount answers ESTALE, EIO, ...
            log(f"boot: {slug}: {exc if not isinstance(exc, OSError) else type(exc).__name__}")
            failed.append(slug)
    return {"ok": not failed, "verb": "boot", "rebound": rebound, "failed": failed}


# ----------------------------------------------------------------------------------------------
# one request at a time, and never forever

def take_lock(env: HostEnv) -> int:
    """A host-wide exclusive lock, held for the whole of every mutating verb. The file is the host's own."""
    try:
        fd = os.open(env.lock_file, os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW | os.O_NONBLOCK, 0o600)
    except OSError:
        raise Failure("the host lock file cannot be opened") from None
    st = os.fstat(fd)
    if not stat.S_ISREG(st.st_mode) or st.st_uid != os.geteuid() or st.st_mode & 0o022:
        os.close(fd)
        raise Failure("the host lock file is not a plain file owned by this user")
    fcntl.flock(fd, fcntl.LOCK_EX)      # bounded by the alarm: a stuck holder times this request out, it does not hang it
    return fd


def on_alarm(_signum, _frame):
    raise Timeout("the request timed out")


def main() -> int:
    boot_mode = sys.argv[1:] == ["--boot"]
    signal.signal(signal.SIGALRM, on_alarm)
    signal.alarm(DEFAULT_TIMEOUT)              # also bounds reading the configuration
    try:
        if sys.argv[1:] and not boot_mode:
            raise Refusal("no arguments are accepted")
        env = read_config()
        if boot_mode and os.environ.get("SUDO_UID"):
            raise Refusal("--boot is for the root boot unit, not for sudo")
        signal.alarm(env.timeout)
        req = None if boot_mode else Request(read_request(), env)
        docker = Docker(env.docker, env)
        if req is None or req.verb in MUTATING:
            lock = take_lock(env)
        else:
            lock = None
        try:
            result = boot(docker, env) if req is None else HANDLERS[req.verb](docker, env, req)
        finally:
            if lock is not None:
                os.close(lock)
    except Refusal as exc:
        log(f"refused: {exc}")
        answer({"ok": False, "error": "refused", "reason": str(exc)})
        return 2
    except Failure as exc:
        log(f"failed: {exc}")
        answer({"ok": False, "error": "failed", "reason": str(exc)})
        return 1
    except Exception as exc:        # a bug must be loud, and must not print anything a request carried
        log(f"internal error: {type(exc).__name__}")
        answer({"ok": False, "error": "internal", "reason": "internal error"})
        return 1
    finally:
        signal.alarm(0)
    answer(result)
    return 0 if result.get("ok") else 1


if __name__ == "__main__":
    sys.exit(main())
