"""Minimal stdlib JSON-over-HTTP transport; credentials remain environment-only."""
from __future__ import annotations

import json
from typing import Any
from urllib.error import HTTPError
from urllib.parse import urlencode
from urllib.request import Request, urlopen


class HttpJsonTransport:
    def __init__(self, base_url: str, headers: dict[str, str]) -> None:
        self.base_url = base_url.rstrip("/")
        self.headers = headers

    def request(self, method: str, path: str, *, payload: dict[str, Any] | None = None,
                params: dict[str, str] | None = None) -> dict[str, Any] | list[Any]:
        url = f"{self.base_url}{path}"
        if params:
            url += "?" + urlencode(params)
        data = json.dumps(payload).encode() if payload is not None else None
        headers = {**self.headers, "Accept": "application/json"}
        if data is not None:
            headers["Content-Type"] = "application/json"
        request = Request(url, data=data, headers=headers, method=method)
        try:
            with urlopen(request, timeout=20) as response:  # nosec B310: URL is explicit operator config
                return json.loads(response.read().decode())
        except HTTPError as exc:
            body = exc.read().decode(errors="replace")
            raise RuntimeError(f"{method} {path} failed with HTTP {exc.code}: {body[:500]}") from exc
