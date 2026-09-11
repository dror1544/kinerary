#!/usr/bin/env bash
# scripts/preflight-deploy.sh — everything that must be true before, and after, a deploy.
#
# THREE MODES
#
#   scripts/preflight-deploy.sh
#       Every suite CI runs, plus the ones it does not, each with its real
#       dependencies. Deploys nothing. This is the default and it is safe.
#
#   scripts/preflight-deploy.sh --deploy
#       The above, then: deploy THIS checkout (build, compose up, the four
#       interview services), prove the running stack is this checkout, run the
#       model-backed checks, and walk one trip signup -> interview (you, in
#       Telegram) -> site -> companion -> MCP. The trip is left running.
#
#   scripts/preflight-deploy.sh --deploy --cleanup
#       The same, then tear down the trip THIS run created — by the id signup
#       returned, never by name (scripts/teardown-trip.py). Nothing that existed
#       before the run is touched.
#
#   --scenario japan|multi|manual|none   the trip to walk (default japan);
#                                        none = deploy + automated checks only
#
# WHY IT GREW. The old version skipped trip-web and runtime-gateway entirely,
# and on a Mac whose python3 lacks PyYAML/psycopg it reported the worker and
# provisioning suites as "skipped" — so a clean preflight could mean 340 worker
# tests had not run (2026-09-11). Now dependencies are provided, not assumed:
# a Python 3.12 venv with the worker's own requirements, `npm ci` where a
# package has none. A suite that cannot run is a failure, not a skip.
#
# HOUSEKEEPING, every mode, on every exit — including Ctrl-C:
#   * the private test database this run created is dropped; the DB suites
#     wipe whatever they are handed, so they never share one
#   * a test Postgres this run had to start is stopped (or removed, if created)
#   * site/modern — the one tracked build output — is restored if the trip-web
#     build changed it and it was clean before
#   * the run's temp dir goes; on failure its logs are kept and the path said
#   The Python venv under ~/.cache/kinerary-preflight is a cache, and stays.
#
# CLAUDE.md hard rule 2: --deploy IS a deploy. The Claude hook prompts on this
# script whatever the flags, and a human typing it is the approval.
set -uo pipefail

# NOT `REPO_ROOT`: --deploy sources provisioning.env, which sets REPO_ROOT=/repo
# (the worker's path inside its container) and silently replaced this one — the
# first real --deploy asked Docker to mount a host path `/repo` and left the
# worker Created, not running. tests/scripts/test_preflight_script.py keeps
# every name compose reads from the environment out of this script.
CHECKOUT="$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)"
cd "$CHECKOUT" || exit 1

DEPLOY=0; CLEANUP=0; SCENARIO=japan
while [ $# -gt 0 ]; do
  case "$1" in
    --deploy) DEPLOY=1 ;;
    --cleanup) CLEANUP=1 ;;
    --scenario) SCENARIO="${2:?--scenario needs japan|multi|manual|none}"; shift ;;
    -h|--help) sed -n '2,40p' "$0"; exit 0 ;;
    *) echo "unknown argument: $1 (see --help)" >&2; exit 2 ;;
  esac
  shift
done
case "$SCENARIO" in japan|multi|manual|none) ;; *) echo "--scenario must be japan|multi|manual|none" >&2; exit 2 ;; esac
if [ "$CLEANUP" = 1 ] && [ "$DEPLOY" = 0 ]; then
  echo "--cleanup tears down the trip a --deploy run creates; without --deploy there is nothing to clean up" >&2
  exit 2
fi

C_R=$'\033[1;31m'; C_G=$'\033[1;32m'; C_B=$'\033[1;34m'; C_Y=$'\033[1;33m'; C_X=$'\033[0m'
step() { printf '\n%s══ %s%s\n' "$C_B" "$1" "$C_X"; }
pass() { printf '%s[ ok ]%s %s\n' "$C_G" "$C_X" "$1"; }
fail() { printf '%s[fail]%s %s\n' "$C_R" "$C_X" "$1"; FAILED=1; }
note() { printf '%s[note]%s %s\n' "$C_Y" "$C_X" "$1"; }
die()  { fail "$1"; exit 1; }

