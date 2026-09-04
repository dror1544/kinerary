#!/usr/bin/env bash
# PreToolUse/Write|Edit — the two hard rules that are about WHERE a file goes.
#
# Runs on every write, so it is limited to the fast checks (B3: trip/ singular,
# B4: the create-trip symlink). No python, no recursive diffs.
set -uo pipefail

REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null)" || exit 0
CHECKS="$REPO_ROOT/scripts/preflight-checks.sh"
[ -x "$CHECKS" ] || exit 0

payload="$(cat)"
f="$(printf '%s' "$payload" | jq -r '.tool_input.file_path // empty' 2>/dev/null)"
[ -n "$f" ] || exit 0

if ! out="$("$CHECKS" --paths "$f" 2>&1)"; then
  jq -cn --arg r "Write refused by scripts/preflight-checks.sh (CLAUDE.md Hard Rules):

$out" '{hookSpecificOutput:{hookEventName:"PreToolUse",permissionDecision:"deny",permissionDecisionReason:$r}}'
fi
exit 0
