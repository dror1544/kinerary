#!/usr/bin/env bash
# vm-e2e.sh — scripts/e2e-full-cycle.py against the Proxmox VM's own stack.
#
#   control-plane/deployment/vm-e2e.sh --scenario manual --auto --stop-after confirm
#   control-plane/deployment/vm-e2e.sh --scenario japan --auto --teardown
#
# Same arguments as the runner. It runs as root because the checks after the
# build read what only root can here: the deploy root (topology.yaml), the
# Hermes volume (a companion's SOUL/config/.env), and the Proxmox key the site
# check uses for `pct exec`. Every switch points at this VM, so nothing in the
# run can reach the Mac's relay, database or companions.
set -euo pipefail
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
DEP="$REPO/control-plane/deployment"
exec sudo env PYTHONUNBUFFERED=1 \
  KINERARY_COMPOSE_PROJECT=kinerary-cp \
  KINERARY_RELAY_CONTAINER=kinerary-cp-relay-1 \
  KINERARY_RELAY_RESTART="$DEP/vm-relay-restart.sh" \
  KINERARY_TEARDOWN="$DEP/vm-teardown-trip.sh" \
  KINERARY_DEPLOY_ROOT=/opt/kinerary-deploy \
  KINERARY_HERMES_HOME=/opt/hermes-data \
  KINERARY_HERMES_BIN=/usr/local/bin/hermes \
  python3 "$REPO/scripts/e2e-full-cycle.py" "$@"
