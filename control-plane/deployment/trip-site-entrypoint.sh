#!/bin/bash
# The trip-site container's entrypoint: one trip's site, state on a mounted directory.
#
# The image carries only code (server/, site/, shared/). Everything the trip owns sits in
# the mounted directory, /trip-store: `.env`, `trip/`, `server-data/`, `documents/`,
# `media/` and `TRIP.txt` (the marker the worker writes when it creates the directory).
#
# It refuses to start, with nothing listening, unless TRIP.txt and .env are both there
# (spec x-trip-vm-container-placement, AC-6). A host that boots before the document store
# mounts, or mounts it late, would otherwise serve an empty site on a fresh database; as
# it is, the container exits non-zero and `restart: unless-stopped` retries until the mount
# is there.
#
# nginx (:8080) and node (:3000) both run here, as the uid the container was started with.
# Either dying ends the container, and the restart policy brings both back.
set -uo pipefail

STORE="${TRIP_STORE_DIR:-/trip-store}"
# Where the image put server/, site/ and shared/ (the Dockerfile sets it; there is no default here).
APP_DIR="${APP_DIR:-}"
NGINX_MAIN_CONF="${NGINX_MAIN_CONF:-/etc/nginx/trip-site-nginx-main.conf}"

die() {
  echo "trip-site: $*" >&2
  exit 1
}

[ -n "$APP_DIR" ] || die "APP_DIR is not set"
[ -d "$STORE" ] || die "refusing to start: $STORE is not mounted"
[ -f "$STORE/TRIP.txt" ] || die "refusing to start: $STORE/TRIP.txt is missing (the trip directory is not mounted, or not yet)"
[ -f "$STORE/.env" ] || die "refusing to start: $STORE/.env is missing"

# .env is read as data, never executed: it is a file the site itself rewrites
# (TELEGRAM_CHAT_ID), and a shell `source` would run anything in it. KEY=VALUE lines only,
# one pair of surrounding quotes stripped, as systemd's EnvironmentFile= does for an LXC.
while IFS= read -r line || [ -n "$line" ]; do
  line="${line%$'\r'}"
  case "$line" in
    ''|'#'*|';'*) continue ;;
  esac
  key="${line%%=*}"
  [ "$key" != "$line" ] || continue
  [[ "$key" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]] || continue
  case "$key" in
    PATH|HOME|LD_*|BASH_ENV|ENV|IFS|SHELL) echo "trip-site: ignoring $key in .env" >&2; continue ;;
  esac
  value="${line#*=}"
  if [[ "$value" =~ ^\"(.*)\"$ ]] || [[ "$value" =~ ^\'(.*)\'$ ]]; then
    value="${BASH_REMATCH[1]}"
  fi
  export "$key=$value"
done < "$STORE/.env"

# The paths are the container's, whatever .env says (an LXC's .env names its own filesystem).
export TRIP_DIR="$STORE/trip"
export DATA_DIR="$STORE/server-data"
export TRIP_DOCUMENTS_DIR="$STORE/documents"
export ENV_FILE_PATH="$STORE/.env"
export AVATARS_DIR="$STORE/media/avatars"
export PORT=3000
export HOME=/tmp

mkdir -p "$DATA_DIR" "$TRIP_DOCUMENTS_DIR" "$AVATARS_DIR" /tmp/nginx-body /tmp/nginx-proxy \
  || die "cannot create the trip's directories under $STORE (is it writable by uid $(id -u)?)"

# site/avatars -> the trip's media/avatars, as the LXC bootstrap links it. The image is read-only
# to this uid, so the link is made at build time; this only confirms it points at the right place.
if [ "$(readlink "$APP_DIR/site/avatars" 2>/dev/null || true)" != "$AVATARS_DIR" ]; then
  ln -sfn "$AVATARS_DIR" "$APP_DIR/site/avatars" 2>/dev/null \
    || die "$APP_DIR/site/avatars does not point at $AVATARS_DIR and cannot be relinked"
fi

NODE_PID=""
NGINX_PID=""

stop_children() {
  [ -z "$NODE_PID" ] || kill "$NODE_PID" 2>/dev/null
  [ -z "$NGINX_PID" ] || kill "$NGINX_PID" 2>/dev/null
  wait 2>/dev/null
}

on_signal() {
  stop_children
  exit 0
}
trap on_signal TERM INT

(cd "$APP_DIR/server" && exec node server.js) &
NODE_PID=$!
# -e: before it reads the config nginx opens its compiled-in error log, which this uid cannot write.
nginx -e /dev/stderr -c "$NGINX_MAIN_CONF" -g 'daemon off;' &
NGINX_PID=$!

# Whichever ends first ends the container, with a status that says it was not asked to.
# Polled rather than `wait -n`, which needs bash 4.3: bash reaps a child the moment it exits,
# so `kill -0` is false for a dead one, and the sleep-then-wait keeps a signal prompt.
while kill -0 "$NODE_PID" 2>/dev/null && kill -0 "$NGINX_PID" 2>/dev/null; do
  sleep 0.5 &
  wait $!
done
if kill -0 "$NODE_PID" 2>/dev/null; then
  who=nginx
  wait "$NGINX_PID"
  status=$?
  NGINX_PID=""
else
  who=node
  wait "$NODE_PID"
  status=$?
  NODE_PID=""
fi
echo "trip-site: $who exited (status $status); stopping the container" >&2
stop_children
[ "$status" -ne 0 ] || status=1
exit "$status"
