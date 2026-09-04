#!/usr/bin/env bash
# SessionStart — one line of state an agent would otherwise have to go find:
# where this branch sits, and whether anything is already in a blocking state.
set -uo pipefail

REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null)" || exit 0
cd "$REPO_ROOT" || exit 0

branch="$(git rev-parse --abbrev-ref HEAD 2>/dev/null)"
ahead="$(git rev-list --count main..HEAD 2>/dev/null || echo '?')"
behind="$(git rev-list --count HEAD..main 2>/dev/null || echo '?')"
line="Repo state: on '$branch' (${ahead} ahead / ${behind} behind main)."

if [ -x scripts/preflight-checks.sh ]; then
  if ! out="$(scripts/preflight-checks.sh --staged 2>&1)"; then
    blocks="$(printf '%s' "$out" | grep -c '^BLOCK')"
    line="$line ${blocks} preflight BLOCK(s) currently standing — a commit will be refused until resolved. Run scripts/preflight-checks.sh --staged to see them."
  fi
fi

jq -cn --arg c "$line" '{hookSpecificOutput:{hookEventName:"SessionStart",additionalContext:$c}}'
