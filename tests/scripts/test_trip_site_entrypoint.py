"""control-plane/deployment/trip-site-entrypoint.sh - the trip-site container's entrypoint.

Run against a fake mount and fake `node` / `nginx` on PATH, so no image and no Docker are needed
(the image itself is built and run in the PR's live check). What is pinned here is the part a
mistake in turns into an empty site on a fresh database, or a half-dead container:

- AC-6: no TRIP.txt or no .env in the mount -> non-zero, and neither process was started;
- the mount's paths win over whatever .env says, and .env is read as data, never executed;
- either process dying ends the entrypoint with a non-zero status, and takes the other with it;
- SIGTERM stops both and exits cleanly.
"""
from __future__ import annotations

import os
import signal
import stat
import subprocess
import tempfile
import time
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
ENTRYPOINT = ROOT / "control-plane" / "deployment" / "trip-site-entrypoint.sh"

# Records its environment and pid, then lives until killed or until FAKE_<NAME>_LIFE seconds pass.
FAKE = """#!/bin/bash
name={name}
out="$FAKE_OUT"
echo $$ > "$out/$name.pid"
env > "$out/$name.env"
pwd > "$out/$name.cwd"
echo "$@" > "$out/$name.args"
life_var="FAKE_$(echo $name | tr a-z A-Z)_LIFE"
life="${{!life_var:-30}}"
code_var="FAKE_$(echo $name | tr a-z A-Z)_EXIT"
code="${{!code_var:-0}}"
trap 'kill $! 2>/dev/null; exit 0' TERM
sleep "$life" &
wait $!
exit "$code"
"""


def alive(pid: int) -> bool:
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    return True


