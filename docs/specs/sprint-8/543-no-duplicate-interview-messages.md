# The interview never sends the same message twice

Status: draft 2026-11-12; approval at merge · Issue: #543 · Track: Sprint 8 staging-test fixes · Size: S · Tier: Normal
Security path: no · Migration: no · Live-trip behaviour: yes (interviews started after the next control-plane restart; a restart is what ships it)

## Problem

Found on Mac staging, 2026-11-12, trip `gatecity-2026-2`, one relay process pair
running. Two reports from the same run:

- Step 4: two ticket photos sent as **one album**; "it replied twice, same
  message, per ticket".
- Step 8: "the confirmation message came twice".

The relay log has no timestamps, so the source was found in code and proved by
tests that reproduce two sends on the unfixed tree.

**Step 4 — one acknowledgement per photo.** `applyDecision`, case
`interview_to_gateway` (`control-plane/api/src/relay/poller.ts`), sent the
"reading it now" line (`documentReading`, or `fileReceived` on the agent path)
for **every inbound message that carried a file**, before queueing it. An album
arrives as one Telegram message per photo, so two photos were two identical
acknowledgements. The burst they belong to is read once and answered once. The
log fits: two `trip_bot.update_shape has_photo=true`, one
`inbound_burst_flushed messages_combined=2`, one `interview.document_committed`.

**Step 8 — the confirmation, sent again on a repeated confirm. Source narrowed,
not proven from the log.** `confirmIntakeVia` (`interview.ts`) is deliberately
idempotent: a second Confirm returns the existing version. The caller,
`applyInterviewCallback` case `confirm`, then went on to send "That's everything
— thank you…" regardless of whether *this* call did the confirming. That string
has exactly one sender, so two copies on screen means that branch ran twice. The
log fits (one `interview.confirmed`, one `interview.provisioning_started`: the
repeat sent the message and nothing else, because by then the session was no
longer readable as "not confirmed").

What the code allows, found by test: a repeat tap that arrives *after* the
confirmation is already dropped as a stale interview button by `dispatchUpdate`
(a confirmed session is no longer live), and the poll loop handles one update at
a time. So the branch can run twice only when two confirm callbacks are
dispatched while the session is still live — two relay processes overlapping at a
restart, or a redelivered callback. The log has no timestamps, so it cannot say
which happened, or whether the tester's "confirmation" was another message
altogether (the recap with its Confirm button, a typed-change preview, the
"site ready" message). This spec therefore fixes the one reachable path, and adds
a counter that makes the next occurrence decidable: `trip_bot.confirmation_sent`
(one line per confirmation message). **If the duplicate recurs with exactly one
`trip_bot.confirmation_sent` for the session, the second message is not this
one**, and the next step is a timestamped log, not another guess.

## Behaviour

- An upload burst is acknowledged once, by its first file. Every file in it is
  still read.
- A file that arrives after the burst was claimed starts a new burst and is
  acknowledged like any other.
- Confirming the trip sends one confirmation message and requests the site build
  once, however many times Confirm is tapped. A repeat tap is still answered (the
  button stops spinning) and is not an error.

## Acceptance criteria

- AC-1 Given an interview on the interpret path, when two photos arrive as one
  album (one message each, one burst), then the organizer receives exactly one
  `documentReading` message, and both photos are read.
- AC-2 Given the same album, when the burst has been read, then no message text
  was sent twice to the organizer.
- AC-3 Given an album already read, when the organizer sends another photo
  later, then that upload is acknowledged once, again.
- AC-4 Given an interview at the confirm step, when Confirm is tapped, then the
  organizer receives `intakeConfirmed` once; when it is tapped again (once or
  twice more, one after another), then no further confirmation message and no
  "couldn't confirm" error is sent. (Already true before this change; pinned.)
- AC-5 Given two Confirm taps dispatched while the session is still live and
  handled at the same time, then the confirmation message is sent once, both taps
  are answered, and one intake version exists. (Fails before this change.)
- AC-7 Each confirmation message sent logs `trip_bot.confirmation_sent` and each
  upload acknowledgement logs `trip_bot.upload_acknowledged`, so a duplicate can
  be counted in the log.
- AC-6 `queueInboundMessage` reports whether a file was already waiting in the
  chat's burst, decided in the same statement as the append, under the row lock,
  so two photos handled at once cannot both find the queue empty.

## Contracts

- `queueInboundMessage(db, chatId, event)` now returns `{ uploadAlreadyQueued }`
  (was `void`); existing callers ignore it.
- `ConfirmIntakeResult` (`ok: true`) gains optional `alreadyConfirmed: true`, set
  only on the idempotent repeat. `POST` confirm routes that return the result
  are unchanged apart from that optional field.
- New log event `trip_bot.confirm_repeat_ignored` (info, session id only).
- The acknowledgement is now sent **after** the message is queued rather than
  before (a few milliseconds; it is still sent well inside the settle window).
- Files: `control-plane/api/src/relay/poller.ts`, `control-plane/api/src/interview.ts`.

## Non-goals

- Removing the Confirm button after a tap (a visible change to the keyboard; the
  repeat tap is now harmless, so it is not needed to stop the duplicate).
- The second, separate sentence an organizer may still get after a long read
  ("I couldn't find anything…" style replies) — those are different messages with
  their own tests.
- Retrying a confirmation message whose first send failed: a repeat tap stays
  silent, exactly as it did not build twice before.

## Security notes

None. No route, schema or visibility change; the confirm result carries a
boolean and nothing the caller could not already infer.

## Test plan

Run with `CONTROL_PLANE_TEST_DATABASE_URL` pointing at a `cptest_*` database.
Each test fails on the tree before this change and passes after.

- `control-plane/api/test/document-intake-flow.test.ts`, describe "an album of
  ticket photos (#543, #544)": AC-1, AC-2, AC-3.
- `control-plane/api/test/relay-poller.test.ts`, describe "the confirm button is
  a real confirmation": AC-4 ("repeat taps … one after another" — passes before
  and after), AC-5 ("two Confirm taps handled at the same time" — fails before).
- AC-6 is exercised by AC-1 (the second photo finds the first queued); the SQL is
  the single statement in `queueInboundMessage`.
- AC-7: asserted indirectly (the events are logged beside the sends the tests
  count); not separately pinned.
