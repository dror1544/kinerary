#!/usr/bin/env bash
# PostToolUse(Bash) — after a merge, sweep what the merged work left behind.
#
# Owner's decision, 2026-11-09: a merged branch and its worktree are deleted
# when the merge happens, not at some later sweep nobody runs. That day's
# cleanup removed 39 worktrees and ~300 branches, all for work merged weeks
# before. GitHub deletes a merged PR's head branch itself (repo setting
# delete_branch_on_merge, with integration/* and release/* protected from
# deletion by a ruleset); this covers the rest: the local branch, the worktree,
# and a branch merged locally with `git merge`, which has no PR to trigger it.
#
# Only a merge that SUCCEEDED, in the lead session, triggers it. Which commands
# are merges is match-command.py's call, the same classifier that makes the
# merge a prompt beforehand, so `--abort`, merge-base and merge-tree do not
# count. What the sweep refuses to touch lives in scripts/sweep-merged.py.
set -uo pipefail

REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null)" || exit 0
MATCH="$REPO_ROOT/scripts/claude-hooks/match-command.py"
SWEEP="$REPO_ROOT/scripts/sweep-merged.py"
[ -f "$MATCH" ] && [ -f "$SWEEP" ] || exit 0

payload="$(cat)"
[ -z "$(printf '%s' "$payload" | jq -r '.agent_type // empty' 2>/dev/null)" ] || exit 0
cmd="$(printf '%s' "$payload" | jq -r '.tool_input.command // empty' 2>/dev/null)"
[ -n "$cmd" ] || exit 0
[ "$(printf '%s' "$cmd" | python3 "$MATCH" 2>/dev/null)" = "merge" ] || exit 0
# A failed merge (conflict, refused) left nothing merged to sweep.
code="$(printf '%s' "$payload" | jq -r '.tool_response.exit_code // .tool_response.exitCode // 0' 2>/dev/null)"
[ "${code:-0}" = "0" ] || exit 0

out="$(python3 "$SWEEP" --repo "$REPO_ROOT" --execute 2>&1 | grep -vE '^kept ' | tail -40)"
[ -n "$out" ] || exit 0
jq -cn --arg c "Post-merge sweep (scripts/sweep-merged.py):
$out" '{hookSpecificOutput:{hookEventName:"PostToolUse",additionalContext:$c}}'
