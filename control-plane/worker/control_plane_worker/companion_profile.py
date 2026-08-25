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
            "site_connection_name": "trip-site",
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
