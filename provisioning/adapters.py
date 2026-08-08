"""Provider adapters. Transport is injected so tests never contact infrastructure."""
from __future__ import annotations

from typing import Any, Protocol

from .models import CloudflareSpec, LxcSpec, ProxySpec


class JsonTransport(Protocol):
    def request(self, method: str, path: str, *, payload: dict[str, Any] | None = None,
                params: dict[str, str] | None = None) -> dict[str, Any] | list[Any]: ...


def _result(response: dict[str, Any] | list[Any]) -> Any:
    return response.get("result", response.get("data", [])) if isinstance(response, dict) else response


class ProxmoxLxcAdapter:
    def __init__(self, transport: JsonTransport, node: str) -> None:
        self.transport, self.node = transport, node

    def inspect(self, spec: LxcSpec) -> dict[str, Any] | None:
        records = _result(self.transport.request("GET", f"/api2/json/nodes/{self.node}/lxc"))
        return next((item for item in records if item.get("name") == spec.name), None)

    def create(self, spec: LxcSpec) -> None:
        self.transport.request("POST", f"/api2/json/nodes/{self.node}/lxc", payload={
            "hostname": spec.name, "ostemplate": spec.template, "storage": spec.storage,
            "cores": spec.cores, "memory": spec.memory_mb, "rootfs": f"{spec.storage}:{spec.disk_gb}",
            "net0": f"name=eth0,bridge={spec.bridge},ip={spec.ipv4}", "start": 1,
        })

    def delete(self, spec: LxcSpec) -> None:
        existing = self.inspect(spec)
        if existing:
            self.transport.request("DELETE", f"/api2/json/nodes/{self.node}/lxc/{existing['vmid']}")


class NpmProxyHostAdapter:
    def __init__(self, transport: JsonTransport) -> None:
        self.transport = transport

    def inspect(self, spec: ProxySpec) -> dict[str, Any] | None:
        records = _result(self.transport.request("GET", "/api/nginx/proxy-hosts"))
        return next((item for item in records if spec.hostname in item.get("domain_names", [])), None)

    def create(self, spec: ProxySpec) -> None:
        self.transport.request("POST", "/api/nginx/proxy-hosts", payload={
            "domain_names": [spec.hostname], "forward_scheme": "http",
            "forward_host": spec.forward_host, "forward_port": spec.forward_port,
            "access_list_id": 0, "certificate_id": 0, "ssl_forced": False,
            "caching_enabled": False, "block_exploits": True, "allow_websocket_upgrade": True,
        })

    def delete(self, spec: ProxySpec) -> None:
        existing = self.inspect(spec)
        if existing:
            self.transport.request("DELETE", f"/api/nginx/proxy-hosts/{existing['id']}")


class CloudflareTunnelDnsAdapter:
    def __init__(self, transport: JsonTransport, account_id: str, zone_id: str) -> None:
        self.transport, self.account_id, self.zone_id = transport, account_id, zone_id

    @property
    def _tunnels_path(self) -> str:
        return f"/client/v4/accounts/{self.account_id}/cfd_tunnel"

    def inspect(self, spec: CloudflareSpec) -> dict[str, Any] | None:
        tunnel = self._tunnel(spec)
        records = self._dns_records(spec)
        if tunnel and any(record.get("name") == spec.hostname for record in records):
            return tunnel
        return None

    def _tunnel(self, spec: CloudflareSpec) -> dict[str, Any] | None:
        records = _result(self.transport.request("GET", self._tunnels_path, params={"name": spec.tunnel_name}))
        return next((item for item in records if item.get("name") == spec.tunnel_name), None)

    def _dns_records(self, spec: CloudflareSpec) -> list[dict[str, Any]]:
        return _result(self.transport.request(
            "GET", f"/client/v4/zones/{self.zone_id}/dns_records", params={"name": spec.hostname}
        ))

    def create(self, spec: CloudflareSpec) -> None:
        tunnel = self._tunnel(spec)
        if tunnel is None:
            tunnel = _result(self.transport.request("POST", self._tunnels_path, payload={"name": spec.tunnel_name}))
        self.transport.request(
            "PUT", f"{self._tunnels_path}/{tunnel['id']}/configurations",
            payload={"config": {"ingress": [
                {"hostname": spec.hostname, "service": spec.service},
                {"service": "http_status:404"},
            ]}},
        )
        records = self._dns_records(spec)
        if not any(record.get("name") == spec.hostname for record in records):
            self.transport.request("POST", f"/client/v4/zones/{self.zone_id}/dns_records", payload={
                "type": "CNAME", "name": spec.hostname,
                "content": f"{tunnel['id']}.cfargotunnel.com", "proxied": True,
            })

    def delete(self, spec: CloudflareSpec) -> None:
        tunnel = self._tunnel(spec)
        records = self._dns_records(spec)
        for record in records:
            if record.get("name") == spec.hostname:
                self.transport.request("DELETE", f"/client/v4/zones/{self.zone_id}/dns_records/{record['id']}")
        if tunnel:
            self.transport.request("DELETE", f"{self._tunnels_path}/{tunnel['id']}")
