#!/usr/bin/env bash
# vm-manual-test.sh — a person's end-to-end test of the Proxmox VM.
#
#   ssh -i ~/.ssh/id_ed25519_kinerary_cp debian@192.168.0.45
#   /opt/kinerary/control-plane/deployment/vm-manual-test.sh --check     # preconditions only
#   /opt/kinerary/control-plane/deployment/vm-manual-test.sh             # the test
#   /opt/kinerary/control-plane/deployment/vm-manual-test.sh --scenario japan   # with a document to send
#
# The same runner the automated cycle uses, minus the automated organizer: it
# signs a new organizer up, prints a t.me link to @Tripinterviewer_bot, and waits
# while YOU do the interview and confirm. Then it verifies what confirming built —
# the provisioning job, the site and its content, the companion, its trip-mcp —
# and leaves the trip running so you can open the site and talk to the companion.
#
# Provisioning is switched on for the run only, and back off on every exit,
# Ctrl-C included: both stacks share Proxmox, NPM, Cloudflare and the RPi4, and
# the Mac's allocator cannot see the VM's trips.
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
VM_ENV=/opt/kinerary-deploy/vm.env
C=(sudo docker compose -f "$DIR/compose.vm.yml" --env-file /opt/kinerary-deploy/provisioning.env --env-file "$VM_ENV")
PSQL=(sudo docker exec kinerary-cp-postgres-1 psql -U kinerary_control_plane -d kinerary_control_plane -At -c)

SCENARIO=manual
WAIT=45
CHECK_ONLY=0
while [ $# -gt 0 ]; do
  case "$1" in
    --scenario) SCENARIO="${2:?}"; shift ;;
    --wait-minutes) WAIT="${2:?}"; shift ;;
    --check) CHECK_ONLY=1 ;;
    *) echo "usage: $0 [--check] [--scenario manual|japan|multi] [--wait-minutes N]" >&2; exit 2 ;;
  esac
  shift
done

PROBLEMS=0
ok()   { printf '  \033[32m✓\033[0m %s\n' "$1"; }
fail() { printf '  \033[31m✗\033[0m %s\n' "$1"; PROBLEMS=$((PROBLEMS + 1)); }
note() { printf '  \033[33m!\033[0m %s\n' "$1"; }

echo "── Preconditions ──"
curl -sf http://127.0.0.1:4310/readyz | grep -q '"status":"ready"' && ok "control plane ready" || fail "control plane not ready: ${C[*]} ps"

bot="$("${C[@]}" logs relay 2>&1 | grep -o '"username":"[A-Za-z_]*"' | tail -1 | cut -d'"' -f4)"
[ "$bot" = "Tripinterviewer_bot" ] && ok "relay is on @$bot (the VM's test bot)" \
  || fail "relay reports @${bot:-unknown} — this test must run on @Tripinterviewer_bot, never @Kinerary_bot"

creds="$(sudo -u hermes -i hermes auth list </dev/null 2>/dev/null | grep -cE 'openai-codex|anthropic|openrouter|ollama' || true)"
[ "${creds:-0}" -gt 0 ] && ok "Hermes has provider credentials ($creds entr$( [ "$creds" = 1 ] && echo y || echo ies))" \
  || fail "Hermes on the VM has no provider credentials — a companion could not answer you. Log in first (runbook: Credentials)."

inflight="$("${PSQL[@]}" "SELECT count(*) FROM control_plane.jobs WHERE state NOT IN ('succeeded','failed','cancelled')")"
[ "$inflight" = "0" ] && ok "no provisioning job in flight on the VM" || fail "$inflight job(s) still in flight on the VM"

sealed="$("${PSQL[@]}" "SELECT count(*) FROM control_plane.releases WHERE status='available' AND jsonb_typeof(manifest->'files')='array'")"
[ "${sealed:-0}" -gt 0 ] && ok "a sealed release is available ($sealed)" || fail "no sealed release — build and promote one (runbook: Provisioning from the VM)"

note "confirm the MAC is not provisioning right now: don't finish an interview on the Mac stack during this test"
note "the trip's slug comes from your answers — don't reuse a destination a live Mac trip already has"

if [ "$PROBLEMS" -gt 0 ]; then
  echo; echo "$PROBLEMS precondition(s) not met — nothing was changed"; exit 1
fi
[ "$CHECK_ONLY" -eq 1 ] && { echo; echo "preconditions met — run without --check to start the test"; exit 0; }

provisioning() {
  local compute="$1" flag="$2"
  sudo sed -i -e "s/^PROVISIONER_COMPUTE_ENABLED=.*/PROVISIONER_COMPUTE_ENABLED=$compute/" \
              -e "s/^PROVISIONER_COMPANION_PROFILE_ENABLED=.*/PROVISIONER_COMPANION_PROFILE_ENABLED=$flag/" \
              -e "s/^PROVISIONER_MCP_BRIDGE_ENABLED=.*/PROVISIONER_MCP_BRIDGE_ENABLED=$flag/" "$VM_ENV"
  "${C[@]}" up -d --wait worker >/dev/null 2>&1
}
restore() {
  provisioning "" 0
  echo
  echo "── Provisioning switched back OFF on the VM ──"
}
trap restore EXIT

echo
echo "── Provisioning ON for this run ──"
provisioning 1 1
ok "worker: compute=$(sudo docker exec kinerary-cp-worker-1 printenv PROVISIONER_COMPUTE_ENABLED), companion + trip-mcp on"

echo
"$DIR/vm-e2e.sh" --scenario "$SCENARIO" --wait-minutes "$WAIT" || true

trip="$("${PSQL[@]}" "SELECT id || '  ' || slug FROM control_plane.trips ORDER BY created_at DESC LIMIT 1")"
echo
echo "── What is left running for you ──"
echo "  trip:      $trip"
slug="${trip##* }"
case "$slug" in draft-*|retired-*|'') ;; *) echo "  site:      https://$slug.ara-united.store" ;; esac
echo "  companion: message @Tripinterviewer_bot from the chat you did the interview in"
echo "  remove it: $DIR/vm-teardown-trip.sh --trip ${trip%% *} --execute"
