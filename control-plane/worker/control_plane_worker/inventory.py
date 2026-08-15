"""Read-only Proxmox inventory adapter."""
from __future__ import annotations

import json
from typing import Any, Protocol
from urllib.request import Request, urlopen


class Transport(Protocol):
    def get(self, path: str) -> dict[str, Any]: ...


class ProxmoxHttpTransport:
    def __init__(self, base_url: str, authorization: str) -> None:
        self.base_url = base_url.rstrip("/")
        self.authorization = authorization

    def get(self, path: str) -> dict[str, Any]:
        request = Request(
            f"{self.base_url}{path}",
            headers={"Authorization": self.authorization, "Accept": "application/json"},
            method="GET",
        )
        with urlopen(request, timeout=20) as response:  # nosec B310: explicit operator profile
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
