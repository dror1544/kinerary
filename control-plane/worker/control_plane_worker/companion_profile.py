"""Builds and installs a per-trip Hermes companion profile from a confirmed
intake's transformed config, using profile-templates/familytrip-companion's
render_profile.py — a separate, security-reviewed template package that
scans every value for secret-like keys (token/password/api_key/etc.) before
writing anything to disk, and refuses to overwrite an existing profile.

The mapping deliberately reads from transform_intake()'s OUTPUT
(config['participants'][*]['needs'], config['agent']), not from raw answers.
That transformer already resolves the dietary/pace/persona questions into
exactly the shape this module needs — severity, bilingual text, per-person
attribution, and an organizer-only-by-default visibility policy documented
in transformer.py's _instruction() and shared/needs-schema.js. This module
does not re-derive any of that; it only re-shapes it into the handoff
contract profile-templates/familytrip-companion/handoff.schema.json defines.
"""
from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
from typing import Any, Mapping, Optional, Protocol


def _slugify_profile_name(slug: str) -> str:
    """Hermes profile names must match ^[a-z][a-z0-9]{2,31}$ — trip slugs
    (e.g. "tokyo-kyoto-2026") contain hyphens the schema forbids, so this
    strips them rather than reusing the slug verbatim."""
    compact = "".join(ch for ch in slug.lower() if ch.isalnum())
    compact = compact[:32] or "trip"
    if not compact[0].isalpha():
        compact = f"t{compact}"[:32]
    return compact


def build_companion_handoff(
    trip_id: str,
    slug: str,
    config: Mapping[str, Any],
    intake_version_id: str,
    intake_schema_version: int,
    intake_digest: str,
    confirmed_at: str,
    canonical_site_url: str,
) -> Optional[dict[str, Any]]:
    """Builds a trip_assistant_profile_input v1 handoff dict, or None if the
    intake didn't answer enough of the assistant questions to name one
    (transform_intake's own `agent` key is already absent in that case) or
    the organizer_identity answer didn't resolve to a real participant
    (transform_intake's _resolve_organizers returns [] rather than a guess
    — same caution applies here: no organizer, no companion profile, rather
    than handing the private channel to the wrong person).
    """
    agent = config.get("agent")
    if not isinstance(agent, dict) or not agent.get("name"):
        return None

    organizers = agent.get("organizers") or []
    participants = config.get("participants") or []
    by_username = {
        p["username"]: p for p in participants
        if isinstance(p, dict) and p.get("username")
    }
    organizer_username = organizers[0] if organizers else None
    organizer = by_username.get(organizer_username) if organizer_username else None
    if not organizer:
        return None

    meta = config.get("meta") or {}
    participant_needs: list[dict[str, Any]] = []
    for p in participants:
        username = p.get("username")
        for idx, need in enumerate(p.get("needs") or []):
            if not isinstance(need, dict):
                continue
            participant_needs.append({
                "person_ref": f"participant:{username}",
                "type": need.get("type", "other"),
                "severity": need.get("severity", "preference"),
                # Organizer-only by default — matches transformer.py's
                # _instruction() policy and shared/needs-schema.js's default
                # for named-person needs, not a guess made here.
                "visibility": "organizer",
                "status": "confirmed",
                "source_answer_ref": f"dietary:{username}:{idx}",
                "text": dict(need.get("text") or {"he": "", "en": ""}),
            })

    group_safe: dict[str, Any] = {}
    if config.get("theme"):
        group_safe["theme"] = config["theme"]

    organizer_private: dict[str, Any] = {}
    if agent.get("standing_instructions"):
        organizer_private["standing_instructions"] = agent["standing_instructions"]
    if agent.get("proactive"):
        organizer_private["proactive_defaults"] = agent["proactive"]

    return {
        "schema_version": 1,
        "record_type": "trip_assistant_profile_input",
        "handoff_id": f"handoff_{trip_id}",
        "trip_ref": trip_id,
        "profile": {
            "name": _slugify_profile_name(slug),
            "description": f"Trip companion for {meta.get('title') or slug}"[:240],
        },
        "trip": {
            "id": trip_id,
            "title": meta.get("title") or slug,
            # meta.defaultLang is already "en"/"he"-shaped — reuse
            # transform_intake's own decision rather than a second guess here.
            "default_language": meta.get("defaultLang") if meta.get("defaultLang") in ("he", "en") else "en",
            "timezone": agent.get("timezone") or "UTC",
            "canonical_site_url": canonical_site_url,
            # trip-mcp, not trip-site. The name here is not cosmetic: it is what
            # SOUL.md and references/sources.md tell the assistant to call, so if it does
            # not match the MCP server actually registered in the profile, the assistant
            # looks for a connection that does not exist and falls back to scraping the
            # public site (or running code to fetch it) — which is what happened on
            # japan-2026.

            # Everything that creates the server already agreed on trip-mcp:
            # kinerary-deploy/setup-mcp.sh registers it under that name, the live
            # shiranusa2026 profile uses it, and this template's OWN skills call it
            # (trip-daily-planning's `get_config` via trip-mcp, trip_kml_export.py).
            # Only the handoff contract said trip-site, so the handoff was the outlier.
            "site_connection_name": "trip-mcp",
        },
        "assistant": {
            "name": agent["name"],
            "name_en": agent.get("name_en") or agent["name"],
            "gender": agent.get("gender", "neutral"),
            "tone": agent.get("tone", "warm"),
            "proactive": agent.get("proactive") or {},
        },
        "organizer": {
            "person_ref": f"participant:{organizer_username}",
            "display_name": organizer.get("name") or organizer.get("name_en") or organizer_username,
        },
        "interview": {
            "confirmed": True,
            "group_safe": group_safe,
            "organizer_private": organizer_private,
            "participant_needs": participant_needs,
        },
        "source": {
            "intake_version_ref": intake_version_id,
            "intake_schema_version": intake_schema_version,
            "intake_digest": intake_digest,
            "confirmed_at": confirmed_at,
        },
    }


