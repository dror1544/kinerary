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
# reused token and lock the account out. So: Hermes, the relay and the
# interview sidecar are stopped FIRST — a refresh after the read would make the
# bytes read stale — then the live files are read (into this shell's memory,
# never onto the Mac's disk). The VM boots from the snapshot with its network
# link DOWN, so nothing can refresh or poll Telegram; those services are
# stopped again, the live files are written back (or removed, where the live VM
# had none), and only then does the link come up. A credential that could not
# be READ is not the same as one that does not exist: the restore stops before
# changing anything, or with --accept-unverified goes ahead and leaves that
# credential's services stopped until someone logs in again.
#
# It refuses a snapshot older than a trip that was built since (container, DNS,
# proxy host and companion would outlive a database that no longer knows them).
# There is no --force: tear that trip down first.
#
# A check that could not run is not a check that passed. When the guest agent,
# the database or the profile list cannot be read, whether trips were built
# since is UNKNOWN and the restore is refused — unless --accept-unverified is
# given AND the snapshot name is typed at the terminal. That is the path for a
# VM too broken to answer, which is when a whole-VM restore is most needed.
set -uo pipefail
usage() { awk 'NR > 1 && !/^#/ { exit } NR > 1 { sub(/^# ?/, ""); print }' "$0"; }
case "${1:-}" in -h|--help) usage; exit 0 ;; esac

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
# Everything that can rotate a credential: Hermes (its providers' OAuth) and the
# relay and interview sidecar (the interview's codex login, mounted at /codex).
HOLDERS=(hermes kinerary-cp-relay-1 kinerary-cp-interview-mcp-1)
HERMES_FILE=/opt/hermes-data/auth.json
CODEX_FILE=/opt/agent-auth/codex/auth.json
BUILT="'provisioning','ready_private','activation_approved','active','completed','sealed'"

