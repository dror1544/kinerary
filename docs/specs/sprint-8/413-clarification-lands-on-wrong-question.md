# A clarification about a document does not land on the question on screen

Status: draft, refreshed against 4510301 (2026-10-30) · Issue: #413 · Track: T1 · Size: M · Tier: Normal
Security path: no · Migration: no · Live-trip behaviour: yes (the interview, for new trips)

> **Sprint 8 (2026-10-30): in scope.**

## Problem

Owner's gate-3 run, 2026-10-18 (`france-2026`). Two tickets were uploaded; the
second couple's names were not read (#412). The organizer typed "נוסעים אחרים"
("other travellers") to explain this, and it was saved as the **assistant's
name**.

How the router got there (`control-plane/api/src/`):

- After a document burst, `readDocumentsInto` ends with a recap sent through
  `say()`: "If any of that is wrong just tell me… Meanwhile, carrying on:"
  (`relay/poller.ts:2384`; `intake-copy.ts:487`, he `:820`). `say()` sets no
  `lastPrompt`. Then `sendNextStep` (`poller.ts:4897+`, called at `:1710`)
  puts the next required question on screen. With travellers held (from the
  first ticket) and the organizer identified, that is `bot_name`, by array
  order (`interview.ts:2118-2129`; `bot_name` at `:925-944`).
- The next typed message is read as a reply to the on-screen question
  (`onScreen` from `lastPrompt`, `poller.ts:3246-3250`). Three things push it there:
  - **The prompt.** "this message is their reply to it … read a short or
    bare answer as answering THAT question" (`interpret.ts:1696-1703`).
  - **No way to say "travellers" is incomplete.** `travelers` is held, so it
    is not outstanding; it is deliberately filtered out of `correctable`
    whenever travellers are held (`poller.ts:3424-3428`; the prompt mirrors
    it at `interpret.ts:1682-1685`), because held lists are changed through
    `ops` (`changeSection`). A message with no names gives no `ops`.
  - **The gate.** The on-screen question is exempt from the confidence floor
    (`interpret.ts:1191`; the same `pendingQuestionId` test also at `:989` and
    `:1049`; added for the 2026-09-12 re-ask loop). `bot_name`
    validation is non-empty and at most 80 characters (`interview.ts:1305-1310`,
    `maxLength` at `:942`).
    "נוסעים אחרים" passes evidence, example-echo and validation checks.
- There is no on-screen state for "the recap you just read": no `q:`, `pc:` or
  `cfl:` key exists for it (`routerPromptKey`, `poller.ts:4672-4686`).
- The echo "Got it — <prompt>: <value>" (`poller.ts:3535-3560`) showed the
  misfile, but nothing invited an undo.
- No test covers this sequence. The closest are
  `organizer-chaos.test.ts:63`, which checks the final intake only, and
  `recap-accepts-new-info-db.test.ts:215-299` (summary, not document recap).

**Refresh against 4510301 (2026-10-30).** Not fixed on main; the trace above
still holds line for line. What moved:

- #51 (`8501225`) sends a "read only in part" notice before interpreting a
  long typed message (`poller.ts:3235-3244`). Unrelated to the misfile, but it
  sits in the same turn; the new tests should use a short message so it does
  not fire.
- #339 (`da74f26`, `b3777c1`) changed the document reply (an unsure reading of
  a held answer is offered merged into it; a restating document is told
  "already have that"). It does not touch the recap's on-screen state.
- **A precedent to reuse.** `summaryOnScreen` (`poller.ts:3420`,
  `interpret.ts:1627-1628`, `:1682-1695`, `:1739-1748`) already widens the
  reader to "answered already or not" questions plus `summarySection` when the
  summary is what the organizer is looking at. `afterDocumentRecap` should be
  the same mechanism scoped to the recap's three question ids, not a parallel
  prompt section.

## Behaviour

After a document recap, the organizer's next message is first read as possibly
being about **the recap**: a correction or addition to what the documents gave
(travellers, stops, bookings). It is filed against the question on screen only
when it plainly answers that question. A message that is about travellers but
names nobody gets a short question back: "Who are the other travellers? Write
their names as on the ticket." That question is about travellers, not the
assistant.

A free-text name answer that reads as a description of people ("other
travellers", "the kids", "נוסעים אחרים") is not accepted as the assistant's
name without a confirm.

## Acceptance criteria

- AC-1 Given a session whose last outbound was a document recap and whose
  on-screen question is `bot_name`, when the organizer sends "נוסעים אחרים",
  then `bot_name` stays unanswered and the reply asks for the other
  travellers' names. The `travelers` question is reopened for adding (held
  entries kept). (`interpret-db.test.ts` style, model stubbed to propose
  `{questionId: "bot_name", value: text "נוסעים אחרים", confidence 0.4}` and
  `unclear: [{questionId: "travelers"}]`.)
