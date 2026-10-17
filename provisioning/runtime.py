"""Minimal stdlib JSON-over-HTTP transport; credentials remain environment-only."""
from __future__ import annotations

import json
import ssl
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode
from urllib.request import Request, urlopen

# OpenSSL X509 verify codes where the local trust store is what is missing:
# 18 self-signed certificate, 19 self-signed certificate in chain,
# 20 unable to get local issuer certificate, 21 unable to verify the first certificate.
# (The brief's "unable to get issuer certificate" is code 2.) Anything else keeps its reason.
_TRUST_STORE_CODES = frozenset({2, 18, 19, 20, 21})
_CERT_PLAIN_WORDS = {
    9: "The server's certificate is not valid yet; check this machine's clock.",
    10: "The server's certificate has expired; its owner has to renew it. "
        "Another Python will not help.",
    62: "The certificate was issued for a different host name than the one being called; "
        "check the URL or the server's certificate.",
}


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
        except URLError as exc:
            if isinstance(exc.reason, ssl.SSLCertVerificationError):
                # Say what failed, not a bare traceback from the middle of a teardown or a
                # deploy. The CA-bundle advice is only true for the trust-store codes (the
                # python.org build until its "Install Certificates" step is run); an expired
                # or mismatched certificate is the server's, and another interpreter would
                # not change it (#361 review).
                code = getattr(exc.reason, "verify_code", None)
                detail = getattr(exc.reason, "verify_message", None) or str(exc.reason)
                if code in _TRUST_STORE_CODES:
                    raise RuntimeError(
                        f"{method} {path}: this Python cannot verify TLS certificates ({detail}). "
                        "It has no CA bundle that trusts this server. Run the script with the "
                        "interpreter the preflight builds, ~/.cache/kinerary-preflight/venv/bin/python, "
                        "or run the python.org 'Install Certificates.command'."
                    ) from exc
                plain = _CERT_PLAIN_WORDS.get(
                    code, "The certificate failed verification for a reason other than a missing CA store.")
                raise RuntimeError(
                    f"{method} {path}: the server's TLS certificate was rejected ({detail}). {plain}"
                ) from exc
            raise
