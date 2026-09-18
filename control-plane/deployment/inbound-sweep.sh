#!/bin/sh
# Deletes files people sent on Telegram once they are old enough to be done with.
#
# The hand-off folder is where Hermes saves a file the relay re-hosted
# (HERMES_RELAY_MEDIA_DIR), and where a trip's mcp.js — on the host, at the SAME path — reads it
# to upload onto the trip site. The site keeps its own copy on the trip's NFS
# folder, attached to its booking or album, so the hand-off copy is only ever
# needed for the turn that used it. Hermes itself never deletes these: before
# this, every document a family sent sat in the container's /tmp until the
# container was recreated.
#
# Only `relay_media_*` files, only at the top level, only on this filesystem.
# Nothing else should be here — the folder is named for received media alone,
# not as the runtime's TMPDIR — and if something else turns up, deleting it is
# not this script's call to make.
#
# Usage: inbound-sweep.sh <dir> [max-age-minutes, default 1440]
# POSIX sh on purpose: it runs in an Alpine (busybox) container.
set -eu

dir="${1:?usage: inbound-sweep.sh <dir> [max-age-minutes]}"
age="${2:-1440}"

case "$age" in
  '' | *[!0-9]*) echo "inbound-sweep: max age must be whole minutes, got '$age'" >&2; exit 2 ;;
esac
[ -d "$dir" ] || { echo "inbound-sweep: no such directory: $dir" >&2; exit 2; }

find "$dir" -xdev -maxdepth 1 -type f -name 'relay_media_*' -mmin "+$age" -exec rm -f {} +
