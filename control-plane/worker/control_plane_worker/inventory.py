"""Read-only Proxmox inventory adapter."""
from __future__ import annotations

import json
import ssl
from typing import Any, Protocol
from urllib.parse import urlsplit
from urllib.request import Request, urlopen


class Transport(Protocol):
    def get(self, path: str) -> dict[str, Any]: ...


class ProxmoxHttpTransport:
    def __init__(self, base_url: str, authorization: str, ca_bundle: str | None = None) -> None:
        # PROXMOX_URL comes from the operator environment, so the scheme is
        # pinned rather than trusted: urlopen would otherwise honour file:// and
        # read a local path, and http:// would put the API token on the wire in
        # plaintext.
        if urlsplit(base_url).scheme != "https":
            raise ValueError("Proxmox base URL must use https://")
        self.base_url = base_url.rstrip("/")
        self.authorization = authorization
        # Proxmox serves a self-signed certificate by default, so an explicit CA
        # bundle is normally required. Verification is never disabled.
        self.context = ssl.create_default_context(cafile=ca_bundle)

    def get(self, path: str) -> dict[str, Any]:
        request = Request(
            f"{self.base_url}{path}",
            headers={"Authorization": self.authorization, "Accept": "application/json"},
            method="GET",
        )
        # nosec B310: __init__ pins the scheme to https, so no local handler is reachable.
        with urlopen(request, timeout=20, context=self.context) as response:
            return json.loads(response.read().decode())


class ProxmoxInventory:
    def __init__(self, transport: Transport, node: str) -> None:
        self.transport = transport
        self.node = node

    def inspect(self) -> dict[str, list[dict[str, Any]]]:
        paths = {
            "containers": f"/api2/json/nodes/{self.node}/lxc",
            "storage": f"/api2/json/nodes/{self.node}/storage",
        }
        result: dict[str, list[dict[str, Any]]] = {}
        for key, path in paths.items():
            response = self.transport.get(path)
            records = response.get("data", [])
            result[key] = [
                {name: record[name] for name in ("vmid", "name", "status", "storage", "type", "content", "avail") if name in record}
                for record in records
            ]
        return result
