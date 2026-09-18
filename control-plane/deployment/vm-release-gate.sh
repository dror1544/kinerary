#!/bin/sh
# vm-release-gate.sh — the forced command for trip-monitor's release key.
#
# Installed as /usr/local/sbin/kinerary-cp-release-gate and pinned in
# ~cprelease/.ssh/authorized_keys:
#
#   restrict,command="/usr/local/sbin/kinerary-cp-release-gate" ssh-ed25519 AAAA… trip-monitor
#
# Whatever the client asked to run arrives in SSH_ORIGINAL_COMMAND and is never
# given to a shell. This splits it on spaces, refuses any token outside
# [A-Za-z0-9._:-] — so no quoting, globbing, redirection or substitution can
# survive — and hands the tokens as argv to the one command sudoers allows:
#
#   cprelease ALL=(root) NOPASSWD: /usr/local/sbin/kinerary-cp-release gate *
#
# Which verbs exist, which flags are a person's, and what needs Dror's code are
# decided in kinerary-cp-release itself (parse_gate), not here: one place.
set -eu

TOOL="${KINERARY_CP_RELEASE_TOOL:-/usr/local/sbin/kinerary-cp-release}"
SUDO="${KINERARY_CP_RELEASE_SUDO:-sudo}"

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
[ "$#" -le 12 ] || { echo "refused: too many arguments"; exit 2; }

for token in "$@"; do
  case "$token" in
    *[!A-Za-z0-9._:-]*|'') echo "refused: token contains a character outside A-Z a-z 0-9 . _ : -"; exit 2 ;;
  esac
  [ "${#token}" -le 64 ] || { echo "refused: token longer than 64 characters"; exit 2; }
done

exec "$SUDO" -n "$TOOL" gate "$@"
