"""The worker's side of `placement: vm-container` (docs/specs/sprint-9/x-trip-vm-container-placement.md).

Two things live here, and both are boundaries:

  DockerSiteAdapter  one JSON request per action over SSH to the forced command on the
                     control-plane host (scripts/trip-container-host.sh). The worker never holds
                     the Docker socket. The request and the answer are that script's contract;
                     its header and tests/scripts/test_trip_container_host.py are the source.
  TripStore          the worker's own writes into a trip's directory on the document store
                     (`trip/`, the first-provision wipe, read-backs), as the worker sees the
                     export. The store is UNTRUSTED ground: the site runs as another uid and can
                     rename or re-point anything it owns, and the worker writes as root, so every
                     component is opened with O_NOFOLLOW from a directory descriptor, never by a
                     path that could have been swapped.

Secrets (the seed password, the exchange key) travel on the SSH connection's stdin and nowhere
else: never on an argv, never in an exception, never in a log line. Errors carry only what the
host's own `reason` says, flattened and bounded, and the host never echoes a request value.
"""
from __future__ import annotations

import errno
import ipaddress
import json
import os
import re
import shutil
import stat
import subprocess
from dataclasses import dataclass
from typing import Any, Callable, Mapping, Sequence

from .companion_profile import forced_command_argv

RECORD_TYPE = "trip_container_request"
#: The host's own ceiling for one request is 600 s (TRIP_CONTAINER_TIMEOUT); the client waits longer, so
#: the host's deadline (which puts things back) always fires before the client gives up and walks away.
SSH_TIMEOUT_SECONDS = 700

TRIP_ID = re.compile(r"trip_[0-9a-f]{8,64}")
SLUG = re.compile(r"[a-z0-9]+(-[a-z0-9]+)*")
IMAGE_DIGEST = re.compile(r"[0-9a-f]{64}")
RELEASE_DIGEST = re.compile(r"sha256:([0-9a-f]{64})")
#: What the host accepts for a secret it writes into a site's .env.
SECRET = re.compile(r"[A-Za-z0-9._~+/=-]{8,256}")
PUBLIC_ORIGIN = re.compile(r"https://[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?)*")
KEY_KINDS = ("shared", "derived")

#: The command that builds the image a trip runs. Named in the error a provision stops with when the host has none.
TRIP_IMAGE_COMMAND = "sudo kinerary-cp-release trip-image"

Transport = Callable[[bytes], "tuple[int, bytes]"]


class TripContainerError(RuntimeError):
    """A trip-container request that did not do what it was asked. `safe_error_code` is what the job records."""

    safe_error_code = "TRIP_CONTAINER_FAILED"


class TripContainerRefused(TripContainerError):
    """The host looked at a well-formed request and refused it; nothing was changed."""

    safe_error_code = "TRIP_CONTAINER_REFUSED"


class TripImageMissing(TripContainerRefused):
    """The host has no `trip-site:<digest>` image. It never builds one; the release tooling does."""

    safe_error_code = "TRIP_IMAGE_MISSING"


class TripContainerUnreachable(TripContainerError):
    """The request could not be put to the host, or its answer was not an answer. Says nothing about the trip."""

    safe_error_code = "TRIP_CONTAINER_UNREACHABLE"


class TripStoreError(TripContainerError):
    """The worker could not do its part on the document store, or the store is not what it must be."""

    safe_error_code = "TRIP_STORE_UNUSABLE"


class ReleaseNotVerified(TripContainerError):
    """A vm-container trip runs `trip-site:<release digest>`; a release with no real digest has no image."""

    safe_error_code = "TRIP_CONTAINER_NEEDS_VERIFIED_RELEASE"


def image_digest(release_digest: "str | None") -> str:
    """The 64 hex digits a release's `sha256:<hex>` artifact digest names. Nothing else may reach the host."""
    match = RELEASE_DIGEST.fullmatch(release_digest or "")
    if not match:
        raise ReleaseNotVerified(
            "a vm-container trip runs the image built from a verified release, and this provision has no release "
            "digest (the dev-seed release has none): promote a manifest-backed release first"
        )
    return match.group(1)


