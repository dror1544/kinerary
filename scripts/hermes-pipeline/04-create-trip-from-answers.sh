#!/usr/bin/env bash
# scripts/hermes-pipeline/04-create-trip-from-answers.sh
#
# Runs on THIS machine (the site host), triggered by a human, when the
# organizer's interview with the trip-setup Hermes agent is done. The agent
# has no tool access to create/verify/activate a trip (see 03's SOUL.md) —
# it only writes the finished interview to its own workspace. This script is
# what actually turns that into a trip: it is the deterministic half of the
# handoff you asked for, so it does exactly what you can read below, nothing
# an LLM decided to do at the time.
#
# Does NOT activate the trip. That's a separate, explicit step (see the end)
# because it restarts the live trip-server container — CLAUDE.md's hard rule
# on that applies here same as anywhere else.

set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=config.sh
. "$HERE/config.sh"
# shellcheck source=lib.sh
. "$HERE/lib.sh"

LOCAL_ANSWERS="$REPO_ROOT/scripts/hermes-pipeline/.last-answers.json"

# Resolve $HOME on the REMOTE side explicitly rather than relying on scp to
# expand it — modern scp (OpenSSH 9+) speaks SFTP by default and does not
# run remote paths through a shell, so a literal "$HOME" in the path would
# be taken as-is and fail.
REMOTE_HOME="$(ssh -i "$HERMES_SSH_KEY" "${HERMES_SSH_USER}@${HERMES_HOST}" 'echo $HOME')"
[ -n "$REMOTE_HOME" ] || die "Could not resolve \$HOME on ${HERMES_HOST}."
REMOTE_ANSWERS="${REMOTE_HOME}/.hermes/profiles/${HERMES_PROFILE_NAME}/workspace/answers.json"

info "Pulling answers.json from ${HERMES_HOST}..."
if ! ssh -i "$HERMES_SSH_KEY" "${HERMES_SSH_USER}@${HERMES_HOST}" \
     "test -f '${REMOTE_ANSWERS}'" 2>/dev/null; then
  die "No answers.json found at ${REMOTE_ANSWERS} on ${HERMES_HOST} — has the interview actually finished?"
fi
scp -i "$HERMES_SSH_KEY" -q "${HERMES_SSH_USER}@${HERMES_HOST}:${REMOTE_ANSWERS}" "$LOCAL_ANSWERS"
ok "Pulled to ${LOCAL_ANSWERS}"

info "Answers preview (meta + participant count):"
node -e "
  const a = JSON.parse(require('fs').readFileSync('$LOCAL_ANSWERS', 'utf8'));
  console.log('  title:', a.meta?.title);
  console.log('  participants:', (a.participants || []).length);
  console.log('  organizer(s):', a.agent?.organizers || a.agent?.organizer || '(none)');
"
confirm "Run driver.mjs generate against this?" || die "Stopped. Re-run this script once you're ready — the pulled file is cached at $LOCAL_ANSWERS."

cd "$REPO_ROOT"
GEN_OUTPUT="$(node .agents/skills/create-trip/driver.mjs generate "$LOCAL_ANSWERS" 2>&1)" || {
  echo "$GEN_OUTPUT"
  die "generate failed — see output above. Fix the answers file or re-run the interview, then try again."
}
echo "$GEN_OUTPUT"
SLUG="$(echo "$GEN_OUTPUT" | command grep -oE 'trips/[a-z0-9-]+/' | head -1 | sed 's#trips/##; s#/##')"
[ -n "$SLUG" ] || die "Could not parse the trip slug out of generate's output — see above."

info "Verifying trips/${SLUG}/ (boots a real server on a throwaway port + temp DB)..."
node .agents/skills/create-trip/driver.mjs verify "$SLUG"

echo
ok "trips/${SLUG}/ created and verified. It is NOT live yet."
info "To go live (only when you're ready — this restarts the running site):"
info "  1. Set ACTIVE_TRIP_DIR=./trips/${SLUG} and TRIP_DIR_HOST=./trips/${SLUG} in .env"
info "  2. docker compose up -d --force-recreate trip-server"
info "  3. Hard-refresh the site"
