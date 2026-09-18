#!/usr/bin/env bash
# Build the Hermes image the VM runs: the pinned snapshot plus every patch in
# hermes-patches/, applied here rather than by hand.
#
# The fork has no remote and /opt/hermes-src is a history-less `git archive`
# (docs/control-plane-vm-deployment.md → Hermes), so the patches in
# control-plane/deployment/hermes-patches/ are the only copy of what we carry
# on top of it. A patch that only exists as a file is not carried at all: on
# 2026-09-18 compose.vm.yml was changed to set HERMES_RELAY_MEDIA_DIR, which
# nothing in the image read, and the failure that produces — media saved to a
# path the host cannot open — is silent.
#
# So the image is built from a COPY of the snapshot with every patch applied,
# and it is tagged for what it contains: <base>-p<hash of the patch set>. A
# stale image cannot answer to the tag of a newer patch set, and
# hermes-image-check.sh reads the manifest back out of whatever is running.
#
#   control-plane/deployment/build-hermes-image.sh                  # build + verify, print the tag
#   control-plane/deployment/build-hermes-image.sh --set-rev        # + write HERMES_REV into vm.env
#   control-plane/deployment/build-hermes-image.sh --apply-only DIR # patch DIR, no docker (tests use this)
#
# It never deploys: bringing the new image up is `$C up -d` with both env
# files, and that restarts every companion gateway.
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
# Overridable so the tests can drive this with a fixture patch set.
PATCHES="${HERMES_PATCHES:-$REPO/control-plane/deployment/hermes-patches}"
MANIFEST_NAME=".kinerary-patches"

SOURCE="${HERMES_SRC:-/opt/hermes-src}"
VM_ENV="${KINERARY_VM_ENV:-/opt/kinerary-deploy/vm.env}"
BASE_REV="${HERMES_BASE_REV:-}"
apply_only=""
set_rev=0

while [ $# -gt 0 ]; do
  case "$1" in
    --apply-only) apply_only="${2:?--apply-only needs a directory}"; shift 2 ;;
    --patches)    PATCHES="${2:?--patches needs a directory}"; shift 2 ;;
    --source)     SOURCE="${2:?--source needs a directory}"; shift 2 ;;
    --base-rev)   BASE_REV="${2:?--base-rev needs a value}"; shift 2 ;;
    --set-rev)    set_rev=1; shift ;;
    -h|--help)    sed -n '2,24p' "$0"; exit 0 ;;
    *) echo "build-hermes-image: unknown argument '$1'" >&2; exit 2 ;;
  esac
done

patch_files() {
  # Lexical order IS apply order — that is what the 000N prefix is for.
  find "$PATCHES" -maxdepth 1 -type f -name '*.patch' | sort
}

# The patch set's identity: names and contents, so editing a patch, adding one
# or removing one all produce a different tag and a different manifest.
manifest() {
  local file
  patch_files | while read -r file; do
    printf '%s  %s\n' "$(sha256sum "$file" | cut -d' ' -f1)" "$(basename "$file")"
  done
}

patch_set_id() {
  manifest | sha256sum | cut -c1-8
}

# Apply every patch to a tree, refusing anything but a clean application onto a
# pristine snapshot. A patch that is already applied means the snapshot has been
# edited by hand — the thing this script exists to stop, because the next
# `git archive` refresh silently drops those edits.
apply_patches() {
  local tree="$1" file name
  [ -d "$tree" ] || { echo "build-hermes-image: no such directory: $tree" >&2; exit 2; }

  local found=0
  while read -r file; do
    [ -n "$file" ] || continue
    found=$((found + 1))
    name="$(basename "$file")"
    if ! patch -p1 --batch --forward --fuzz=0 --dry-run -d "$tree" < "$file" >/dev/null 2>&1; then
      echo "build-hermes-image: $name does not apply cleanly to $tree" >&2
      patch -p1 --batch --forward --fuzz=0 --dry-run -d "$tree" < "$file" >&2 || true
      echo "  the source must be the pristine snapshot — patches are carried in the repo," >&2
      echo "  never applied to /opt/hermes-src by hand." >&2
      exit 1
    fi
    patch -p1 --batch --forward --fuzz=0 -d "$tree" < "$file" >/dev/null
    echo "  applied $name"
  done <<EOF
$(patch_files)
EOF

  [ "$found" -gt 0 ] || { echo "build-hermes-image: no patches in $PATCHES" >&2; exit 1; }
  manifest > "$tree/$MANIFEST_NAME"
  echo "  manifest: $tree/$MANIFEST_NAME ($found patch(es))"
}