def image_missing_message(digest: str) -> str:
    return (
        f"the host has no trip-site image for release {digest[:12]}...: build it on the control-plane host with "
        f"`{TRIP_IMAGE_COMMAND} sha256:{digest}`, then the job retries"
    )


def ssh_transport(
    host: str, user: str, key_path: str, known_hosts: str, *, port: int = 22, timeout: int = SSH_TIMEOUT_SECONDS,
) -> Transport:
    """Send a payload to the host's forced command: (exit status, stdout). The payload goes on stdin; the
    command line is the fixed one every forced-command request uses (`companion_profile.forced_command_argv`).
    stderr is not read: the host's own log lines are for the host's log."""
    argv = forced_command_argv(host, user, key_path, port, known_hosts)

    def send(payload: bytes) -> "tuple[int, bytes]":
        try:
            result = subprocess.run(argv, input=payload, capture_output=True, timeout=timeout)
        except subprocess.TimeoutExpired:
            raise TripContainerUnreachable(f"the trip-container host did not answer within {timeout}s") from None
        except OSError as exc:
            raise TripContainerUnreachable(f"ssh to the trip-container host could not start ({type(exc).__name__})") from None
        return result.returncode, result.stdout

    return send


_REASON_UNSAFE = re.compile(r"[^A-Za-z0-9 .,;:()'/=_-]")


def _safe_reason(value: Any) -> str:
    """The host's `reason`, flattened and bounded. The host composes it and never echoes a request value."""
    text = value if isinstance(value, str) else ""
    return _REASON_UNSAFE.sub("?", " ".join(text.split()))[:200] or "(no reason given)"


