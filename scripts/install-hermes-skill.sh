#!/usr/bin/env bash
# scripts/install-hermes-skill.sh
#
# Installs a repo-versioned skill from .agents/skills/ into a Hermes profile.
#
# The repo is the source of truth; a profile copy is a deployment artifact.
# Edit .agents/skills/<name>/ and re-run this, never the other way round --
# ~/.hermes is not version controlled, so an edit made there has no history and
# is silently overwritten by the next install.
#
#   scripts/install-hermes-skill.sh trip-assistant-experience-evaluation shiranusa2026
#   scripts/install-hermes-skill.sh trip-assistant-experience-evaluation shiranusa2026 --check
#
# --check reports whether the profile copy is in sync and changes nothing,
# which is what you want in a review or before relying on the skill.
set -euo pipefail

die() { printf '\033[1;31m[fail]\033[0m %s\n' "$*" >&2; exit 1; }
ok()   { printf '\033[1;32m[ ok ]\033[0m %s\n' "$*"; }
info() { printf '\033[1;34m[info]\033[0m %s\n' "$*"; }

SKILL_NAME="${1:-}"
PROFILE_NAME="${2:-}"
MODE="${3:-install}"
[ -n "$SKILL_NAME" ] && [ -n "$PROFILE_NAME" ] || die "usage: $0 <skill-name> <hermes-profile> [--check]"

REPO_ROOT="$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)"
SRC="$REPO_ROOT/.agents/skills/$SKILL_NAME"
DEST="${HERMES_HOME:-$HOME/.hermes}/profiles/$PROFILE_NAME/skills/travel/$SKILL_NAME"

[ -d "$SRC" ] || die "no such skill in the repo: $SRC"
[ -f "$SRC/SKILL.md" ] || die "$SKILL_NAME has no SKILL.md"

if [ "$MODE" = "--check" ]; then
  [ -d "$DEST" ] || die "not installed in profile '$PROFILE_NAME': $DEST"
  if diff -r "$SRC" "$DEST" >/dev/null 2>&1; then
    ok "$SKILL_NAME is in sync with $PROFILE_NAME"
    exit 0
  fi
  printf '\033[1;31m[fail]\033[0m %s\n' "$SKILL_NAME has drifted from $PROFILE_NAME:" >&2
  diff -r "$SRC" "$DEST" >&2 || true
  exit 1
fi

info "skill:   $SRC"
info "profile: $DEST"
mkdir -p "$(dirname "$DEST")"
# Replace rather than merge: a file deleted from the repo skill must not
# survive in the profile as an orphan the next reader mistakes for current.
rm -rf "$DEST"
cp -R "$SRC" "$DEST"
ok "installed $SKILL_NAME into profile $PROFILE_NAME"
