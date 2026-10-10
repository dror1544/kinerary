#!/usr/bin/env bash
# Nightly: deploy the latest leading branch to the Mac staging stack, walk one
# trip end to end with the automated organizer, tear it down, write a report.
#
# Owner's decision, 2026-09-26: rebuild staging every night rather than test a
# stack that never changes; a separate nightly stack comes later. So this IS a
# deploy of staging with nobody asked — never of a live trip site — and it is
# guarded instead: it skips (exit 0, reason in the report) when
#   * another nightly run holds the lock (a lock whose run is dead is taken over),
#   * staging's database cannot be read — the guards fail closed, never open,
#   * someone is mid-interview on staging (a session touched in the last hour),
#   * a provisioning job is running on staging,
#   * the deployment's own guard says no (KINERARY_NIGHTLY_GUARD — e.g. the
#     production VM is provisioning onto the same Proxmox, NPM and Cloudflare).
#
# Generic by design (CLAUDE.md hard rule 6): it knows no host and no path, and
# refuses when they are unset. A wrapper in kinerary-deploy supplies them.
#
#   NIGHTLY_CHECKOUT   a worktree used ONLY by this job; it is reset --hard to the
#                      branch every run, so it must carry the marker file
#                      .nightly-e2e-checkout (refused otherwise)
#   NIGHTLY_REPORTS    where one report per night is written
#   NIGHTLY_BRANCH     default integration/sprint-6
#   NIGHTLY_SCENARIO   default multi (never japan: it collides with a live trip)
#   KINERARY_NIGHTLY_GUARD  optional command; non-zero exit = skip tonight, its
#                      stdout is the reason
set -uo pipefail

: "${NIGHTLY_CHECKOUT:?NIGHTLY_CHECKOUT is unset — the wrapper in kinerary-deploy supplies it}"
: "${NIGHTLY_REPORTS:?NIGHTLY_REPORTS is unset — the wrapper in kinerary-deploy supplies it}"
BRANCH="${NIGHTLY_BRANCH:-integration/sprint-6}"
SCENARIO="${NIGHTLY_SCENARIO:-multi}"
[ "$SCENARIO" != japan ] || { echo "refusing: the japan fixture collides with a live trip" >&2; exit 2; }
[ -f "$NIGHTLY_CHECKOUT/.nightly-e2e-checkout" ] \
  || { echo "refusing: $NIGHTLY_CHECKOUT has no .nightly-e2e-checkout marker — it is reset --hard every run" >&2; exit 2; }

mkdir -p "$NIGHTLY_REPORTS"
stamp="$(date +%Y-%m-%d)"
report="$NIGHTLY_REPORTS/nightly-e2e-$stamp.md"
log="$NIGHTLY_REPORTS/nightly-e2e-$stamp.log"
LOCK="$NIGHTLY_REPORTS/.lock"

say() { printf '%s\n' "$*" >>"$report"; }
finish() { say ""; say "**Result: $1**"; exit "${2:-0}"; }

: >"$report"
say "# Nightly e2e — $stamp"
say ""
say "Started $(date '+%H:%M %Z'), branch \`$BRANCH\`, scenario \`$SCENARIO\`, automated organizer, torn down after."

# The lock holds the pid of the run that took it. A run that died without its
# EXIT trap (kill -9, power cut) leaves a pid that is no longer alive, and the
# next night takes the lock over instead of skipping forever.
take_lock() { ( set -o noclobber; echo $$ >"$LOCK" ) 2>/dev/null; }
if ! take_lock; then
  holder="$(cat "$LOCK" 2>/dev/null)"
  if [ -n "$holder" ] && kill -0 "$holder" 2>/dev/null; then
    finish "SKIPPED — another nightly run (pid $holder) holds $LOCK"
  fi
  say "Took over a stale lock left by pid ${holder:-unknown}, which is no longer running."
  rm -f "$LOCK"
  take_lock || finish "SKIPPED — another nightly run took the lock first"
fi
trap 'rm -f "$LOCK"' EXIT

PG="kinerary-control-plane-local-postgres-1"
sql() { docker exec "$PG" psql -U kinerary_control_plane -d kinerary_control_plane -At -c "$1" 2>/dev/null; }

# Fail closed: an answer that is not a number means the guard could not look,
# which is never the same as "nobody is there".
count() { local n; n="$(sql "$1")" && [[ "$n" =~ ^[0-9]+$ ]] && printf '%s' "$n"; }
live="$(count "SELECT count(*) FROM control_plane.intake_sessions WHERE state IN ('interviewing','awaiting_confirmation') AND updated_at > now() - interval '60 minutes'")" \
  || finish "SKIPPED — could not read staging's interview sessions (is the stack up?)"
[ "$live" = 0 ] || finish "SKIPPED — someone was mid-interview on staging in the last hour ($live session(s))"
busy="$(count "SELECT count(*) FROM control_plane.jobs WHERE state IN ('leased','running')")" \
  || finish "SKIPPED — could not read staging's provisioning jobs (is the stack up?)"
[ "$busy" = 0 ] || finish "SKIPPED — a provisioning job is running on staging"
if [ -n "${KINERARY_NIGHTLY_GUARD:-}" ]; then
  if ! why="$(bash -c "$KINERARY_NIGHTLY_GUARD" 2>&1)"; then finish "SKIPPED — deployment guard: ${why:-no reason given}"; fi
fi

cd "$NIGHTLY_CHECKOUT" || finish "FAILED — cannot enter $NIGHTLY_CHECKOUT" 1
git fetch -q origin "$BRANCH" || finish "FAILED — git fetch origin $BRANCH" 1
git reset -q --hard "origin/$BRANCH" || finish "FAILED — reset to origin/$BRANCH" 1
say "Commit under test: \`$(git rev-parse --short HEAD)\` — $(git log -1 --format=%s)"

start=$(date +%s)
scripts/preflight-deploy.sh --deploy --auto --scenario "$SCENARIO" --cleanup >"$log" 2>&1
rc=$?
mins=$(( ($(date +%s) - start) / 60 ))

say "Duration: ${mins} min. Full log: \`$log\`."
say ""
say "Last lines of the run:"
say '```'
tail -25 "$log" | sed 's/\x1b\[[0-9;]*m//g' >>"$report"
say '```'
forced="$(grep -m1 'companions render' "$log" | sed 's/\x1b\[[0-9;]*m//g; s/^ *//')"
[ -z "$forced" ] || say "Note: $forced (#127)."
[ "$rc" = 0 ] && finish "PASSED" 0
finish "FAILED (exit $rc) — staging is left on the commit above; check that the test trip was torn down" "$rc"
