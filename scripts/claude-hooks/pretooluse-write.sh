#!/usr/bin/env bash
# PreToolUse/Write|Edit — the two hard rules that are about WHERE a file goes.
#
# Runs on every write, so it is limited to the fast checks (B3: trip/ singular,
# B4: the create-trip symlink). No python, no recursive diffs for THOSE — but
# see #262 below: a case- or Unicode-normalisation-insensitive filesystem
# (APFS, this Mac) answers more than one spelling with the SAME file, so the
# path is canonicalized to every on-disk spelling that can alias it BEFORE
# any pattern match runs, using the one routine #261 already proved for the
# Codex route (scripts/claude-hooks/path_canon.py) — not a second one.
set -uo pipefail

REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null)" || exit 0
CHECKS="$REPO_ROOT/scripts/preflight-checks.sh"
CANON="$REPO_ROOT/scripts/claude-hooks/path_canon.py"
[ -x "$CHECKS" ] || exit 0

payload="$(cat)"
f="$(printf '%s' "$payload" | jq -r '.tool_input.file_path // empty' 2>/dev/null)"
[ -n "$f" ] || exit 0
agent="$(printf '%s' "$payload" | jq -r '.agent_type // empty' 2>/dev/null)"

deny() {
  jq -cn --arg r "$1" '{hookSpecificOutput:{hookEventName:"PreToolUse",permissionDecision:"deny",permissionDecisionReason:$r}}'
  exit 0
}

# Every spelling that can alias $f on this filesystem (#262): the value as
# given, its on-disk spelling, and a casefolded variant — so a differently
# cased or confusable-Unicode path (".PROJECT/sprint.json", "TRIP/x.txt",
# ".project/ſprint.json" — U+017F folds to 's' under Unicode case
# folding, which is what APFS's case-insensitive comparison uses) cannot
# dodge a check below by not being the one spelling this hook happened to
# receive. Falls back to the single as-given spelling — exactly this file's
# behaviour before #262, never weaker — if python3 or the canonicalizer is
# unavailable: the same fail-open posture this file already has above for a
# missing jq.
spellings=()
if command -v python3 >/dev/null 2>&1 && [ -f "$CANON" ]; then
  while IFS= read -r line; do
    [ -n "$line" ] && spellings+=("$line")
  done < <(python3 "$CANON" "$REPO_ROOT" "$f" 2>/dev/null)
fi
[ "${#spellings[@]}" -gt 0 ] || spellings=("$f")

# Two files no tool edits directly, whatever the rest of the checks say —
# checked against every spelling above, not just the one literal in the
# payload.
for s in "${spellings[@]}"; do
  rel="${s#"$REPO_ROOT"/}"
  case "$rel" in
    CLAUDE.md)
      # Policy, not documentation (decision 2026-09-20). A subagent — the doc
      # keeper included — may detect drift and prepare a diff; a person applies
      # it, after explicit approval. Only the lead session, which the person is
      # talking to, may write it — and its commit is still hard rule 1.
      [ -n "$agent" ] && deny "CLAUDE.md is policy, not ordinary documentation. A subagent ($agent) never edits it: put the proposed diff in your report, and a person applies it after explicit approval."
      ;;
    .project/sprint.json)
      deny ".project/sprint.json is the single source of truth for the sprint and baseline locks, and a hand edit carries no who, when or why. Change it with scripts/project-state.py (lock | unlock | set-baseline | set-sprint …), which records all three."
      ;;
  esac
done

if ! out="$("$CHECKS" --paths "${spellings[@]}" 2>&1)"; then
  jq -cn --arg r "Write refused by scripts/preflight-checks.sh (CLAUDE.md Hard Rules):

$out" '{hookSpecificOutput:{hookEventName:"PreToolUse",permissionDecision:"deny",permissionDecisionReason:$r}}'
fi
exit 0
