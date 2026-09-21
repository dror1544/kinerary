#!/usr/bin/env bash
# PreToolUse/Bash — enforces CLAUDE.md hard rules 1 and 2.
#
# Rule 1 (never commit without approval) and rule 2 (never deploy without
# approval) cannot be checked by a script: they are about intent. What a hook
# CAN do is make them a prompt every single time, instead of an instruction an
# agent has to remember. That is what permissionDecision "ask" is for.
#
# A commit additionally runs the mechanical checks first, so a violation is
# refused with the reason rather than becoming a prompt someone has to reason
# about.
#
# Classification lives in match-command.py, not in a grep here: the words "git"
# and "commit" appear constantly inside heredocs and documentation being
# written BY a command, and matching those refuses real work.
set -uo pipefail

REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null)" || exit 0
CHECKS="$REPO_ROOT/scripts/preflight-checks.sh"
MATCH="$REPO_ROOT/scripts/claude-hooks/match-command.py"

payload="$(cat)"
cmd="$(printf '%s' "$payload" | jq -r '.tool_input.command // empty' 2>/dev/null)"
[ -n "$cmd" ] || exit 0
[ -f "$MATCH" ] || exit 0

kind="$(printf '%s' "$cmd" | python3 "$MATCH" 2>/dev/null)" || exit 0
[ "$kind" != "none" ] || exit 0

# WHO is asking. A tool call from a subagent carries agent_type; the lead
# session — the one the person is talking to — carries none. CLAUDE.md says
# no agent can commit or deploy, and docs/agent-team-plan.md (2026-09-20) makes
# every role hand back instead: the change, the verifier report, a proposed
# commit message. An "ask" inside a subagent is a prompt nobody expected and
# nobody may be there to answer, so for a subagent every one of these is a
# refusal with the reason, not a question.
agent="$(printf '%s' "$payload" | jq -r '.agent_type // empty' 2>/dev/null)"

# Has this exact HEAD been risk-assessed?
#
# The CI assessment (.github/workflows/regression-assessment.yml) runs with no
# production access, so it can never answer "which live trips does this touch".
# That half is owed here, at the deploy, which is the only moment it can be
# answered — and the only moment anyone is forced to look. So this does not
# block: it puts the answer in front of the person while they decide.
plan_note() {
  local head short branch dir exact stale
  dir="$REPO_ROOT/docs/test-reports"
  [ -d "$dir" ] || { printf 'No docs/test-reports/ — nothing has been assessed.'; return; }
  head="$(git -C "$REPO_ROOT" rev-parse HEAD 2>/dev/null)" || return
  short="${head:0:7}"
  branch="$(git -C "$REPO_ROOT" rev-parse --abbrev-ref HEAD 2>/dev/null)"

  exact="$(grep -rl -- "$short" "$dir"/regression-plan-*.md 2>/dev/null | head -3)"
  if [ -n "$exact" ]; then
    printf 'Assessed at this commit (%s):
%s' "$short" "$exact"
    return
  fi
  stale="$(grep -rl -- "$branch" "$dir"/regression-plan-*.md 2>/dev/null | head -3)"
  if [ -n "$stale" ]; then
    printf 'NO plan for this commit (%s). There is one for an EARLIER commit on %s:
%s

Commits since then are unassessed.' \
      "$short" "$branch" "$stale"
    return
  fi
  printf 'NO regression plan for %s or %s.
Ask for one first: "use the regression-planner agent on this branch" — it reads the live fleet, which CI cannot.' \
    "$short" "$branch"
}

emit() {  # emit <allow|deny|ask> <reason>
  jq -cn --arg d "$1" --arg r "$2" \
    '{hookSpecificOutput:{hookEventName:"PreToolUse",permissionDecision:$d,permissionDecisionReason:$r}}'
  exit 0
}

if [ -n "$agent" ]; then
  case "$kind" in
    deploy) rule="hard rule 2 — never deploy a live trip site without explicit approval" ;;
    *)      rule="hard rule 1 — never git commit without explicit user approval; a merge, cherry-pick, revert, rebase, gh pr merge or push is a commit by another name" ;;
  esac
  emit deny "A subagent never commits, merges, pushes or deploys (CLAUDE.md: none can commit or deploy — $rule). You are '$agent'. Hand back instead: the change, the verifier report and a proposed commit message; the lead session runs the command after the person approves. Classified as: $kind."
fi

case "$kind" in
  merge)
    # Lands commits without the word "commit". A local merge runs the
    # git-side pre-merge-commit hook for the mechanical checks; `gh pr merge`
    # runs on GitHub and gets no hook at all. Either way, this is the approval.
    emit ask "CLAUDE.md hard rule 1 — a merge, cherry-pick, revert, rebase or gh pr merge creates commits, so it needs the same explicit approval as git commit. Approve only if you meant to land this now."
    ;;
  push)
    emit ask "Pushing publishes commits to origin: after this they exist for everyone who fetches, and a force push rewrites what they already had. Approve only if you meant to push right now."
    ;;
  deploy)
    # Deploys do not go through git, so this is the only place to catch them.
    emit ask "CLAUDE.md hard rule 2 — never deploy a live trip site without explicit approval. A commit instruction does not imply a deploy instruction. Approve only if you meant to deploy right now.

$(plan_note)"
    ;;
  commit)
    out=""
    if [ -x "$CHECKS" ]; then
      if ! out="$("$CHECKS" --staged 2>&1)"; then
        emit deny "Commit refused by scripts/preflight-checks.sh (CLAUDE.md Hard Rules):

$out

Fix the BLOCK lines above, or bypass deliberately with: git commit --no-verify"
      fi
    fi
    # A change to .project/sprint.json — a lock, the baseline, the sprint, an
    # override — is approved BY NAME inside this prompt, not as one more diff.
    changes="$(printf '%s\n' "$out" | grep -E '^warn +state change' || true)"
    if [ -n "$changes" ]; then
      emit ask "CLAUDE.md hard rule 1 — never git commit without explicit user approval. Mechanical checks passed; this prompt is the approval.

THIS COMMIT CHANGES THE SPRINT/BASELINE STATE (.project/sprint.json):
$changes"
    fi
    emit ask "CLAUDE.md hard rule 1 — never git commit without explicit user approval. Mechanical checks passed; this prompt is the approval."
    ;;
esac
exit 0
