"""scripts/trip-container-host.sh as ROOT, on Linux, with the production paths and a real bind mount.

test_trip_container_host.py runs the script as an ordinary user, with a test-owned configuration file, a fake
mount and a fake mountinfo, because those overrides are honoured only when the script is not root. That leaves the
production branch unexecuted: the fixed configuration path, the root-owned-file checks, the fixed docker path, the
chown to the container uid, the lock under /run, and the kernel's own answer to `mount --bind /proc/self/fd/N`.
This module runs exactly that, and nothing else:

  - the configuration is read from /etc/kinerary/trip-container-host.conf (and a TRIP_CONTAINER_HOST_CONFIG in the
    environment is ignored);
  - docker is the one fixed path, here /usr/local/bin/docker (a fake from test_trip_container_host.py);
  - files are chowned to the container uid (10001, the default);
  - the lock is /run/trip-container-host.lock;
  - the bind is REAL: the daemon's mount point shows the very directory the walk opened, survives a rename or swap
    of the store entry, is undone by `remove`, and is re-established by `--boot`.

It changes the host (it writes /etc/kinerary, /usr/local/bin/docker, /run and binds under /srv), so it refuses to
run unless it is told it is on a throwaway machine: TRIP_CONTAINER_ROOT_TESTS=1, euid 0, Linux. CI sets that on
a hosted runner (.github/workflows/control-plane.yml, job trip-container-host-root). It cannot run on a Mac, and a
developer who runs it on a machine with a real /etc/kinerary or /usr/local/bin/docker is refused, not overwritten.
"""
from __future__ import annotations

import json
import os
import shutil
import stat
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

from tests.scripts.test_trip_container_host import FAKE_DOCKER

REPO = Path(__file__).resolve().parents[2]
SCRIPT = REPO / "scripts/trip-container-host.sh"
CONFIG_DIR = Path("/etc/kinerary")
CONFIG = CONFIG_DIR / "trip-container-host.conf"
DOCKER = Path("/usr/local/bin/docker")
LOCK = Path("/run/trip-container-host.lock")
UID = 10001                      # the default, because the config does not set it
TRIP_ID = "trip_0123456789abcdef0123456789abcdef"
SLUG = "root-trip"
NAME = f"trip-{SLUG}"
DIGEST = "ab" * 32
IP = "10.250.0.10"

ENABLED = (sys.platform.startswith("linux") and os.geteuid() == 0
           and os.environ.get("TRIP_CONTAINER_ROOT_TESTS") == "1")


