"""scripts/trip_container_client.py - how the host-side lifecycle scripts reach a vm-container trip.

docs/specs/sprint-9/x-trip-vm-container-placement.md, build step 5. The scripts run ON the control-plane host; the
client is the worker's own (`DockerSiteAdapter`, `ssh_transport`), pointed at loopback with the pin kept. What is held
here: the ssh command line is the pinned one (never `accept-new`), the connection goes to loopback under the host's own
alias, the secrets-free request reaches a stand-in `ssh` on stdin, an unset variable is refused BY NAME, and a topology's
container section is validated before anything is built from it.
"""
from __future__ import annotations

import importlib.util
import json
import os
import stat
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SPEC = importlib.util.spec_from_file_location("trip_container_client", ROOT / "scripts" / "trip_container_client.py")
client = importlib.util.module_from_spec(SPEC)
sys.modules["trip_container_client"] = client
SPEC.loader.exec_module(client)

TRIP_ID = "trip_0123456789abcdef0123456789abcdef"
ENV = {
    "TRIP_CONTAINER_SSH_HOST": "cp.example.test", "TRIP_CONTAINER_SSH_USER": "tripctl",
    "TRIP_CONTAINER_SSH_KEY_HOST": "/keys/id", "TRIP_CONTAINER_SSH_KNOWN_HOSTS_HOST": "/keys/known_hosts",
    "TRIP_CONTAINER_BRIDGE_URL": "http://bridge.test:4310",
}
TOPOLOGY = {
    "version": 1, "name": "gatecity2026", "placement": "vm-container", "routing": "wildcard",
    "container": {"name": "trip-gatecity2026", "ipv4": "10.250.0.10", "forward_port": 8080,
                  "public_hostname": "gatecity2026.example.test", "nfs_host_dir": f"/srv/nfs/{TRIP_ID}",
                  "nfs_mount_path": "/trip-store", "image": "trip-site:" + "ab" * 32},
}


