from __future__ import annotations

import re
import unittest

from provisioning.adapters import CloudflareTunnelDnsAdapter, NpmProxyHostAdapter, ProxmoxLxcAdapter
from provisioning.models import CloudflareSpec, LxcSpec, ProxySpec


class FakeTransport:
    def __init__(self, responses):
        self.responses = list(responses)
        self.calls = []

    def request(self, method, path, *, payload=None, params=None):
        self.calls.append((method, path, payload, params))
        return self.responses.pop(0)


_HEREDOC = re.compile(
    r"^cat > (?P<path>\S+) <<'KINERARY_CLOUDFLARED_CONFIG_EOF'\n(?P<content>.*)\nKINERARY_CLOUDFLARED_CONFIG_EOF$",
    re.DOTALL,
)


class FakeSshTransport:
    """Simulates just enough of the RPi4's filesystem/systemd for
    CloudflareTunnelDnsAdapter's config-file read/backup/write/restart/
    verify sequence, without a real SSH connection."""

    def __init__(self, config_path: str, initial_yaml: str, fail_restart: bool = False) -> None:
        self.config_path = config_path
        self.files: dict[str, str] = {config_path: initial_yaml}
        self.commands: list[str] = []
        self.fail_restart = fail_restart
        self.restart_count = 0
        self._active = True

    def run(self, command: str) -> str:
        self.commands.append(command)
        if command == f"sudo -n cat {self.config_path}":
            return self.files[self.config_path]
        if command.startswith("sudo -n cp "):
            _, _, _, src, dst = command.split(" ", 4)
            self.files[dst] = self.files[src]
            return ""
        match = _HEREDOC.match(command)
        if match:
            self.files[match.group("path")] = match.group("content")
            return ""
        if command.startswith("sudo -n mv "):
            _, _, _, src, dst = command.split(" ", 4)
            self.files[dst] = self.files.pop(src)
            return ""
        if command == "sudo -n systemctl restart cloudflared":
            self.restart_count += 1
            self._active = not self.fail_restart
            return ""
        if command == "sudo -n systemctl is-active cloudflared || true":
            return "active" if self._active else "failed"
        raise AssertionError(f"FakeSshTransport got an unexpected command: {command!r}")


LXC_SPEC = LxcSpec(
    "trip-tokyo-2026", "pve", "local:vztmpl/debian.tar.zst", "local-lvm", 2, 1024, 8, "vmbr0",
    "192.168.0.60/24", "192.168.0.1", "192.168.0.41",
    "/mnt/pve/truenas-nfs/tokyo-2026", "/nfs/tokyo-2026",
)

# Real `pct list` output (2026-08-25, read-only inspection of the actual
# Proxmox host) — note a stopped container with no lock produces only 3
# whitespace-separated tokens, not 4; inspect() must key off the LAST token,
# not a fixed column index.
PCT_LIST_OUTPUT = (
    "VMID       Status     Lock         Name                \n"
    "102        stopped                 pi-hole             \n"
    "201        running                 trip-kinerary       \n"
    "202        running                 trip-shiran-usa2026 \n"
)


class FakeProxmoxSsh:
    def __init__(self, pct_list_output: str = PCT_LIST_OUTPUT, nextid: str = "203") -> None:
        self.pct_list_output = pct_list_output
        self.nextid = nextid
        self.commands: list[str] = []

    def run(self, command: str) -> str:
        self.commands.append(command)
        if command == "pct list":
            return self.pct_list_output
        if command == "pvesh get /cluster/nextid":
            return self.nextid + "\n"
        if command.startswith("mkdir -p "):
            return ""
        if command.startswith("pct create ") and " && pct start " in command:
            return ""
        if command.startswith("pct stop "):
            return ""
        if command.startswith("#!/bin/bash") and "BOOTSTRAP_INNER" in command:
            return ""
        raise AssertionError(f"FakeProxmoxSsh got an unexpected command: {command!r}")