@unittest.skipUnless(ENABLED, "needs root on Linux and TRIP_CONTAINER_ROOT_TESTS=1 (it changes the host: CI only)")
class AsRoot(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        for path in (CONFIG, DOCKER):
            if path.exists():
                # TRIP_CONTAINER_ROOT_TESTS=1 says "this is a throwaway machine": if it is not, fail, do not skip quietly
                raise RuntimeError(f"{path} already exists, so this is not the throwaway machine the caller said it is")
        cls.base = Path(tempfile.mkdtemp(prefix="tch-root-", dir="/srv"))     # /srv: root-owned, nobody can write above it
        cls.base.chmod(0o755)
        cls.nfs = cls.base / "nfs"
        cls.mnt = cls.base / "mnt"
        cls.state_dir = cls.base / "state"
        for d in (cls.nfs, cls.mnt, cls.state_dir):
            d.mkdir(mode=0o755)
        DOCKER.write_text(FAKE_DOCKER.replace("__PYTHON__", sys.executable).replace("__STATE__", str(cls.state_dir)))
        DOCKER.chmod(0o755)
        CONFIG_DIR.mkdir(mode=0o755, exist_ok=True)
        cls.write_config()

    @classmethod
    def write_config(cls, extra: str = "", mode: int = 0o644) -> None:
        CONFIG.write_text(
            "# written by test_trip_container_host_root\n"
            "TRIP_CONTAINER_NETWORK=tripnet\nTRIP_CONTAINER_SUBNET=10.250.0.0/24\nTRIP_CONTAINER_MEMORY=512m\n"
            f"KINERARY_NFS_ROOT={cls.nfs}\nTRIP_CONTAINER_MOUNT_ROOT={cls.mnt}\nTRIP_CONTAINER_DOCKER={DOCKER}\n" + extra)
        os.chown(CONFIG, 0, 0)
        CONFIG.chmod(mode)

    @classmethod
    def tearDownClass(cls) -> None:
        subprocess.run(["/usr/bin/umount", "-l", str(cls.mnt / TRIP_ID)], capture_output=True)
        for path in (CONFIG, DOCKER, LOCK):
            path.unlink(missing_ok=True)
        try:
            CONFIG_DIR.rmdir()
        except OSError:
            pass
        shutil.rmtree(cls.base, ignore_errors=True)

    def setUp(self) -> None:
        self.write_config()
        DOCKER.chmod(0o755)
        self.addCleanup(self.cleanup_trip)
        (self.state_dir / "state.json").write_text(json.dumps({
            "containers": {}, "networks": [{"Name": "bridge", "Id": "idbridge", "IPAM": {"Config": [{"Subnet": "172.17.0.0/16"}]}}],
            "images": [f"trip-site:{DIGEST}"]}))
        for leftover in (self.state_dir / "calls.jsonl", self.state_dir / "env.jsonl"):
            leftover.unlink(missing_ok=True)

    def cleanup_trip(self) -> None:
        subprocess.run(["/usr/bin/umount", "-l", str(self.mnt / TRIP_ID)], capture_output=True)
        for path in (self.mnt / TRIP_ID, self.nfs / TRIP_ID, Path(str(self.nfs / TRIP_ID) + ".moved")):
            if path.is_symlink():
                path.unlink()          # shutil.rmtree will not remove a link
            else:
                shutil.rmtree(path, ignore_errors=True)

    # -- helpers --------------------------------------------------------------------------
    def run_script(self, request=None, args=(), env_extra=None):
        data = b"" if request is None else json.dumps(request).encode()
        env = {"PATH": "/usr/bin:/bin"}
        env.update(env_extra or {})
        proc = subprocess.run([str(SCRIPT), *args], input=data, capture_output=True, env=env, timeout=120)
        out = proc.stdout.decode()
        lines = [l for l in out.splitlines() if l.strip()]
        return proc.returncode, out, proc.stderr.decode(), (json.loads(lines[0]) if len(lines) == 1 else None)

    def request(self, verb, **fields):
        body = {"record_type": "trip_container_request", "verb": verb, "trip_id": TRIP_ID, "slug": SLUG}
        body.update(fields)
        return body

    def ensure(self, **over):
        fields = {"ip": IP, "image": DIGEST, "seed_password": "k7mq-x3ra-pw9d-hn4t"}
        fields.update(over)
        return self.run_script(self.request("ensure", **fields))

    def state(self):
        return json.loads((self.state_dir / "state.json").read_text())

    def calls(self):
        p = self.state_dir / "calls.jsonl"
        return [json.loads(l) for l in p.read_text().splitlines()] if p.exists() else []

    def mountinfo_points(self):
        out = []
        for line in Path("/proc/self/mountinfo").read_text().splitlines():
            out.append(line.split(" ")[4])
        return out

    @staticmethod
    def ident(path):
        st = os.stat(path)
        return (st.st_dev, st.st_ino)

    # -- the tests --------------------------------------------------------------------------
    def test_ensure_chowns_to_the_container_uid_and_makes_a_real_bind(self):
        code, out, err, answer = self.ensure()
        self.assertEqual(code, 0, f"{out!r} {err!r}")
        self.assertEqual(answer["bind"], "mounted")
        trip = self.nfs / TRIP_ID
        for sub in ("", "trip", "server-data", "documents", "media", "media/avatars", "TRIP.txt", ".env"):
            st = (trip / sub).lstat()
            self.assertEqual((st.st_uid, st.st_gid), (UID, UID), sub or "trip dir")
        self.assertEqual(stat.S_IMODE((trip / ".env").lstat().st_mode), 0o600)
        point = self.mnt / TRIP_ID
        self.assertIn(str(point), self.mountinfo_points(), "the kernel lists the bind")
        self.assertEqual(self.ident(point), self.ident(trip))
        (point / "probe").write_text("through the bind")
        self.assertEqual((trip / "probe").read_text(), "through the bind")
        run = [c for c in self.calls() if c[0] == "run"][0]
        self.assertEqual(run[run.index("--mount") + 1], f"type=bind,source={point},target=/trip-store")
        self.assertEqual(run[run.index("--user") + 1], f"{UID}:{UID}")
        (trip / "probe").unlink()

    def test_the_lock_is_under_run_and_the_config_is_the_fixed_file(self):
        code, out, err, _ = self.ensure()
        self.assertEqual(code, 0, f"{out!r} {err!r}")
        st = LOCK.lstat()
        self.assertEqual((st.st_uid, stat.S_IMODE(st.st_mode)), (0, 0o600))

    def test_the_environment_cannot_point_root_at_another_configuration(self):
        evil_store = self.base / "evil-nfs"
        evil_store.mkdir()
        evil = self.base / "evil.conf"
        evil.write_text(CONFIG.read_text().replace(str(self.nfs), str(evil_store)))
        os.chmod(evil, 0o644)
        code, out, err, answer = self.run_script(self.request("ensure", ip=IP, image=DIGEST, seed_password="k7mq-x3ra-pw9d-hn4t"),
                                                  env_extra={"TRIP_CONTAINER_HOST_CONFIG": str(evil)})
        self.assertEqual(code, 0, f"{out!r} {err!r}")
        self.assertTrue((self.nfs / TRIP_ID).is_dir(), "the fixed configuration was used")
        self.assertEqual(list(evil_store.iterdir()), [])

    def test_root_refuses_test_only_keys_and_a_docker_outside_the_fixed_list(self):
        for extra in ("TRIP_CONTAINER_MOUNT=/tmp/mount\n", "TRIP_CONTAINER_UMOUNT=/tmp/umount\n",
                      "TRIP_CONTAINER_MOUNTINFO=/tmp/mountinfo\n"):
            with self.subTest(extra=extra):
                self.write_config(extra)
                self.assertEqual(self.run_script(self.request("stop"))[0], 2)
        self.write_config()
        CONFIG.write_text(CONFIG.read_text().replace(f"TRIP_CONTAINER_DOCKER={DOCKER}", "TRIP_CONTAINER_DOCKER=/srv/docker"))
        self.assertEqual(self.run_script(self.request("stop"))[0], 2)

    def test_the_configuration_must_be_root_owned_and_not_writable_by_others(self):
        for mode in (0o664, 0o646):
            self.write_config(mode=mode)
            self.assertEqual(self.run_script(self.request("stop"))[0], 2, oct(mode))
        self.write_config()
        os.chown(CONFIG, 1, 1)
        self.assertEqual(self.run_script(self.request("stop"))[0], 2)

    def test_the_container_uid_may_not_be_the_invoking_users(self):
        self.assertEqual(self.run_script(self.request("stop"), env_extra={"SUDO_UID": str(UID)})[0], 2)

    def test_docker_must_be_a_file_only_root_can_replace(self):
        DOCKER.chmod(0o775)
        self.assertEqual(self.run_script(self.request("stop"))[0], 2)

    def test_the_bind_is_the_inode_and_survives_a_swap_of_the_store_entry(self):
        code, out, err, _ = self.ensure()
        self.assertEqual(code, 0, f"{out!r} {err!r}")
        trip, point = self.nfs / TRIP_ID, self.mnt / TRIP_ID
        before = self.ident(point)
        host = self.base / "HOSTROOT"
        host.mkdir()
        (host / "host-secret").write_text("x")
        os.rename(trip, str(trip) + ".moved")
        os.symlink(host, trip)
        self.assertEqual(self.ident(point), before, "the daemon's mount did not move")
        self.assertFalse((point / "host-secret").exists())
        (self.state_dir / "calls.jsonl").unlink(missing_ok=True)
        for verb, extra in (("start", {}), ("check", {}), ("deploy", {"ip": IP, "image": DIGEST})):
            code, out, err, answer = self.run_script(self.request(verb, **extra))
            self.assertEqual(code, 2, f"{verb}: {out!r} {err!r}")
        self.assertEqual(self.ident(point), before, "nothing was remounted")

    def test_a_replaced_directory_is_never_mounted_over(self):
        code, out, err, _ = self.ensure()
        self.assertEqual(code, 0, f"{out!r} {err!r}")
        trip, point = self.nfs / TRIP_ID, self.mnt / TRIP_ID
        before = self.ident(point)
        os.rename(trip, str(trip) + ".moved")
        shutil.copytree(str(trip) + ".moved", trip, symlinks=True)      # a different directory with the same contents
        for dirpath, dirnames, filenames in os.walk(trip):                # ... and the same owner
            for name in [""] + dirnames + filenames:
                os.chown(os.path.join(dirpath, name), UID, UID)
        code, out, err, answer = self.run_script(self.request("start"))
        self.assertEqual(code, 2, f"{out!r} {err!r}")
        self.assertIn("different directory", answer["reason"])
        self.assertEqual(self.ident(point), before)

    def test_remove_unmounts_for_real_and_keeps_the_store(self):
        self.ensure()
        code, out, err, _ = self.run_script(self.request("remove"))
        self.assertEqual(code, 0, f"{out!r} {err!r}")
        self.assertNotIn(str(self.mnt / TRIP_ID), self.mountinfo_points())
        self.assertFalse((self.mnt / TRIP_ID).exists())
        self.assertTrue((self.nfs / TRIP_ID / "TRIP.txt").is_file())

    def test_boot_reestablishes_the_bind_after_it_is_lost(self):
        self.ensure()
        point = self.mnt / TRIP_ID
        subprocess.run(["/usr/bin/umount", str(point)], check=True)        # what a reboot did to it
        self.assertNotIn(str(point), self.mountinfo_points())
        code, out, err, answer = self.run_script(args=("--boot",))
        self.assertEqual(code, 0, f"{out!r} {err!r}")
        self.assertEqual(answer["rebound"], [SLUG])
        self.assertIn(str(point), self.mountinfo_points())
        self.assertEqual(self.ident(point), self.ident(self.nfs / TRIP_ID))

    def test_boot_is_refused_under_sudo(self):
        self.assertEqual(self.run_script(args=("--boot",), env_extra={"SUDO_UID": "1000"})[0], 2)


if __name__ == "__main__":
    unittest.main()
