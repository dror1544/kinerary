"""A stand-in for scripts/trip-container-host.sh, at the level of its request/answer contract.

It is a transport for control_plane_worker.trip_container.DockerSiteAdapter: bytes in (the one JSON request
the SSH connection's stdin would carry), (exit status, stdout) out. It keeps the little state the real script
keeps - the trip's directory on a store, a container per slug, an image list - and refuses what the real one
refuses: a verb or field outside the contract, an image the host does not have, a request before `ensure`.

It is NOT the script. tests/scripts/test_trip_container_worker_contract.py drives the real script through the
same client, which is what keeps this file honest; when the script's contract changes, that test goes red first.
"""
from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any

DIGEST_TAG = "trip-site:{}"
COMMON = {"record_type", "verb", "trip_id", "slug"}
REQUIRED = {"ensure": {"ip", "image"}, "deploy": {"ip", "image"}, "start": set(), "stop": set(), "remove": set(),
            "check": set(), "read": {"fields"}}
OPTIONAL = {"ensure": {"seed_password", "exchange_key", "hermes_url", "public_origin", "trip_mcp_enabled"},
            "deploy": set(), "start": set(), "stop": set(), "remove": set(), "check": set(),
            "read": {"exchange_key_candidates", "bridge_url"}}


class FakeTripHost:
    def __init__(self, store_root: "str | Path", *, images: "set[str] | None" = None,
                 bridge_url: str = "http://bridge.test:4310", unhealthy_checks: int = 0) -> None:
        self.store_root = Path(store_root)
        self.images = set(images or ())            # 64-hex digests the host "has"
        self.bridge_url = bridge_url
        self.unhealthy_checks = unhealthy_checks     # this many `check`s answer unhealthy before the first healthy one
        self.raw: "list[bytes]" = []
        self.requests: "list[dict[str, Any]]" = []
        # (verb, did the store's trip/ hold a trip.config.json when the verb ran?) in the order the verbs came
        self.events: "list[tuple[str, bool]]" = []
        self.containers: "dict[str, dict[str, Any]]" = {}    # slug -> {"image", "running", "trip_id", "ip"}
        self.bridge_answer = {"ok": True, "evidence": "health 200: the container reached the bridge"}
        self.refuse_with: "dict[str, str]" = {}            # verb -> a refusal reason to answer with
        self.ssh_failure = False

    # -- the transport --------------------------------------------------------------------------------------
    def __call__(self, payload: bytes) -> "tuple[int, bytes]":
        if self.ssh_failure:
            return 255, b""
        self.raw.append(payload)
        try:
            body = json.loads(payload)
        except ValueError:
            return self._refuse("request is not one valid JSON object")
        self.requests.append(body)
        verb = body.get("verb")
        if body.get("record_type") != "trip_container_request" or verb not in REQUIRED:
            return self._refuse("unknown verb")
        if set(body) - (COMMON | REQUIRED[verb] | OPTIONAL[verb]) or (COMMON | REQUIRED[verb]) - set(body):
            return self._refuse("unknown or foreign fields in the request" if set(body) - (COMMON | REQUIRED[verb] | OPTIONAL[verb])
                                else "required fields are missing")
        for field in ("hermes_url", "bridge_url"):
            if field in body and body[field] != self.bridge_url:
                return self._refuse(f"{field} is not the bridge origin this host is configured for")
        if verb in self.refuse_with:
            return self._refuse(self.refuse_with[verb])
        self.events.append((verb, self._config_present(body["trip_id"])))
        return getattr(self, f"_{verb}")(body)

    # -- answers --------------------------------------------------------------------------------------------
    @staticmethod
    def _answer(exit_code: int, /, **fields: Any) -> "tuple[int, bytes]":
        return exit_code, (json.dumps(fields) + "\n").encode()

    def _refuse(self, reason: str) -> "tuple[int, bytes]":
        return self._answer(2, ok=False, error="refused", reason=reason)

    def _fail(self, reason: str) -> "tuple[int, bytes]":
        return self._answer(1, ok=False, error="failed", reason=reason)

    # -- state ----------------------------------------------------------------------------------------------
    def _dir(self, trip_id: str) -> Path:
        return self.store_root / trip_id

    def _config_present(self, trip_id: str) -> bool:
        return (self._dir(trip_id) / "trip" / "trip.config.json").is_file()

    def _env(self, trip_id: str) -> "dict[str, str]":
        path = self._dir(trip_id) / ".env"
        if not path.is_file():
            return {}
        return dict(line.split("=", 1) for line in path.read_text().splitlines() if "=" in line)

    def _store_ready(self, body: dict) -> bool:
        return (self._dir(body["trip_id"]) / "TRIP.txt").is_file() and (self._dir(body["trip_id"]) / ".env").is_file()

    # -- verbs ----------------------------------------------------------------------------------------------
    def _ensure(self, body: dict) -> "tuple[int, bytes]":
        slug, trip_id = body["slug"], body["trip_id"]
        existing = self.containers.get(slug)
        if existing is None and body["image"] not in self.images:
            return self._refuse("the image is not on this host: build it with the release tooling first")
        trip = self._dir(trip_id)
        for sub in ("trip", "server-data", "documents", "media"):
            (trip / sub).mkdir(parents=True, exist_ok=True)
        (trip / "TRIP.txt").write_text(f"trip: {slug}\ntrip_id: {trip_id}\nslug: {slug}\ncontainer: trip-{slug}\n")
        env_state = "kept"
        if not (trip / ".env").exists():
            if "seed_password" not in body:
                return self._refuse("a new .env needs a seed_password")
            lines = [f"SEED_PASSWORD={body['seed_password']}", f"HERMES_API_KEY={'2' * 64}"]
            if "exchange_key" in body:
                lines.append(f"CONTROL_PLANE_EXCHANGE_KEY={body['exchange_key']}")
            if "hermes_url" in body:
                lines.append(f"HERMES_URL={body['hermes_url']}")
            (trip / ".env").write_text("\n".join(lines) + "\n")
            os.chmod(trip / ".env", 0o600)
            env_state = "created"
        if existing is None:
            self.containers[slug] = {"image": body["image"], "running": True, "trip_id": trip_id, "ip": body["ip"]}
            container = "created"
        else:
            existing["running"] = True
            container = "existing"
        return self._answer(0, ok=True, verb="ensure", name=f"trip-{slug}", container=container, env=env_state,
                            bind="bound", network="existing")

    def _deploy(self, body: dict) -> "tuple[int, bytes]":
        slug = body["slug"]
        if not self._store_ready(body):
            return self._refuse("the trip has no store yet: run ensure first")
        if body["image"] not in self.images:
            return self._refuse("the image is not on this host: build it with the release tooling first")
        previous = self.containers.get(slug)
        self.containers[slug] = {"image": body["image"], "running": True, "trip_id": body["trip_id"], "ip": body["ip"]}
        return self._answer(0, ok=True, verb="deploy", name=f"trip-{slug}",
                            previous_image=DIGEST_TAG.format(previous["image"]) if previous else None)

    def _check(self, body: dict) -> "tuple[int, bytes]":
        container = self.containers.get(body["slug"])
        if container is None:
            return self._fail("no such container")
        if not container["running"]:
            return self._answer(1, ok=False, verb="check", running=False, healthy=False, status=None)
        if self.unhealthy_checks > 0:
            self.unhealthy_checks -= 1
            return self._answer(1, ok=False, verb="check", running=True, healthy=False, status=None)
        return self._answer(0, ok=True, verb="check", running=True, healthy=True, status=200)

    def _start(self, body: dict) -> "tuple[int, bytes]":
        container = self.containers.get(body["slug"])
        if container is None:
            return self._fail("no such container")
        container["running"] = True
        return self._answer(0, ok=True, verb="start", name=f"trip-{body['slug']}")

    def _stop(self, body: dict) -> "tuple[int, bytes]":
        container = self.containers.get(body["slug"])
        if container is None:
            return self._fail("no such container")
        container["running"] = False
        return self._answer(0, ok=True, verb="stop", name=f"trip-{body['slug']}")

    def _remove(self, body: dict) -> "tuple[int, bytes]":
        removed = self.containers.pop(body["slug"], None) is not None
        return self._answer(0, ok=True, verb="remove", name=f"trip-{body['slug']}", removed=removed)

    def _read(self, body: dict) -> "tuple[int, bytes]":
        if not (self._dir(body["trip_id"]) / "TRIP.txt").is_file():
            return self._refuse("the trip has no store yet")
        fields = body["fields"]
        if ("exchange_key_candidates" in body) != ("exchange_key_kind" in fields):
            return self._refuse("exchange_key_candidates go with exchange_key_kind, and only with it")
        if ("bridge_url" in body) != ("site_to_bridge" in fields):
            return self._refuse("bridge_url goes with site_to_bridge, and only with it")
        env = self._env(body["trip_id"])
        out: "dict[str, Any]" = {"ok": True, "verb": "read"}
        if "seed_password" in fields:
            out["seed_password"] = env.get("SEED_PASSWORD") or None
        if "exchange_key_kind" in fields:
            held = env.get("CONTROL_PLANE_EXCHANGE_KEY", "")
            out["exchange_key_kind"] = next((k for k, v in body["exchange_key_candidates"].items() if v == held), None)
        if "site_to_bridge" in fields:
            out["site_to_bridge"] = self.bridge_answer
        return self._answer(0, **out)

    # -- helpers for assertions ---------------------------------------------------------------------------------
    def verbs(self) -> "list[str]":
        return [verb for verb, _ in self.events]
