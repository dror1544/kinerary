#!/usr/bin/env bash
# Test the Hermes patch set against a Hermes tree BEFORE it is applied.
#
# Upstream moves under us: an update can fix what a patch fixes, restructure the
# code the patch edits, or leave it alone. Before 2026-10-03 the only way to
# find out was to run the image build against the new snapshot and read the
# failure — and the failure only said "does not apply", never "upstream already
# fixed this" or "it applies and its own tests fail".
#
#   scripts/hermes-patches.sh check <hermes-tree>     # classify, test in a copy, change nothing
#   scripts/hermes-patches.sh apply <hermes-tree>     # check, then write the patches to the tree
#   options: --patches DIR   the patch set (default: control-plane/deployment/hermes-patches,
#                            or $HERMES_PATCHES)
#
# Per patch, in name order (the apply order), against a scratch copy that the
# earlier patches have already been applied to:
#   APPLIES          forward dry-run clean at --fuzz=0
#   ALREADY-APPLIED  reverse dry-run clean — idempotent, not an error
#   SUPERSEDED       the patch's own test files, with the patch's SOURCE hunks
#                    left out, already pass — upstream fixed it. Reported, never
#                    applied; exit 1 so a person decides whether to drop the patch
#   CONFLICT         neither direction applies
# Then, in the scratch copy with every patch in, the test files the patches add
# or touch (`+++ b/tests/...`, the same list build-hermes-image.sh derives) run
# under $HERMES_PATCH_PYTHON. Any failure refuses.
#
# `apply` writes to the tree only when every patch is APPLIES or ALREADY-APPLIED
# and the tests pass, and then all-or-nothing: a patch that fails midway is
# reversed, and the touched files are compared against the tested copy. It
# writes no manifest — that file belongs to build-hermes-image.sh's snapshot.
#
# The interpreter comes from $HERMES_PATCH_PYTHON and nothing else: it is the
# one that can import Hermes' dependencies, it differs per machine, and this
# repo does not name machines. It needs pytest and pytest-asyncio (add them with
# PYTHONPATH if its environment lacks them). Unset, the script refuses.
#
# It touches the tree (apply only, after the checks) and one mktemp directory,
# which is removed on every exit. Exit: 0 ready, 1 not ready, 2 could not start.
#
# Why this does not call build-hermes-image.sh's apply: that one stamps a
# manifest into the tree and refuses a tree that already carries any patch, which
# is its contract with the image tag and what this tool must not inherit. The
# flags are the same (patch -p1 --batch --forward --fuzz=0, name order) and a
# test holds the two to the same result.
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PATCHES="${HERMES_PATCHES:-$REPO/control-plane/deployment/hermes-patches}"

die() { echo "hermes-patches: $*" >&2; exit 2; }

mode="${1:-}"
case "$mode" in
  check|apply) shift ;;
  -h|--help)   sed -n '2,/^set -euo/p' "$0" | sed '$d'; exit 0 ;;
  *) echo "usage: hermes-patches.sh check|apply [--patches DIR] <hermes-tree>" >&2; exit 2 ;;
esac

tree=""
while [ $# -gt 0 ]; do
  case "$1" in
    --patches) PATCHES="${2:?--patches needs a directory}"; shift 2 ;;
    -*) die "unknown argument '$1'" ;;
    *)  [ -z "$tree" ] || die "one tree only"; tree="$1"; shift ;;
  esac
done

[ -n "$tree" ] || die "give the Hermes tree to test"
[ -d "$tree" ] || die "no such directory: $tree"
[ -d "$PATCHES" ] || die "no patch directory: $PATCHES"
tree="$(cd "$tree" && pwd)"
[ -n "${HERMES_PATCH_PYTHON:-}" ] || die "HERMES_PATCH_PYTHON is unset — it names the interpreter that can run Hermes' tests, and without it a patch could be 'tested' by nothing"
[ -x "$HERMES_PATCH_PYTHON" ] || die "HERMES_PATCH_PYTHON is not an executable: $HERMES_PATCH_PYTHON"

patch_list="$(find "$PATCHES" -maxdepth 1 -type f -name '*.patch' | sort)"
[ -n "$patch_list" ] || die "no patches in $PATCHES"

TMP="$(mktemp -d "${TMPDIR:-/tmp}/hermes-patches.XXXXXX")"
trap 'rm -rf "$TMP"' EXIT
trap 'exit 130' INT TERM
SCRATCH="$TMP/tree"
# `git apply` reads paths against the enclosing repository when there is one;
# the scratch copy is not part of any.
export GIT_CEILING_DIRECTORIES="$TMP"

PATCH_FLAGS=(-p1 --batch --fuzz=0)

patch_tests() {   # test files a patch adds or touches
  grep -ho '^+++ b/tests/[^[:space:]]*' "$1" | sed 's|^+++ b/||' | sort -u || true
}

run_tests() {     # run_tests <log> <file>...   (in the scratch copy)
  local log="$1"; shift
  ( cd "$SCRATCH" && \
    HERMES_HOME="$TMP/hermes-home" TMPDIR="$TMP/pytmp" PYTHONDONTWRITEBYTECODE=1 \
    "$HERMES_PATCH_PYTHON" -m pytest -o addopts= -o asyncio_mode=auto -p no:cacheprovider -q "$@" ) \
    > "$log" 2>&1
}

