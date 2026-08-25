"""Provider adapters. Transport is injected so tests never contact infrastructure."""
from __future__ import annotations

import shlex
import subprocess
import time
from typing import Any, Protocol

import yaml

from .models import CloudflareSpec, LxcSpec, ProxySpec


class SshTransport(Protocol):
    def run(self, command: str) -> str: ...


class SubprocessSshTransport:
    """Runs one remote command per call via the system `ssh` binary. Used
    for the RPi4 that runs cloudflared — that tunnel is locally-managed
    (reads /etc/cloudflared/config.yml), confirmed by direct inspection
    (2026-08-25), so there is no API to push its ingress config through."""

    def __init__(self, host: str, user: str, identity_file: str, timeout: int = 20) -> None:
        self.host, self.user, self.identity_file, self.timeout = host, user, identity_file, timeout

    def run(self, command: str) -> str:
        result = subprocess.run(
            ["ssh", "-i", self.identity_file, "-o", "BatchMode=yes", "-o", "IdentitiesOnly=yes",
             "-o", f"ConnectTimeout={self.timeout}", f"{self.user}@{self.host}", command],
            capture_output=True, text=True, timeout=self.timeout + 15,
        )
        if result.returncode != 0:
            raise RuntimeError(f"ssh command failed (exit {result.returncode}): {result.stderr[:500]}")
        return result.stdout


class JsonTransport(Protocol):
    def request(self, method: str, path: str, *, payload: dict[str, Any] | None = None,
                params: dict[str, str] | None = None) -> dict[str, Any] | list[Any]: ...


def _result(response: dict[str, Any] | list[Any]) -> Any:
    return response.get("result", response.get("data", [])) if isinstance(response, dict) else response


