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
# and the tests pass, and then all-or-nothing. Before the first write every file
# the patches touch is copied, byte for byte and mode for mode, into the temp
# directory, with a note of whether it existed. ANY unsuccessful exit after that
# — a patch that fails or dies halfway, a failed check, INT, TERM, HUP, `set -e`
# — puts the tree back from those copies (files the patches created are deleted,
# with the directories they made) before the temp directory is removed. The
# restoration ignores further signals, and a `patch` still running is stopped
# first. If the restoration itself fails, the temp directory is kept and named.
# On success the touched files are compared against the tested copy. It writes
# no manifest — that file belongs to build-hermes-image.sh's snapshot.
#
# The interpreter comes from $HERMES_PATCH_PYTHON and nothing else: it is the
# one that can import Hermes' dependencies, it differs per machine, and this
# repo does not name machines. It needs pytest and pytest-asyncio (add them with
# PYTHONPATH if its environment lacks them). Unset, the script refuses.
#
# It touches the tree (apply only, after the checks) and one mktemp directory,
# which is removed on every exit. Exit: 0 ready, 1 not ready, 2 could not start,
# 128+N when stopped by signal N (after the restoration above).
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
SCRATCH="$TMP/tree"
BACKUP="$TMP/backup"

# ── write-phase state and the traps that guard it ───────────────────────────
# in_write is 1 from the moment the backups are complete until the apply has
# succeeded (committed=1). Outside that window the traps only clean up.
in_write=0; committed=0; restored=0; keep_tmp=0; child=""

stop_child() {    # a `patch` started in the background must not outlive the restoration
  # $child, and any background job: a signal can land between `&` and `child=$!`.
  local pids watchdog p
  pids="$child $(jobs -p | tr '\n' ' ')"
  [ -n "${pids// /}" ] || return 0
  # shellcheck disable=SC2086
  kill -TERM $pids 2>/dev/null || true
  # shellcheck disable=SC2086
  ( sleep 5; kill -KILL $pids 2>/dev/null ) >/dev/null 2>&1 &
  watchdog=$!
  for p in $pids; do wait "$p" 2>/dev/null || true; done
  kill -KILL "$watchdog" 2>/dev/null || true   # TERM is ignored in here
  wait "$watchdog" 2>/dev/null || true
  child=""
}

restore_tree() {  # put every touched file back from $BACKUP; idempotent
  [ "$in_write" -eq 1 ] && [ "$committed" -eq 0 ] && [ "$restored" -eq 0 ] || return 0
  restored=1
  local kind path top suffix dir bad=0
  echo "hermes-patches: restoring $tree from the backups taken before the first write" >&2
  stop_child
  while read -r kind path top; do
    [ -n "$kind" ] || continue
    case "$kind" in
      F)  rm -f "$tree/$path" \
            && mkdir -p "$(dirname "$tree/$path")" \
            && cp -p "$BACKUP/files/$path" "$tree/$path" \
            && cmp -s "$BACKUP/files/$path" "$tree/$path" || bad=1 ;;
      N)  rm -f "$tree/$path" || bad=1
          if [ -n "$top" ]; then     # the directories the patch created, deepest first
            dir="$(dirname "$path")"
            while :; do
              rmdir "$tree/$dir" 2>/dev/null || break
              [ "$dir" = "$top" ] && break
              dir="$(dirname "$dir")"
            done
          fi ;;
    esac
    case "$kind" in F|N)
      for suffix in .rej .orig; do   # sidecars `patch` leaves when a hunk fails
        grep -qxF "K $path$suffix" "$BACKUP/index" || rm -f "$tree/$path$suffix"
      done ;;
    esac
  done < "$BACKUP/index"
  if [ "$bad" -ne 0 ]; then
    keep_tmp=1
    echo "hermes-patches: COULD NOT fully restore $tree — the originals are in $BACKUP (kept); compare and copy them back by hand" >&2
  else
    echo "hermes-patches: $tree restored" >&2
  fi
}

on_exit() {
  local rc=$?
  trap '' INT TERM HUP      # nothing interrupts the restoration
  set +e
  restore_tree
  [ "$keep_tmp" -eq 1 ] && [ "$rc" -eq 0 ] && rc=1
  [ "$keep_tmp" -eq 1 ] || rm -rf "$TMP"
  exit "$rc"
}