class EntrypointTests(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory(prefix="trip-site-entrypoint-")
        self.addCleanup(self._tmp.cleanup)
        tmp = Path(self._tmp.name)
        self.store = tmp / "trip-store"
        self.app = tmp / "app"
        self.bin = tmp / "bin"
        self.out = tmp / "out"
        for d in (self.store, self.app / "site", self.app / "server", self.bin, self.out):
            d.mkdir(parents=True)
        for name in ("node", "nginx"):
            f = self.bin / name
            f.write_text(FAKE.format(name=name))
            f.chmod(f.stat().st_mode | stat.S_IXUSR)
        self.procs: list[subprocess.Popen] = []
        self.addCleanup(self._reap)

    def _reap(self) -> None:
        for p in self.procs:
            if p.poll() is None:
                p.kill()
                p.wait()
        for name in ("node", "nginx"):
            pidfile = self.out / f"{name}.pid"
            if pidfile.exists():
                try:
                    os.kill(int(pidfile.read_text()), signal.SIGKILL)
                except (ProcessLookupError, ValueError):
                    pass

    def mount(self, trip_txt: bool = True, env: str | None = "PORT=3000\nJWT_SECRET=s3cret\n") -> None:
        if trip_txt:
            (self.store / "TRIP.txt").write_text("trip: demo\n")
        if env is not None:
            (self.store / ".env").write_text(env)

    def start(self, **extra: str) -> subprocess.Popen:
        env = {
            "PATH": f"{self.bin}:{os.environ['PATH']}",
            "TRIP_STORE_DIR": str(self.store),
            "APP_DIR": str(self.app),
            "NGINX_MAIN_CONF": str(self.app / "main.conf"),
            "FAKE_OUT": str(self.out),
            **extra,
        }
        p = subprocess.Popen(["/bin/bash", str(ENTRYPOINT)], env=env, stdout=subprocess.PIPE,
                             stderr=subprocess.PIPE, text=True)
        self.procs.append(p)
        return p

    def wait_for(self, *names: str, timeout: float = 10.0) -> None:
        deadline = time.time() + timeout
        while time.time() < deadline:
            if all((self.out / f"{n}.pid").exists() and (self.out / f"{n}.env").exists() for n in names):
                return
            time.sleep(0.05)
        self.fail(f"{names} never started")

    def read_env(self, name: str) -> dict[str, str]:
        out = {}
        for line in (self.out / f"{name}.env").read_text().splitlines():
            if "=" in line:
                k, _, v = line.partition("=")
                out[k] = v
        return out

    # -- AC-6 ------------------------------------------------------------------------------

    def test_no_trip_txt_exits_non_zero_and_starts_nothing(self) -> None:
        self.mount(trip_txt=False)
        p = self.start()
        _, err = p.communicate(timeout=10)
        self.assertNotEqual(0, p.returncode)
        self.assertIn("TRIP.txt", err)
        self.assertEqual([], list(self.out.iterdir()), "neither node nor nginx may have been started")

    def test_no_env_exits_non_zero_and_starts_nothing(self) -> None:
        self.mount(env=None)
        p = self.start()
        _, err = p.communicate(timeout=10)
        self.assertNotEqual(0, p.returncode)
        self.assertIn(".env", err)
        self.assertEqual([], list(self.out.iterdir()))

    def test_an_unmounted_store_exits_non_zero_and_starts_nothing(self) -> None:
        self.store.rmdir()
        p = self.start()
        _, err = p.communicate(timeout=10)
        self.assertNotEqual(0, p.returncode)
        self.assertIn("not mounted", err)
        self.assertEqual([], list(self.out.iterdir()))

    # -- the environment -------------------------------------------------------------------

    def test_the_mounts_paths_win_over_whatever_env_says(self) -> None:
        self.mount(env=(
            "TRIP_DIR=/opt/kinerary/trips/somewhere\nDATA_DIR=/nfs/x/server-data\n"
            "TRIP_DOCUMENTS_DIR=/nfs/x/documents\nPORT=9999\nJWT_SECRET=s3cret\nHERMES_API_KEY=ab12\n"
        ))
        p = self.start()
        self.wait_for("node", "nginx")
        env = self.read_env("node")
        self.assertEqual(f"{self.store}/trip", env["TRIP_DIR"])
        self.assertEqual(f"{self.store}/server-data", env["DATA_DIR"])
        self.assertEqual(f"{self.store}/documents", env["TRIP_DOCUMENTS_DIR"])
        self.assertEqual(f"{self.store}/.env", env["ENV_FILE_PATH"])
        self.assertEqual(f"{self.store}/media/avatars", env["AVATARS_DIR"])
        self.assertEqual("3000", env["PORT"])
        # ...and the secrets from .env still reach the site.
        self.assertEqual("s3cret", env["JWT_SECRET"])
        self.assertEqual("ab12", env["HERMES_API_KEY"])
        p.terminate()
        p.communicate(timeout=10)

    def test_env_is_data_not_a_script(self) -> None:
        marker = self.out / "pwned"
        self.mount(env=(
            f"SEED_PASSWORD=a$(touch {marker})b`touch {marker}`;touch {marker}\n"
            f"QUOTED=\"two words\"\nSINGLE='x y'\nEMPTY=\n# a comment\n\nnot a pair\n1BAD=nope\n"
            "WITH_EQUALS=ab+c/d==\nPATH=/nonexistent\n"
        ))
        p = self.start()
        self.wait_for("node", "nginx")
        env = self.read_env("node")
        self.assertFalse(marker.exists(), "a .env value was executed")
        self.assertEqual(f"a$(touch {marker})b`touch {marker}`;touch {marker}", env["SEED_PASSWORD"])
        self.assertEqual("two words", env["QUOTED"])
        self.assertEqual("x y", env["SINGLE"])
        self.assertEqual("", env["EMPTY"])
        self.assertEqual("ab+c/d==", env["WITH_EQUALS"])
        self.assertNotIn("1BAD", env)
        self.assertNotEqual("/nonexistent", env["PATH"], ".env must not replace PATH")
        p.terminate()
        p.communicate(timeout=10)

    def test_state_directories_are_made_in_the_mount_and_the_avatar_link_points_there(self) -> None:
        self.mount()
        p = self.start()
        self.wait_for("node", "nginx")
        for d in ("server-data", "documents", "media/avatars"):
            self.assertTrue((self.store / d).is_dir(), d)
        link = self.app / "site" / "avatars"
        self.assertTrue(link.is_symlink())
        self.assertEqual(str(self.store / "media" / "avatars"), os.readlink(link))
        self.assertEqual(str(self.app / "server"), (self.out / "node.cwd").read_text().strip())
        self.assertIn(f"{self.app}/main.conf", (self.out / "nginx.args").read_text())
        self.assertIn("daemon off", (self.out / "nginx.args").read_text())
        p.terminate()
        p.communicate(timeout=10)

    # -- supervision -----------------------------------------------------------------------

    def test_node_dying_ends_the_container_non_zero_and_takes_nginx_with_it(self) -> None:
        self.mount()
        p = self.start(FAKE_NODE_LIFE="0.3", FAKE_NODE_EXIT="3")
        self.wait_for("node", "nginx")
        nginx_pid = int((self.out / "nginx.pid").read_text())
        _, err = p.communicate(timeout=10)
        self.assertNotEqual(0, p.returncode)
        self.assertIn("exited", err)
        time.sleep(0.2)
        self.assertFalse(alive(nginx_pid), "nginx outlived node")

    def test_nginx_dying_ends_the_container_non_zero_and_takes_node_with_it(self) -> None:
        self.mount()
        p = self.start(FAKE_NGINX_LIFE="0.3")
        self.wait_for("node", "nginx")
        node_pid = int((self.out / "node.pid").read_text())
        p.communicate(timeout=10)
        self.assertNotEqual(0, p.returncode, "a clean exit of one process is still the container dying")
        time.sleep(0.2)
        self.assertFalse(alive(node_pid), "node outlived nginx")

    def test_sigterm_stops_both_and_exits_zero(self) -> None:
        self.mount()
        p = self.start()
        self.wait_for("node", "nginx")
        pids = [int((self.out / f"{n}.pid").read_text()) for n in ("node", "nginx")]
        p.send_signal(signal.SIGTERM)
        p.communicate(timeout=10)
        self.assertEqual(0, p.returncode)
        time.sleep(0.2)
        for pid in pids:
            self.assertFalse(alive(pid))


if __name__ == "__main__":
    unittest.main()