class CompanionProfileAdapter(Protocol):
    """Installs a rendered companion profile and returns its Hermes profile
    name, or None if nothing was installed."""

    def install(self, handoff: Mapping[str, Any]) -> Optional[str]: ...


class NullCompanionProfileAdapter:
    """No-op — used when profile-templates isn't configured for this
    deployment. Provisioning still succeeds; only the automatic
    companion-profile-creation step is skipped."""

    def install(self, handoff: Mapping[str, Any]) -> Optional[str]:
        return None


def forced_command_argv(
    host: str, user: str, key_path: str, port: int = 22, known_hosts: str | None = None,
) -> list[str]:
    """The ssh invocation for the host's forced-command key.

    No remote command: the key's forced command decides what runs. Even if this
    list gained an attacker-controlled entry it could not choose the program —
    but there is nothing to append to in the first place. Shared by every
    request that goes over this key, so they cannot drift in how they reach it.
    """
    return [
        "ssh",
        "-i", key_path,
        "-p", str(port),
        "-o", "BatchMode=yes",
        "-o", "ConnectTimeout=10",
        "-o", "IdentitiesOnly=yes",
        # Host-key policy is explicit either way rather than left to the
        # ambient ~/.ssh/known_hosts of whatever user the worker runs as.
        *(("-o", f"UserKnownHostsFile={known_hosts}", "-o", "StrictHostKeyChecking=yes")
          if known_hosts else
          ("-o", "StrictHostKeyChecking=accept-new")),
        f"{user}@{host}",
    ]