class AdapterTests(unittest.TestCase):
    def test_proxmox_inspect_finds_a_container_by_name_despite_the_empty_lock_column(self) -> None:
        ssh = FakeProxmoxSsh()
        adapter = ProxmoxLxcAdapter(ssh)

        found = adapter.inspect(LxcSpec(
            "trip-kinerary", "pve", "t", "s", 2, 1024, 8, "vmbr0", "ip", "gw", "ns", "h", "m",
        ))

        self.assertEqual({"vmid": "201", "status": "running", "name": "trip-kinerary"}, found)

    def test_proxmox_inspect_returns_none_when_not_found(self) -> None:
        ssh = FakeProxmoxSsh()
        adapter = ProxmoxLxcAdapter(ssh)

        self.assertIsNone(adapter.inspect(LXC_SPEC))

    def test_proxmox_create_makes_the_nfs_dir_then_creates_and_starts_the_container(self) -> None:
        ssh = FakeProxmoxSsh(nextid="203")
        adapter = ProxmoxLxcAdapter(ssh)

        adapter.create(LXC_SPEC)

        self.assertEqual(f"mkdir -p {LXC_SPEC.nfs_host_dir}", ssh.commands[0])
        self.assertEqual("pvesh get /cluster/nextid", ssh.commands[1])
        create_and_start = ssh.commands[2]
        self.assertIn("pct create 203 local:vztmpl/debian.tar.zst", create_and_start)
        self.assertIn("--hostname trip-tokyo-2026", create_and_start)
        self.assertIn("--storage local-lvm", create_and_start)
        self.assertIn("--cores 2", create_and_start)
        self.assertIn("--memory 1024", create_and_start)
        self.assertIn("--rootfs local-lvm:8", create_and_start)
        self.assertIn("gw=192.168.0.1", create_and_start)
        self.assertIn("ip=192.168.0.60/24", create_and_start)
        self.assertIn("--nameserver 192.168.0.41", create_and_start)
        self.assertIn("--mp0 /mnt/pve/truenas-nfs/tokyo-2026,mp=/nfs/tokyo-2026", create_and_start)
        self.assertIn("&& pct start 203", create_and_start)

        # deploy.sh assumes nginx/Node/the systemd unit/.env already exist —
        # bootstrap installs them so a freshly created container isn't dead
        # on arrival at the first real deploy.
        bootstrap = ssh.commands[3]
        self.assertIn("pct exec 203 -- bash -s", bootstrap)
        self.assertIn("TRIP_DIR=/opt/kinerary/trips/tokyo-2026", bootstrap)
        self.assertIn("DATA_DIR=/nfs/tokyo-2026/server-data", bootstrap)
        self.assertIn("ln -sfn /nfs/tokyo-2026/media/avatars /opt/kinerary/site/avatars", bootstrap)
        self.assertIn("listen 8080", bootstrap)
        self.assertIn("systemctl enable nginx kinerary-server", bootstrap)

    def test_proxmox_delete_stops_and_destroys_when_found(self) -> None:
        ssh = FakeProxmoxSsh()
        adapter = ProxmoxLxcAdapter(ssh)
        spec = LxcSpec(
            "trip-kinerary", "pve", "t", "s", 2, 1024, 8, "vmbr0", "ip", "gw", "ns", "h", "m",
        )

        adapter.delete(spec)

        self.assertIn("pct stop 201 || true; pct destroy 201", ssh.commands)

    def test_proxmox_delete_is_a_noop_when_not_found(self) -> None:
        ssh = FakeProxmoxSsh()
        adapter = ProxmoxLxcAdapter(ssh)

        adapter.delete(LXC_SPEC)

        self.assertFalse(any("pct stop" in c or "pct destroy" in c for c in ssh.commands))

    def test_npm_existing_hostname_is_idempotent(self) -> None:
        transport = FakeTransport([[{"id": 9, "domain_names": ["site.example.invalid"]}]])
        adapter = NpmProxyHostAdapter(transport)

        existing = adapter.inspect(ProxySpec("site.example.invalid", "app", 8080))

        self.assertEqual(9, existing["id"])
        self.assertEqual(1, len(transport.calls))

    def test_cloudflare_create_writes_ingress_rule_then_dns_record(self) -> None:
        transport = FakeTransport([
            {"result": []},                                        # inspect(): no dns
            {"result": []}, {"result": {"id": "dns-id"}},          # create(): dns lookup, then create
        ])
        ssh = FakeSshTransport(
            "/etc/cloudflared/config.yml",
            "tunnel: t\ncredentials-file: /home/dror/.cloudflared/t.json\ningress:\n"
            "  - hostname: other.example.invalid\n    service: http://127.0.0.1:8081\n"
            "  - service: http_status:404\n",
        )
        adapter = CloudflareTunnelDnsAdapter(transport, "zone", ssh, restart_timeout=0)
        spec = CloudflareSpec("tunnel-id", "site.example.invalid", "http://127.0.0.1:8080")

        self.assertIsNone(adapter.inspect(spec))
        adapter.create(spec)

        self.assertEqual("POST", transport.calls[-1][0])
        self.assertEqual("/client/v4/zones/zone/dns_records", transport.calls[-1][1])
        self.assertEqual("tunnel-id.cfargotunnel.com", transport.calls[-1][2]["content"])

        # No API call is ever made against the tunnel resource itself — this
        # tunnel is locally-managed and pre-existing, never created/deleted
        # by this adapter.
        self.assertFalse(any("cfd_tunnel" in call[1] for call in transport.calls))

        # The new ingress rule landed BEFORE the catch-all, and the existing
        # unrelated rule survived untouched.
        rendered = ssh.files["/etc/cloudflared/config.yml"]
        self.assertIn("hostname: site.example.invalid", rendered)
        self.assertIn("hostname: other.example.invalid", rendered)
        self.assertLess(
            rendered.index("site.example.invalid"), rendered.index("http_status:404"),
        )
        self.assertLess(
            rendered.index("other.example.invalid"), rendered.index("site.example.invalid"),
        )
        self.assertEqual(1, ssh.restart_count)
        # A backup was taken before the write.
        self.assertTrue(any(f.startswith("/etc/cloudflared/config.yml.bak-") for f in ssh.files))

    def test_cloudflare_existing_ingress_rule_without_dns_only_creates_dns(self) -> None:
        transport = FakeTransport([
            {"result": []},                                        # inspect(): dns no
            {"result": []}, {"result": {"id": "dns-id"}},          # create(): dns lookup, then create
        ])
        ssh = FakeSshTransport(
            "/etc/cloudflared/config.yml",
            "tunnel: t\ningress:\n"
            "  - hostname: site.example.invalid\n    service: http://127.0.0.1:8080\n"
            "  - service: http_status:404\n",
        )
        adapter = CloudflareTunnelDnsAdapter(transport, "zone", ssh, restart_timeout=0)
        spec = CloudflareSpec("tunnel-id", "site.example.invalid", "http://127.0.0.1:8080")

        self.assertIsNone(adapter.inspect(spec))  # dns still missing, so not fully provisioned
        adapter.create(spec)

        # Ingress rule was already present — no config write, no restart.
        self.assertEqual(0, ssh.restart_count)
        self.assertEqual("/client/v4/zones/zone/dns_records", transport.calls[-1][1])

    def test_cloudflare_inspect_is_not_satisfied_by_dns_alone(self) -> None:
        transport = FakeTransport([
            {"result": [{"name": "site.example.invalid"}]},
        ])
        ssh = FakeSshTransport("/etc/cloudflared/config.yml", "tunnel: t\ningress:\n  - service: http_status:404\n")
        adapter = CloudflareTunnelDnsAdapter(transport, "zone", ssh)
        spec = CloudflareSpec("tunnel-id", "site.example.invalid", "http://127.0.0.1:8080")

        # DNS record exists but the ingress rule doesn't — not fully provisioned.
        self.assertIsNone(adapter.inspect(spec))

    def test_cloudflare_create_rolls_back_when_cloudflared_fails_to_come_back_active(self) -> None:
        transport = FakeTransport([])
        original = "tunnel: t\ningress:\n  - service: http_status:404\n"
        ssh = FakeSshTransport("/etc/cloudflared/config.yml", original, fail_restart=True)
        adapter = CloudflareTunnelDnsAdapter(transport, "zone", ssh, restart_timeout=0, restart_poll_interval=0)
        spec = CloudflareSpec("tunnel-id", "site.example.invalid", "http://127.0.0.1:8080")

        with self.assertRaises(RuntimeError):
            adapter.create(spec)

        # Rolled back to the original content, and cloudflared was restarted
        # a second time as part of the rollback.
        self.assertEqual(original, ssh.files["/etc/cloudflared/config.yml"])
        self.assertEqual(2, ssh.restart_count)
        # DNS creation never happened — the ingress write failed first.
        self.assertEqual(0, len(transport.calls))

    def test_cloudflare_delete_removes_only_the_matching_dns_and_ingress_rule_never_the_tunnel(self) -> None:
        transport = FakeTransport([
            {"result": [{"name": "site.example.invalid", "id": "dns-id"}]},
            {"result": {"success": True}},
        ])
        ssh = FakeSshTransport(
            "/etc/cloudflared/config.yml",
            "tunnel: t\ningress:\n"
            "  - hostname: site.example.invalid\n    service: http://127.0.0.1:8080\n"
            "  - hostname: other.example.invalid\n    service: http://127.0.0.1:8081\n"
            "  - service: http_status:404\n",
        )
        adapter = CloudflareTunnelDnsAdapter(transport, "zone", ssh, restart_timeout=0)
        spec = CloudflareSpec("tunnel-id", "site.example.invalid", "http://127.0.0.1:8080")

        adapter.delete(spec)

        self.assertEqual("DELETE", transport.calls[-1][0])
        self.assertEqual("/client/v4/zones/zone/dns_records/dns-id", transport.calls[-1][1])
        # Never a DELETE against the tunnel resource itself — it's shared.
        self.assertFalse(any(call[0] == "DELETE" and "cfd_tunnel" in call[1] for call in transport.calls))

        rendered = ssh.files["/etc/cloudflared/config.yml"]
        self.assertNotIn("site.example.invalid", rendered)
        self.assertIn("other.example.invalid", rendered)


if __name__ == "__main__":
    unittest.main()
