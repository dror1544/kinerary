FROM python:3.12-alpine
WORKDIR /app
# openssh-client: ComputeAdapter's CloudflareTunnelDnsAdapter shells out to
# `ssh` to edit the RPi4's locally-managed cloudflared config — not present
# in the base image by default. bash: kinerary-deploy/deploy.sh (invoked by
# ShellDeployAdapter) is a bash script; Alpine's default /bin/sh (busybox
# ash) doesn't support all of it.
#
# git: release_source.materialize_release_source runs `git ls-tree` / `git
# archive` at a promoted release's source_revision to re-derive its sealed
# blob-sha digest and extract site/server/shared for that exact commit (see
# release_source.py <-> release-artifact.ts computeArtifactDigest). This is
# core to release verification, not incidental — a production worker needs it
# too. Only the `provision` path calls it; the `run` queue-observer (this
# image's default CMD, and all that compose.example.yml runs) never does.
#
# What is still DEV-ONLY is HOW the worker gets a repo to run those against:
# compose.local.yml bind-mounts the operator's live checkout at /repo. The
# production design — fetch the pinned source_revision from the git remote
# with a read-only deploy key, no bind mount — is tracked with the Sprint 4.7
# deferred compute/data/secret adapter abstractions (see the sprint plan).
RUN apk add --no-cache openssh-client bash git
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
