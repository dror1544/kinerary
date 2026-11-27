#!/bin/bash -p
# Run one trip site as a Docker container on this host, from one JSON request on stdin.
#
# THIS IS A TRUST BOUNDARY. It is the forced command for a dedicated SSH key
# used by the provisioning worker, and what it can do (start containers) is
# root-equivalent on this host. It is written on the assumption that everything
# arriving from the other side, and everything on the document store, is
# untrusted. Spec: docs/specs/sprint-9/x-trip-vm-container-placement.md
# (AC-4, AC-5).
#
#   - `$SSH_ORIGINAL_COMMAND` is IGNORED, deliberately and completely. No
#     command-line arguments are accepted. PATH is replaced, not appended to;
#     docker is run by absolute path; every subprocess gets an environment
#     this script builds (no DOCKER_*, nothing of the caller's, not its HOME).
#   - Host configuration is NOT read from the environment. It comes from one
#     root-owned file (below); the script runs as root through sudo, whose
#     env_reset leaves a caller nothing to inject.
#   - The request is ONE JSON object, at most 64 KiB, with exactly the fields
#     its verb allows. An unknown verb, an unknown or foreign field, a
#     duplicate key, a slug or trip id that fails its pattern: refused, nothing
#     changed, exit 2, one JSON answer line `{"ok":false,"error":"refused",...}`.
#     Exit 1 is "the request was fine and the work failed"; 0 is success.
#   - Every `docker` argument is built here from validated values. No request
#     value is passed through; none is ever a flag, a path, an image reference
#     or a command. The trip's directory is derived from the trip id and the
#     configured document-store root, never from a request path.
#   - THE SCRIPT NEVER BUILDS AN IMAGE. `trip-site:<64 hex>` is built by the
#     release tooling (vm-release) from a sealed tree. A request naming an image
#     the host does not have is refused.
#   - A container is touched only if it carries `kinerary.trip_id=<the request's
#     trip id>` and `kinerary.slug=<its slug>`. A different or absent label
#     under the same name is refused, and so is the trip id's label on a
#     container with another name. After every `docker run` and `docker start`
#     the container's mounts are read back: exactly one read-write bind, the
#     trip's mount point (below), at /trip-store; anything else removes or stops
#     the container and fails.
#   - THE DOCUMENT STORE IS UNTRUSTED (the worker writes it; the export does not
#     squash root). Every component under the store root is opened with
#     O_NOFOLLOW, every file is checked regular before it is read (and opened
#     O_NONBLOCK, so a FIFO cannot hang it), and TRIP.txt must carry
#     `trip_id:` and `slug:` lines equal to the request's. This does not stop
#     the worker swapping the store root's top level itself: the deployment
#     must keep that part of the export from being replaceable by the worker
#     (the worker should mount only what it needs, PR4).
#   - THE DAEMON IS NEVER GIVEN A PATH ON THE STORE. The daemon re-resolves a
#     bind-mount source on every start (restart policy and reboot included), so
#     a path the worker can rename or re-point would redirect a restart. The
#     trip's directory is therefore bind-mounted, by open descriptor
#     (`mount --no-canonicalize --bind /proc/self/fd/N`), onto a root-owned empty
#     directory <TRIP_CONTAINER_MOUNT_ROOT>/<trip id>, and `docker run` gets
#     that path. A bind binds the directory itself: a later rename or swap of
#     the store entry does not move it. ensure, deploy, start and check redo the
#     walk and the TRIP.txt check, and if the mount point is already bound to a
#     DIFFERENT directory they refuse; they never mount over it. After every
#     run and every start the container's mounts are read back.
#   - One mutating request at a time (an exclusive host-wide flock; check counts,
#     because it may re-establish the bind), and every request has a deadline:
#     it cannot hang the host. A deadline that fires half-way removes what was
#     just made, and restores the previous container, under a short deadline
#     of its own.
#   - Secrets: JWT_SECRET and HERMES_API_KEY are generated here from
#     /dev/urandom; the other `.env` values arrive on stdin. None is ever on an
#     argv, in a log line or in an answer, except the fields `read` is asked
#     for by name. The container reads its `.env` from the mounted directory;
#     docker is never given an env file or `-e`.
#
# THE SEVEN VERBS (the request is {"record_type":"trip_container_request",
# "verb":...,"trip_id":...,"slug":...} plus the fields below):
#
#   ensure   ip, image [, seed_password, exchange_key, hermes_url, public_origin,
#            trip_mcp_enabled]   create the network if absent, the trip's
#            directory layout, TRIP.txt, `.env` (only if absent, never
#            rewritten), then run the container (or start it if it exists).
#   deploy   ip, image           recreate the container on another image digest;
#            the old container is set aside and put back if the new one fails.
#            The answer carries `previous_image`.
#   start / stop / remove / check          no further fields. `remove` removes
#            the container(s), unmounts the bind and removes the empty mount
#            point; the store directory is kept. `check` curls /api/health
#            from inside.
#   read     fields [, exchange_key_candidates, bridge_url]   returns ONLY the
#            named fields: seed_password, exchange_key_kind (which candidate
#            the site holds: "shared" or "derived", never the key),
#            site_to_bridge (proved from inside the container).
#
# HOST CONFIGURATION: /etc/kinerary/trip-container-host.conf, owned by root,
# not writable by group or others, in a directory the same is true of; anything
# else is refused. `KEY=value` lines, `#` comments, no repeats, no other keys:
#   TRIP_CONTAINER_NETWORK   the Docker network trips run on (created if absent)
#   TRIP_CONTAINER_SUBNET    its IPv4 subnet, private, /16../28; refused if it
#                            overlaps an existing network
#   TRIP_CONTAINER_UID       the fixed non-root uid in the container (default
#                            10001 when the line is absent; 0 or empty refused).
#                            Never the uid of the ssh user (SUDO_UID).
#   TRIP_CONTAINER_MEMORY    the memory limit, e.g. 512m
#   TRIP_CONTAINER_MOUNT_ROOT  a directory (refused when its filesystem is NFS; other
#                            network filesystems are not detected) that root
#                            owns, 0755 or tighter, reached through directories
#                            root owns and nobody else can write, and that is its
#                            own canonical path. Holds one empty mount point per
#                            trip. Created by the host, not here.
#   KINERARY_NFS_ROOT        the document store; each trip is <root>/<trip id>.
#                            The root itself is never created here (a MISSING
#                            root refuses). An existing but unmounted, empty
#                            mount point cannot be told from a real store: the
#                            image's entrypoint (no TRIP.txt/.env, no start) and
#                            the boot ordering are what cover that.
#   TRIP_CONTAINER_LOCK_FILE the flock file (default /run/trip-container-host.lock)
#   TRIP_CONTAINER_TIMEOUT   seconds a request may take, 1..600 (default 120)
#   TRIP_CONTAINER_BRIDGE_URL the one shared-bridge origin a site may be pointed at. A
#                            request's hermes_url / bridge_url must equal it (a site
#                            sends its host-generated bridge key to whatever HERMES_URL
#                            its .env names); with none configured they are refused.
#   TRIP_CONTAINER_DOCKER    /usr/bin/docker or /usr/local/bin/docker only
#                            (default: the first that exists)
#
# INSTALL (a person does this once, as root, on the control-plane host). One
# shape only:
#   1. A user of its own, with shell /bin/sh, no password, not in the docker
#      group, whose key is used for nothing else. Its uid is NOT
#      TRIP_CONTAINER_UID.
#   2. This script and trip-container-host.py side by side, owned by root and
#      not writable by anyone else; the configuration file above.
#   3. /etc/sudoers.d: `<user> ALL=(root) NOPASSWD: <path to>/trip-container-host.sh ""`
#      (the empty argument list: no arguments are allowed) with the defaults
#      left at env_reset, NO env_keep for this user, and a secure_path. (The
#      script is the only thing the user can run as root.)
#   4. In that user's authorized_keys, one line:
#        restrict,command="sudo -n <path to>/trip-container-host.sh" ssh-ed25519 AAAA...
#      `restrict` turns off forwarding, a pty and agent use; `command=` makes
#      whatever the caller types irrelevant.
#   5. Boot. The binds do not survive a reboot, and docker's restart policy may
#      start a container before they exist; its mount point is then an empty
#      root-owned directory, so the image's entrypoint refuses (no TRIP.txt) and
#      the restart policy keeps retrying. A root systemd unit, ordered after the
#      document store is mounted, puts the binds back (not installed by this
#      repository; deployment writes it):
#        [Unit]
#        Description=Re-establish trip store binds
#        RequiresMountsFor=<the document store> <the mount root>
#        After=docker.service
#        [Service]
#        Type=oneshot
#        ExecStart=<path to>/trip-container-host.sh --boot
#        [Install]
#        WantedBy=multi-user.target
#      `--boot` is the one argument this script takes. ssh cannot pass it (the
#      forced command is fixed) and sudo is refused for it. It redoes the walk
#      and identity check for every container carrying our labels, binds what
#      passes, reports the rest and exits non-zero if any failed.
#   6. The trip image (control-plane/deployment, built by vm-release) must put
#      `.env` at /trip-store/.env, carry curl, answer /api/health on port 8080,
#      and refuse to start without TRIP.txt and .env.
# The worker's side of the key (its private half, the known_hosts pin) lives
# in the deployment, never in this repository.

