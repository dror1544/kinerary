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

# MVP phase: documentation work needs no per-commit approval.
#
# CLAUDE.md "MVP phase — lighter rules" (2026-09-25, the owner's decision). A
# commit whose every staged path is documentation, and the push of commits that
# are only that, on an integration or docs branch, from the lead session, is
# allowed without a prompt. Code commits, merges, pushes of anything else and
# deploys are untouched.
#
# This hook sees the world BEFORE the command runs, so it vouches only for a
# command that cannot change what it inspected: one plain `git commit` with its
# message from -F <file> or -m '<text>' and nothing else on the line. Anything
# that could stage or widen a commit in the same breath — `git add … && git
# commit`, `-a`, `--amend`, `--no-verify`, another directory — falls through to
# the ordinary prompt. Policy files are not documentation here: CLAUDE.md,
# AGENTS.md, .claude/, .githooks/, .github/ and scripts/ always ask.
is_policy_path() {
  case "$1" in
    CLAUDE.md|AGENTS.md|.claude/*|.githooks/*|.github/*|scripts/*|.preflight-allow) return 0 ;;
    *) return 1 ;;
  esac
}

is_docs_path() {
  is_policy_path "$1" && return 1
  case "$1" in
    CHANGELOG.md|FRAMEWORK.md|README.md) return 0 ;;
    docs/*.md) return 0 ;;
    *) return 1 ;;
  esac
}

docs_branch_ok() {
  local branch
  branch="$(git -C "$REPO_ROOT" rev-parse --abbrev-ref HEAD 2>/dev/null)" || return 1
  case "$branch" in
    integration/sprint-*|docs/*) return 0 ;;
    *) return 1 ;;
  esac
}

RE_DOCS_COMMIT='^git commit( -q| --quiet)*( -F [A-Za-z0-9_./~-]+| -m "[^"$`\\]*"| -m '\''[^'\''$`\\]*'\'')+$'
RE_DOCS_PUSH='^git push( -u| --set-upstream)*( origin( [A-Za-z0-9_./-]+)?)?$'

docs_only_commit_ok() {
  local c="$1" f n=0
  c="${c#"cd $REPO_ROOT && "}"
  [[ "$c" =~ $RE_DOCS_COMMIT ]] || return 1
  docs_branch_ok || return 1
  while IFS= read -r f; do
    [ -n "$f" ] || continue
    n=$((n + 1))
    is_docs_path "$f" || return 1
  done < <(git -C "$REPO_ROOT" diff --cached --name-only 2>/dev/null)
  [ "$n" -gt 0 ]
}

docs_only_push_ok() {
  local c="$1" branch up commits sha files f
  c="${c#"cd $REPO_ROOT && "}"
  [[ "$c" =~ $RE_DOCS_PUSH ]] || return 1
  docs_branch_ok || return 1
  branch="$(git -C "$REPO_ROOT" rev-parse --abbrev-ref HEAD 2>/dev/null)" || return 1
  # A branch named on the line must be the one checked out, and it must already
  # track its own namesake on origin: nothing here creates or redirects a ref.
  if [ -n "${BASH_REMATCH[3]:-}" ] && [ "${BASH_REMATCH[3]# }" != "$branch" ]; then return 1; fi
  up="$(git -C "$REPO_ROOT" rev-parse --abbrev-ref --symbolic-full-name '@{u}' 2>/dev/null)" || return 1
  [ "$up" = "origin/$branch" ] || return 1
  [ -z "$(git -C "$REPO_ROOT" rev-list --merges "$up..HEAD" 2>/dev/null)" ] || return 1
  commits="$(git -C "$REPO_ROOT" rev-list "$up..HEAD" 2>/dev/null)" || return 1
  [ -n "$commits" ] || return 1
  for sha in $commits; do
    files="$(git -C "$REPO_ROOT" diff-tree --no-commit-id --name-only -r "$sha" 2>/dev/null)"
    [ -n "$files" ] || return 1
    while IFS= read -r f; do
      is_docs_path "$f" || return 1
    done <<<"$files"
  done
  return 0
}

# MVP phase, 2026-09-26: work on a feature branch needs no per-commit or per-push
# approval; the merge into the leading branch is the one prompt.
#
# CLAUDE.md "MVP phase — lighter rules", item 3. The leading branch is
# integration/sprint-N and the production branch is main: neither is ever exempted
# here, and a feature-branch commit reaches nobody until someone merges it. The
# decision moves to the merge, where the integrator's report and CI exist.
#
# Same discipline as the docs exemption above: one plain `git commit` (message from
# -F/-m) or one plain `git push [-u] origin <branch>` naming the checked-out branch,
# from the lead session, nothing else on the line. The one difference is WHERE: a
# feature branch lives in its own worktree, so the command may start with `cd <dir> &&`
# or `git -C <dir>`. <dir> must be a worktree of THIS repository — an unrelated
# repository is not vouched for — and the mechanical checks run against that index.
RE_FEATURE_BRANCH='^(fix|feat|carry|chore)/[A-Za-z0-9._-]+$'
RE_FEATURE_PUSH='^git push( -u| --set-upstream)* origin ([A-Za-z0-9_./-]+)$'

# Split a leading `cd <dir> && ` or `git -C <dir> ` off a command: sets TARGET (the
# directory the command acts on) and REST (the command as if run there).
target_of() {
  local c="$1"
  c="${c#"cd $REPO_ROOT && "}"
  TARGET="$REPO_ROOT"; REST="$c"
  if [[ "$c" =~ ^cd\ ([A-Za-z0-9_./-]+)\ \&\&\ (git\ .*)$ ]]; then
    TARGET="${BASH_REMATCH[1]}"; REST="${BASH_REMATCH[2]}"
  elif [[ "$c" =~ ^git\ -C\ ([A-Za-z0-9_./-]+)\ (.*)$ ]]; then
    TARGET="${BASH_REMATCH[1]}"; REST="git ${BASH_REMATCH[2]}"
  fi
}

same_repo() {
  local a b
  a="$(git -C "$1" rev-parse --path-format=absolute --git-common-dir 2>/dev/null)" || return 1
  b="$(git -C "$REPO_ROOT" rev-parse --path-format=absolute --git-common-dir 2>/dev/null)" || return 1
  [ -n "$a" ] && [ "$a" = "$b" ]
}

feature_branch_of() {  # feature_branch_of <dir> -> prints the branch when it qualifies
  local b
  b="$(git -C "$1" rev-parse --abbrev-ref HEAD 2>/dev/null)" || return 1
  [[ "$b" =~ $RE_FEATURE_BRANCH ]] || return 1
  printf '%s' "$b"
}

feature_commit_ok() {
  local f n=0
  target_of "$1"
  [[ "$REST" =~ $RE_DOCS_COMMIT ]] || return 1
  same_repo "$TARGET" || return 1
  feature_branch_of "$TARGET" >/dev/null || return 1
  # No copy of the checks in that worktree means nothing has inspected its index.
  [ -x "$(git -C "$TARGET" rev-parse --show-toplevel)/scripts/preflight-checks.sh" ] || return 1
  while IFS= read -r f; do
    [ -n "$f" ] || continue
    n=$((n + 1))
    is_policy_path "$f" && return 1
  done < <(git -C "$TARGET" diff --cached --name-only 2>/dev/null)
  [ "$n" -gt 0 ]
}

feature_push_ok() {
  local named branch
  target_of "$1"
  [[ "$REST" =~ $RE_FEATURE_PUSH ]] || return 1
  named="${BASH_REMATCH[2]}"
  same_repo "$TARGET" || return 1
  branch="$(feature_branch_of "$TARGET")" || return 1
  [ "$named" = "$branch" ]
}

# What the person needs at the moment they approve a merge. Best effort: a GitHub
# that cannot be read must never turn a prompt into a failure.
merge_evidence() {
  local n json base checks draft="" where
  [[ "$1" =~ gh[[:space:]]+pr[[:space:]]+merge[[:space:]]+([0-9]+) ]] || return 0
  n="${BASH_REMATCH[1]}"
  command -v gh >/dev/null 2>&1 && command -v jq >/dev/null 2>&1 || return 0
  if ! json="$(gh pr view "$n" --json baseRefName,isDraft,statusCheckRollup 2>/dev/null)"; then
    printf '\n\nPR #%s: could not read its state from GitHub — look before approving.' "$n"
    return 0
  fi
  base="$(printf '%s' "$json" | jq -r '.baseRefName // "?"')"
  checks="$(printf '%s' "$json" | jq -r '[.statusCheckRollup[]? | (.conclusion // .status // "pending") | ascii_downcase] | group_by(.) | map("\(.[0]) \(length)") | join(", ")')"
  [ -n "$checks" ] || checks="none reported"
  [ "$(printf '%s' "$json" | jq -r '.isDraft')" = "true" ] && draft=" It is a DRAFT."
  case "$base" in
    main) where="main (the PRODUCTION branch — this is the release path)" ;;
    integration/sprint-*) where="$base (the leading branch)" ;;
    *) where="$base" ;;
  esac
  printf '\n\nPR #%s -> %s. Checks: %s.%s' "$n" "$where" "$checks" "$draft"
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
    emit ask "CLAUDE.md hard rule 1 — a merge, cherry-pick, revert, rebase or gh pr merge creates commits, so it needs the same explicit approval as git commit. Approve only if you meant to land this now.$(merge_evidence "$cmd")"
    ;;
  push)
    if docs_only_push_ok "$cmd"; then
      emit allow "MVP-phase rule (CLAUDE.md, 2026-09-25): pushing docs-only commits on an integration or docs branch, to the branch's own upstream, needs no per-push approval. Every commit being pushed changes only documentation."
    fi
    if feature_push_ok "$cmd"; then
      emit allow "MVP-phase rule (CLAUDE.md, 2026-09-26): pushing a feature branch (fix/, feat/, carry/, chore/) to its own name on origin needs no per-push approval; nothing lands until it is merged, and that merge is prompted."
    fi
    emit ask "Pushing publishes commits to origin: after this they exist for everyone who fetches, and a force push rewrites what they already had. Approve only if you meant to push right now."
    ;;
  deploy)
    # Deploys do not go through git, so this is the only place to catch them.
    emit ask "CLAUDE.md hard rule 2 — never deploy a live trip site without explicit approval. A commit instruction does not imply a deploy instruction. Approve only if you meant to deploy right now.

$(plan_note)"
    ;;
  commit)
    out=""
    # The checks read the index they are run in, so run them where the commit will
    # happen: a feature branch usually lives in a sibling worktree of this repository.
    # preflight-checks.sh inspects the checkout that CONTAINS the script, whatever the
    # working directory, so it is that worktree's own copy that has to run.
    target_of "$cmd"
    check_script="$CHECKS"
    if same_repo "$TARGET"; then check_script="$(git -C "$TARGET" rev-parse --show-toplevel)/scripts/preflight-checks.sh"; fi
    if [ -x "$check_script" ]; then
      if ! out="$("$check_script" --staged 2>&1)"; then
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
    if docs_only_commit_ok "$cmd"; then
      emit allow "MVP-phase rule (CLAUDE.md, 2026-09-25): a docs-only commit on an integration or docs branch needs no per-commit approval. Every staged path is documentation and the mechanical checks passed."
    fi
    if feature_commit_ok "$cmd"; then
      emit allow "MVP-phase rule (CLAUDE.md, 2026-09-26): a commit on a feature branch (fix/, feat/, carry/, chore/) needs no per-commit approval. No staged path is policy and the mechanical checks passed; the approval comes at the merge into the leading branch."
    fi
    emit ask "CLAUDE.md hard rule 1 — never git commit without explicit user approval. Mechanical checks passed; this prompt is the approval."
    ;;
esac
exit 0
