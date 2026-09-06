#!/usr/bin/env bash
# Back up the repo's gitignored-but-irreplaceable files OUTSIDE the repo.
#
# Why this exists, precisely. On 2026-09-06 `git worktree remove` deleted a
# worktree's `control-plane/deployment/.local-secrets/` along with it —
# untracked files go with the worktree, which is correct behaviour and exactly
# the trap. That directory held the only copy of the relay's architecture
# profile, the relay↔gateway shared secret, and the host-addressable database
# URL. The running stack kept serving from memory, so nothing failed until the
# next deploy tried to read them. Two of the three were reconstructible; the
# README was not.
#
# `.local-secrets/` is gitignored ON PURPOSE and must stay that way — real
# credentials do not belong in git. The answer is a copy outside the repo, in
# the deploy root, which no git operation touches.
#
#   scripts/backup-local-secrets.sh            # back up
#   scripts/backup-local-secrets.sh --restore  # put them back
#   scripts/backup-local-secrets.sh --check    # report drift, exit 1 if any
#
# Deliberately NOT automatic: a hook that silently copied credentials around
# on every commit is a worse problem than the one being solved. Run it after
# changing anything under .local-secrets/, and before removing a worktree.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SRC="$REPO_ROOT/control-plane/deployment/.local-secrets"
DEST="${KINERARY_SECRETS_BACKUP:-$HOME/kinerary-deploy/.local-secrets-backup}"

die() { printf 'FAILED: %s\n' "$1" >&2; exit 1; }

MODE=backup
case "${1:-}" in
  --restore) MODE=restore ;;
  --check)   MODE=check ;;
  --help|-h) sed -n '2,26p' "${BASH_SOURCE[0]}"; exit 0 ;;
  "")        ;;
  *)         die "unknown argument: $1" ;;
esac

case "$MODE" in
  backup)
    [ -d "$SRC" ] || die "nothing to back up: $SRC does not exist"
    mkdir -p "$DEST"
    chmod 700 "$DEST"
    # -a preserves the 0600 modes, which matter: these are credentials.
    # --delete so a file removed on purpose does not linger in the backup
    # and get restored later as a surprise.
    rsync -a --delete "$SRC/" "$DEST/"
    printf 'backed up %s file(s)\n  %s\n  -> %s\n' \
      "$(find "$DEST" -type f | wc -l | tr -d ' ')" "$SRC" "$DEST"
    ;;
  restore)
    [ -d "$DEST" ] || die "no backup at $DEST"
    mkdir -p "$SRC"
    rsync -a "$DEST/" "$SRC/"
    printf 'restored %s file(s)\n  %s\n  -> %s\n' \
      "$(find "$SRC" -type f | wc -l | tr -d ' ')" "$DEST" "$SRC"
    ;;
  check)
    [ -d "$DEST" ] || die "no backup at $DEST — run scripts/backup-local-secrets.sh"
    [ -d "$SRC" ] || die "no $SRC — run scripts/backup-local-secrets.sh --restore"
    # Names and sizes only. Never diff contents to stdout: this runs in
    # terminals and CI logs, and the whole point is that these are secrets.
    if diff <(cd "$SRC" && find . -type f -exec stat -f '%N %z' {} + | sort) \
            <(cd "$DEST" && find . -type f -exec stat -f '%N %z' {} + | sort) >/dev/null; then
      printf 'in sync: %s\n' "$DEST"
    else
      printf 'DRIFT between %s and %s\n' "$SRC" "$DEST" >&2
      printf 'run scripts/backup-local-secrets.sh to update the backup,\n' >&2
      printf 'or --restore if the repo copy is the one that is wrong.\n' >&2
      exit 1
    fi
    ;;
esac
