---
description: Reset a draft trip's interview and print a fresh Telegram deep link
argument-hint: [trip-slug-or-id]
allowed-tools: Bash, Read
---

Restart an intake interview from scratch for end-to-end testing of the Trip Bot
router, and hand back a tappable deep link.

Run this, substituting the argument if one was given (default is the standing
Sprint 5 test trip):

```bash
set -a && . ~/kinerary-deploy/provisioning.env && set +a
scripts/fresh-interview.py --trip "${ARG:-draft-sreq-9b7cc7c80cf24498ba81daff47b3bc21}" --yes
```

where `ARG` is: $ARGUMENTS

The script clears the interview session and agent turns, clears the chat's
Hermes gateway conversation, resets the trip to `draft`, revokes the previous
link, and issues a new enrollment through the real HTTP endpoint. It refuses
outright on a trip with a confirmed intake version or one past
`intake_in_progress` — if it refuses, relay the reason and stop rather than
working around it.

Then:

1. **Give the `t.me` link on its own line** so it is easy to tap. It is the last
   line of the script's output.
2. **Confirm the stack can actually serve the interview** before inviting a
   test run — a link into a dead stack wastes a real person's time. Check that
   4310 (API), 4311 (interview MCP sidecar) and 4312 (relay) are listening, and
   say plainly which is down if any are. `~/kinerary-deploy/bring-up.sh` starts
   the sidecar and bridges; the relay is started separately and deliberately,
   because it puts the assistant into live chats.
3. **Say what to watch for on this run**, based on what is currently unproven —
   not a fixed list. Check the recent git log and open issues if unsure what is
   newly landed and therefore worth exercising.

When the user reports back, **read the database rather than trusting the bot's
own account of itself**. The interviewer has claimed to record answers it never
wrote; the answers column is the only evidence that counts:

```bash
docker exec kinerary-control-plane-local-postgres-1 psql -U kinerary_control_plane \
  -d kinerary_control_plane -c "SELECT id, telegram_chat_id, state, answers FROM control_plane.intake_sessions;"
docker exec kinerary-control-plane-local-postgres-1 psql -U kinerary_control_plane \
  -d kinerary_control_plane -c "SELECT chat_id, session_id, opened_at, closed_at FROM control_plane.interview_agent_turns ORDER BY opened_at DESC LIMIT 5;"
tail -30 ~/kinerary-deploy/logs/relay.log
```

An **open turn that never closed** means the agent took the turn and failed
silently — that is the signature of the 2026-09-03 failure, and it is invisible
from the conversation itself.
