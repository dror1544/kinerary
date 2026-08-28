"""Provider adapters. Transport is injected so tests never contact infrastructure."""
from __future__ import annotations

import re
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

    def __init__(
        self, host: str, user: str, identity_file: str,
        timeout: int = 20, command_timeout: int = 900,
    ) -> None:
        self.host, self.user, self.identity_file, self.timeout = host, user, identity_file, timeout
        # Deliberately separate from `timeout`. That one bounds establishing the
        # connection, where 20s already means the host is unreachable. This one
        # bounds how long the remote command may RUN, and the bootstrap installs
        # build-essential and a Node toolchain over apt — minutes, not seconds.
        # Sharing one number (previously `timeout + 15` = 35s) killed every real
        # container bootstrap partway through apt on 2026-08-28.
        self.command_timeout = command_timeout

    def run(self, command: str) -> str:
        result = subprocess.run(
            ["ssh", "-i", self.identity_file, "-o", "BatchMode=yes", "-o", "IdentitiesOnly=yes",
             # These are static, LAN-only, operator-controlled hosts — not
             # exposed to the internet. A fresh caller (e.g. a freshly built
             # Docker container, unlike this developer machine's own already
             # populated known_hosts) has no prior host-key history for them,
             # and BatchMode=yes refuses rather than prompts on an unknown
             # host key. accept-new still does the key exchange and pins the
             # key for the session; it just doesn't require a pre-seeded,
             # writable known_hosts file (the worker container runs as
             # `nobody`, which has none).
             "-o", "StrictHostKeyChecking=accept-new", "-o", "UserKnownHostsFile=/dev/null",
             "-o", f"ConnectTimeout={self.timeout}", f"{self.user}@{self.host}", command],
            capture_output=True, text=True, timeout=self.command_timeout,
        )
        if result.returncode != 0:
            raise RuntimeError(
                f"ssh command failed (exit {result.returncode}): {_truncate_middle(result.stderr)}"
            )
        return result.stdout


