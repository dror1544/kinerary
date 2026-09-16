#!/usr/bin/env bash
# vm-restore-snapshot.sh — put the whole control-plane VM back to a release
# snapshot. The last way back, for a person, from the Mac.
#
#   control-plane/deployment/vm-restore-snapshot.sh                          # --list
#   control-plane/deployment/vm-restore-snapshot.sh --snapshot <pre-…>       # the plan: what it costs; changes nothing
#   control-plane/deployment/vm-restore-snapshot.sh --snapshot <pre-…> --execute
#
# Try the cheaper ways first — they keep more:
#   kinerary-cp-release rollback               code only, keeps the database
#   kinerary-cp-release rollback --restore-db  code + the pre-upgrade dump
# This one discards EVERYTHING on the VM since the snapshot: database rows,
# companion conversations and memory, deploy-root state. It is for damage those
# cannot reach — a broken Docker, OS or Hermes image, a disk in a bad state.
#
# Every action is `qm` on the Proxmox host over ssh, and everything inside the
# VM goes through the guest agent (`qm guest exec`), so it works when the VM has
# no network and no sshd.
#
# THE CREDENTIALS. Hermes's OAuth logins (/opt/hermes-data/auth.json) and the
# interview's codex login rotate single-use refresh tokens. The snapshot holds
# OLD ones; if the restored VM refreshed with them, the provider would see a
# reused token and lock the account out. So: the live files are read first
# (into this shell's memory, never onto the Mac's disk), the VM boots from the
# snapshot with its network link DOWN — nothing can refresh or poll Telegram —
# Hermes is stopped, the live files are written back, and only then does the
# link come up.
#
# It refuses a snapshot older than a trip that was built since (container, DNS,
# proxy host and companion would outlive a database that no longer knows them).
# There is no --force: tear that trip down first.
set -uo pipefail
case "${1:-}" in -h|--help) sed -n '2,31p' "$0"; exit 0 ;; esac

# Which VM, which Proxmox host, which key: facts about this deployment, kept in
# the private kinerary-deploy repo (the kinerary repo is public). No defaults —
# a wrong guess here would roll back the wrong machine.
DEPLOY_ROOT="${KINERARY_DEPLOY_ROOT:-$HOME/kinerary-deploy}"
# Read single KEY=value lines; never source these files (provisioning.env holds credentials).
conf() { [ -f "$2" ] && sed -n "s/^$1=//p" "$2" | tail -1; }
VMID="$(conf CP_VMID "$DEPLOY_ROOT/control-plane.env")"
PVE_KEY="$(conf CP_PROXMOX_SSH_KEY_ON_MAC "$DEPLOY_ROOT/control-plane.env")"
REFUSE_STORAGE="$(conf CP_REFUSE_STORAGE "$DEPLOY_ROOT/control-plane.env")"
PVE="$(conf PROXMOX_HOST "$DEPLOY_ROOT/provisioning.env")"
PVE_USER="$(conf PROXMOX_SSH_USER "$DEPLOY_ROOT/provisioning.env")"
PVE_KEY="${PVE_KEY/#\~/$HOME}"
for pair in "CP_VMID=$VMID" "CP_PROXMOX_SSH_KEY_ON_MAC=$PVE_KEY" "PROXMOX_HOST=$PVE" "PROXMOX_SSH_USER=$PVE_USER"; do
  [ -n "${pair#*=}" ] || { echo "missing ${pair%%=*} in $DEPLOY_ROOT/control-plane.env or provisioning.env" >&2; exit 2; }
done
printf '%s' "$VMID" | grep -Eq '^[0-9]+$' || { echo "CP_VMID is not a number" >&2; exit 2; }
printf '%s' "$PVE$PVE_USER$REFUSE_STORAGE" | grep -Eq '^[A-Za-z0-9._: -]*$' || { echo "a Proxmox setting holds characters it may not" >&2; exit 2; }
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUNNER="$DIR/proxmox-snapshot-runner.sh"
PG=kinerary-cp-postgres-1
BUILT="'provisioning','ready_private','activation_approved','active','completed','sealed'"