MODE=list
SNAP=""
DRY_RUN=0
ACCEPT_UNVERIFIED=0
while [ $# -gt 0 ]; do
  case "$1" in
    --list) MODE=list ;;
    --snapshot) SNAP="${2:?--snapshot needs a name}"; MODE=plan; shift ;;
    --dry-run) DRY_RUN=1 ;;
    --execute) MODE=execute ;;
    --accept-unverified) ACCEPT_UNVERIFIED=1 ;;
    -h|--help) usage; exit 0 ;;
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
#
# `qm guest exec` exits 0 whenever it could ASK the agent — the command's own
# result is only in the JSON it prints ({"exited":1,"exitcode":N,...}). So the
# exit status here is read from that JSON: the command's exit code, or 125 when
# the agent did not answer, the command did not finish, or no JSON came back.
# Trusting ssh's status instead reported failed credential writes as written.
guest_result() {
  python3 -c '
import json, sys
try:
    d = json.load(sys.stdin)
except ValueError:
    sys.exit(125)
if not d.get("exited"):
    sys.exit(125)
sys.stdout.write(d.get("out-data", ""))
code = d.get("exitcode")
sys.exit(code if isinstance(code, int) else 125)'
}
guest() {
  local timeout="$1"; shift
  local joined="" arg
  for arg in "$@"; do joined="$joined $(printf '%q' "$arg")"; done
  pve "qm guest exec $VMID --timeout $timeout --$joined" 2>/dev/null | guest_result
}
# The same, with this script's stdin forwarded to the command in the VM.
guest_stdin() {
  local timeout="$1"; shift
  local joined="" arg
  for arg in "$@"; do joined="$joined $(printf '%q' "$arg")"; done
  pve "qm guest exec $VMID --timeout $timeout --pass-stdin 1 --$joined" 2>/dev/null | guest_result
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
VERIFIED=0
if agent_up; then
  GUEST_ANSWERS=1
  VERIFIED=1
  q() { guest 60 docker exec "$PG" psql -U kinerary_control_plane -d kinerary_control_plane -At -v ON_ERROR_STOP=1 -c "$1"; }
  # Each read must succeed on its own: an empty answer from a query that failed
  # is not "none", and a job count that is not a number is not zero.
  built="$(q "SELECT string_agg(slug || ' (' || lifecycle_state || ')', ', ') FROM control_plane.trips WHERE updated_at > '$SINCE' AND lifecycle_state IN ($BUILT)")" || VERIFIED=0
  jobs="$(q "SELECT count(*) FROM control_plane.jobs WHERE created_at > '$SINCE'")" || VERIFIED=0
  case "$jobs" in ''|*[!0-9]*) VERIFIED=0 ;; esac
  profiles="$(guest 60 sh -c "for d in /opt/hermes-data/profiles/*/; do b=\$(stat -c %W \"\$d\") || exit 3; [ \"\$b\" -gt $SNAPTIME ] && basename \"\$d\"; done; exit 0")" || VERIFIED=0
  profiles="$(printf '%s' "$profiles" | tr '\n' ' ')"
  lost="$(q "SELECT (SELECT count(*) FROM control_plane.trips WHERE created_at > '$SINCE') || ' trips, ' || (SELECT count(*) FROM control_plane.intake_sessions WHERE created_at > '$SINCE') || ' interview sessions, ' || (SELECT count(*) FROM control_plane.telegram_chat_bindings WHERE created_at > '$SINCE') || ' chat bindings'")" || lost="unknown"
  if [ "$VERIFIED" -eq 0 ]; then
    note "the database or the Hermes profile list inside the VM could not be read — whether trips were built since the snapshot is UNKNOWN"
  elif [ -n "$built" ] || [ "$jobs" != "0" ] || [ -n "${profiles// /}" ]; then
    bad "trips were built since the snapshot — built: ${built:-none}; jobs: $jobs; new companion profiles: ${profiles:-none}. Tear them down first (vm-teardown-trip.sh), or use kinerary-cp-release rollback"
  else
    ok "no trip was built since the snapshot"
  fi
  note "discarded with the restore: ${lost:-unknown}, plus every companion conversation and deploy-root change since $SINCE"
  if auth_present="$(guest 30 sh -c 'test -s /opt/hermes-data/auth.json && echo hermes; test -s /opt/agent-auth/codex/auth.json && echo codex; exit 0')"; then
    ok "live credentials to carry across: $(printf '%s' "$auth_present" | tr '\n' ' ')"
  else
    note "could not see which live credentials exist"
  fi
else
  note "the VM's guest agent does not answer — nothing inside it can be checked, and its live credentials cannot be carried across"
fi
if [ "$VERIFIED" -eq 0 ]; then
  if [ "$ACCEPT_UNVERIFIED" -eq 1 ]; then
    note "--accept-unverified: a restore that could not be checked needs the snapshot name typed to go ahead"
  else
    bad "this restore cannot be verified, so it is refused. If the VM is too broken to answer, rerun with --accept-unverified and type the snapshot name when asked"
  fi
fi
echo
echo "  → stop Hermes, the relay and the interview sidecar, so no credential rotates after it is read; read the live credentials"
echo "  → shut VM $VMID down, qm rollback $VMID $SNAP"
echo "  → start it with its network link down; stop those three again; put the live credentials back and check them"
echo "  → bring the link up; start each of those only if its credential came back"
echo "  → restart every trip's trip-mcp bridge and companion; kinerary-cp-release verify"
echo "  downtime: the bot, every companion and site AI features, for ~3-5 minutes"

if [ "$MODE" != execute ]; then
  echo
  [ "$PROBLEMS" -eq 0 ] && echo "Plan only — nothing was changed. Add --execute to restore." || echo "$PROBLEMS problem(s). Nothing was changed."
  exit $(( PROBLEMS > 0 ))
fi
[ "$PROBLEMS" -eq 0 ] || die "$PROBLEMS problem(s) above — nothing was changed"
if [ "$VERIFIED" -eq 0 ]; then
  printf '\nThis restore could not be verified. Type the snapshot name to restore it anyway: '
  typed=""
  read -r typed </dev/tty 2>/dev/null || true
  [ "$typed" = "$SNAP" ] || die "not confirmed — nothing was changed"
fi

echo
echo "── Restoring ──"
NET0="$(pve "qm config $VMID" | awk -F': ' '$1 == "net0" { print $2 }')"
[ -n "$NET0" ] || die "could not read net0 of VM $VMID — nothing was changed"
NET0_BASE="$(printf '%s' "$NET0" | sed -E 's/,?link_down=[01]//')"

# Before the VM is rolled back, the services this stopped come back as they were.
resume_live() {
  if guest 180 docker start "${HOLDERS[@]}" >/dev/null && guest 900 /usr/local/sbin/kinerary-cp-release restart-bridges >/dev/null; then
    echo "  Hermes, the relay and the interview sidecar are running again; bridges restarted." >&2
  else
    echo "  Could NOT start them again. Inside the VM: sudo docker start ${HOLDERS[*]} && sudo kinerary-cp-release restart-bridges" >&2
  fi
}

# A credential is one of: captured (its bytes, in memory), absent (the live VM
# has none), or unknown (it could not be read). Only the text of a captured one
# is kept, in HERMES_AUTH / CODEX_AUTH, and never printed: every message below
# is built from the state word, never from those variables.
HERMES_STATE=unknown; CODEX_STATE=unknown; HERMES_AUTH=""; CODEX_AUTH=""
read_credential() {  # prints "absent", or "b64:" and the file in base64
  guest 30 sh -c 'test -s "$1" || { echo absent; exit 0; }; printf b64:; base64 -w0 "$1"' sh "$1"
}
if [ "$GUEST_ANSWERS" -eq 0 ]; then
  bad "the guest agent did not answer, so no live credential could be read — Hermes, the relay and the interview sidecar will stay stopped"
elif ! guest 120 docker stop "${HOLDERS[@]}" >/dev/null; then
  # A broken Docker is a reason to restore, not a reason to refuse — but a
  # holder that may still be running could rotate a credential after it is read.
  if [ "$ACCEPT_UNVERIFIED" -eq 0 ]; then
    resume_live
    die "could not stop Hermes, the relay and the interview sidecar before reading their credentials — nothing was rolled back. If Docker in the VM is broken, add --accept-unverified to restore without carrying credentials (those services then stay stopped until you log in again)"
  fi
  bad "could not stop Hermes, the relay and the interview sidecar — --accept-unverified: no credential is read (one could still rotate after the read), so all three stay stopped"
else
  ok "Hermes, the relay and the interview sidecar are stopped (downtime starts) — no credential can rotate from here"
  HERMES_AUTH="$(read_credential "$HERMES_FILE")" || HERMES_AUTH=""
  case "$HERMES_AUTH" in
    absent) HERMES_STATE=absent; HERMES_AUTH="" ;;
    b64:?*) HERMES_STATE=captured; HERMES_AUTH="${HERMES_AUTH#b64:}" ;;
    *) HERMES_STATE=unknown; HERMES_AUTH="" ;;
  esac
  CODEX_AUTH="$(read_credential "$CODEX_FILE")" || CODEX_AUTH=""
  case "$CODEX_AUTH" in
    absent) CODEX_STATE=absent; CODEX_AUTH="" ;;
    b64:?*) CODEX_STATE=captured; CODEX_AUTH="${CODEX_AUTH#b64:}" ;;
    *) CODEX_STATE=unknown; CODEX_AUTH="" ;;
  esac
  if [ "$HERMES_STATE" = unknown ] || [ "$CODEX_STATE" = unknown ]; then
    if [ "$ACCEPT_UNVERIFIED" -eq 0 ]; then
      unset HERMES_AUTH CODEX_AUTH
      resume_live
      die "could not read the live credentials (hermes $HERMES_STATE, codex $CODEX_STATE) — nothing was rolled back. Rerun, or add --accept-unverified to restore anyway and leave the services whose credential could not be read stopped until you log in again"
    fi
    bad "could not read the live credentials (hermes $HERMES_STATE, codex $CODEX_STATE) — --accept-unverified: restoring anyway, and what needs them stays stopped"
  else
    ok "read live credentials into memory: hermes $HERMES_STATE, codex $CODEX_STATE"
  fi
fi

if ! pve "qm shutdown $VMID --timeout 120 || qm stop $VMID" >/dev/null 2>&1; then
  [ "$GUEST_ANSWERS" -eq 1 ] && resume_live
  die "could not stop VM $VMID — nothing was rolled back"
fi
ok "VM $VMID stopped"
pve "timeout 300 qm rollback $VMID $SNAP" || die "qm rollback failed — the VM is stopped; inspect with: qm listsnapshot $VMID"
ok "rolled back to $SNAP"
pve "qm set $VMID --net0 '$NET0_BASE,link_down=1'" >/dev/null || die "could not take the network link down — NOT starting the VM"
pve "qm start $VMID" || die "qm start failed (link is down: qm set $VMID --net0 '$NET0_BASE' restores it)"
for _ in $(seq 1 60); do agent_up && break; sleep 3; done
agent_up || die "the guest agent did not come back within 3 minutes — the VM is up with its link DOWN; console: qm terminal $VMID"
ok "VM booted from the snapshot, network link down"

# Everything that holds a rotating credential stays down until its credential is
# back: Hermes (its providers' OAuth) and the relay and interview sidecar (the
# interview's codex login). The link is still down, so nothing has refreshed yet.
guest 120 docker stop hermes kinerary-cp-relay-1 kinerary-cp-interview-mcp-1 >/dev/null \
  || die "could not stop Hermes, the relay and the interview sidecar — the VM is up with its network link DOWN, so nothing can refresh a token. Console: qm terminal $VMID"
ok "Hermes, the relay and the interview sidecar are stopped"

restore_file() {  # restore_file <path> <base64> — succeeds only if the VM then holds exactly these bytes
  local path="$1" data="$2" want got
  want="$(printf '%s' "$data" | python3 -c 'import base64, hashlib, sys; print(hashlib.sha256(base64.b64decode(sys.stdin.read())).hexdigest())')" || return 1
  printf '%s' "$data" | guest_stdin 30 sh -c "f=$path; base64 -d > \"\$f.carried\" && chown --reference=\"\$(dirname \"\$f\")\" \"\$f.carried\" && chmod 600 \"\$f.carried\" && mv \"\$f.carried\" \"\$f\"" >/dev/null || return 1
  got="$(guest 30 sha256sum "$path")" || return 1
  [ "${got%% *}" = "$want" ]
}

remove_file() {  # remove_file <path> — succeeds only if the VM then has no such file
  guest 30 sh -c 'rm -f "$1" && ! test -e "$1"' sh "$1" >/dev/null
}

# Each service starts only once its credential is exactly what the live VM had:
# the same bytes, or — where the live VM had none — none. Unknown is neither.
HERMES_OK=0
case "$HERMES_STATE" in
  captured)
    if restore_file "$HERMES_FILE" "$HERMES_AUTH"; then
      ok "Hermes credentials carried across (checked by hash inside the VM)"; HERMES_OK=1
    else
      bad "could not write Hermes credentials back — Hermes stays stopped"
    fi ;;
  absent)
    if remove_file "$HERMES_FILE"; then
      ok "the live VM had no Hermes credentials, so the snapshot's copy is removed"; HERMES_OK=1
    else
      bad "could not remove the snapshot's stale Hermes credentials — Hermes stays stopped"
    fi ;;
  *) bad "the live Hermes credentials were not read, so the snapshot's copy may be stale — Hermes stays stopped" ;;
esac
CODEX_OK=0
case "$CODEX_STATE" in
  captured)
    if restore_file "$CODEX_FILE" "$CODEX_AUTH"; then
      ok "interview codex login carried across (checked by hash inside the VM)"; CODEX_OK=1
    else
      bad "could not write the interview's codex login back — the relay and interview sidecar stay stopped"
    fi ;;
  absent)
    if remove_file "$CODEX_FILE"; then
      ok "the live VM had no codex login, so the snapshot's copy is removed"; CODEX_OK=1
    else
      bad "could not remove the snapshot's stale codex login — the relay and interview sidecar stay stopped"
    fi ;;
  *) bad "the live codex login was not read, so the snapshot's copy may be stale — the relay and interview sidecar stay stopped" ;;
esac
unset HERMES_AUTH CODEX_AUTH

pve "qm set $VMID --net0 '$NET0_BASE'" >/dev/null || die "could not bring the network link back up: qm set $VMID --net0 '$NET0_BASE'"
ok "network link up"
sleep 5
if [ "$CODEX_OK" -eq 1 ]; then
  guest 180 docker start kinerary-cp-relay-1 kinerary-cp-interview-mcp-1 >/dev/null \
    && ok "relay and interview sidecar started" || bad "starting the relay and interview sidecar failed"
fi
if [ "$HERMES_OK" -eq 1 ]; then
  if guest 180 docker start hermes >/dev/null; then
    ok "Hermes started"
    echo
    echo "── Trip bridges, companions, verify (inside the VM) ──"
    guest 900 /usr/local/sbin/kinerary-cp-release restart-bridges || bad "restart-bridges reported problems"
  else
    bad "docker start hermes failed"
  fi
fi
if [ "$HERMES_OK" -eq 0 ] || [ "$CODEX_OK" -eq 0 ]; then
  echo
  note "Some services stay STOPPED: starting them on the snapshot's credentials would lock the accounts."
  echo "  Log in again inside the VM, then start what stayed down and repair the trips:"
  [ "$HERMES_OK" -eq 1 ] || echo "    sudo docker exec -it hermes hermes auth add openai-codex   (and the other providers, runbook: Credentials)"
  [ "$CODEX_OK" -eq 1 ] || echo "    /opt/kinerary/control-plane/deployment/vm-interview-runner.sh login codex"
  [ "$CODEX_OK" -eq 1 ] || echo "    sudo docker start kinerary-cp-relay-1 kinerary-cp-interview-mcp-1"
  [ "$HERMES_OK" -eq 1 ] || echo "    sudo docker start hermes && sudo kinerary-cp-release restart-bridges"
fi
echo
echo "Restored VM $VMID to $SNAP."
exit $(( PROBLEMS > 0 ))
