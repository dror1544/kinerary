#!/usr/bin/env bash
# vm-whatsapp-pair.sh — link the WhatsApp bridge to the bot's phone, or unlink it.
#
#   sudo KINERARY_PROVISIONING_ENV=<provisioning.env> KINERARY_VM_ENV=<vm.env> \
#     control-plane/deployment/vm-whatsapp-pair.sh [pair]     # show a QR; scan it in WhatsApp > Linked devices
#   ... vm-whatsapp-pair.sh unlink                            # forget the session on this VM
#
# Needs an interactive terminal (the QR is drawn in it). The env files' paths are given, never
# assumed: they name this deployment, and this script ships in a repository that does not.
#
# pair   Refuses unless WhatsApp is switched on in vm.env (WHATSAPP_BRIDGE_ENABLED=1, and this
#        checkout carries compose.vm.whatsapp.yml) and WHATSAPP_SESSION_DIR is a host directory
#        outside every git checkout. Stops the serving bridge if it is running (two processes
#        on one session would log each other out), runs the bridge image once with --pair-only
#        against that directory, and starts the serving bridge again afterwards — also when the
#        pairing failed, if it was running before, so a failed attempt leaves things as it found
#        them. Nothing here touches the relay, Telegram or any trip.
# unlink Stops and removes the bridge container and empties the session directory. It cannot sign
#        the device out on WhatsApp's side (the bridge has no logout command, on purpose: logging
#        out is how a number gets flagged): remove the device on the phone first, under
#        Settings > Linked devices. A session deleted here but still listed there is harmless
#        but untidy.
#
# The number the bridge links to must be a DEDICATED one with an empty address book: pairing hands
# the linked device the phone's address book and history-sync notices, and the session directory
# holds the library's per-participant key files.
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROVISIONING_ENV="${KINERARY_PROVISIONING_ENV:?set KINERARY_PROVISIONING_ENV to the provisioning.env of this VM}"
VM_ENV="${KINERARY_VM_ENV:?set KINERARY_VM_ENV to the vm.env of this VM}"
SERVICE=whatsapp-bridge

die() { printf 'vm-whatsapp-pair: %s\n' "$1" >&2; exit 1; }

ACTION="${1:-pair}"
case "$ACTION" in pair|unlink) ;; *) echo "usage: $0 [pair|unlink]" >&2; exit 2 ;; esac

# The same file set the release tool uses; without the overlay there is no bridge service at all.
. "$DIR/vm-compose-files.sh"
vm_compose_files_init "$DIR" "$PROVISIONING_ENV" "$VM_ENV" || die "cannot read the env files"
[ "${#VM_COMPOSE_FILES[@]}" -gt 2 ] || die "WhatsApp is not switched on: set WHATSAPP_BRIDGE_ENABLED=1 in vm.env (and run a version that carries compose.vm.whatsapp.yml)"
compose() { sudo docker compose "${VM_COMPOSE_FILES[@]}" --env-file "$PROVISIONING_ENV" --env-file "$VM_ENV" "$@"; }

SESSION="$(vm_compose_env_value WHATSAPP_SESSION_DIR "$PROVISIONING_ENV" "$VM_ENV")" || die "cannot read the env files"
[ -n "$SESSION" ] || die "WHATSAPP_SESSION_DIR is not set in vm.env"
case "$SESSION" in /*) ;; *) die "WHATSAPP_SESSION_DIR must be an absolute host path" ;; esac
[ "$SESSION" != "/" ] || die "WHATSAPP_SESSION_DIR must not be /"
[ -d "$SESSION" ] || die "$SESSION does not exist: create it first (mode 0700, owned by uid 1000, the user the bridge runs as)"

# The bridge refuses a session inside a git work tree, but inside its container it only sees
# /session, so this is the check that can see the host path. A credential in a checkout is
# how it ends up in a commit.
probe="$(cd "$SESSION" && pwd -P)"
while :; do
  [ ! -e "$probe/.git" ] || die "$SESSION is inside a git work tree ($probe): the session is a credential and must live outside every checkout"
  [ "$probe" != "/" ] || break
  probe="$(dirname "$probe")"
done

running() { [ -n "$(compose ps --status running -q "$SERVICE" 2>/dev/null)" ]; }

if [ "$ACTION" = unlink ]; then
  printf 'This forgets the WhatsApp session in %s and removes the bridge container.\n' "$SESSION"
  printf 'Remove the device on the phone first (Settings > Linked devices). Type "unlink" to go on: '
  read -r answer
  [ "$answer" = unlink ] || die "not confirmed; nothing was changed"
  compose rm -sf "$SERVICE" >/dev/null 2>&1 || true
  sudo find "$SESSION" -mindepth 1 -delete
  echo "unlinked: the session directory is empty and the bridge is removed. Telegram is untouched."
  echo "To turn WhatsApp off for good: switch the feature off, remove the relay.whatsapp block from the profile and"
  echo "WHATSAPP_BRIDGE_ENABLED from vm.env, then restart the relay (docs/control-plane-vm-deployment.md, \"WhatsApp\")."
  exit 0
fi

[ -t 0 ] && [ -t 1 ] || die "pairing draws a QR code: run it from an interactive terminal"

was_running=0
if running; then
  was_running=1
  echo "stopping the serving bridge (WhatsApp pauses; Telegram is untouched)..."
  compose stop "$SERVICE" >/dev/null
fi

restore() {
  # Whatever the pairing did, a bridge that was serving is serving again; after a first successful
  # pairing it is started for the first time.
  if [ "$1" = ok ] || [ "$was_running" -eq 1 ]; then
    if compose up -d --no-deps "$SERVICE" >/dev/null; then
      echo "the bridge is started."
    else
      echo "could not start the bridge: docker compose up -d --no-deps $SERVICE (with the same -f files)" >&2
    fi
  fi
}

# One container, one pass: --rm leaves nothing behind but the session directory.
if compose run --rm --no-deps "$SERVICE" --session /session --pair-only; then
  restore ok
  cat <<'NEXT'

Paired. Next:
  - If the relay was already running when you paired, it keeps trying the bridge and reports
    whatsapp.bridge_state connected within a minute, with no restart.
  - If the relay logged relay.whatsapp_disabled or relay.whatsapp configured:false, it was started
    without the block or the secrets: restart it with vm-relay-restart.sh, or let the next
    kinerary-cp-release upgrade do it.
  - Check: kinerary-cp-release verify (it prints the bridge's state, never the number).
NEXT
else
  restore failed
  die "pairing did not complete (a bridge that was serving has been started again); run it again when the phone is ready"
fi