MODE=list
SNAP=""
DRY_RUN=0
while [ $# -gt 0 ]; do
  case "$1" in
    --list) MODE=list ;;
    --snapshot) SNAP="${2:?--snapshot needs a name}"; MODE=plan; shift ;;
    --dry-run) DRY_RUN=1 ;;
    --execute) MODE=execute ;;
    -h|--help) sed -n '2,33p' "$0"; exit 0 ;;
    *) echo "unknown argument: $1 (see --help)" >&2; exit 2 ;;
  esac
  shift
done
if [ "$MODE" = execute ] && [ -z "$SNAP" ]; then echo "--execute needs --snapshot <name>" >&2; exit 2; fi
# --dry-run always wins: it is the plan, whatever else was passed.
if [ "$DRY_RUN" -eq 1 ] && [ "$MODE" = execute ]; then MODE=plan; fi
case "$SNAP" in ''|pre-*) ;; *) echo "only release snapshots (pre-*) are restored here" >&2; exit 2 ;; esac
# (grep sees no line at all for an empty name, so only a given name is checked)
[ -z "$SNAP" ] || printf '%s\n' "$SNAP" | grep -Eq '^[A-Za-z0-9_-]+$' || { echo "bad snapshot name" >&2; exit 2; }

ok()   { printf '  \033[32m✓\033[0m %s\n' "$1"; }
bad()  { printf '  \033[31m✗\033[0m %s\n' "$1"; PROBLEMS=$((PROBLEMS + 1)); }
note() { printf '  \033[33m!\033[0m %s\n' "$1"; }
die()  { printf '\nSTOPPED: %s\n' "$1" >&2; exit 1; }
PROBLEMS=0

pve() { ssh -i "$PVE_KEY" -o BatchMode=yes -o IdentitiesOnly=yes -o ConnectTimeout=10 "$PVE_USER@$PVE" "$@"; }

# Run a command inside the VM through the guest agent; print its stdout.
# Exit status is the command's, or 125 when the agent did not answer.
guest() {
  local timeout="$1"; shift
  local joined="" arg
  for arg in "$@"; do joined="$joined $(printf '%q' "$arg")"; done
  pve "qm guest exec $VMID --timeout $timeout --$joined" 2>/dev/null | python3 -c '
import json, sys
try:
    d = json.load(sys.stdin)
except ValueError:
    sys.exit(125)
sys.stdout.write(d.get("out-data", ""))
sys.exit(d.get("exitcode", 125) if d.get("exited", 1) else 125)'
}

agent_up() { pve "timeout 10 qm agent $VMID ping" >/dev/null 2>&1; }

echo "── VM $VMID snapshots (on $PVE) ──"
LIST="$(pve "bash -s -- list $VMID" < "$RUNNER")" || die "could not reach the Proxmox host"
NOW="$(date +%s)"
printf '%s\n' "$LIST" | awk -F'\t' -v now="$NOW" '/^snapshot=/ { sub(/^snapshot=/, "", $1); printf "  %-32s %5.1f days  %s\n", $1, (now - $2) / 86400, $3 }'
[ "$MODE" = list ] && exit 0

SNAPTIME="$(printf '%s\n' "$LIST" | awk -F'\t' -v s="snapshot=$SNAP" '$1 == s { print $2 }')"
[ -n "$SNAPTIME" ] || die "no snapshot named $SNAP on VM $VMID"
SINCE="$(python3 -c "import datetime,sys; print(datetime.datetime.fromtimestamp(int(sys.argv[1]), datetime.timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ'))" "$SNAPTIME")"

echo
echo "── The plan: restore $SNAP (taken $SINCE) ──"
PRE="$(pve "env REFUSE_STORAGE='$REFUSE_STORAGE' bash -s -- preflight $VMID" < "$RUNNER" 2>/dev/null)"
for check in lock tasks storage; do
  line="$(printf '%s\n' "$PRE" | grep "^check.$check=" | head -1)"
  case "$line" in *=pass*) ok "${line#*=pass }" ;; *=fail*) bad "${line#*=fail }" ;; *) bad "could not read the $check check from the host" ;; esac
