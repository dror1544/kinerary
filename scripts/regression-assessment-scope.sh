#!/bin/bash
# regression-assessment-scope.sh — is this change set safe to skip the Opus
# regression-planner run entirely?
#
# Reads changed paths from stdin, one per line. Exit 0 means "in scope for
# skipping the assessment" — ONLY when there is at least one path AND every
# single path is on the SAFE list below. Exit 1 in every other case,
# including empty input: a missed assessment is silent, a redundant one is
# merely noise, so this fails toward assessing.
#
# The SAFE list is a positive list, not "everything else" — it grows only by
# a recorded decision (docs/agent-team-plan.md Appendix B / a brief), never by
# habit. .github/workflows/regression-assessment.yml is the only caller: it
# pipes `gh pr diff --name-only` into this script before the Opus step and
# reads the exit code. It never runs on `synchronize` (that path is handled
# separately, already narrower) and never on a `labeled` event (the
# `regression-assessment` label is the manual override and always assesses).
#
# bash 3.2 compatible on purpose — this also has to parse under macOS's
# /bin/bash (see tests/scripts/test_shell_scripts_parse.py): no `${var,,}`,
# no associative arrays.

set -euo pipefail

unsafe_found=0
path_seen=0

while IFS= read -r path || [ -n "$path" ]; do
  [ -n "$path" ] || continue
  path_seen=1

  # NEVER-SAFE first: deployed prompts, policy, the sanitizer, migrations,
  # provisioning, trip data and the tracked SPA build are never skippable,
  # whatever else the diff also contains.
  case "$path" in
    .agents/*|.claude/*|.codex/*|.github/*|.githooks/*|scripts/*|shared/*|server/*|mcp/*|control-plane/db/migrations/*|CLAUDE.md|AGENTS.md|.preflight-allow|.project/*|trips/*|site/modern/*)
      echo "assess: $path" >&2
      unsafe_found=1
      continue
      ;;
  esac

  # SAFE: docs, a short list of root-level docs, test-only files and
  # stylesheets.
  case "$path" in
    docs/*|README.md|CHANGELOG.md|FRAMEWORK.md)
      continue
      ;;
  esac

  base="${path##*/}"
  case "$base" in
    *.test.*|*.spec.*|test_*.py|*_test.py)
      continue
      ;;
  esac
  case "$base" in
    *.css|*.scss)
      continue
      ;;
  esac

  # A directory segment named test, tests or __tests__ anywhere in the path.
  case "/$path/" in
    */test/*|*/tests/*|*/__tests__/*)
      continue
      ;;
  esac

  echo "assess: $path" >&2
  unsafe_found=1
done

if [ "$path_seen" -eq 0 ]; then
  exit 1
fi

if [ "$unsafe_found" -eq 1 ]; then
  exit 1
fi

exit 0