FAILED=0
RUN_DIR="$(mktemp -d "${TMPDIR:-/tmp}/kinerary-preflight.XXXXXX")"
LOGS="$RUN_DIR/logs"; mkdir -p "$LOGS"

# ── Housekeeping ─────────────────────────────────────────────────────────────
TEST_PG="${KINERARY_TEST_PG_CONTAINER:-kinerary-sprint5-testdb}"
TEST_PG_PORT="${KINERARY_TEST_PG_PORT:-5434}"
TEST_DB=""; PG_STARTED=0; PG_CREATED=0
MODERN_WAS_CLEAN=0
[ -z "$(git status --porcelain -- site/modern)" ] && MODERN_WAS_CLEAN=1

housekeeping() {
  local code=$?
  trap - EXIT INT TERM
  step "Housekeeping"
  if [ -n "$TEST_DB" ]; then
    docker exec "$TEST_PG" psql -U postgres -q -c "DROP DATABASE IF EXISTS \"$TEST_DB\" WITH (FORCE)" >/dev/null 2>&1 \
      && pass "dropped test database $TEST_DB" || note "could not drop $TEST_DB on $TEST_PG — drop it by hand"
  fi
  if [ "$PG_CREATED" = 1 ]; then docker rm -f "$TEST_PG" >/dev/null 2>&1 && pass "removed the test Postgres this run created"
  elif [ "$PG_STARTED" = 1 ]; then docker stop "$TEST_PG" >/dev/null 2>&1 && pass "stopped the test Postgres this run started"; fi
  if [ "$MODERN_WAS_CLEAN" = 1 ] && [ -n "$(git status --porcelain -- site/modern)" ]; then
    git checkout -- site/modern >/dev/null 2>&1; git clean -fdq -- site/modern >/dev/null 2>&1
    note "the trip-web build changed site/modern — restored (the committed assets may be stale)"
  fi
  if [ "$FAILED" = 0 ] && [ "$code" = 0 ]; then rm -rf "$RUN_DIR"; pass "removed $RUN_DIR"
  else note "kept the logs of this failed run: $LOGS"; fi
  exit "$code"
}
trap housekeeping EXIT
trap 'exit 130' INT TERM

run() {  # run <label> <dir> <command...>
  local label="$1" dir="$2"; shift 2
  local log="$LOGS/$(printf '%s' "$label" | tr -c 'A-Za-z0-9._-' '_').log"
  if ( cd "$dir" && "$@" ) >"$log" 2>&1; then pass "$label"
  else fail "$label  (log: $log)"; tail -25 "$log" | sed 's/^/       /'; fi
}

# ── Dependencies: provided, not assumed ──────────────────────────────────────
step "Dependencies"
VENV="${KINERARY_PREFLIGHT_VENV:-$HOME/.cache/kinerary-preflight/venv}"
PY_BASE="$(command -v python3.12 || command -v /opt/homebrew/bin/python3.12 || true)"
[ -n "$PY_BASE" ] || die "python3.12 not found — CI runs the worker on 3.12 (brew install python@3.12)"
REQS="control-plane/worker/requirements.txt provisioning/requirements.txt"
REQS_SHA="$(cat $REQS | shasum | cut -c1-12)"
if [ ! -x "$VENV/bin/python" ] || [ "$(cat "$VENV/.reqs" 2>/dev/null)" != "$REQS_SHA" ]; then
  rm -rf "$VENV" && "$PY_BASE" -m venv "$VENV" \
    && "$VENV/bin/pip" install -q --disable-pip-version-check $(printf -- '-r %s ' $REQS) >"$LOGS/venv.log" 2>&1 \
    && echo "$REQS_SHA" > "$VENV/.reqs" || die "could not build the Python venv (log: $LOGS/venv.log)"