class SshCompanionProfileAdapter:
    """Materializes a companion on a host reachable over SSH.

    ONE fulfilment of `CompanionProfileAdapter`, not a new contract. The
    provisioning contract is and stays "materialize this companion from this
    validated handoff"; that this particular implementation gets there by SSH
    is an implementation detail of one deployment shape.

    WHY IT EXISTS. The Hermes install the profile must be created in is a macOS
    arm64 venv pinned to absolute host paths, and the gateway that serves those
    profiles runs on that same host. A containerised Hermes could neither
    execute it nor create profiles for the build that actually runs them, so
    `RenderProfileAdapter` — which shells `render_profile.py` locally — cannot
    work from inside the worker container.

    WHAT IT IS NOT. This is a provisioning/install-time mechanism only.
    Nothing about a trip that is already provisioned depends on it: not its
    routing, not its chat binding, not the Hermes runtime, not a live
    conversation. `install()` is called from exactly one place, the
    provisioner's completion path, and if SSH is unavailable the consequence
    is a recorded `COMPANION_INSTALL_FAILED` on a trip that still deploys,
    still serves its site, and still binds its chat (A4).

    A BRIDGE, DELIBERATELY. The planned K3s direction makes a trip companion an
    orchestrated deployable unit; that becomes another implementation of this
    same `install()` and this class is deleted. Nothing above the adapter
    should learn that SSH was ever involved — which is why the failure it
    raises is an ordinary RuntimeError and the reason recorded upstream is
    COMPANION_INSTALL_FAILED rather than anything mentioning a host.

    TRUST. The host wrapper is the boundary, not this class: it ignores
    `SSH_ORIGINAL_COMMAND` entirely, accepts no arguments, derives every path
    itself, and charset-checks the profile name before it becomes one. The
    key is expected to be installed with a forced command, so even a fully
    compromised worker can only hand this wrapper a handoff on stdin.
    """

    def __init__(
        self,
        host: str,
        user: str,
        key_path: str,
        *,
        port: int = 22,
        timeout: int = 180,
        known_hosts: str | None = None,
    ) -> None:
        self._host = host
        self._user = user
        self._key_path = key_path
        self._port = port
        self._timeout = timeout
        self._known_hosts = known_hosts

    def preflight(self) -> None:
        """Fails loudly at startup rather than once per job.

        The 2026-09-06 failure mode this answers: a missing capability that
        only shows up when a real organizer's trip is being provisioned, one
        job at a time, as a warning nobody is watching.
        """
        if not os.path.isfile(self._key_path):
            raise RuntimeError(
                f"companion SSH key not found at {self._key_path} — "
                "the worker cannot materialize companion profiles"
            )

    def install(self, handoff: Mapping[str, Any]) -> Optional[str]:
        payload = json.dumps(dict(handoff), ensure_ascii=False)
        result = subprocess.run(
            forced_command_argv(self._host, self._user, self._key_path, self._port, self._known_hosts),
            input=payload, capture_output=True, text=True, timeout=self._timeout,
        )
        if result.returncode != 0:
            raise RuntimeError(
                f"companion install over ssh exited {result.returncode}: "
                f"{(result.stderr or result.stdout)[:500]}"
            )
        # The wrapper's contract: one line, a verb and the profile name.
        line = (result.stdout or "").strip().splitlines()[-1] if result.stdout.strip() else ""
        verb, _, name = line.partition(" ")
        if verb not in {"INSTALLED", "ALREADY_PRESENT"} or not name:
            raise RuntimeError(f"unrecognized companion install result: {line[:200]!r}")
        return name


class RenderProfileAdapter:
    """Shells out to profile-templates/familytrip-companion/render_profile.py
    --install-profile, mirroring ShellDeployAdapter's subprocess pattern.
    That script does its own strict schema validation and forbidden-key scan
    (no token/secret/password/api_key-shaped key may appear anywhere in the
    handoff) before writing anything — this adapter doesn't duplicate that
    validation, only invokes it. install() refuses to overwrite an existing
    profile, so a retried job after a partial prior success is a safe no-op
    error, not a silent overwrite — callers should treat "already exists" as
    non-fatal (the profile from the earlier attempt is still there).
    """

    def __init__(self, templates_dir: str, timeout: int = 60) -> None:
        self._templates_dir = templates_dir
        self._timeout = timeout

    def install(self, handoff: Mapping[str, Any]) -> Optional[str]:
        profile_name = handoff["profile"]["name"]
        render_script = os.path.join(self._templates_dir, "render_profile.py")
        with tempfile.TemporaryDirectory() as tmp:
            handoff_path = os.path.join(tmp, "handoff.json")
            with open(handoff_path, "w", encoding="utf-8") as fh:
                json.dump(dict(handoff), fh, ensure_ascii=False)
            output_dir = os.path.join(tmp, "rendered")
            result = subprocess.run(
                [sys.executable, render_script,
                 "--input", handoff_path,
                 "--output", output_dir,
                 "--install-profile", profile_name],
                capture_output=True, text=True, timeout=self._timeout,
            )
            if result.returncode != 0:
                raise RuntimeError(
                    f"render_profile.py exited {result.returncode}: "
                    f"{(result.stderr or result.stdout)[:500]}"
                )
        return profile_name