set -u

refuse() {
  printf '{"ok":false,"error":"refused","reason":"%s"}\n' "$1"
  printf 'trip-container-host: refused: %s\n' "$1" >&2
  exit 2
}

unset BASH_ENV ENV
# One argument is ever accepted: --boot, from the root boot unit (below). ssh cannot supply it (command= fixes the
# command line), and sudo is refused for it, so the worker's key can never ask for it.
boot=""
if [ "$#" -eq 1 ] && [ "$1" = "--boot" ] && [ -z "${SUDO_UID-}" ]; then
  boot="--boot"
elif [ "$#" -ne 0 ]; then
  refuse "no arguments are accepted"
fi
unset SSH_ORIGINAL_COMMAND

# Replaced, not appended to: nothing the caller's PATH names is searched, and
# the working directory is not on it. (bash reads BASH_ENV/ENV before the first
# line runs; the `-p` on the first line stops that, and sudo's env_reset removes
# them before bash starts at all.)
PATH=/usr/bin:/bin
export PATH

HERE="$(cd "$(dirname "$0")" && pwd -P)" || refuse "cannot locate the script"
IMPL="$HERE/trip-container-host.py"
[ -f "$IMPL" ] || refuse "trip-container-host.py is not next to the script"
[ -x /usr/bin/python3 ] || refuse "/usr/bin/python3 is not installed"

# The request stays on stdin, inherited, and is read by one python process: no
# bash variable, no argument, no temp file ever holds it. The environment is
# rebuilt from nothing (`env -i`): only what sudo says about the invoking user
# (so the container uid can be refused if it is that user's own) and, honoured
# by the python ONLY when it is not root, the path of a configuration file to
# test with. -I: no PYTHON* variables, no user site, no script directory on the
# import path.
keep=()
[ -z "${SUDO_UID-}" ] || keep+=("SUDO_UID=$SUDO_UID")
[ -z "${TRIP_CONTAINER_HOST_CONFIG-}" ] || keep+=("TRIP_CONTAINER_HOST_CONFIG=$TRIP_CONTAINER_HOST_CONFIG")
exec /usr/bin/env -i PATH=/usr/bin:/bin ${keep[@]+"${keep[@]}"} /usr/bin/python3 -I "$IMPL" ${boot:+--boot}