fi
PY="$VENV/bin/python"
pass "python $("$PY" -c 'import sys;print(sys.version.split()[0])') + worker requirements ($VENV)"

is_worktree() { [ "$(git rev-parse --git-common-dir)" != "$(git rev-parse --git-dir)" ]; }
NEED_LINK=0
for pkg in server tests mcp control-plane/api web trip-web control-plane/runtime-gateway; do
  [ -f "$pkg/package.json" ] || continue
  if [ -e "$pkg/node_modules" ]; then
    # A real install older than its lockfile is a stale one.
    if [ ! -L "$pkg/node_modules" ] && [ "$pkg/package-lock.json" -nt "$pkg/node_modules/.package-lock.json" ]; then
      ( cd "$pkg" && npm ci --no-audit --no-fund ) >"$LOGS/npm-$(echo "$pkg" | tr / _).log" 2>&1 \
        && pass "$pkg: reinstalled (lockfile was newer)" || die "$pkg: npm ci failed"
    fi
    continue
  fi
  case "$pkg" in server|tests|mcp|control-plane/api) is_worktree && { NEED_LINK=1; continue; } ;; esac
  if [ -f "$pkg/package-lock.json" ]; then
    ( cd "$pkg" && npm ci --no-audit --no-fund ) >"$LOGS/npm-$(echo "$pkg" | tr / _).log" 2>&1 \
      && pass "$pkg: installed" || die "$pkg: npm ci failed"
  fi
done
if [ "$NEED_LINK" = 1 ]; then
  scripts/link-worktree-deps.sh >"$LOGS/link-deps.log" 2>&1 && pass "worktree deps linked" || die "link-worktree-deps failed"
fi

# A PRIVATE test database. Every DB suite drops the schema it is handed, so two
# runs (or another session's) sharing one database corrupt each other silently.
running="$(docker inspect -f '{{.State.Running}}' "$TEST_PG" 2>/dev/null || true)"
if [ -z "$running" ]; then
  TEST_PG="kinerary-preflight-testdb"
  docker run -d --name "$TEST_PG" -e POSTGRES_PASSWORD=test -p "$TEST_PG_PORT:5432" postgres:16-alpine >/dev/null \
    || die "no test Postgres, and could not start one on :$TEST_PG_PORT"
  PG_CREATED=1
elif [ "$running" = "false" ]; then
  docker start "$TEST_PG" >/dev/null || die "could not start $TEST_PG"; PG_STARTED=1
fi
for _ in $(seq 1 30); do docker exec "$TEST_PG" pg_isready -U postgres >/dev/null 2>&1 && break; sleep 1; done
TEST_DB="cptest_preflight_$(date +%s)_$$"
docker exec "$TEST_PG" psql -U postgres -q -c "CREATE DATABASE $TEST_DB" >/dev/null || die "could not create $TEST_DB"
export CONTROL_PLANE_TEST_DATABASE_URL="postgres://postgres:test@127.0.0.1:$TEST_PG_PORT/$TEST_DB"
pass "private test database $TEST_DB on $TEST_PG"

# ── Every suite ──────────────────────────────────────────────────────────────
step "Hard rules (scripts/preflight-checks.sh --all)"
if ./scripts/preflight-checks.sh --all >"$LOGS/hard-rules.log" 2>&1; then pass "no blocking violations"
else fail "blocking violations"; tail -25 "$LOGS/hard-rules.log" | sed 's/^/       /'; fi

step "Trip site suite"
run "tests"                    tests                        npm test

step "Control-plane API"
# Typecheck, not `npm run build`: the live API container bind-mounts dist/ from
# whichever checkout it was started from, and this may be that checkout.
run "api typecheck"            control-plane/api            node_modules/.bin/tsc --noEmit
run "api tests (full, DB)"     control-plane/api            npm test

