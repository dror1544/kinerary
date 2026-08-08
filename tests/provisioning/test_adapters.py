from __future__ import annotations

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


class AdapterTests(unittest.TestCase):
    def test_proxmox_create_uses_spec_without_network_or_token_literals(self) -> None:
        transport = FakeTransport([{"data": []}, {"data": {"vmid": 101}}])
        adapter = ProxmoxLxcAdapter(transport, "node-a")
        spec = LxcSpec("app", "node-a", "local:vztmpl/debian.tar.zst", "local-lvm", 2, 1024, 8, "vmbr0", "dhcp")

        self.assertIsNone(adapter.inspect(spec))
        adapter.create(spec)

        self.assertEqual("POST", transport.calls[1][0])
        self.assertEqual("/api2/json/nodes/node-a/lxc", transport.calls[1][1])
        self.assertEqual("name=eth0,bridge=vmbr0,ip=dhcp", transport.calls[1][2]["net0"])
        self.assertNotIn("token", transport.calls[1][2])

    def test_npm_existing_hostname_is_idempotent(self) -> None:
        transport = FakeTransport([[{"id": 9, "domain_names": ["site.example.invalid"]}]])
        adapter = NpmProxyHostAdapter(transport)

        existing = adapter.inspect(ProxySpec("site.example.invalid", "app", 8080))

        self.assertEqual(9, existing["id"])
        self.assertEqual(1, len(transport.calls))

    def test_cloudflare_create_creates_tunnel_then_dns_record(self) -> None:
        transport = FakeTransport([
            {"result": []}, {"result": []}, {"result": []}, {"result": {"id": "tunnel-id"}}, {"result": {"success": True}}, {"result": []}, {"result": {"id": "dns-id"}},
        ])
        adapter = CloudflareTunnelDnsAdapter(transport, "account", "zone")
        spec = CloudflareSpec("tunnel", "site.example.invalid", "http://app:8080")

        self.assertIsNone(adapter.inspect(spec))
        adapter.create(spec)

        self.assertEqual("POST", transport.calls[3][0])
        self.assertEqual("/client/v4/accounts/account/cfd_tunnel", transport.calls[3][1])
        self.assertEqual("PUT", transport.calls[4][0])
        self.assertEqual("http://app:8080", transport.calls[4][2]["config"]["ingress"][0]["service"])
        self.assertEqual("POST", transport.calls[6][0])
        self.assertEqual("/client/v4/zones/zone/dns_records", transport.calls[6][1])
        self.assertEqual("tunnel-id.cfargotunnel.com", transport.calls[6][2]["content"])

    def test_cloudflare_existing_tunnel_without_dns_only_creates_dns(self) -> None:
        transport = FakeTransport([
            {"result": [{"id": "tunnel-id", "name": "tunnel"}]}, {"result": []},
            {"result": [{"id": "tunnel-id", "name": "tunnel"}]}, {"result": {"success": True}}, {"result": []}, {"result": {"id": "dns-id"}},
        ])
        adapter = CloudflareTunnelDnsAdapter(transport, "account", "zone")
        spec = CloudflareSpec("tunnel", "site.example.invalid", "http://app:8080")

        self.assertIsNone(adapter.inspect(spec))
        adapter.create(spec)

        self.assertEqual(0, sum(call[0] == "POST" and "cfd_tunnel" in call[1] for call in transport.calls))
        self.assertEqual("/client/v4/zones/zone/dns_records", transport.calls[-1][1])


if __name__ == "__main__":
    unittest.main()
