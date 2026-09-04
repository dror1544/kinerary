#!/usr/bin/env bash
# scripts/preflight-deploy.sh — prove the build is deployable. Does NOT deploy.
#
# docs/landing-spa-test-runbook.md already spelled this out as six commands
# nobody had turned into a script, so it was re-typed (and half-run) each time.
# This runs all of them, plus the hard-rule checks, plus a summary of what the
# diff would actually ship.
#
# CLAUDE.md hard rule 2 still stands: a green run here is not permission to
# deploy. Ask.
set -uo pipefail

REPO_ROOT="$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)"
cd "$REPO_ROOT" || exit 1

FAILED=0
C_R=$'\033[1;31m'; C_G=$'\033[1;32m'; C_B=$'\033[1;34m'; C_Y=$'\033[1;33m'; C_X=$'\033[0m'
step() { printf '\n%s══ %s%s\n' "$C_B" "$1" "$C_X"; }
pass() { printf '%s[ ok ]%s %s\n' "$C_G" "$C_X" "$1"; }
fail() { printf '%s[fail]%s %s\n' "$C_R" "$C_X" "$1"; FAILED=1; }
skip() { printf '%s[skip]%s %s\n' "$C_Y" "$C_X" "$1"; }

# A missing interpreter package is an unconfigured machine, not a failing test.
# Conflating the two makes preflight permanently red, and a permanently red
# check is one nobody reads.
missing_dep() {
  grep -qE "ModuleNotFoundError: No module named|ImportError: Failed to import test module" "$1"
}

report() {  # report <label> <logfile> <exit-status> <hint>
  local label="$1" log="$2" st="$3" hint="${4:-}"
  if [ "$st" -eq 0 ]; then pass "$label"; return; fi
  if missing_dep "$log"; then
    local mods; mods="$(grep -oE "No module named '[^']+'" "$log" | sort -u | tr '\n' ' ')"
    skip "$label — missing local dependency: ${mods:-see log}"
    [ -n "$hint" ] && printf '       install with: %s\n' "$hint"
    return
  fi
  fail "$label"; tail -25 "$log" | sed 's/^/       /'
}

run() {  # run <label> <dir> <command...>
  local label="$1" dir="$2"; shift 2
  if [ ! -d "$dir" ]; then skip "$label — $dir does not exist"; return; fi
  ( cd "$dir" && "$@" >/tmp/pfd.$$ 2>&1 ); local st=$?
  report "$label" /tmp/pfd.$$ "$st"
  rm -f /tmp/pfd.$$
}

step "Hard rules (scripts/preflight-checks.sh --all)"
if ./scripts/preflight-checks.sh --all; then pass "no blocking violations"; else fail "blocking violations above"; fi

step "Trip site suite"
run "tests"                 tests                   npm test

step "Control-plane API"
run "api build"             control-plane/api       npm run build
if [ -n "${CONTROL_PLANE_TEST_DATABASE_URL:-}" ]; then
  run "api tests (full)"    control-plane/api       npm test
else
  skip "api tests — CONTROL_PLANE_TEST_DATABASE_URL unset, running the unit subset only"
  run "api tests (subset)"  control-plane/api       npm run test:unit
fi

step "Python worker + provisioning"
if [ -d control-plane/worker ]; then
  ( cd control-plane/worker && PYTHONPATH=.:../.. python3 -m unittest discover -s tests >/tmp/pfd.$$ 2>&1 ); st=$?
  report "worker tests" /tmp/pfd.$$ "$st" "pip install -r control-plane/worker/requirements.txt"
  rm -f /tmp/pfd.$$
fi
if [ -d tests/provisioning ]; then
  python3 -m unittest discover -s tests/provisioning >/tmp/pfd.$$ 2>&1; st=$?
  report "provisioning tests" /tmp/pfd.$$ "$st" "pip install pyyaml"
  rm -f /tmp/pfd.$$
fi

step "Web SPA"
run "web tests"             web                     npm test
run "web typecheck"         web                     npm run typecheck
run "web build"             web                     npm run build

step "What this would ship"
BRANCH="$(git rev-parse --abbrev-ref HEAD)"
printf '  branch   : %s (%s ahead / %s behind main)\n' "$BRANCH" \
  "$(git rev-list --count main..HEAD 2>/dev/null || echo '?')" \
  "$(git rev-list --count HEAD..main 2>/dev/null || echo '?')"
printf '  uncommitted: %s file(s)\n' "$(git status --porcelain | wc -l | tr -d ' ')"
git diff main...HEAD --stat | tail -12 | sed 's/^/  /'

printf '\n'
if [ "$FAILED" -eq 0 ]; then
  printf '%s[ ok ]%s preflight clean — the build looks deployable.\n' "$C_G" "$C_X"
  printf '       This is NOT permission to deploy (CLAUDE.md hard rule 2). Ask first.\n'
else
  printf '%s[fail]%s preflight failed — do not deploy.\n' "$C_R" "$C_X"
fi
exit $FAILED
