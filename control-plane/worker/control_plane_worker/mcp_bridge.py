"""Wires a newly-provisioned trip's companion Hermes profile to its own
trip-mcp bridge, via kinerary-deploy/setup-mcp.sh — the same script an
operator runs by hand today for japan-2025/los-angeles-hawaii-vegas-2026.

Reads the container's LAN address from the same topology.yaml
ShellDeployAdapter already relies on (provisioner.py's _private_url), so no
new per-trip state is required — the two adapters just need to agree on
deploy_root/vmid_map.

GATED OFF BY DEFAULT, and that default is what most deployments actually run.
This adapter is used only when --enable-mcp-bridge AND --companion-templates-dir
are both passed; otherwise a NullMcpBridgeAdapter takes its place. The local
compose worker passes neither, so a trip onboarded there gets a live site and
no bridge — its companion answers with no access to trip data, which reads as
a confidently wrong assistant rather than an obviously broken one.

That failure is easy to mistake for a configuration leak. It cost an evening
on 2026-09-02: japan-2026's bridge was in fact correctly configured and had
simply died in a power outage, while a stale shared trip-mcp pointed at another
trip made it look like cross-trip contamination. kinerary-deploy/bring-up.sh
now reports the two states separately — "no bridge" (this step never ran) vs a
dead process it can restart — and names this flag as the usual cause of the
former.

This is a separate, independently-gated step from CompanionProfileAdapter:
installing the profile bundle (SOUL.md/skills/references) is a local
filesystem operation, while this step does real SSH-to-Proxmox and
`hermes mcp add` mutations. A failure here is non-fatal to provisioning —
without it, the trip site itself is fully live and the companion profile
exists; only its ability to reach trip-mcp tools (e.g. set_telegram_group)
is missing, and that gap is closed by re-running setup-mcp.sh by hand later.

Note for whoever builds Phase G's container-creation code: for this bridge
to actually result in a working set_telegram_group call, the deployed
site's own TELEGRAM_BOT_TOKEN (trip.env) must be the SAME bot as the one
connected to Hermes as the shared companion (see CONTROL_PLANE_CHAT_ROUTING_*
in the API's chat-routing endpoint / trip-intake's Hermes profile) — not a
freshly-minted per-trip bot the way japan-2025/los-angeles-hawaii-vegas-2026
were set up. The site's getChatMember-based membership check requires the
token to belong to a bot that is actually a member of the family group, and
that has to be the same bot the organizer is DMing for it to make sense as
one continuous "trip companion." Nothing currently in this codebase enforces
that — it depends on Phase G actually writing the shared token into a new
trip's trip.env instead of minting one.
"""
from __future__ import annotations

import os
import subprocess
from typing import Mapping, Protocol


class McpBridgeAdapter(Protocol):
    """Wires trip-mcp to a companion Hermes profile. Returns True if wired,
    False if skipped (e.g. no vmid/topology yet available for this slug)."""

    def setup(self, slug: str, profile_name: str) -> bool: ...


class NullMcpBridgeAdapter:
    """No-op — used when kinerary-deploy isn't configured for this
    deployment, or the operator hasn't opted into this step yet. Provisioning
    still succeeds; only the trip-mcp wiring is skipped (same story as
    NullCompanionProfileAdapter)."""

    def setup(self, slug: str, profile_name: str) -> bool:
        return False


class ShellMcpBridgeAdapter:
    """Calls kinerary-deploy/setup-mcp.sh via subprocess, mirroring
    ShellDeployAdapter's subprocess pattern in provisioner.py."""

    def __init__(
        self,
        deploy_root: str,
        vmid_map: Mapping[str, str],
        timeout: int = 180,
    ) -> None:
        self._deploy_root = deploy_root
        self._vmid_map = vmid_map
        self._timeout = timeout

    def setup(self, slug: str, profile_name: str) -> bool:
        trip_dir = os.path.join(self._deploy_root, "trips", slug)
        local_url = self._local_url(trip_dir)
        if not local_url:
            return False

        # The static map only ever covers the two hand-provisioned legacy
        # trips; a Phase-G auto-created trip's vmid instead lives in
        # topology.yaml, written there by compute.LxcProvisionAdapter once
        # Proxmox assigns it.
        vmid = self._vmid_map.get(slug) or self._topology_vmid(trip_dir)
        if not vmid:
            return False

        setup_mcp_sh = os.path.join(self._deploy_root, "setup-mcp.sh")
        result = subprocess.run(
            [setup_mcp_sh, profile_name, local_url, "--vmid", vmid, "--trip-dir", trip_dir],
            capture_output=True,
            text=True,
            timeout=self._timeout,
        )
        if result.returncode != 0:
            raise RuntimeError(
                f"setup-mcp.sh exited {result.returncode}: "
                f"{result.stderr[:500] or result.stdout[:500]}"
            )
        return True

    def _local_url(self, trip_dir: str) -> str | None:
        """Reads proxmox.lxc.ipv4 and npm.forward_port out of topology.yaml
        with the same deliberately-minimal line scan _private_url uses for
        npm.hostname — not a real YAML parse, matching the existing
        convention in this file rather than adding a new dependency."""
        topology_path = os.path.join(trip_dir, "topology.yaml")
        ipv4 = None
        port = None
        try:
            with open(topology_path, encoding="utf-8") as fh:
                for line in fh:
                    stripped = line.strip()
                    if stripped.startswith("ipv4:"):
                        ipv4 = stripped.split(":", 1)[1].strip().split("/")[0]
                    elif stripped.startswith("forward_port:"):
                        port = stripped.split(":", 1)[1].strip()
        except FileNotFoundError:
            return None
        if not ipv4 or not port:
            return None
        return f"http://{ipv4}:{port}"

    def _topology_vmid(self, trip_dir: str) -> str | None:
        """Same deliberately-minimal line scan as _local_url, for the
        proxmox.vmid line compute.LxcProvisionAdapter writes back into
        topology.yaml once it's known (absent for the two legacy trips,
        which never go through that adapter)."""
        topology_path = os.path.join(trip_dir, "topology.yaml")
        try:
            with open(topology_path, encoding="utf-8") as fh:
                for line in fh:
                    stripped = line.strip()
                    if stripped.startswith("vmid:"):
                        # yaml.safe_dump quotes a numeric-looking string
                        # value (vmid: '205') to preserve it as text.
                        return stripped.split(":", 1)[1].strip().strip("'\"") or None
        except FileNotFoundError:
            return None
        return None
