#!/usr/bin/env bash
# vm-teardown-trip.sh — scripts/teardown-trip.py on the Proxmox VM.
#
#   control-plane/deployment/vm-teardown-trip.sh --trip <slug|trip_id>            # the plan
#   control-plane/deployment/vm-teardown-trip.sh --trip <slug|trip_id> --execute  # do it
#
# Same arguments, same refusals, same order of steps. What differs is where the
# state lives and who may touch it: the deploy root and provisioning.env (whose
# Cloudflare/NPM/Proxmox credentials the infra step uses) are root-only, and the
# Hermes volume is /opt/hermes-data with its gateways as s6 slots in the `hermes`
# container. So it runs as root with the VM's locations; teardown-trip.py picks
# the Linux path for gateways, the bridge listener and the s6 rescan by itself.
set -euo pipefail
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
exec sudo env \
  KINERARY_DEPLOY_ROOT=/opt/kinerary-deploy \
  KINERARY_HERMES_HOME=/opt/hermes-data \
  KINERARY_COMPOSE_PROJECT=kinerary-cp \
  KINERARY_HERMES_CONTAINER=hermes \
  python3 "$REPO/scripts/teardown-trip.py" "$@"
