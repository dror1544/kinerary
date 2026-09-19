#!/usr/bin/env bash
# Does this Hermes image (or the running container) carry the repo's patches?
#
# The compose file can only say which image tag to run; it cannot say what is
# inside it. build-hermes-image.sh writes a manifest of the patch set into the
# image, and this reads it back and compares. Run it after a deploy — and
# before trusting a setting that only a patch makes the runtime read, such as
# HERMES_RELAY_MEDIA_DIR.
#
#   control-plane/deployment/hermes-image-check.sh                    # the running `hermes` container
#   control-plane/deployment/hermes-image-check.sh kinerary-cp/hermes:abc-p1234
#   control-plane/deployment/hermes-image-check.sh --manifest FILE    # compare a file (tests use this)
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
PATCHES="${HERMES_PATCHES:-$REPO/control-plane/deployment/hermes-patches}"
MANIFEST_PATH="/opt/hermes/.kinerary-patches"
CONTAINER="${KINERARY_HERMES_CONTAINER:-hermes}"

expected() {
  find "$PATCHES" -maxdepth 1 -type f -name '*.patch' | sort | while read -r file; do
    printf '%s  %s\n' "$(sha256sum "$file" | cut -d' ' -f1)" "$(basename "$file")"
  done
}

target="${1:-}"
case "$target" in
  --manifest) found="$(cat "${2:?--manifest needs a file}" 2>/dev/null || true)"; what="${2}" ;;
  "")         found="$(docker exec "$CONTAINER" cat "$MANIFEST_PATH" 2>/dev/null || true)"; what="container $CONTAINER" ;;
  *)          found="$(docker run --rm --entrypoint sh "$target" -lc "cat $MANIFEST_PATH" 2>/dev/null || true)"; what="image $target" ;;
esac

if [ -z "$found" ]; then
  echo "✗ $what carries no patch manifest — it was not built by build-hermes-image.sh," >&2
  echo "  so nothing in it reads a setting a patch adds. Rebuild before deploying." >&2
  exit 1
fi

if ! diff <(printf '%s\n' "$found") <(expected) >/dev/null; then
  echo "✗ $what carries a different patch set than this checkout:" >&2
  diff <(printf '%s\n' "$found") <(expected) >&2 || true
  exit 1
fi

echo "✓ $what carries this checkout's patch set ($(expected | wc -l | tr -d ' ') patch(es))"
