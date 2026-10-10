#!/bin/sh
# vm-invite-gate.sh — the forced command for the fleet monitor's invitation key.
#
# Installed as /usr/local/sbin/kinerary-invite-gate and pinned in
# ~cpinvite/.ssh/authorized_keys:
#
#   restrict,command="/usr/local/sbin/kinerary-invite-gate" ssh-ed25519 AAAA… trip-monitor
#
# Whatever the client asked to run arrives in SSH_ORIGINAL_COMMAND and is never
# given to a shell. This splits it on spaces, refuses any token outside
# [A-Za-z0-9._:@+-] — so no quoting, globbing, redirection or substitution can
# survive — and hands the tokens as argv to the one command sudoers allows:
#
#   cpinvite ALL=(root) NOPASSWD: /usr/local/sbin/kinerary-invite gate *
#
# Which verbs exist and what each one accepts is decided in kinerary-invite
# itself (parse_gate), not here: one place, and the same one a person at the
# VM's terminal goes through.
#
# The charset is this repo's release gate's plus '@', because an address is the
# argument this tool takes. Nothing reaches a shell, so the extra character
# costs nothing.
set -eu

TOOL="${KINERARY_INVITE_TOOL:-/usr/local/sbin/kinerary-invite}"
SUDO="${KINERARY_INVITE_SUDO:-sudo}"

command_line="${SSH_ORIGINAL_COMMAND:-}"
if [ -z "$command_line" ]; then
  echo "refused: no command — try: help"
  exit 2
fi
if [ "${#command_line}" -gt 512 ]; then
  echo "refused: command too long"
  exit 2
fi

set -f  # no globbing while splitting
# shellcheck disable=SC2086  # splitting on spaces is the point
set -- $command_line
set +f
[ "$#" -le 8 ] || { echo "refused: too many arguments"; exit 2; }

for token in "$@"; do
  case "$token" in
    *[!A-Za-z0-9._:@+-]*|'') echo "refused: token contains a character outside A-Z a-z 0-9 . _ : @ + -"; exit 2 ;;
  esac
  [ "${#token}" -le 120 ] || { echo "refused: token longer than 120 characters"; exit 2; }
done

exec "$SUDO" -n "$TOOL" gate "$@"