done
printf '%s\n' "$PRE" | grep '^pool\.' | sed 's/^pool\./  · pool /'

GUEST_ANSWERS=0
if agent_up; then
  GUEST_ANSWERS=1
  q() { guest 60 docker exec "$PG" psql -U kinerary_control_plane -d kinerary_control_plane -At -c "$1"; }
  built="$(q "SELECT string_agg(slug || ' (' || lifecycle_state || ')', ', ') FROM control_plane.trips WHERE updated_at > '$SINCE' AND lifecycle_state IN ($BUILT)")"
  jobs="$(q "SELECT count(*) FROM control_plane.jobs WHERE created_at > '$SINCE'")"
  profiles="$(guest 60 sh -c "for d in /opt/hermes-data/profiles/*/; do b=\$(stat -c %W \"\$d\"); [ \"\$b\" -gt $SNAPTIME ] && basename \"\$d\"; done; true" | tr '\n' ' ')"
  lost="$(q "SELECT (SELECT count(*) FROM control_plane.trips WHERE created_at > '$SINCE') || ' trips, ' || (SELECT count(*) FROM control_plane.intake_sessions WHERE created_at > '$SINCE') || ' interview sessions, ' || (SELECT count(*) FROM control_plane.telegram_chat_bindings WHERE created_at > '$SINCE') || ' chat bindings'")"
  if [ -n "$built" ] || [ "${jobs:-0}" != "0" ] || [ -n "${profiles// /}" ]; then
    bad "trips were built since the snapshot — built: ${built:-none}; jobs: ${jobs:-?}; new companion profiles: ${profiles:-none}. Tear them down first (vm-teardown-trip.sh), or use kinerary-cp-release rollback"
  else
    ok "no trip was built since the snapshot"
  fi
  note "discarded with the restore: ${lost:-unknown}, plus every companion conversation and deploy-root change since $SINCE"
  auth_present="$(guest 30 sh -c 'test -s /opt/hermes-data/auth.json && echo hermes; test -s /opt/agent-auth/codex/auth.json && echo codex; true' | tr '\n' ' ')"
  ok "live credentials to carry across: ${auth_present:-none found}"
else
  note "the VM's guest agent does not answer — nothing inside it can be checked, and its live credentials cannot be carried across"
fi
echo
echo "  → shut VM $VMID down, qm rollback $VMID $SNAP"
echo "  → start it with its network link down; stop Hermes; write the live credentials back"
echo "  → bring the link up; start Hermes; restart the relay and interview sidecar"
echo "  → restart every trip's trip-mcp bridge and companion; kinerary-cp-release verify"
echo "  downtime: the bot, every companion and site AI features, for ~3-5 minutes"

if [ "$MODE" != execute ]; then
  echo
  [ "$PROBLEMS" -eq 0 ] && echo "Plan only — nothing was changed. Add --execute to restore." || echo "$PROBLEMS problem(s). Nothing was changed."
  exit $(( PROBLEMS > 0 ))
fi
[ "$PROBLEMS" -eq 0 ] || die "$PROBLEMS problem(s) above — nothing was changed"
if [ "$GUEST_ANSWERS" -eq 0 ]; then
  printf '\nThe VM could not be checked. Type the snapshot name to restore it anyway: '
  read -r typed </dev/tty
  [ "$typed" = "$SNAP" ] || die "not confirmed — nothing was changed"
fi

echo
echo "── Restoring ──"
HERMES_AUTH=""; CODEX_AUTH=""
if [ "$GUEST_ANSWERS" -eq 1 ]; then
  HERMES_AUTH="$(guest 30 sh -c 'test -s /opt/hermes-data/auth.json && base64 -w0 /opt/hermes-data/auth.json; true')"
  CODEX_AUTH="$(guest 30 sh -c 'test -s /opt/agent-auth/codex/auth.json && base64 -w0 /opt/agent-auth/codex/auth.json; true')"
  ok "read live credentials into memory: hermes ${HERMES_AUTH:+yes}${HERMES_AUTH:-no}, codex ${CODEX_AUTH:+yes}${CODEX_AUTH:-no}"
fi

NET0="$(pve "qm config $VMID" | awk -F': ' '$1 == "net0" { print $2 }')"
[ -n "$NET0" ] || die "could not read net0 of VM $VMID"
NET0_BASE="$(printf '%s' "$NET0" | sed -E 's/,?link_down=[01]//')"

pve "qm shutdown $VMID --timeout 120 || qm stop $VMID" >/dev/null 2>&1 || die "could not stop VM $VMID"
ok "VM $VMID stopped"
pve "timeout 300 qm rollback $VMID $SNAP" || die "qm rollback failed — the VM is stopped; inspect with: qm listsnapshot $VMID"
ok "rolled back to $SNAP"
pve "qm set $VMID --net0 '$NET0_BASE,link_down=1'" >/dev/null || die "could not take the network link down — NOT starting the VM"
pve "qm start $VMID" || die "qm start failed (link is down: qm set $VMID --net0 '$NET0_BASE' restores it)"
for _ in $(seq 1 60); do agent_up && break; sleep 3; done
agent_up || die "the guest agent did not come back within 3 minutes — the VM is up with its link DOWN; console: qm terminal $VMID"
ok "VM booted from the snapshot, network link down"

guest 120 docker stop hermes >/dev/null || note "docker stop hermes did not succeed"
restore_file() {  # restore_file <path> <base64>
  local path="$1" data="$2"
  printf '%s' "$data" | pve "qm guest exec $VMID --timeout 30 --pass-stdin 1 -- sh -c 'f=$path; base64 -d > \$f.carried && chown --reference=\$(dirname \$f) \$f.carried && chmod 600 \$f.carried && mv \$f.carried \$f'" >/dev/null 2>&1
}
CARRIED=1
if [ -n "$HERMES_AUTH" ]; then
  restore_file /opt/hermes-data/auth.json "$HERMES_AUTH" && ok "Hermes credentials carried across" || { bad "could not write Hermes credentials back"; CARRIED=0; }
else
  CARRIED=0
fi
if [ -n "$CODEX_AUTH" ]; then
  restore_file /opt/agent-auth/codex/auth.json "$CODEX_AUTH" && ok "interview codex login carried across" || bad "could not write the codex login back"
fi
unset HERMES_AUTH CODEX_AUTH

pve "qm set $VMID --net0 '$NET0_BASE'" >/dev/null || die "could not bring the network link back up: qm set $VMID --net0 '$NET0_BASE'"
ok "network link up"
sleep 5
guest 180 docker restart kinerary-cp-relay-1 kinerary-cp-interview-mcp-1 >/dev/null || note "relay/sidecar restart reported a problem"
if [ "$CARRIED" -eq 1 ]; then
  guest 180 docker start hermes >/dev/null && ok "Hermes started" || bad "docker start hermes failed"
  echo
  echo "── Trip bridges, companions, verify (inside the VM) ──"
  guest 900 /usr/local/sbin/kinerary-cp-release restart-bridges
else
  echo
  note "Hermes stays STOPPED: its live credentials could not be carried, and starting it on the snapshot's would lock the accounts."
  echo "  Log in again inside the VM, then start it and repair the trips:"
  echo "    sudo docker exec -it hermes hermes auth add openai-codex   (and the other providers, runbook: Credentials)"
  echo "    /opt/kinerary/control-plane/deployment/vm-interview-runner.sh login codex"
  echo "    sudo docker start hermes && sudo kinerary-cp-release restart-bridges"
fi
echo
echo "Restored VM $VMID to $SNAP."