echo "tree:    $tree"
echo "patches: $PATCHES"
echo "copying the tree to a scratch directory (the tree itself is not written)"
mkdir -p "$SCRATCH" "$TMP/hermes-home" "$TMP/pytmp"   # the tests' own temp files land here too
rsync -a --exclude=.git --exclude=node_modules --exclude=.venv --exclude=venv \
      --exclude=__pycache__ --exclude=.pytest_cache "$tree/" "$SCRATCH/"

names=(); verdicts=(); to_apply=(); all_tests=(); touched=()
bad=0

while read -r file; do
  name="$(basename "$file")"
  names+=("$name")
  if patch "${PATCH_FLAGS[@]}" --forward --dry-run -d "$SCRATCH" < "$file" >/dev/null 2>&1; then
    verdict="APPLIES"
    tests="$(patch_tests "$file")"
    if [ -n "$tests" ]; then
      # Would the patch's tests pass without its fix? Add only the test hunks.
      if ( cd "$SCRATCH" && git apply --whitespace=nowarn --include='tests/*' "$file" ) >/dev/null 2>&1; then
        # shellcheck disable=SC2086
        if run_tests "$TMP/superseded-$name.log" $tests; then verdict="SUPERSEDED"; fi
        ( cd "$SCRATCH" && git apply -R --whitespace=nowarn --include='tests/*' "$file" ) >/dev/null 2>&1 \
          || die "could not take the test hunks of $name back out of the scratch copy"
      fi
    fi
    if [ "$verdict" = "APPLIES" ]; then
      patch "${PATCH_FLAGS[@]}" --forward -d "$SCRATCH" < "$file" >/dev/null
      to_apply+=("$file")
    else
      bad=1
    fi
  elif patch "${PATCH_FLAGS[@]}" --reverse --dry-run -d "$SCRATCH" < "$file" >/dev/null 2>&1; then
    verdict="ALREADY-APPLIED"
  else
    verdict="CONFLICT"
    bad=1
  fi
  verdicts+=("$verdict")
  printf '  %-16s %s\n' "$verdict" "$name"
  case "$verdict" in
    CONFLICT)
      patch "${PATCH_FLAGS[@]}" --forward --dry-run -d "$SCRATCH" < "$file" 2>&1 | sed 's/^/                     /' | head -12 || true ;;
    SUPERSEDED)
      echo "                     its own tests already pass on this tree without it — upstream fixed it."
      echo "                     Not applied. Drop the patch, or keep it on purpose; that is a person's call." ;;
  esac
  if [ "$verdict" = "APPLIES" ] || [ "$verdict" = "ALREADY-APPLIED" ]; then
    while read -r t; do [ -z "$t" ] || all_tests+=("$t"); done <<EOF
$(patch_tests "$file")
EOF
    while read -r t; do [ -z "$t" ] || touched+=("$t"); done <<EOF
$(grep -ho '^+++ b/[^[:space:]]*' "$file" | sed 's|^+++ b/||')
EOF
  fi
done <<EOF
$patch_list
EOF

if [ "$bad" -ne 0 ]; then
  echo "REFUSED: not every patch applies as it is. Nothing was written to $tree."
  exit 1
fi

# The tested tree, as it stands before any test can add a file to it.
mkdir -p "$TMP/expected"
for f in ${touched[@]+"${touched[@]}"}; do
  mkdir -p "$TMP/expected/$(dirname "$f")"
  cp "$SCRATCH/$f" "$TMP/expected/$f"
done

if [ "${#all_tests[@]}" -gt 0 ]; then
  uniq_tests="$(printf '%s\n' "${all_tests[@]}" | sort -u)"
  echo "tests:   $(printf '%s\n' "$uniq_tests" | wc -l | tr -d ' ') file(s), patched copy, $HERMES_PATCH_PYTHON"
  # shellcheck disable=SC2086
  if run_tests "$TMP/tests.log" $uniq_tests; then
    tail -1 "$TMP/tests.log" | sed 's/^/         /'
  else
    tail -30 "$TMP/tests.log" | sed 's/^/         /'
    echo "REFUSED: the patched tests fail. Nothing was written to $tree."
    exit 1
  fi
else
  echo "tests:   none of the patches adds or touches a test file; nothing to run"
fi

if [ "$mode" = "check" ]; then
  echo "READY: every patch applies or is already applied, and the tests pass. check writes nothing; run 'apply' to write."
  exit 0
fi

# ── apply ────────────────────────────────────────────────────────────────────
applied=()
rollback() {
  local i
  echo "hermes-patches: $1 — reversing what was applied" >&2
  for ((i=${#applied[@]}-1; i>=0; i--)); do
    patch "${PATCH_FLAGS[@]}" --reverse -E -d "$tree" < "${applied[$i]}" >/dev/null 2>&1 \
      || echo "hermes-patches: COULD NOT reverse $(basename "${applied[$i]}") in $tree — inspect it by hand" >&2
  done
  exit 1
}

for file in ${to_apply[@]+"${to_apply[@]}"}; do
  if ! patch "${PATCH_FLAGS[@]}" --forward -d "$tree" < "$file" >/dev/null 2>"$TMP/apply.err"; then
    cat "$TMP/apply.err" >&2
    rollback "$(basename "$file") failed to apply to the tree"
  fi
  applied+=("$file")
  echo "  wrote   $(basename "$file")"
done

for f in ${touched[@]+"${touched[@]}"}; do
  cmp -s "$tree/$f" "$TMP/expected/$f" || rollback "$f in the tree is not the file the tests ran against"
done

echo "APPLIED: ${#applied[@]} patch(es) written to $tree ($(( ${#names[@]} - ${#applied[@]} )) already there). No manifest written."
