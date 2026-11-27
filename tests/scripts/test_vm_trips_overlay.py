"""compose.vm.trips.yml: trip sites as containers on the control-plane host (spec x-trip-vm-container-placement.md, PR4).

The overlay puts the runtime gateway on the (external) network trip containers run on and gives the worker the key and
host pin of the trip-container host. It is on ONLY when vm.env sets TRIP_CONTAINER_NETWORK, so that a deployment that
never set it is exactly what it was: compose.vm.yml needs no network that does not exist.

What is pinned: (1) off means no change to the file set or to `docker compose config`; (2) on, the gateway is on both
networks, the worker gets the two mounts and in-container paths, and the worker is NOT on the trips network; (3) the
shell helper and the release tool choose the same files from the same env files, in every compose call, and agree with
the WhatsApp overlay's order; (4) a missing host path is a refused `up`, not a created directory.
"""
from __future__ import annotations

import importlib.util
import io
import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[2]


def _load(name: str, path: Path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


wa = _load("vm_whatsapp_helpers_for_trips", ROOT / "tests" / "scripts" / "test_vm_whatsapp.py")
vr = wa.vr
OVERLAY = wa.DEPLOYMENT / "compose.vm.trips.yml"
TRIPS_ENV = {
    "TRIP_CONTAINER_NETWORK": "trips-net",
    "TRIP_CONTAINER_SSH_KEY_HOST": "/keys/trip-container", "TRIP_CONTAINER_SSH_KNOWN_HOSTS_HOST": "/keys/known_hosts",
}


def compose_json(env: dict, overlays: "list[Path]") -> dict:
    workdir = Path(tempfile.mkdtemp(prefix="vm-trips-compose-"))
    try:
        compose = wa.shimmed_compose(workdir)
        (workdir / "vm.env").write_text("".join(f"{k}={v}\n" for k, v in env.items()))
        (workdir / "provisioning.env").write_text("UNRELATED=1\n")
        argv = [wa.DOCKER, "compose", "--project-directory", str(wa.DEPLOYMENT), "-f", str(compose),
                *[a for o in overlays for a in ("-f", str(o))],
                "--env-file", str(workdir / "provisioning.env"), "--env-file", str(workdir / "vm.env"),
                "--profile", "web", "config", "--format", "json"]
        proc = subprocess.run(argv, capture_output=True, timeout=120)
    finally:
        shutil.rmtree(workdir, ignore_errors=True)
    if proc.returncode != 0:
        raise AssertionError(proc.stderr.decode()[-600:])
    return json.loads(proc.stdout)


@unittest.skipUnless(wa.HAVE_COMPOSE, "docker compose is not available - the overlay NOT validated")
class ComposeOverlay(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.without = compose_json(wa.BASE_ENV, [])
        cls.with_overlay = compose_json({**wa.BASE_ENV, **TRIPS_ENV}, [OVERLAY])

    def test_off_the_gateway_is_on_ingress_only_and_no_trips_network_exists(self) -> None:
        self.assertEqual({"ingress"}, set(self.without["services"]["runtime-gateway"]["networks"]))
        self.assertNotIn("trips", self.without["networks"])

    def test_off_the_worker_has_no_trip_container_mount_and_the_variables_are_empty(self) -> None:
        worker = self.without["services"]["worker"]
        self.assertFalse([v for v in worker.get("volumes", []) if "trip-container" in v["target"]])
        for name in ("TRIP_CONTAINER_SSH_HOST", "TRIP_CONTAINER_SSH_KEY", "TRIP_CONTAINER_IP_POOL", "TRIP_CONTAINER_BRIDGE_URL"):
            self.assertEqual("", worker["environment"][name], name)

    def test_on_the_gateway_joins_the_external_network_the_env_names(self) -> None:
        gateway = self.with_overlay["services"]["runtime-gateway"]
        self.assertEqual({"ingress", "trips"}, set(gateway["networks"]))
        trips = self.with_overlay["networks"]["trips"]
        self.assertEqual(("trips-net", True), (trips["name"], trips["external"]))

    def test_on_the_worker_is_not_on_the_trips_network(self) -> None:
        # the worker verifies a site through the host's `check` verb; Docker's isolation between bridges is relied on
        self.assertEqual({"private"}, set(self.with_overlay["services"]["worker"]["networks"]))
        for name, service in self.with_overlay["services"].items():
            if name != "runtime-gateway":
                self.assertNotIn("trips", service.get("networks") or {}, name)

    def test_on_the_worker_gets_its_key_and_the_hosts_pin_read_only_at_fixed_paths(self) -> None:
        worker = self.with_overlay["services"]["worker"]
        mounts = {v["target"]: v for v in worker["volumes"] if v["target"].startswith("/run/trip-container")}
        self.assertEqual({"/run/trip-container/ssh-key", "/run/trip-container/known-hosts"}, set(mounts))
        self.assertEqual("/keys/trip-container", mounts["/run/trip-container/ssh-key"]["source"])
        self.assertEqual("/keys/known_hosts", mounts["/run/trip-container/known-hosts"]["source"])
        for mount in mounts.values():
            self.assertTrue(mount["read_only"])
        self.assertEqual("/run/trip-container/ssh-key", worker["environment"]["TRIP_CONTAINER_SSH_KEY"])
        self.assertEqual("/run/trip-container/known-hosts", worker["environment"]["TRIP_CONTAINER_SSH_KNOWN_HOSTS"])

    def test_on_it_changes_nothing_else_of_the_stack(self) -> None:
        a, b = json.loads(json.dumps(self.without)), json.loads(json.dumps(self.with_overlay))
        for doc in (a, b):
            doc["networks"].pop("trips", None)
            doc["services"]["runtime-gateway"]["networks"].pop("trips", None)
            doc["services"]["worker"]["volumes"] = [v for v in doc["services"]["worker"]["volumes"]
                                                    if not v["target"].startswith("/run/trip-container")]
            for key in ("TRIP_CONTAINER_SSH_KEY", "TRIP_CONTAINER_SSH_KNOWN_HOSTS"):
                doc["services"]["worker"]["environment"].pop(key)
        self.assertEqual(a, b)

    def test_a_missing_host_path_refuses_the_whole_up_instead_of_making_a_directory(self) -> None:
        for dropped in ("TRIP_CONTAINER_SSH_KEY_HOST", "TRIP_CONTAINER_SSH_KNOWN_HOSTS_HOST", "TRIP_CONTAINER_NETWORK"):
            with self.subTest(dropped=dropped), self.assertRaisesRegex(AssertionError, dropped):
                compose_json({**wa.BASE_ENV, **{k: v for k, v in TRIPS_ENV.items() if k != dropped}}, [OVERLAY])


@unittest.skipUnless(wa.BASH, "no bash")
class FileSet(unittest.TestCase):
    CASES = [
        (("", ""), False),
        (("TRIP_CONTAINER_NETWORK=trips-net\n", ""), True),
        (("", "TRIP_CONTAINER_NETWORK=trips-net\n"), True),
        (("TRIP_CONTAINER_NETWORK=trips-net\n", "TRIP_CONTAINER_NETWORK=\n"), False),      # vm.env wins, even empty
        (("", "TRIP_CONTAINER_NETWORK='trips-net'\n"), True),
        (("", "TRIP_CONTAINER_PLACEMENT=x\nTRIP_PLACEMENT=vm-container\n"), False),        # the placement alone is not it
    ]

    def setUp(self) -> None:
        self.dir = Path(tempfile.mkdtemp(prefix="vm-trips-files-"))
        self.addCleanup(shutil.rmtree, self.dir, ignore_errors=True)
        (self.dir / "compose.vm.yml").write_text("services: {}\n")
        (self.dir / "compose.vm.trips.yml").write_text(OVERLAY.read_text())
        (self.dir / vr.WHATSAPP_OVERLAY).write_text(wa.OVERLAY.read_text())

    def python_files(self, texts) -> list:
        prov, vm = self.dir / "provisioning.env", self.dir / "vm.env"
        prov.write_text(texts[0])
        vm.write_text(texts[1])
        with mock.patch.object(vr, "DEPLOYMENT_DIR", self.dir), mock.patch.object(vr, "PROVISIONING_ENV", prov), \
                mock.patch.object(vr, "VM_ENV", vm):
            argv = vr.ControlPlane(vr.Report(io.StringIO(), color=False)).compose("config")
        return [Path(a).name for a in argv if a.endswith(".yml")]

    def test_shell_and_python_choose_the_same_files(self) -> None:
        for texts, on in self.CASES:
            with self.subTest(texts=texts):
                shell = [Path(a).name for a in wa.shell_files(self.dir, *texts) if a.endswith(".yml")]
                self.assertEqual(shell, self.python_files(texts))
                self.assertEqual(["compose.vm.yml", *(["compose.vm.trips.yml"] if on else [])], shell)

    def test_with_whatsapp_too_the_order_is_whatsapp_then_trips_in_both(self) -> None:
        texts = ("WHATSAPP_BRIDGE_ENABLED=1\n", "TRIP_CONTAINER_NETWORK=trips-net\n")
        expected = ["compose.vm.yml", "compose.vm.whatsapp.yml", "compose.vm.trips.yml"]
        self.assertEqual(expected, [Path(a).name for a in wa.shell_files(self.dir, *texts) if a.endswith(".yml")])
        self.assertEqual(expected, self.python_files(texts))

    def test_a_checkout_without_the_overlay_never_gets_a_missing_file_in_its_argv(self) -> None:
        # a rollback to a version from before the overlay, with the network still set
        (self.dir / "compose.vm.trips.yml").unlink()
        texts = ("", "TRIP_CONTAINER_NETWORK=trips-net\n")
        self.assertEqual(["compose.vm.yml"], [Path(a).name for a in wa.shell_files(self.dir, *texts) if a.endswith(".yml")])
        self.assertEqual(["compose.vm.yml"], self.python_files(texts))

    def test_a_dry_run_asks_git_about_the_target_not_the_checkout(self) -> None:
        (self.dir / "compose.vm.trips.yml").unlink()
        (self.dir / "vm.env").write_text("TRIP_CONTAINER_NETWORK=trips-net\n")
        (self.dir / "provisioning.env").write_text("")
        with mock.patch.object(vr, "DEPLOYMENT_DIR", self.dir), mock.patch.object(vr, "PROVISIONING_ENV", self.dir / "provisioning.env"), \
                mock.patch.object(vr, "VM_ENV", self.dir / "vm.env"):
            cp = vr.ControlPlane(vr.Report(io.StringIO(), color=False), dry_run=True)
            cp.target_full = "f" * 40
            cp.git_argv = lambda *a: ["git", *a]
            seen = []
            cp.sh.read = lambda argv, **kw: seen.append(argv) or mock.Mock(returncode=0, stdout=b"x")
            self.assertTrue(cp.trips_active())
            cp.sh.read = lambda argv, **kw: mock.Mock(returncode=128, stdout=b"")
            self.assertFalse(cp.trips_active())
        self.assertIn(f"{'f' * 40}:control-plane/deployment/compose.vm.trips.yml", seen[0])

    def test_the_relay_restart_and_the_whatsapp_pairing_only_treat_the_whatsapp_overlay_as_whatsapp(self) -> None:
        # with the trips overlay on and WhatsApp off the file set has 4 entries: a count would call that "WhatsApp on"
        for name in ("vm-relay-restart.sh", "vm-whatsapp-pair.sh"):
            text = (wa.DEPLOYMENT / name).read_text()
            self.assertNotIn('"${#VM_COMPOSE_FILES[@]}" -gt 2', text, name)
            self.assertIn("compose.vm.whatsapp.yml) whatsapp_overlay=1", text, name)


if __name__ == "__main__":
    unittest.main()
