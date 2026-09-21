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
agent="$(printf '%s' "$payload" | jq -r '.agent_type // empty' 2>/dev/null)"
rel="${f#"$REPO_ROOT"/}"

deny() {
  jq -cn --arg r "$1" '{hookSpecificOutput:{hookEventName:"PreToolUse",permissionDecision:"deny",permissionDecisionReason:$r}}'
  exit 0
}

# Two files no tool edits directly, whatever the rest of the checks say.
case "$rel" in
  CLAUDE.md)
    # Policy, not documentation (decision 2026-09-20). A subagent — the doc
    # keeper included — may detect drift and prepare a diff; a person applies
    # it, after explicit approval. Only the lead session, which the person is
    # talking to, may write it — and its commit is still hard rule 1.
    [ -n "$agent" ] && deny "CLAUDE.md is policy, not ordinary documentation. A subagent ($agent) never edits it: put the proposed diff in your report, and a person applies it after explicit approval."
    ;;
  .project/sprint.json)
    deny "$rel is the single source of truth for the sprint and baseline locks, and a hand edit carries no who, when or why. Change it with scripts/project-state.py (lock | unlock | set-baseline | set-sprint …), which records all three."
    ;;
esac

if ! out="$("$CHECKS" --paths "$f" 2>&1)"; then
  jq -cn --arg r "Write refused by scripts/preflight-checks.sh (CLAUDE.md Hard Rules):

$out" '{hookSpecificOutput:{hookEventName:"PreToolUse",permissionDecision:"deny",permissionDecisionReason:$r}}'
fi
exit 0
