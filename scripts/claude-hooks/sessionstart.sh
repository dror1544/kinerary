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

# Which roles this session loaded. They are read once, at start; a change on
# disk afterwards runs silently as the OLD text (dry run 2026-09-20, M4).
if [ -d .claude/agents ]; then
  roles="$(git log -1 --format=%h -- .claude/agents 2>/dev/null)"
  dirty="$(git status --short -- .claude/agents 2>/dev/null | wc -l | tr -d ' ')"
  [ -n "$roles" ] && line="$line Roles as of $roles$([ "${dirty:-0}" != "0" ] && printf ' (+%s uncommitted)' "$dirty"); restart the session if .claude/agents changes."
fi

# Which sprint, which locks, which baseline — from the file, not from memory.
if [ -f .project/sprint.json ] && [ -f scripts/project-state.py ]; then
  state="$(python3 scripts/project-state.py show --line 2>/dev/null)" && [ -n "$state" ] && line="$line $state"
fi

# Where notes, handovers and insights go: a folder OUTSIDE this public repo,
# reached only through KINERARY_NOTES_DIR (CLAUDE.md, "Notes, handovers and
# insights live outside the repo"). Silent failure is the bug class here, so the
# state is said every session. Never creates a probe file: the folder may be a
# synced share and a file per session would churn it. `[ -w ]` is not enough on
# macOS, where a folder locked with the uchg flag still reports writable while
# every create fails, so the flag is read first. The path itself is not printed.
notes_line() {
  local d="${KINERARY_NOTES_DIR:-}" flags n=0 t
  if [ -z "$d" ]; then
    printf 'Notes dir: KINERARY_NOTES_DIR is unset — handovers, regression plans and insights cannot be filed; hand them back in the conversation and never write them into the repo.'
    return
  fi
  if [ ! -d "$d" ]; then
    printf 'Notes dir: KINERARY_NOTES_DIR is set but the directory does not exist — hand notes back in the conversation; never write them into the repo.'
    return
  fi
  if [ "$(uname -s 2>/dev/null)" = "Darwin" ]; then
    flags="$(stat -f %Sf "$d" 2>/dev/null)"
    case "$flags" in
      *uchg*) printf 'Notes dir: the directory is locked (uchg) — creates fail, whatever a writability test says; hand notes back in the conversation; never write them into the repo.'; return ;;
    esac
  fi
  if [ ! -w "$d" ]; then
    printf 'Notes dir: the directory is not writable — hand notes back in the conversation; never write them into the repo.'
    return
  fi
  for t in handovers regression-plans test-reports run-notes insights security specs; do
    [ -d "$d/$t" ] && n=$((n + 1))
  done
  printf 'Notes dir: ok (%s of 7 type folders present).' "$n"
}
line="$line $(notes_line)"

jq -cn --arg c "$line" '{hookSpecificOutput:{hookEventName:"SessionStart",additionalContext:$c}}'