class ProxmoxLxcAdapter:
    """Creates/inspects/deletes an LXC via `pct` over SSH into the Proxmox
    host itself, reusing the same SSH key kinerary-deploy's scripts already
    use for every `pct exec`/`pct config` call — rather than a separate
    Proxmox API token. `pct create` is synchronous (blocks until the
    container exists or the command fails), so unlike the HTTP API's
    `POST /nodes/{node}/lxc` there is no async task to poll.

    Also creates the trip's NFS media-storage directory (mp0) as part of
    create() — it lives on the SAME NFS mount already visible on the
    Proxmox host (/mnt/pve/truenas-nfs/..., confirmed live), so this is a
    plain `mkdir`, not a separate TrueNAS-side provisioning step.
    """

    def __init__(self, ssh: SshTransport) -> None:
        self.ssh = ssh

    def inspect(self, spec: LxcSpec) -> dict[str, Any] | None:
        output = self.ssh.run("pct list")
        for line in output.splitlines()[1:]:  # header: VMID Status Lock Name
            parts = line.split()
            if len(parts) >= 3 and parts[-1] == spec.name:
                return {"vmid": parts[0], "status": parts[1], "name": parts[-1]}
        return None

    def create(self, spec: LxcSpec) -> None:
        self.ssh.run(f"mkdir -p {shlex.quote(spec.nfs_host_dir)}")
        vmid = self.ssh.run("pvesh get /cluster/nextid").strip()
        net0 = (
            f"name=eth0,bridge={spec.bridge},ip={spec.ipv4},"
            f"gw={spec.gateway},type=veth"
        )
        mp0 = f"{spec.nfs_host_dir},mp={spec.nfs_mount_path}"
        create_cmd = " ".join(
            shlex.quote(part) for part in [
                "pct", "create", vmid, spec.template,
                "--hostname", spec.name,
                "--storage", spec.storage,
                "--cores", str(spec.cores),
                "--memory", str(spec.memory_mb),
                "--swap", "512",
                "--rootfs", f"{spec.storage}:{spec.disk_gb}",
                "--net0", net0,
                "--nameserver", spec.nameserver,
                "--features", "nesting=1,keyctl=1",
                "--mp0", mp0,
                "--ostype", "debian",
                "--tags", "sites",
            ]
        )
        self.ssh.run(f"{create_cmd} && pct start {shlex.quote(vmid)}")

    def delete(self, spec: LxcSpec) -> None:
        existing = self.inspect(spec)
        if existing:
            vmid = shlex.quote(existing["vmid"])
            self.ssh.run(f"pct stop {vmid} || true; pct destroy {vmid}")


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
    """Manages DNS (Cloudflare API) and tunnel ingress (SSH into the RPi4
    that runs cloudflared) for one trip hostname on the existing, shared,
    locally-managed tunnel.

    The tunnel is shared across every service this RPi4 exposes (home-lab
    hosts plus every trip site) — create()/delete() only ever add or remove
    ONE ingress rule and ONE DNS record for `spec.hostname`. Neither ever
    touches the tunnel object itself: an earlier version of delete() called
    DELETE on the tunnel resource, which would have destroyed the shared
    tunnel (and every hostname it serves) the first time anything actually
    tore a trip down — caught before it was ever exercised for real.
    """

    def __init__(
        self,
        transport: JsonTransport,
        account_id: str,
        zone_id: str,
        ssh: SshTransport,
        config_path: str = "/etc/cloudflared/config.yml",
        restart_poll_interval: float = 1.0,
        restart_timeout: float = 15.0,
    ) -> None:
        self.transport, self.account_id, self.zone_id = transport, account_id, zone_id
        self.ssh = ssh
        self.config_path = config_path
        self._restart_poll_interval = restart_poll_interval
        self._restart_timeout = restart_timeout

    @property
    def _tunnels_path(self) -> str:
        return f"/client/v4/accounts/{self.account_id}/cfd_tunnel"

    def inspect(self, spec: CloudflareSpec) -> dict[str, Any] | None:
        tunnel = self._tunnel(spec)
        records = self._dns_records(spec)
        dns_present = bool(tunnel) and any(record.get("name") == spec.hostname for record in records)
        if dns_present and self._ingress_rule_present(spec):
            return tunnel
        return None

    def _tunnel(self, spec: CloudflareSpec) -> dict[str, Any] | None:
        records = _result(self.transport.request("GET", self._tunnels_path, params={"name": spec.tunnel_name}))
        return next((item for item in records if item.get("name") == spec.tunnel_name), None)

    def _dns_records(self, spec: CloudflareSpec) -> list[dict[str, Any]]:
        return _result(self.transport.request(
            "GET", f"/client/v4/zones/{self.zone_id}/dns_records", params={"name": spec.hostname}
        ))

    def _read_config(self) -> dict[str, Any]:
        raw = self.ssh.run(f"sudo -n cat {self.config_path}")
        return yaml.safe_load(raw) or {}

    def _ingress_rule_present(self, spec: CloudflareSpec) -> bool:
        config = self._read_config()
        return any(rule.get("hostname") == spec.hostname for rule in config.get("ingress", []))

    def create(self, spec: CloudflareSpec) -> None:
        tunnel = self._tunnel(spec)
        if tunnel is None:
            tunnel = _result(self.transport.request("POST", self._tunnels_path, payload={"name": spec.tunnel_name}))

        if not self._ingress_rule_present(spec):
            config = self._read_config()
            ingress = list(config.get("ingress", []))
            # Insert before the final catch-all so it stays the last rule —
            # every existing rule (home-lab hosts, other trips) is preserved
            # untouched.
            catch_all_index = next(
                (i for i, rule in enumerate(ingress) if rule.get("service") == "http_status:404"),
                len(ingress),
            )
            new_rule = {"hostname": spec.hostname, "service": spec.service}
            config["ingress"] = ingress[:catch_all_index] + [new_rule] + ingress[catch_all_index:]
            self._write_config(config)

        records = self._dns_records(spec)
        if not any(record.get("name") == spec.hostname for record in records):
            self.transport.request("POST", f"/client/v4/zones/{self.zone_id}/dns_records", payload={
                "type": "CNAME", "name": spec.hostname,
                "content": f"{tunnel['id']}.cfargotunnel.com", "proxied": True,
            })

    def delete(self, spec: CloudflareSpec) -> None:
        records = self._dns_records(spec)
        for record in records:
            if record.get("name") == spec.hostname:
                self.transport.request("DELETE", f"/client/v4/zones/{self.zone_id}/dns_records/{record['id']}")

        config = self._read_config()
        ingress = config.get("ingress", [])
        remaining = [rule for rule in ingress if rule.get("hostname") != spec.hostname]
        if len(remaining) != len(ingress):
            config["ingress"] = remaining
            self._write_config(config)

    def _write_config(self, config: dict[str, Any]) -> None:
        """Backs up the live config, writes the new one atomically (write to
        a remote temp file, then mv), restarts cloudflared, and rolls back
        automatically if it doesn't come back active — a malformed edit here
        can take down every hostname this shared tunnel serves, not just the
        one being added or removed."""
        rendered = yaml.safe_dump(config, sort_keys=False)
        suffix = time.strftime("%Y%m%d-%H%M%S")
        backup_path = f"{self.config_path}.bak-{suffix}"
        remote_tmp = f"/tmp/cloudflared-config-{suffix}.yml"

        self.ssh.run(f"sudo -n cp {self.config_path} {backup_path}")
        self.ssh.run(
            f"cat > {remote_tmp} <<'KINERARY_CLOUDFLARED_CONFIG_EOF'\n{rendered}\nKINERARY_CLOUDFLARED_CONFIG_EOF"
        )
        self.ssh.run(f"sudo -n mv {remote_tmp} {self.config_path}")
        self.ssh.run("sudo -n systemctl restart cloudflared")
        self._verify_active_or_rollback(backup_path)

    def _verify_active_or_rollback(self, backup_path: str) -> None:
        deadline = time.monotonic() + self._restart_timeout
        status = ""
        while True:
            status = self.ssh.run("sudo -n systemctl is-active cloudflared || true").strip()
            if status == "active":
                return
            if time.monotonic() >= deadline:
                break
            time.sleep(self._restart_poll_interval)
        self.ssh.run(f"sudo -n cp {backup_path} {self.config_path}")
        self.ssh.run("sudo -n systemctl restart cloudflared")
        raise RuntimeError(
            f"cloudflared did not report active after the ingress edit (last status: {status!r}) — "
            f"rolled back to the pre-change config from {backup_path}"
        )