class Environment(unittest.TestCase):
    def test_every_unset_variable_is_named_and_nothing_is_defaulted(self) -> None:
        with self.assertRaises(client.ClientConfigError) as caught:
            client.adapter({})
        for name, _ in client.CLIENT_ENV:
            self.assertIn(name, str(caught.exception))

    def test_one_missing_pin_is_a_refusal_not_an_accept_new(self) -> None:
        env = dict(ENV)
        del env["TRIP_CONTAINER_SSH_KNOWN_HOSTS_HOST"]
        with self.assertRaises(client.ClientConfigError) as caught:
            client.adapter(env)
        self.assertIn("TRIP_CONTAINER_SSH_KNOWN_HOSTS_HOST", str(caught.exception))

    def test_vm_env_is_read_before_provisioning_env_and_the_process_wins(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            (Path(tmp) / "vm.env").write_text("A_ONE=vm\nB_TWO=vm\n")
            (Path(tmp) / "provisioning.env").write_text("A_ONE=prov\nC_THREE='prov'\n")
            seen = {"B_TWO": "process"}
            client.load_env_defaults(Path(tmp), seen)
        self.assertEqual({"A_ONE": "vm", "B_TWO": "process", "C_THREE": "prov"}, seen)


class StandInSsh(unittest.TestCase):
    def test_the_real_transport_connects_to_loopback_under_the_hosts_alias_and_sends_the_request_on_stdin(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            bin_dir = Path(tmp) / "bin"
            bin_dir.mkdir()
            argv_file, stdin_file = Path(tmp) / "argv", Path(tmp) / "stdin"
            ssh = bin_dir / "ssh"
            ssh.write_text(f'#!/bin/sh\nprintf "%s\\n" "$@" > "{argv_file}"\ncat > "{stdin_file}"\n'
                           'echo \'{"ok":true,"verb":"stop","name":"trip-gatecity2026","running":false}\'\n')
            ssh.chmod(ssh.stat().st_mode | stat.S_IXUSR)
            old = os.environ["PATH"]
            os.environ["PATH"] = f"{bin_dir}:{old}"
            try:
                answer = client.adapter(ENV).stop(TRIP_ID, "gatecity2026")
            finally:
                os.environ["PATH"] = old
            argv = argv_file.read_text().split("\n")
            self.assertTrue(answer["ok"])
            self.assertEqual("tripctl@127.0.0.1", argv[argv.index("tripctl@127.0.0.1")])
            self.assertIn("HostKeyAlias=cp.example.test", argv)
            self.assertIn("StrictHostKeyChecking=yes", argv)
            self.assertNotIn("StrictHostKeyChecking=accept-new", argv)
            self.assertIn("UserKnownHostsFile=/keys/known_hosts", argv)
            self.assertEqual("/keys/id", argv[argv.index("-i") + 1])
            sent = json.loads(stdin_file.read_text())
            self.assertEqual({"record_type": "trip_container_request", "verb": "stop", "trip_id": TRIP_ID,
                              "slug": "gatecity2026"}, sent)

    def test_the_connect_address_can_be_named_and_is_still_the_pinned_one(self) -> None:
        module = client.worker_module()
        seen = {}

        def run(argv, **kwargs):
            import subprocess
            seen["argv"] = argv
            return subprocess.CompletedProcess(argv, 0, stdout=b'{"ok":true}\n', stderr=b"")

        import subprocess
        original = subprocess.run
        subprocess.run = run
        try:
            module.ssh_transport("cp.example.test", "u", "/k", "/kh", connect_host="::1")(b"{}")
        finally:
            subprocess.run = original
        self.assertEqual("u@::1", seen["argv"][-1])
        self.assertIn("HostKeyAlias=cp.example.test", seen["argv"])


class Topology(unittest.TestCase):
    def test_a_valid_container_section_is_read(self) -> None:
        info = client.container_info(TOPOLOGY, "gatecity2026")
        self.assertEqual((TRIP_ID, "10.250.0.10", 8080, "trip-gatecity2026"), (info.trip_id, info.ipv4, info.forward_port, info.name))
        self.assertEqual("trip-site:" + "ab" * 32, info.image_tag)

    def test_the_text_parser_reads_the_nested_sections_the_worker_writes(self) -> None:
        text = ("version: 1\nname: x\nplacement: vm-container\ncontainer:\n  name: trip-x\n  ipv4: 10.250.0.10\n"
                "  forward_port: 8080\n  nfs_host_dir: '/srv/nfs/" + TRIP_ID + "'\n")
        parsed = client.parse_topology_text(text)
        self.assertEqual("vm-container", parsed["placement"])
        self.assertEqual({"name": "trip-x", "ipv4": "10.250.0.10", "forward_port": "8080",
                          "nfs_host_dir": "/srv/nfs/" + TRIP_ID}, parsed["container"])

    def test_the_placement_defaults_to_lxc(self) -> None:
        self.assertEqual("lxc", client.placement_of({"name": "x"}))
        self.assertEqual("lxc", client.placement_of_text("version: 1\nname: x\nproxmox:\n  vmid: '1'\n"))
        self.assertEqual("vm-container", client.placement_of_text("version: 1\nplacement: vm-container\n"))

    def test_a_topology_for_another_trip_or_with_a_bad_address_or_directory_is_refused(self) -> None:
        for mutate in (
            lambda t: t.update(name="other"),
            lambda t: t["container"].update(name="trip-other"),
            lambda t: t["container"].update(ipv4="dhcp"),
            lambda t: t["container"].update(ipv4="10.250.0.10\t1"),
            lambda t: t["container"].update(forward_port=0),
            lambda t: t["container"].update(nfs_host_dir="/srv/nfs/gatecity2026"),
            lambda t: t.pop("container"),
            lambda t: t.pop("placement"),
        ):
            topology = json.loads(json.dumps(TOPOLOGY))
            mutate(topology)
            with self.assertRaises(client.ClientConfigError, msg=str(topology)):
                client.container_info(topology, "gatecity2026")

    def test_the_store_needs_its_root_and_a_trip_id(self) -> None:
        with self.assertRaises(client.ClientConfigError):
            client.store({}, TRIP_ID)
        with self.assertRaises(client.ClientConfigError):
            client.store({"KINERARY_NFS_ROOT": "/srv/nfs"}, "../x")
        self.assertEqual(f"/srv/nfs/{TRIP_ID}", client.store({"KINERARY_NFS_ROOT": "/srv/nfs"}, TRIP_ID).path)


if __name__ == "__main__":
    unittest.main()
