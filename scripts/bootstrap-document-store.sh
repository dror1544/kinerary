#!/usr/bin/env bash
# scripts/bootstrap-document-store.sh — make a host satisfy the document-store
# contract: NFS client present, the export mounted, the mount surviving reboot,
# the marker written once on the real volume, and the directory actually
# writable by the service that will use it.
#
# GENERIC ON PURPOSE. Nothing here knows a hostname, an export path, a mount
# point, a uid or a deployment. Those are operator concerns and live in
# kinerary-deploy; this is the mechanism and the values come from the
# environment. It REFUSES rather than defaulting to somebody's machine —
# see scripts/bootstrap-fleet-monitor.sh, which follows the same rule.
#
# WHY THIS EXISTS AT ALL — the structural fact worth keeping:
#
#   A trip's site is an LXC container. Proxmox mounts the TrueNAS export once
#   on the HOST, and each trip container receives it as an `mp0` mountpoint,
#   so a trip inherits document storage without doing anything.
#
#   The control plane is a full VM. A VM inherits nothing from the Proxmox
#   host's mount table, so it needs its OWN NFS client mount of the same
#   export. That is not a misconfiguration to repair once; it is a different
#   class of guest, and every future control-plane VM will need this script.
#
#   docs/control-plane-vm-deployment.md carries the same fact in prose.
#
#   usage:
#     DOCUMENT_STORE_NFS_SOURCE=<host>:/<export> \
#     DOCUMENT_STORE_MOUNT=/srv/kinerary-nfs \
#     sudo -E scripts/bootstrap-document-store.sh
#
# Idempotent: an installed package, an existing fstab line, an active mount and
# an existing marker are all left alone. Re-run it after rebuilding a host
# rather than remembering the steps. `--check` changes nothing and reports.
#
# | variable | required | what |
# |---|---|---|
# | `DOCUMENT_STORE_NFS_SOURCE`  | yes | `<host>:/<export>`, the SAME export the Proxmox host mounts |
# | `DOCUMENT_STORE_MOUNT`       | yes | absolute path to mount it at ON THIS HOST |
# | `DOCUMENT_STORE_ROOT`        | no  | what KINERARY_NFS_ROOT must become (default: the mount) |
# | `DOCUMENT_STORE_MOUNT_OPTS`  | no  | fstab options (default: a conservative NFS set) |
# | `DOCUMENT_STORE_OWNER`       | no  | `uid:gid` the store must be writable by; checked, not chowned blindly |
# | `DOCUMENT_STORE_ENV_FILE`    | no  | env file to set KINERARY_NFS_ROOT in; absent = report only |
#
# Exit codes: 0 satisfied · 1 refused (bad input, or a check failed) · 2 usage.

set -euo pipefail

MARKER=".kinerary-document-store"   # must equal DOCUMENT_STORE_MARKER in
                                    # control_plane_worker/document_handoff.py
                                    # and document-store.ts. tests/scripts/
                                    # test_bootstrap_document_store.py asserts it.

MODE="apply"
case "${1:-}" in
  --check)   MODE="check" ;;
  --dry-run) MODE="dry-run" ;;
  "")        ;;
  *) echo "usage: $0 [--check|--dry-run]" >&2; exit 2 ;;
esac

say()  { printf '  %s\n' "$*"; }
ok()   { printf '  ok      %s\n' "$*"; }
step() { printf '  %s %s\n' "$([ "$MODE" = apply ] && echo 'did    ' || echo 'would  ')" "$*"; }
die()  { printf 'refused: %s\n' "$*" >&2; exit 1; }

need() {
  local name="$1"
  local value="${!name-}"
  [ -n "$value" ] || die "$name is not set — this script never guesses infrastructure. See the table in its header."
  printf '%s' "$value"
}

# ── inputs ───────────────────────────────────────────────────────────────────
SOURCE="$(need DOCUMENT_STORE_NFS_SOURCE)"
MOUNT="$(need DOCUMENT_STORE_MOUNT)"
ROOT="${DOCUMENT_STORE_ROOT:-$MOUNT}"
OPTS="${DOCUMENT_STORE_MOUNT_OPTS:-rw,hard,nfsvers=4.1,_netdev,noatime}"
OWNER="${DOCUMENT_STORE_OWNER:-}"
ENV_FILE="${DOCUMENT_STORE_ENV_FILE:-}"