step "Python: worker, provisioning, scripts"
run "worker tests (DB)"        control-plane/worker         env PYTHONPATH=.:../.. "$PY" -m unittest discover -s tests
run "provisioning tests"       .                            "$PY" -m unittest discover -s tests/provisioning
run "scripts tests"            .                            "$PY" -m unittest discover -s tests/scripts

step "Web SPA"
run "web tests"                web                          npm test
run "web typecheck"            web                          npm run typecheck
run "web build"                web                          npm run build

step "Modern trip SPA"
run "trip-web tests"           trip-web                     npm test
run "trip-web build"           trip-web                     npm run build
# The build writes the TRACKED site/modern. Put it back now, not only at exit:
# a --deploy later in this run provisions a trip from this checkout, and must
# ship the committed assets, not whatever this build happened to produce.
if [ "$MODERN_WAS_CLEAN" = 1 ] && [ -n "$(git status --porcelain -- site/modern)" ]; then
  git checkout -- site/modern >/dev/null 2>&1; git clean -fdq -- site/modern >/dev/null 2>&1
  note "the trip-web build does not reproduce the committed site/modern — restored; rebuild and commit it"
fi

step "Runtime gateway"
run "runtime-gateway tests"    control-plane/runtime-gateway npm test

BRANCH="$(git rev-parse --abbrev-ref HEAD)"
step "What this would ship"
printf '  branch   : %s @ %s (%s ahead / %s behind main)\n' "$BRANCH" "$(git rev-parse --short HEAD)" \
  "$(git rev-list --count main..HEAD 2>/dev/null || echo '?')" "$(git rev-list --count HEAD..main 2>/dev/null || echo '?')"
printf '  uncommitted: %s file(s)\n' "$(git status --porcelain --untracked-files=no | wc -l | tr -d ' ')"

if [ "$FAILED" = 1 ]; then
  printf '\n%s[fail]%s preflight failed — nothing deployed.\n' "$C_R" "$C_X"; exit 1
fi
if [ "$DEPLOY" = 0 ]; then
  printf '\n%s[ ok ]%s every suite green — the build is deployable. Nothing was deployed.\n' "$C_G" "$C_X"
  exit 0
fi

# ── --deploy ─────────────────────────────────────────────────────────────────
LIVE_PG="kinerary-control-plane-local-postgres-1"
live_sql() { docker exec "$LIVE_PG" psql -U kinerary_control_plane -d kinerary_control_plane -At -c "$1"; }

step "Deploy $BRANCH @ $(git rev-parse --short HEAD) — this checkout"
[ -z "$(git status --porcelain --untracked-files=no)" ] \
  || die "uncommitted changes to tracked files — a deploy must be a commit you can name"
busy="$(live_sql "SELECT count(*) FROM control_plane.jobs WHERE state IN ('leased','running')" 2>/dev/null || echo 0)"
[ "${busy:-0}" = "0" ] || die "a provisioning job is running — recreating the worker now would kill it mid-build"

run "api build"                control-plane/api            npm run build
[ "$FAILED" = 0 ] || exit 1
[ -d "$CHECKOUT/control-plane/worker" ] || die "$CHECKOUT is not a checkout — refusing to hand it to compose"
if ( set -a; . "$HOME/kinerary-deploy/provisioning.env"; set +a
     WORKER_REPO_ROOT_HOST="$CHECKOUT" BUILDX_CONFIG="$HOME/.docker/buildx-local" \
       docker compose -f control-plane/deployment/compose.local.yml up -d --build --wait ) >"$LOGS/compose.log" 2>&1; then
  pass "compose stack up (worker mounts $CHECKOUT)"
else die "compose up failed (log: $LOGS/compose.log)"; fi

# The directory decides the branch (CLAUDE.md). Read it off the containers.
mount_of() { docker inspect "$1" --format "{{range .Mounts}}{{if eq .Destination \"$2\"}}{{.Source}}{{end}}{{end}}"; }
[ "$(mount_of kinerary-control-plane-local-api-1 /app/dist)" = "$CHECKOUT/control-plane/api/dist" ] \
  && pass "API serves this checkout's dist" || die "the API container mounts another checkout's dist"