class DockerSiteAdapter:
    """The seven verbs of scripts/trip-container-host.sh, as one JSON request each.

    `bridge_url` is the shared bridge as a container reaches it. The host refuses any `hermes_url` or
    `bridge_url` that is not exactly its own TRIP_CONTAINER_BRIDGE_URL (a site sends its bridge key to whatever
    its .env names), so the same string is sent every time and never composed from anything else."""

    def __init__(self, transport: Transport, *, bridge_url: str) -> None:
        if not bridge_url:
            raise ValueError("a vm-container worker needs TRIP_CONTAINER_BRIDGE_URL: the bridge as a container reaches it")
        self._send = transport
        self._bridge_url = bridge_url

    # -- the contract ---------------------------------------------------------------------------------------

    @staticmethod
    def _identity(trip_id: str, slug: str) -> "dict[str, str]":
        # The same patterns the host applies, so a bad value fails here with a name instead of as a bare refusal.
        if not TRIP_ID.fullmatch(trip_id or ""):
            raise TripContainerError("a vm-container trip needs its trip id (trip_<hex>); none was given")
        if not SLUG.fullmatch(slug or "") or len(slug) > 80:
            raise TripContainerError(f"{slug!r} is not a slug the trip-container host accepts")
        return {"trip_id": trip_id, "slug": slug}

    @staticmethod
    def _ip(ip: str) -> str:
        try:
            if str(ipaddress.IPv4Address(ip)) == ip:
                return ip
        except ValueError:
            pass
        raise TripContainerError("the trip's container address is not a plain IPv4 address")

    def _call(self, verb: str, trip_id: str, slug: str, **fields: Any) -> "dict[str, Any]":
        body = {"record_type": RECORD_TYPE, "verb": verb, **self._identity(trip_id, slug), **fields}
        status, stdout = self._send(json.dumps(body, separators=(",", ":")).encode("utf-8"))
        answer = self._parse(stdout, status)
        if answer.get("ok") is True or verb == "check":
            # `check` answers ok:false for a container that is down or unhealthy: that is an answer, not an error.
            return answer
        reason = _safe_reason(answer.get("reason"))
        if answer.get("error") == "refused":
            if "image is not on this host" in reason:
                raise TripImageMissing(image_missing_message(str(body.get("image", ""))))
            raise TripContainerRefused(f"the trip-container host refused {verb}: {reason}")
        raise TripContainerError(f"the trip-container host failed {verb}: {reason}")

    @staticmethod
    def _parse(stdout: bytes, status: int) -> "dict[str, Any]":
        """The last non-empty stdout line as one JSON object, on EVERY exit status: the host answers with a
        non-zero exit for a refusal, a failure and an unhealthy check alike. Nothing of the output is kept in
        the error: a `read` answer carries the site's password."""
        lines = [line for line in (stdout or b"").decode("utf-8", "replace").splitlines() if line.strip()]
        if lines:
            try:
                answer = json.loads(lines[-1])
            except ValueError:
                answer = None
            if isinstance(answer, dict) and isinstance(answer.get("ok"), bool):
                return answer
        raise TripContainerUnreachable(
            f"the trip-container host gave no usable answer (ssh/exit status {status}); is the forced-command key "
            "installed, and does the host's pin match TRIP_CONTAINER_SSH_KNOWN_HOSTS?"
        )

    def preflight(self) -> None:
        """Ask the host something it can only answer if its forced command, its sudoers line, its configuration file
        and its docker binary are all in place: `read` of a trip that cannot exist. The one right answer is the
        refusal "the trip has no store yet". Anything else (no answer, another refusal) is a host that is not set up
        the way this worker was told, and raises with the host's own reason."""
        probe = "trip_" + "0" * 32
        try:
            self._call("read", probe, "preflight-probe", fields=["seed_password"])
        except TripContainerRefused as exc:
            if "no store yet" in str(exc):
                return
            raise
        raise TripContainerError("the trip-container host answered a probe that must be refused: not the script this worker expects")

    # -- the verbs -------------------------------------------------------------------------------------------

    def ensure(
        self, trip_id: str, slug: str, *, ip: str, image: str, seed_password: "str | None" = None,
        exchange_key: "str | None" = None, public_origin: "str | None" = None, trip_mcp_enabled: bool = False,
    ) -> "dict[str, Any]":
        """The trip's directory layout, TRIP.txt and (only when absent) .env, then the container. Must run
        BEFORE the worker writes `trip/`: it hands each directory it makes to the container's uid."""
        if not IMAGE_DIGEST.fullmatch(image or ""):
            raise TripContainerError("the image must be a release digest (64 hex digits)")
        fields: "dict[str, Any]" = {"ip": self._ip(ip), "image": image, "hermes_url": self._bridge_url}
        for name, secret in (("seed_password", seed_password), ("exchange_key", exchange_key)):
            if secret:
                if not SECRET.fullmatch(secret):
                    # Named, never shown.
                    raise TripContainerError(f"the {name.replace('_', ' ')} has characters the trip-container host will not write")
                fields[name] = secret
        if public_origin:
            if not PUBLIC_ORIGIN.fullmatch(public_origin):
                raise TripContainerError("public_origin must be a plain https origin")
            fields["public_origin"] = public_origin
        if trip_mcp_enabled:
            fields["trip_mcp_enabled"] = True
        return self._call("ensure", trip_id, slug, **fields)

    def deploy(self, trip_id: str, slug: str, *, ip: str, image: str) -> "dict[str, Any]":
        """Recreate the container on `image`; the answer's `previous_image` is the way back."""
        if not IMAGE_DIGEST.fullmatch(image or ""):
            raise TripContainerError("the image must be a release digest (64 hex digits)")
        return self._call("deploy", trip_id, slug, ip=self._ip(ip), image=image)

    def check(self, trip_id: str, slug: str) -> "dict[str, Any]":
        """{"running", "healthy", "status"}: /api/health asked from inside the container."""
        return self._call("check", trip_id, slug)

    def start(self, trip_id: str, slug: str) -> "dict[str, Any]":
        return self._call("start", trip_id, slug)

    def stop(self, trip_id: str, slug: str, *, missing_ok: bool = False) -> "dict[str, Any]":
        try:
            return self._call("stop", trip_id, slug)
        except TripContainerError as exc:
            if missing_ok and type(exc) is TripContainerError and "no such container" in str(exc):
                return {"ok": True, "verb": "stop", "name": f"trip-{slug}", "running": False}
            raise

    def remove(self, trip_id: str, slug: str) -> "dict[str, Any]":
        return self._call("remove", trip_id, slug)

    def read(
        self, trip_id: str, slug: str, fields: Sequence[str], *, exchange_key_candidates: "Mapping[str, str] | None" = None,
    ) -> "dict[str, Any]":
        """Named fields only: seed_password, exchange_key_kind (which candidate the site holds), site_to_bridge."""
        request: "dict[str, Any]" = {"fields": list(fields)}
        if "exchange_key_kind" in fields:
            candidates = dict(exchange_key_candidates or {})
            if not candidates or any(kind not in KEY_KINDS or not SECRET.fullmatch(key or "") for kind, key in candidates.items()):
                raise TripContainerError("exchange_key_kind needs candidate keys of kind shared and/or derived")
            request["exchange_key_candidates"] = candidates
        if "site_to_bridge" in fields:
            request["bridge_url"] = self._bridge_url
        return self._call("read", trip_id, slug, **request)


