#!/usr/bin/env bash
# scripts/link-worktree-deps.sh — point a git worktree's node_modules (for
# server/, tests/, mcp/) at the main checkout's real node_modules instead of
# paying for a full `npm install` x3 per worktree.
#
# Usage: scripts/link-worktree-deps.sh [worktree-path]   # defaults to CWD
#
# Idempotent — safe to re-run against an already-linked or partially-broken
# worktree. Never touches the main checkout. Refuses to run against the main
# checkout itself (that's exactly how server/node_modules ended up a broken
# self-referential symlink — see commit 8aae012).

set -euo pipefail

info()  { printf '\033[1;34m[info]\033[0m %s\n'  "$*"; }
ok()    { printf '\033[1;32m[ ok ]\033[0m %s\n'  "$*"; }
warn()  { printf '\033[1;33m[warn]\033[0m %s\n'  "$*" >&2; }
die()   { printf '\033[1;31m[fail]\033[0m %s\n'  "$*" >&2; exit 1; }

TARGET="${1:-$PWD}"
[ -d "$TARGET" ] || die "not a directory: $TARGET"

git -C "$TARGET" rev-parse --is-inside-work-tree >/dev/null 2>&1 \
  || die "$TARGET is not inside a git repository"

WT_ROOT="$(git -C "$TARGET" rev-parse --show-toplevel)"
COMMON_DIR="$(git -C "$TARGET" rev-parse --path-format=absolute --git-common-dir)"
MAIN_ROOT="${COMMON_DIR%/.git}"

[ "$WT_ROOT" != "$MAIN_ROOT" ] || die \
  "refusing to run inside the main checkout ($MAIN_ROOT) — this links a WORKTREE to main; running it here would symlink main's node_modules to itself. Run from inside a worktree instead."

info "worktree: $WT_ROOT"
info "main:     $MAIN_ROOT"

for pkg in server tests mcp control-plane/api; do
  main_pkg="$MAIN_ROOT/$pkg"
  wt_pkg="$WT_ROOT/$pkg"

  if [ ! -f "$wt_pkg/package.json" ]; then
    warn "$pkg: no package.json in worktree, skipping"
    continue
  fi
  if [ ! -f "$main_pkg/package-lock.json" ]; then
    warn "$pkg: main has no package-lock.json yet, installing in worktree instead"
    if [ -L "$wt_pkg/node_modules" ]; then
      rm "$wt_pkg/node_modules"        # drop stale link before a real install — otherwise npm
    fi                                 # install follows it and writes into main's node_modules
    ( cd "$wt_pkg" && npm install )
    ok "$pkg: installed"
    continue
  fi

  main_hash="$(shasum -a 256 "$main_pkg/package-lock.json" | cut -d' ' -f1)"
  wt_hash=""
  if [ -f "$wt_pkg/package-lock.json" ]; then
    wt_hash="$(shasum -a 256 "$wt_pkg/package-lock.json" | cut -d' ' -f1)"
  fi

  main_nm="$main_pkg/node_modules"
  main_nm_usable=false
  if [ -d "$main_nm" ] && [ ! -L "$main_nm" ]; then
    main_nm_usable=true      # never chain a symlink to a symlink
  fi

  if [ "$wt_hash" = "$main_hash" ] && [ "$main_nm_usable" = true ]; then
    info "$pkg: relinking node_modules -> main"
    rm -rf "$wt_pkg/node_modules"     # nothing, a stale symlink, or a real dir — all fine to clear
    ln -s "$main_nm" "$wt_pkg/node_modules"
    ok "$pkg: linked -> $main_nm"
  else
    if [ "$main_nm_usable" != true ]; then
      reason="main has no real node_modules for $pkg yet (run npm install in $main_pkg)"
    else
      reason="package-lock.json differs from main (lockfile drift) — symlinking would give wrong deps"
    fi
    warn "$pkg: $reason"
    if [ -L "$wt_pkg/node_modules" ]; then
      rm "$wt_pkg/node_modules"        # drop stale link before a real install
    fi
    ( cd "$wt_pkg" && npm install )
    ok "$pkg: installed real node_modules in worktree"
  fi
done