case "$SOURCE" in
  *:/*) ;;
  *) die "DOCUMENT_STORE_NFS_SOURCE must look like <host>:/<export>, got '$SOURCE'" ;;
esac
case "$MOUNT" in /*) ;; *) die "DOCUMENT_STORE_MOUNT must be absolute, got '$MOUNT'" ;; esac
case "$ROOT"  in /*) ;; *) die "DOCUMENT_STORE_ROOT must be absolute, got '$ROOT'" ;; esac
case "$ROOT"  in "$MOUNT"|"$MOUNT"/*) ;; *) die "DOCUMENT_STORE_ROOT ($ROOT) must live under the mount ($MOUNT)" ;; esac

printf '\nDocument store — %s\n' "$MODE"
say "source  $SOURCE"
say "mount   $MOUNT"
say "root    $ROOT"

[ "$MODE" = apply ] && [ "$(id -u)" -ne 0 ] && die "apply needs root (mount, fstab, package install). Re-run with sudo -E, or use --check."

# ── 1. the NFS client ────────────────────────────────────────────────────────
# `dpkg -l` prints a line for a package that was never installed (state 'un'),
# so the state column is what decides, not the presence of the row.
client_installed() { [ "$(dpkg-query -W -f='${db:Status-Status}' nfs-common 2>/dev/null || true)" = "installed" ]; }

if client_installed; then
  ok "nfs-common installed"
elif [ "$MODE" != apply ]; then
  step "install nfs-common"
else
  step "install nfs-common"
  DEBIAN_FRONTEND=noninteractive apt-get update -qq
  DEBIAN_FRONTEND=noninteractive apt-get install -y -qq nfs-common >/dev/null
  client_installed || die "nfs-common did not install"
  ok "nfs-common installed"
fi

# ── 2. the mount point ───────────────────────────────────────────────────────
if [ -d "$MOUNT" ]; then ok "mount point $MOUNT exists"
elif [ "$MODE" != apply ]; then step "mkdir -p $MOUNT"
else mkdir -p "$MOUNT"; ok "created $MOUNT"; fi

# ── 3. fstab, so it survives a reboot ────────────────────────────────────────
# Matched on the mount point, which is the field that must be unique — matching
# the whole line would add a second entry whenever the options changed, and two
# fstab lines for one mount point is how a host comes back up wrong.
FSTAB_LINE="$SOURCE	$MOUNT	nfs	$OPTS	0	0"
fstab_has_mount() { awk -v m="$MOUNT" '!/^[[:space:]]*#/ && $2 == m { found = 1 } END { exit !found }' /etc/fstab; }

if fstab_has_mount; then
  existing="$(awk -v m="$MOUNT" '!/^[[:space:]]*#/ && $2 == m { print; exit }' /etc/fstab)"
  if [ "$(printf '%s' "$existing" | awk '{print $1}')" != "$SOURCE" ]; then
    die "/etc/fstab already mounts $MOUNT from $(printf '%s' "$existing" | awk '{print $1}'), not $SOURCE — resolve by hand rather than have this script pick"
  fi
  ok "fstab entry for $MOUNT present"
elif [ "$MODE" != apply ]; then
  step "append to /etc/fstab: $FSTAB_LINE"
else
  cp /etc/fstab "/etc/fstab.bak-$(date -u +%Y%m%d%H%M%S)"
  printf '%s\n' "$FSTAB_LINE" >> /etc/fstab
  ok "fstab entry added (previous /etc/fstab backed up)"
fi

# ── 4. mounted now ───────────────────────────────────────────────────────────
is_mounted() { findmnt -rn --target "$MOUNT" -o TARGET 2>/dev/null | grep -qx "$MOUNT"; }

if is_mounted; then
  ok "$MOUNT is mounted ($(findmnt -rn --target "$MOUNT" -o SOURCE,FSTYPE 2>/dev/null | head -1))"
elif [ "$MODE" != apply ]; then
  step "mount $MOUNT"
else
  step "mount $MOUNT"
  mount "$MOUNT" || die "mount $MOUNT failed — is the export reachable, and does it permit this host?"
  is_mounted || die "mount reported success but $MOUNT is not a mount point"
  ok "$MOUNT mounted"
fi

# ── 5. the store root and its marker ─────────────────────────────────────────
# The marker is written ONCE on the real volume. Its whole purpose is to be
# absent when the export is not mounted, so that a service starting against an
# empty local directory fails loudly instead of quietly writing documents to a
# filesystem that vanishes on the next redeploy.
if [ "$MODE" != apply ] && ! is_mounted; then
  step "create $ROOT and its $MARKER (skipped: not mounted yet)"
else
  if [ -d "$ROOT" ]; then ok "store root $ROOT exists"
  elif [ "$MODE" != apply ]; then step "mkdir -p $ROOT"
  else mkdir -p "$ROOT"; ok "created $ROOT"; fi

  # The marker is a DIRECTORY, not a file. Both readiness checks only stat() it,
  # so a file would pass verification and then break the provisioner, which
  # creates each trip's folder INSIDE it:
  #   os.path.join(nfs, ".kinerary-document-store", "trip_<id>")
  # — control_plane_worker/tests/test_provisioner.py. A check that passes and a
  # system that then fails is worse than no check, so this is asserted below too.
  if [ -d "$ROOT/$MARKER" ]; then ok "marker directory present"
  elif [ -e "$ROOT/$MARKER" ]; then die "$ROOT/$MARKER exists but is not a directory — the provisioner creates each trip's folder inside it; move it aside deliberately"
  elif [ "$MODE" != apply ]; then step "create $ROOT/$MARKER/ (a directory; trips get a folder each inside it)"
  else
    mkdir -p "$ROOT/$MARKER"
    printf 'Kinerary document store.\nEach trip has a trip_<id> directory here.\nCreated %s on %s.\n' \
      "$(date -u +%FT%TZ)" "$(hostname)" > "$ROOT/$MARKER/README"
    ok "marker directory created"
  fi

  if [ -n "$OWNER" ]; then
    if [ "$MODE" = apply ]; then chown "$OWNER" "$ROOT" "$ROOT/$MARKER" 2>/dev/null || say "note: could not chown to $OWNER (NFS squash?) — the write probe below is what decides"
    else step "chown $OWNER $ROOT"; fi
  fi
fi

# ── 6. verify against the contract the product enforces ──────────────────────
# Same conditions, same order, as check_document_store() in
# control_plane_worker/document_handoff.py and checkDocumentStore in
# document-store.ts. Those stay the runtime authority; this proves the host
# will satisfy them BEFORE a service starts and exits 1 in front of a user.
verify() {
  local failed=0
  [ -n "$ROOT" ]                 || { say "FAIL NOT_CONFIGURED  root is empty";                         failed=1; }
  [ -e "$ROOT" ]                 || { say "FAIL MISSING         $ROOT does not exist";                  failed=1; }
  [ -d "$ROOT" ] || [ ! -e "$ROOT" ] || { say "FAIL NOT_A_DIRECTORY $ROOT is not a directory";          failed=1; }
  [ -e "$ROOT/$MARKER" ]         || { say "FAIL NO_MARKER       $ROOT/$MARKER is missing";              failed=1; }
  # Stricter than the product's stat(): a marker FILE satisfies both readiness
  # checks and then breaks the provisioner. Fail here, where it is cheap.
  if [ -e "$ROOT/$MARKER" ] && [ ! -d "$ROOT/$MARKER" ]; then
    say "FAIL NOT_A_DIRECTORY $ROOT/$MARKER is a file; the provisioner needs to create trip_<id> inside it"; failed=1
  fi
  if [ -d "$ROOT/$MARKER" ]; then
    local trialdir="$ROOT/$MARKER/.trip-probe-$$"
    if mkdir "$trialdir" 2>/dev/null; then rmdir "$trialdir"
    else say "FAIL NOT_WRITABLE    cannot create a trip directory in $ROOT/$MARKER"; failed=1; fi
  fi

  local probe="$ROOT/.write-probe-$$"
  if ( set -C; : > "$probe" ) 2>/dev/null; then rm -f "$probe"; else say "FAIL NOT_WRITABLE    cannot create a file in $ROOT"; failed=1; fi

  # NOT_A_MOUNT: the product asks whether the containing mount is `/`.
  local mp; mp="$(findmnt -rn --target "$ROOT" -o TARGET 2>/dev/null | head -1 || true)"
  [ "$mp" != "/" ] || { say "FAIL NOT_A_MOUNT     $ROOT sits on the root filesystem, not a mounted volume"; failed=1; }

  return "$failed"
}

printf '\n  verifying the document-store contract\n'
if verify; then
  ok "contract satisfied — a service starting here will find its document store"
else
  [ "$MODE" = apply ] && die "the host does not satisfy the document-store contract (see FAIL lines above)"
  say "not satisfied yet — the steps above would fix it; re-run without --check/--dry-run"
  exit 1
fi

# ── 7. KINERARY_NFS_ROOT ─────────────────────────────────────────────────────
# The VALUE is a deployment fact and belongs in kinerary-deploy's vm.env. This
# script will set it when handed the file, and otherwise only reports it, so
# that a repo-owned mechanism never writes a deployment-owned file it was not
# explicitly given.
printf '\n'
if [ -z "$ENV_FILE" ]; then
  say "KINERARY_NFS_ROOT=$ROOT   <- set this in vm.env (DOCUMENT_STORE_ENV_FILE=… to have this script do it)"
elif grep -qE "^KINERARY_NFS_ROOT=" "$ENV_FILE" 2>/dev/null; then
  current="$(sed -n 's/^KINERARY_NFS_ROOT=//p' "$ENV_FILE" | head -1)"
  if [ "$current" = "$ROOT" ]; then ok "KINERARY_NFS_ROOT already $ROOT in $ENV_FILE"
  else die "$ENV_FILE has KINERARY_NFS_ROOT=$current, not $ROOT — change it deliberately, not from here"; fi
elif [ "$MODE" != apply ]; then
  step "append KINERARY_NFS_ROOT=$ROOT to $ENV_FILE"
else
  printf 'KINERARY_NFS_ROOT=%s\n' "$ROOT" >> "$ENV_FILE"
  ok "KINERARY_NFS_ROOT=$ROOT written to $ENV_FILE"
fi

printf '\n'