# ──────────────────────────────────────────────────────────────────────────────────────────────────────────
# the worker's own writes on the document store

_DIR_FLAGS = os.O_RDONLY | os.O_DIRECTORY | getattr(os, "O_NOFOLLOW", 0)
_TRIP_TXT_MAX = 4096


@dataclass(frozen=True)
class TripStore:
    """One trip's directory on the export, as the worker sees it: `<base>/<dirname>`.

    It never creates the trip's directory or `trip/`: the host's `ensure` does, and hands them to the
    container's uid. A directory that is absent after `ensure` means the worker is looking at a different
    export from the host's, and writing a look-alike would publish into a place the container never mounts."""

    base: str
    dirname: str
    trip_id: str

    @property
    def path(self) -> str:
        return os.path.join(self.base, self.dirname)

    @property
    def documents_dir(self) -> str:
        return os.path.join(self.path, "documents")

    # -- opening ---------------------------------------------------------------------------------------------

    def _open_trip(self) -> int:
        """The trip's directory, proven to be this trip's: TRIP.txt (written by the host) names this trip id."""
        try:
            root_fd = os.open(self.base, os.O_RDONLY | os.O_DIRECTORY)
        except OSError:
            raise TripStoreError(
                "the trips' document store is not visible to the worker: PROVISIONER_TRIP_NFS_LOCAL_BASE must be the "
                "export the control-plane host calls KINERARY_NFS_ROOT"
            ) from None
        try:
            fd = self._open_dir(root_fd, self.dirname, "the trip's directory is not on the document store the worker sees "
                                "(did ensure create it on another export?)")
        finally:
            os.close(root_fd)
        try:
            self._check_identity(fd)
        except BaseException:
            os.close(fd)
            raise
        return fd

    @staticmethod
    def _open_dir(parent_fd: int, name: str, missing: str) -> int:
        try:
            return os.open(name, _DIR_FLAGS, dir_fd=parent_fd)
        except FileNotFoundError:
            raise TripStoreError(missing) from None
        except OSError as exc:
            if exc.errno in (errno.ELOOP, errno.ENOTDIR):
                raise TripStoreError(f"{name} on the trip's store is not a real directory; not touching it") from None
            raise TripStoreError(f"{name} on the trip's store could not be opened ({errno.errorcode.get(exc.errno or 0, 'error')})") from None

    def _check_identity(self, trip_fd: int) -> None:
        try:
            fd = os.open("TRIP.txt", os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=trip_fd)
        except OSError:
            raise TripStoreError("the trip's directory has no TRIP.txt: ensure has not run for it") from None
        try:
            if not stat.S_ISREG(os.fstat(fd).st_mode):
                raise TripStoreError("TRIP.txt is not a plain file")
            text = os.read(fd, _TRIP_TXT_MAX).decode("utf-8", "replace")
        finally:
            os.close(fd)
        named = [line.partition(": ")[2] for line in text.split("\n") if line.startswith("trip_id: ")]
        if named != [self.trip_id]:
            raise TripStoreError("the directory does not belong to this trip (TRIP.txt names another trip id)")

    # -- writes ----------------------------------------------------------------------------------------------

    def write_trip_files(self, files: "Mapping[str, bytes]") -> None:
        """Each file into `trip/`: written whole beside the target, handed to the owner of `trip/` (the container's
        uid: the site rewrites trip.config.json in place at runtime), then renamed over it. A name is a plain file
        name, and what is replaced is replaced, never followed."""
        trip_fd = self._open_trip()
        try:
            sub_fd = self._open_dir(trip_fd, "trip", "the trip's `trip/` directory is missing: ensure has not run for it")
            try:
                owner = os.fstat(sub_fd)
                for name, content in files.items():
                    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]{0,80}", name):
                        raise TripStoreError(f"{name!r} is not a file name a trip's directory may hold")
                    self._write_one(sub_fd, name, content, owner.st_uid, owner.st_gid)
            finally:
                os.close(sub_fd)
        finally:
            os.close(trip_fd)

    @staticmethod
    def _write_one(dir_fd: int, name: str, content: bytes, uid: int, gid: int) -> None:
        tmp = f".{name}.tmp-{os.urandom(6).hex()}"
        fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0), 0o644, dir_fd=dir_fd)
        try:
            try:
                os.fchmod(fd, 0o644)
                try:
                    os.fchown(fd, uid, gid)
                except OSError:
                    raise TripStoreError(
                        f"could not hand {name} to the container's user: the site could not save its own changes to it"
                    ) from None
                view = memoryview(content)
                while view:
                    view = view[os.write(fd, view):]
                os.fsync(fd)
            finally:
                os.close(fd)
            os.replace(tmp, name, src_dir_fd=dir_fd, dst_dir_fd=dir_fd)
        except BaseException:
            try:
                os.unlink(tmp, dir_fd=dir_fd)
            except OSError:
                pass
            raise

    def read_trip_file(self, name: str, limit: int = 4_000_000) -> "bytes | None":
        """A plain file in `trip/`, or None when it is absent. Never follows a link, never blocks on a FIFO."""
        trip_fd = self._open_trip()
        try:
            sub_fd = self._open_dir(trip_fd, "trip", "the trip's `trip/` directory is missing")
            try:
                try:
                    fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=sub_fd)
                except FileNotFoundError:
                    return None
                except OSError:
                    raise TripStoreError(f"{name} is not a plain file on the trip's store") from None
                try:
                    st = os.fstat(fd)
                    if not stat.S_ISREG(st.st_mode) or st.st_size > limit:
                        raise TripStoreError(f"{name} is not a plain file of a sane size")
                    return os.read(fd, limit + 1)
                finally:
                    os.close(fd)
            finally:
                os.close(sub_fd)
        finally:
            os.close(trip_fd)

    def reset_data(self) -> None:
        """The first-provision wipe: exactly what `ProxmoxLxcAdapter._reset_trip_data` removes for an LXC trip, the
        SQLite data and the uploaded media, and nothing else (not `.env`, not `trip/`, not `documents/`). The
        container must be stopped first (the caller does it). `ensure` makes both directories again, owned by the
        container's uid. A link in either place is removed as a link and never followed."""
        trip_fd = self._open_trip()
        try:
            for name in ("server-data", "media"):
                try:
                    st = os.stat(name, dir_fd=trip_fd, follow_symlinks=False)
                except FileNotFoundError:
                    continue
                if stat.S_ISDIR(st.st_mode):
                    shutil.rmtree(name, dir_fd=trip_fd)
                else:
                    os.unlink(name, dir_fd=trip_fd)
        finally:
            os.close(trip_fd)


def validate_ip_pool(pool: Sequence[str]) -> "list[str]":
    """Validate a TRIP_CONTAINER_IP_POOL: plain IPv4 addresses, no repeats."""
    seen: "list[str]" = []
    for candidate in pool:
        if not isinstance(candidate, str):
            raise ValueError("TRIP_CONTAINER_IP_POOL must be a JSON array of IPv4 address strings")
        try:
            address = ipaddress.IPv4Address(candidate)
        except ValueError:
            raise ValueError(f"TRIP_CONTAINER_IP_POOL has {candidate!r}, which is not an IPv4 address") from None
        if str(address) != candidate:
            raise ValueError(f"TRIP_CONTAINER_IP_POOL has {candidate!r}; write addresses plainly (no leading zeros)")
        if candidate in seen:
            raise ValueError(f"TRIP_CONTAINER_IP_POOL lists {candidate} twice")
        seen.append(candidate)
    return seen
