#!/usr/bin/env bash
# scripts/hermes-pipeline/02-setup-ssh-access.sh
#
# Generates a dedicated ed25519 keypair for talking to the Hermes host, and
# installs the public key there. Interactive: ssh-copy-id will prompt for the
# account password on the Hermes host ONE time; that's expected since there's
# no access to bootstrap from yet. Idempotent after that — re-running with a
# working key is a harmless no-op.

set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=config.sh
. "$HERE/config.sh"
# shellcheck source=lib.sh
. "$HERE/lib.sh"

info "Target: ${HERMES_SSH_USER}@${HERMES_HOST}"

if ! nc -z -w3 "$HERMES_HOST" 22 2>/dev/null; then
  die "Port 22 not reachable on ${HERMES_HOST}. Is Remote Login (System Settings > General > Sharing > Remote Login) enabled on that Mac?"
fi
ok "SSH port reachable on ${HERMES_HOST}"

if [ -f "$HERMES_SSH_KEY" ]; then
  info "Keypair already exists at ${HERMES_SSH_KEY}, reusing it"
else
  mkdir -p "$(dirname "$HERMES_SSH_KEY")"
  ssh-keygen -t ed25519 -f "$HERMES_SSH_KEY" -N "" -C "kinerary-hermes-pipeline"
  ok "Generated keypair: ${HERMES_SSH_KEY}"
fi

# Already installed? (idempotent re-run check)
if ssh -o BatchMode=yes -o ConnectTimeout=5 -i "$HERMES_SSH_KEY" \
     "${HERMES_SSH_USER}@${HERMES_HOST}" 'true' 2>/dev/null; then
  ok "Key-based login already works — nothing to do."
  exit 0
fi

echo
info "Public key:"
cat "${HERMES_SSH_KEY}.pub"
echo
info "About to run ssh-copy-id — you'll be asked for ${HERMES_SSH_USER}'s password on ${HERMES_HOST} ONE time."
confirm "Proceed?" || die "Aborted. You can also add the key above to ~/.ssh/authorized_keys on ${HERMES_HOST} by hand."

ssh-copy-id -i "${HERMES_SSH_KEY}.pub" "${HERMES_SSH_USER}@${HERMES_HOST}"

if ssh -o BatchMode=yes -o ConnectTimeout=5 -i "$HERMES_SSH_KEY" \
     "${HERMES_SSH_USER}@${HERMES_HOST}" 'true' 2>/dev/null; then
  ok "Key-based login to ${HERMES_HOST} confirmed working."
else
  die "ssh-copy-id ran but key-based login still fails — check ${HERMES_HOST}'s sshd_config (PubkeyAuthentication) and try again."
fi

info "Next: scripts/hermes-pipeline/run.sh will use this key for phase 3."