[ "$(mount_of kinerary-control-plane-local-worker-1 /repo)" = "$CHECKOUT" ] \
  && pass "worker reads this checkout" || die "the worker container mounts another checkout"

if ( set -a; . "$HOME/kinerary-deploy/provisioning.env"; set +a; export WORKER_REPO_ROOT_HOST="$CHECKOUT"
     .agents/skills/interview-stack-deploy/deploy.sh ) >"$LOGS/interview-stack.log" 2>&1; then
  pass "API, interview sidecar, interviewer gateway and relay restarted and verified"
else fail "interview-stack-deploy failed (log: $LOGS/interview-stack.log)"; tail -15 "$LOGS/interview-stack.log" | sed 's/^/       /'; exit 1; fi

# Companions are rendered by whichever checkout the worker's SSH forced command
# names — not by the containers. Say so when it is not this one; changing a
# trust boundary is not a preflight's decision.
forced="$(grep -o 'command="[^"]*companion-install-host.sh"' "$HOME/.ssh/authorized_keys" 2>/dev/null | sed 's/command="//; s/"$//')"
if [ "$forced" = "$CHECKOUT/scripts/companion-install-host.sh" ]; then pass "companions render from this checkout"
else note "companions render from ${forced:-<no forced command>}, not this checkout"; fi

step "Post-deploy checks — the running stack, then the model-backed harnesses"
run "stack preflight (markers, relay env)" . python3 -c '
import importlib.util, sys
spec = importlib.util.spec_from_file_location("e2e", "scripts/e2e-full-cycle.py")
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
try: m.stage_preflight()
except m.Failed as e: print("FAILED:", e); sys.exit(1)'

FIX=control-plane/api/test/fixtures/make_documents.py
expect_for() { python3 -c "import sys; sys.path.insert(0,'control-plane/api/test/fixtures')
from make_documents import SCENARIOS; s=SCENARIOS['$1']; print(','.join(s.get('expect_in_phases',[])+s.get('expect_planned',[])))"; }
for s in japan multi; do python3 "$FIX" "$s" "$RUN_DIR/docs-$s" >/dev/null; done
harness() {
  ( set -a; . "$HOME/kinerary-deploy/provisioning.env"; set +a
    export PATH="/opt/homebrew/bin:$PATH" INTERPRET_TIMEOUT_MS=120000
    cd control-plane/api && node --import tsx "$@" )
}
run "interview on the interpret path (Hebrew)" . harness tools/interview-e2e.ts
run "one booking PDF (japan)"                  . harness tools/document-e2e.ts "$RUN_DIR/docs-japan" --expect "$(expect_for japan)"
run "four documents, four formats (multi)"     . harness tools/document-e2e.ts "$RUN_DIR/docs-multi" --expect "$(expect_for multi)"
if [ "$FAILED" = 1 ]; then
  printf '\n%s[fail]%s deployed, but a post-deploy check failed — no trip was started.\n' "$C_R" "$C_X"; exit 1
fi

if [ "$SCENARIO" = none ]; then
  printf '\n%s[ ok ]%s deployed and verified. No trip walked (--scenario none).\n' "$C_G" "$C_X"; exit 0
fi

step "One trip, signup to working companion ($SCENARIO)$([ "$CLEANUP" = 1 ] && echo ', then torn down')"
if [ "$CLEANUP" = 1 ]; then python3 scripts/e2e-full-cycle.py --scenario "$SCENARIO" --teardown
else python3 scripts/e2e-full-cycle.py --scenario "$SCENARIO"; fi
e2e=$?
[ "$e2e" = 0 ] || { FAILED=1; exit "$e2e"; }
printf '\n%s[ ok ]%s deployed, verified, and one trip walked end to end.\n' "$C_G" "$C_X"