on_signal() {     # $1 = signal number
  trap '' INT TERM HUP      # a second signal must not cut the first one's cleanup short
  exit $((128 + $1))        # on_exit restores, then removes the temp directory
}

trap on_exit EXIT
trap 'on_signal 2' INT
trap 'on_signal 15' TERM
trap 'on_signal 1' HUP
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

patch_paths() {   # every path a patch names, relative to the tree (-p1), one per line
  {
    grep -ho '^\(---\|+++\) [ab]/[^[:space:]]*' "$1" | sed 's|^[-+]* [ab]/||'
    grep -ho '^diff --git a/[^[:space:]]* b/[^[:space:]]*' "$1" | sed 's|^diff --git a/||; s| b/| |' | tr ' ' '\n'
    grep -ho '^\(rename\|copy\) \(from\|to\) [^[:space:]]*' "$1" | sed 's/^[a-z]* [a-z]* //'
  } | sort -u || true
}

refuse() { echo "hermes-patches: $* — nothing was written to $tree." >&2; exit 1; }

# Before the first write: every file any patch to be applied touches, copied
# with its mode (cp -p) into $BACKUP, plus a note of whether it existed and, for
# a file that did not, the topmost directory that did not either — so the
# restoration can delete exactly what a patch created. One mechanism for every
# patch, the failing one included: nothing here depends on reversing a patch.
backup_touched() {
  local file path d top suffix
  mkdir -p "$BACKUP/files"
  : > "$BACKUP/index"
  while read -r path; do
    [ -n "$path" ] || continue
    case "$path" in
      /*|..|../*|*/../*|*/..) refuse "a patch names a path outside the tree ($path)" ;;
    esac
    if [ -L "$tree/$path" ]; then
      refuse "$path is a symbolic link; the restoration does not handle those"
    elif [ -f "$tree/$path" ]; then
      mkdir -p "$BACKUP/files/$(dirname "$path")"
      cp -p "$tree/$path" "$BACKUP/files/$path"
      echo "F $path" >> "$BACKUP/index"
    elif [ -e "$tree/$path" ]; then
      refuse "$path is not a regular file"
    else
      top=""; d="$(dirname "$path")"
      while [ "$d" != "." ] && [ ! -e "$tree/$d" ]; do top="$d"; d="$(dirname "$d")"; done
      echo "N $path $top" >> "$BACKUP/index"
    fi
    for suffix in .rej .orig; do
      if [ -e "$tree/$path$suffix" ]; then echo "K $path$suffix" >> "$BACKUP/index"; fi
    done
  done <<EOF
$(for file in ${to_apply[@]+"${to_apply[@]}"}; do patch_paths "$file"; done | sort -u)
EOF
}

backup_touched
in_write=1     # from here, any unsuccessful exit restores the tree (on_exit)

for file in ${to_apply[@]+"${to_apply[@]}"}; do
  # In the background and waited for, so a signal is handled at once instead of
  # after the child finishes; the handler stops the child before it restores.
  # TMPDIR inside $TMP: a killed `patch` leaves its own scratch files, and they go with it.
  TMPDIR="$TMP/pytmp" patch "${PATCH_FLAGS[@]}" --forward -d "$tree" < "$file" >/dev/null 2>"$TMP/apply.err" &
  child=$!
  rc=0
  wait "$child" || rc=$?
  child=""
  if [ "$rc" -ne 0 ]; then
    cat "$TMP/apply.err" >&2
    echo "hermes-patches: $(basename "$file") failed to apply to the tree" >&2
    exit 1                       # on_exit puts every touched file back
  fi
  applied+=("$file")
  echo "  wrote   $(basename "$file")"
done

for f in ${touched[@]+"${touched[@]}"}; do
  if ! cmp -s "$tree/$f" "$TMP/expected/$f"; then
    echo "hermes-patches: $f in the tree is not the file the tests ran against" >&2
    exit 1
  fi
done
committed=1

echo "APPLIED: ${#applied[@]} patch(es) written to $tree ($(( ${#names[@]} - ${#applied[@]} )) already there). No manifest written."