- AC-2 Given the same session, when the organizer then sends two names, then
  they are added to `travelers` and the first ticket's travellers are
  unchanged.
- AC-3 Given a session with a recap just sent and `bot_name` on screen, when the
  organizer sends "Mira", then `bot_name` = "Mira" (no regression to the
  2026-09-12 loop fix; `interpret.test.ts:246` stays green).
- AC-4 Given the interpret prompt built with `afterDocumentRecap: true`, then
  it lists the recap's question ids (travelers, phases, travel_anchors) as
  addressable, and it tells the model that a message about one of them is not
  a reply to the on-screen question.
- AC-5 Given a `bot_name` proposal whose text is in a small closed list of
  people words, in he and en (travellers, passengers, kids, family, others,
  נוסעים, מטיילים, ילדים, משפחה, אחרים), when it arrives below the floor,
  then it is not exempt from the floor (the `pendingQuestionId` exemption at
  `interpret.ts:1168` does not apply), and it becomes a suggestion that is
  confirmed rather than saved.

## Contracts

- `control-plane/api/src/relay/poller.ts`: after the recap, record a
  `recap:doc:<burst id>` marker beside `lastPrompt`, alive for the next one
  inbound message. On that turn pass `afterDocumentRecap` and add `travelers`,
  `phases` and `travel_anchors` to `correctable`, as additions only.
- `control-plane/api/src/interpret.ts`: the prompt section (`:1680-1760`),
  built on the `summaryOnScreen` path (`answeredToo`, `:1682`); the
  exemption narrowed by `looksLikePeopleWords` for `bot_name`; the "other
  travellers, no names" outcome expressed as `unclear` on `travelers`.
- `control-plane/api/src/intake-copy.ts`: the he/en question "who are the
  other travellers?".
- No schema or migration: the marker lives in the session view, the same
  store as `lastPrompt`. If that needs a column, this spec goes back for
  review.

## Non-goals

- Fixing why the names were not read (#412).
- #114's volunteered-fact class in general. This fixes one window: the message
  right after a document recap.

## Security and boundary notes

None of the three invariants applies. Traveller names are organizer-private
intake data and stay inside the control plane.

## Test plan

Write first:
- `control-plane/api/test/interpret-db.test.ts`:
  - `after a document recap, "other travellers" is not the assistant's name`
    (AC-1)
  - `names sent next are added to the held travellers` (AC-2)
  - `after a document recap, a plain name still answers bot_name` (AC-3)
  - These are DB-backed: they run only with `CONTROL_PLANE_TEST_DATABASE_URL`
    on a `*test*` database, and are skipped otherwise.
- `control-plane/api/test/interpret.test.ts`:
  - `the recap's questions are addressable on the turn after it` (AC-4)
  - `people words are not exempt from the floor as a bot_name` (AC-5)

Suites: `control-plane/api`, unit plus DB. Manual: replay the two-ticket upload
on Mac staging once #412's fixture exists (`tests/fixtures` from #412).

## Rollout and regression

The interview runs in the relay. This takes effect on a relay restart
(`scripts/relay-restart.sh` on the Mac; `vm-relay-restart.sh` on the VM, as
part of a release). No live trip site is affected; only interviews started
after the restart. **Per-PR regression plan: needed** (router behaviour in a
live interview).

## Open questions

Size: unchanged (M). Reusing the `summaryOnScreen` path may make the interpret
half smaller, but the relay marker and DB tests are as drafted.


1. Is this the same bug family as #114 (Track 2) or its own? The trace says it
   is its own: a missing on-screen state after a document recap, not an
   unprompted fact. This spec keeps it in T1 and links #114.
2. Should the closed people-word list (AC-5) exist at all, or is the recap
   marker (AC-1) enough? The list is a second line of defence. It could
   wrongly block an assistant someone deliberately names "Family".
3. (new) Reuse `summaryOnScreen` for the turn after a document recap (the
   reader sees the recap's questions as "answered already or not"), or keep a
   separate `afterDocumentRecap` flag limited to travelers/phases/
   travel_anchors? The spec now prefers reuse, scoped to those three ids; the
   wider option (every answered question) is simpler but invites more
   misreadings of a plain answer to the on-screen question (AC-3).