if [ -n "$apply_only" ]; then
  apply_patches "$apply_only"
  exit 0
fi

# ── The real build ───────────────────────────────────────────────────────────
[ -d "$SOURCE" ] || { echo "build-hermes-image: no Hermes source at $SOURCE (set HERMES_SRC)" >&2; exit 2; }

if [ -z "$BASE_REV" ]; then
  BASE_REV="$(sed -n 's/^HERMES_REV=\([^-]*\).*/\1/p' "$VM_ENV" 2>/dev/null | head -1)"
fi
[ -n "$BASE_REV" ] || { echo "build-hermes-image: set --base-rev (the snapshot's revision)" >&2; exit 2; }

TAG="kinerary-cp/hermes:${BASE_REV}-p$(patch_set_id)"
BUILD_DIR="$(mktemp -d "${TMPDIR:-/tmp}/hermes-build.XXXXXX")"
trap 'rm -rf "$BUILD_DIR"' EXIT

echo "base:   $SOURCE (rev $BASE_REV)"
cp -a "$SOURCE/." "$BUILD_DIR/"
[ ! -e "$BUILD_DIR/$MANIFEST_NAME" ] || { echo "build-hermes-image: $SOURCE already carries a patch manifest — it is not a pristine snapshot" >&2; exit 1; }
apply_patches "$BUILD_DIR"

echo "build:  $TAG"
docker build --build-arg "HERMES_GIT_SHA=${BASE_REV}-p$(patch_set_id)" -t "$TAG" "$BUILD_DIR" >/dev/null

# Verify what was built, rather than trusting that it was: the manifest must be
# inside the image, and the fork's own tests for the patched files must pass
# against the image's interpreter, with the patched tree mounted (the image
# excludes tests/ and ships no pytest).
echo "verify: manifest + the fork's tests for the patched files"
docker run --rm --entrypoint sh "$TAG" -lc "cat /opt/hermes/$MANIFEST_NAME" | diff - <(manifest) \
  || { echo "build-hermes-image: the built image's manifest is not this patch set" >&2; exit 1; }

TESTS="$(grep -ho '^+++ b/tests/[^[:space:]]*' "$PATCHES"/*.patch | sed 's|^+++ b/||' | sort -u | tr '\n' ' ')"
if [ -n "${TESTS// /}" ]; then
  docker run --rm --entrypoint sh -v "$BUILD_DIR:/src" -w /src -e PYTHONDONTWRITEBYTECODE=1 "$TAG" -lc \
    "VIRTUAL_ENV=/opt/hermes/.venv uv pip install -q pytest pytest-asyncio >/dev/null 2>&1; \
     /opt/hermes/.venv/bin/python -m pytest $TESTS -q -p no:cacheprovider" \
    || { echo "build-hermes-image: the patched tests fail in the built image" >&2; exit 1; }
fi

echo
echo "built and verified: $TAG"
if [ "$set_rev" -eq 1 ]; then
  sed -i "s|^HERMES_REV=.*|HERMES_REV=${TAG#kinerary-cp/hermes:}|" "$VM_ENV"
  echo "vm.env: HERMES_REV=${TAG#kinerary-cp/hermes:}  (bring it up with \$C up -d)"
else
  echo "put it in $VM_ENV:  HERMES_REV=${TAG#kinerary-cp/hermes:}"
fi
