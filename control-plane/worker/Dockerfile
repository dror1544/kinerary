FROM python:3.12-alpine
WORKDIR /app
# openssh-client: ComputeAdapter's CloudflareTunnelDnsAdapter shells out to
# `ssh` to edit the RPi4's locally-managed cloudflared config — not present
# in the base image by default. bash: kinerary-deploy/deploy.sh (invoked by
# ShellDeployAdapter) is a bash script; Alpine's default /bin/sh (busybox
# ash) doesn't support all of it.
RUN apk add --no-cache openssh-client bash
COPY control-plane/worker/requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt
COPY control-plane/worker/control_plane_worker ./control_plane_worker
# provisioning/ lives at the repo root, not under control-plane/worker — the
# ComputeAdapter (Phase G) imports it directly rather than duplicating the
# Proxmox/NPM/Cloudflare adapters here. This is why the build context is the
# repo root (see compose.local.yml) instead of control-plane/worker itself.
COPY provisioning ./provisioning
USER nobody
CMD ["python", "-m", "control_plane_worker", "run"]