def _truncate_middle(text: str, head: int = 400, tail: int = 600) -> str:
    """Keep both ends of a failed command's stderr.

    Head-only truncation loses the actual error whenever a script emits
    warnings before failing: a bootstrap run on 2026-08-28 reported nothing but
    locale warnings from apt/perl while the real cause — an EACCES several
    hundred characters later — fell outside the window. The tail is where the
    failing command's own message lives, so it is the half worth guaranteeing.
    """
    text = text.strip()
    if len(text) <= head + tail:
        return text
    return f"{text[:head]}\n[...{len(text) - head - tail} chars omitted...]\n{text[-tail:]}"


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

    def __init__(self, ssh: SshTransport, seed_password: str = "", reset_data: bool = False) -> None:
        self.ssh = ssh
        # Optional shared onboarding password for the new site's participants.
        # Deliberately NOT part of LxcSpec/Topology: those are serialized to
        # kinerary-deploy/trips/<slug>/topology.yaml, which is a tracked file in
        # a git repository — a secret must not travel that way. Empty keeps
        # server.js's safe default (independent random per-user passwords).
        self._seed_password = seed_password
        # When true, create() wipes the trip's NFS data dir (SQLite DB + media)
        # before anything else. The control plane sets this only for a first
        # provision — a container teardown leaves that dir intact, so a failed
        # earlier attempt can leave a stale users table that server.js will not
        # re-seed over. Never set on a redeploy of a live trip.
        self._reset_data = reset_data

    def inspect(self, spec: LxcSpec) -> dict[str, Any] | None:
        output = self.ssh.run("pct list")
        for line in output.splitlines()[1:]:  # header: VMID Status Lock Name
            parts = line.split()
            if len(parts) >= 3 and parts[-1] == spec.name:
                return {"vmid": parts[0], "status": parts[1], "name": parts[-1]}
        return None

    def create(self, spec: LxcSpec) -> None:
        if self._reset_data:
            self._reset_trip_data(spec.nfs_host_dir)
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
                # Privileged, matching every real trip container (CT200/201/202
                # carry no `unprivileged` line at all). `pct create` defaults to
                # unprivileged=1, where container root is host uid 100000: the
                # root-owned mp0 NFS directory then appears inside as
                # nobody:nogroup, and _bootstrap_app_environment's own
                # `mkdir -p <mount>/media/avatars` fails EACCES under `set -e`,
                # killing the bootstrap before .env/the systemd unit/the nginx
                # site are written. Confirmed live 2026-08-28 on CT101, the
                # first container this adapter ever created.
                "--unprivileged", "0",
                "--ostype", "debian",
                "--tags", "sites",
            ]
        )
        self.ssh.run(f"{create_cmd} && pct start {shlex.quote(vmid)}")
        self._bootstrap_app_environment(vmid, spec)

    def _bootstrap_app_environment(self, vmid: str, spec: LxcSpec) -> None:
        """Installs everything kinerary-deploy/deploy.sh assumes already
        exists on the target — nginx, Node, the systemd unit, and a `.env`
        with a TRIP_DIR matching this trip (deploy.sh refuses to sync onto a
        container whose TRIP_DIR doesn't match, as a guard against deploying
        to the wrong box). `pct create` alone only produces a bare Debian
        template; without this, deploy.sh's first real run on a freshly
        created container fails outright — found and closed 2026-08-26 while
        running the first real end-to-end onboarding test against a
        Phase-G-created container; every earlier real container (CT200-202)
        had this done by hand.

        Reruns are safe: apt installs are no-ops when already satisfied, and
        every file this writes is fully overwritten each time, not appended.
        """
        trip_slug = spec.nfs_mount_path.rsplit("/", 1)[-1]
        app_dir = "/opt/kinerary"
        avatars_dir = f"{spec.nfs_mount_path}/media/avatars"
        # Appended with printf rather than written inside the heredoc above:
        # that heredoc is unquoted (it has to expand ${JWT_SECRET}), so a
        # password containing $ or ` would be mangled or executed there.
        seed_password_line = (
            f"  printf 'SEED_PASSWORD=%s\\n' {shlex.quote(self._seed_password)} >> {app_dir}/.env\n"
            if self._seed_password else ""
        )
        script = f"""#!/bin/bash
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive
for i in $(seq 1 30); do pct exec {vmid} -- true 2>/dev/null && break; sleep 2; done

pct exec {vmid} -- bash -s <<'BOOTSTRAP_INNER'
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive
# The template generates only C.utf8; without this every apt/perl invocation
# emits several lines of "Setting locale failed" warnings, which is what
# masked a real EACCES behind truncated stderr on 2026-08-28.
export LANG=C.UTF-8 LC_ALL=C.UTF-8
apt-get update -qq
# build-essential is not optional: server/package.json pulls in better-sqlite3,
# a native module, and npm falls back to a node-gyp build whenever no prebuilt
# binary matches the platform. Without a compiler deploy.sh's own
# `npm install --production` fails and the service never starts.
apt-get install -y -qq curl nginx ca-certificates gnupg build-essential >/dev/null
if ! command -v node >/dev/null 2>&1; then
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash - >/dev/null 2>&1
  apt-get install -y -qq nodejs >/dev/null
fi

mkdir -p {app_dir}/trips {app_dir}/site
mkdir -p {avatars_dir}
ln -sfn {avatars_dir} {app_dir}/site/avatars

if [ ! -f {app_dir}/.env ]; then
  JWT_SECRET=$(head -c 32 /dev/urandom | base64)
  # Hex, not base64: setup-mcp.sh copies this value around by
  # `grep '^HERMES_API_KEY=' | cut -d= -f2-`, so it must not contain '='.
  HERMES_API_KEY=$(head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \\n')
  cat > {app_dir}/.env <<ENVEOF
TRIP_DIR={app_dir}/trips/{trip_slug}
DATA_DIR={spec.nfs_mount_path}/server-data
PORT=3000
JWT_SECRET=${{JWT_SECRET}}
HERMES_API_KEY=${{HERMES_API_KEY}}
ENVEOF
{seed_password_line}fi

cat > /etc/systemd/system/kinerary-server.service <<'UNITEOF'
[Unit]
Description=Kinerary Trip Server
After=network.target

[Service]
Type=simple
WorkingDirectory={app_dir}/server
EnvironmentFile={app_dir}/.env
ExecStart=/usr/bin/node server.js
Restart=always
RestartSec=5
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
UNITEOF

cat > /etc/nginx/sites-available/kinerary <<'NGINXEOF'
server {{
  listen 8080;
  server_name _;
  root {app_dir}/site;
  index index.html;

  add_header X-Content-Type-Options nosniff;
  add_header X-Frame-Options DENY;
  add_header X-XSS-Protection "1; mode=block";

  location ~ ^/api/trivia/(events|public-events) {{
    proxy_pass http://127.0.0.1:3000;
    proxy_http_version 1.1;
    proxy_set_header Connection '';
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_buffering off;
    proxy_cache off;
    proxy_read_timeout 86400s;
  }}

  location ^~ /api/ {{
    proxy_pass http://127.0.0.1:3000;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_read_timeout 120s;
    client_max_body_size 500m;
  }}

  location /photo/ {{
    proxy_pass http://127.0.0.1:3000;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
  }}

  location ~* \\.(html)$ {{
    add_header Cache-Control "no-cache, must-revalidate";
    try_files $uri =404;
  }}

  location /avatars/ {{
    return 404;
  }}

  location ^~ /confirmations/ {{
    proxy_pass http://127.0.0.1:3000;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
  }}

  location ~* \\.(md|txt|rtf|pdf|doc|docx|xls|xlsx|ppt|pptx|odt|ods|odp|pkpass)$ {{
    proxy_pass http://127.0.0.1:3000;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
  }}

  location / {{
    try_files $uri $uri/ =404;
  }}
}}
NGINXEOF
rm -f /etc/nginx/sites-enabled/default
ln -sfn /etc/nginx/sites-available/kinerary /etc/nginx/sites-enabled/kinerary
systemctl daemon-reload
systemctl enable nginx kinerary-server >/dev/null 2>&1 || true
systemctl restart nginx
BOOTSTRAP_INNER
"""
        self.ssh.run(script)

    def _reset_trip_data(self, nfs_host_dir: str) -> None:
        """Wipe the trip's persisted app state (SQLite DB under server-data/)
        and uploaded media so a first provision starts clean. The NFS dir
        outlives a container, so a failed earlier attempt can leave a users
        table server.js seeds only once and never migrates.

        Only ever reached when the control plane says this trip has never
        provisioned successfully — a redeploy of a live trip must not lose
        its family's photos and RSVPs.
        """
        base = nfs_host_dir.rstrip("/")
        # Defence in depth before an `rm -rf`: the last path segment must be a
        # real slug, never empty (which would target the shared NFS root).
        segment = base.rsplit("/", 1)[-1]
        if not re.fullmatch(r"[a-z0-9]+(?:-[a-z0-9]+)*", segment):
            raise ValueError(f"refusing to reset data for unexpected dir {base!r}")
        self.ssh.run(
            f"rm -rf {shlex.quote(base + '/server-data')} {shlex.quote(base + '/media')}"
        )

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
        zone_id: str,
        ssh: SshTransport,
        config_path: str = "/etc/cloudflared/config.yml",
        restart_poll_interval: float = 1.0,
        restart_timeout: float = 15.0,
    ) -> None:
        self.transport, self.zone_id = transport, zone_id
        self.ssh = ssh
        self.config_path = config_path
        self._restart_poll_interval = restart_poll_interval
        self._restart_timeout = restart_timeout

    def inspect(self, spec: CloudflareSpec) -> dict[str, Any] | None:
        records = self._dns_records(spec)
        dns_present = any(record.get("name") == spec.hostname for record in records)
        if dns_present and self._ingress_rule_present(spec):
            return {"hostname": spec.hostname, "tunnel_id": spec.tunnel_id}
        return None

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
                "content": f"{spec.tunnel_id}.cfargotunnel.com", "proxied": True,
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
