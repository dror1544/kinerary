# A trip created on the dashboard seeds the interview

Status: draft (2026-10-30) · Issue: #438 · Track: T1 · Size: M · Tier: Normal
Security path: no (none of the three named invariants; reads the trip's own card inside the session-start transaction) · Migration: no · Live-trip behaviour: yes (interviews started after the relay restart)

> **Sprint 8 (2026-10-30): in scope, prioritised — first in the build order** (Dror via the lead session, 2026-10-30).

## Problem

Staging acceptance run, 2026-10-19 (combined candidate served as `404ea2b`;
organizer on iPhone and Mac Chrome; issue #438): the organizer created a trip on
the dashboard with a destination and dates, started the interview from it, and
the interview asked for the destination and the dates again. Owner, round-2
acceptance (2026-10-20): values entered on the dashboard's new-trip form are set
on the trip and skipped in the interview, unless they could not be resolved.
Owner, scope extension (2026-10-30, issue comment): the account that created the
trip is the organizer and is greeted **by name**; the greeting states the
**destination and dates** already chosen; destination, dates and trip type are
confirmed, never re-asked, and changing them is an explicit correction. Product
direction: dashboard-first trip creation, step 1 (notes folder,
`specs/2026-10-30-dashboard-first-trip-creation.md`).

What the code does today (4510301):

- **The card is stored and never read by the interview.** `POST /v1/trips`
  (`control-plane/api/src/portal.ts:1314-1347`) writes `destination_label`,
  `start_date`, `end_date`, `trip_type` and `draft_inputs`
  (`{destination, trip_type, departure_date?, return_date?}`, `:1328`).
  Nothing reads `draft_inputs` (its only writer is that route; column from
  migration `0020_web_portal.sql:10`), and no route edits the card afterwards.
- **The interview link is bound to the organizer.** `POST
  /v1/trips/:id/interview-link` (`portal.ts:1358-1371`) requires the `owner`
  membership and calls `issueEnrollment` (`enrollment.ts:40`) for that user and
  trip.
- **The session starts empty.** `/start <token>` → `relay/dispatch.ts:731-750`
  → `startFromDeepLink` (`chat-router.ts:792`, `startSession` at `:871`) →
  `startSession` (`interview.ts:2604`), which inserts `intake_sessions` with
  `answers = '{}'` (`:2677-2681`). The first question is the first required
  one.
- **The opening is generic.** `renderDocumentOffer` (`chat-router.ts:1307-1333`)
  sends `introduction` or `introductionReturning` (`intake-copy.ts:389`, `:422`;
  Hebrew `:779`, `:801`). Neither carries a name, a destination or dates.
  `introductionReturning` omits the name on purpose: "The display name on a
  password signup is the local part of an email address" (`intake-copy.ts:419`). That holds: `users.display_name` is the email's local
  part for a password signup (`password-identity.ts:99`, `:323`) and Google's
  name or the local part for a Google sign-in (`portal.ts:206`). The Telegram
  account's first name, from the update's verified `from`, already reaches
  `startSession` as `telegramName` (`dispatch.ts:732`).
- **The questions it would re-ask.** `trip_type` (router-owned choice,
  `interview.ts:605`), `destination` (`:623`), `departure_date` (`:642`),
  `return_date` (`:649`). `timezone` derives from `destination` (`:664-678`), so
  a seeded destination also settles it where the zone is known.
- **"Who are you" is a separate question.** `organizer_identity` (`:887-930`)
  asks which traveller on the roster is speaking; its prompt says "Never infer
  it from anything else — not from who signed up". The trip-level organizer is
  already settled: the enrollment's user holds the `owner` membership, and
  `startSession` links the Telegram chat to that user (`:2696`).
- **Trip type vocabularies differ.** Dashboard: `family | couple | group |
  other` (`web/src/pages/ProductApp.tsx:139`; migration `0020` check).
  Interview: `family | group_of_families | couple` plus free text
  (`interview.ts:605-617`). `web/src/pages/NewTripPage.tsx` holds a third set
  (`multi-family`, `friends`, `road-trip`) but is not routed (`web/src/App.tsx:55`
  sends `/trips/new` to `ProductApp`).

## Behaviour

When the organizer opens the interview link of a trip created on the dashboard:

- The opening greets them by name (see the name rule in Contracts), as the
  organizer of this trip, and states what is already chosen as the starting
  point — "Japan, 12–26 April 2027" — in words, never as `YYYY-MM-DD`. It does
  not ask for the destination or the dates. The document offer follows as
  today.
- The router does not ask a seeded question. The values appear in the final
  summary with everything else, which is where they are confirmed.
- Changing one is an ordinary correction ("actually it's May"): an answered
  question is already correctable, so it goes through the existing path.
- A value the interview would not accept from a typed answer (fails
  `validateAnswer`, `interview.ts:1237`, or dates out of order,
  `datesInOrder`, `:372`) is not seeded; that question is asked as today.
- A partial card seeds only what it holds: a start date without an end date
  seeds `departure_date`, and `return_date` is asked.
- A trip created anywhere else (Telegram signup, `signup.ts:98`; operator
  invitation, `organizer-invite.ts:319`) has no card values and opens exactly as
  today.

## Acceptance criteria

- AC-1 Given a trip created through `POST /v1/trips` with destination "Japan",
  start 2027-04-12, end 2027-04-26 and type `family`, when the organizer's
  interview session starts, then its stored answers hold `destination` =
  "Japan", `departure_date` = "2027-04-12", `return_date` = "2027-04-26" and
  `trip_type` = `family`, in the same transaction that creates the session,
  and the session's first `nextQuestion` is none of those four.
- AC-2 Given that session, when the opening is rendered in English and in
  Hebrew, then it contains the organizer's name (per the name rule), the
  destination, and both dates as `readableDate` (`intake-copy.ts:1034`) words,
  contains no `YYYY-MM-DD`, and asks for neither the destination nor the
  dates. The returning-organizer opening does the same.
- AC-3 Given the same session, when the organizer answers every remaining
  required question, then the router never puts `destination`,
  `departure_date`, `return_date` or a seeded `trip_type` on screen, and the
  final summary lists all four.
- AC-4 Given a seeded session, when the organizer writes "actually we go in
  May, 3 to 17", then `departure_date` and `return_date` take the new values
  through the existing correction path, and the card's values are not
  re-applied afterwards.
- AC-5 Given a card with only a start date, then only `departure_date` is
  seeded and `return_date` is the router's question when dates come up; given
  a card with no dates, no date is seeded and the opening names only the
  destination.
- AC-6 Given a card value that `validateAnswer` rejects (for example a
  destination over the question's `maxLength`), then that question is not
  seeded and is asked as today, and the session still starts.
- AC-7 Given a trip created by Telegram signup or by an operator invitation
  (no card values), then the session starts with `answers = '{}'` and the
  opening text is byte-identical to today's.
- AC-8 Given a session start with a seed, then one structured log line
  `interview.session_seeded` names the seeded question ids and no values.

## Contracts

- `control-plane/api/src/interview.ts` `startSession` (`:2604`): reads the
  trip's card (`destination_label`, `start_date`, `end_date`, `trip_type`) in
  the transaction that already locks the trip row (`:2627`), builds the
  seed through a new pure `seedAnswersFromCard(card) -> AnswerStore` that runs
  each value through `validateAnswer` and `datesInOrder`, and inserts the
  session with those answers. The card columns are the source; `draft_inputs`
  holds the same values and stays unread.
- Trip type mapping, in `seedAnswersFromCard`: `family` → `family`, `couple`
  → `couple`. `group` and `other` are not seeded (Open question 3).
- `SessionView` (or `StartSessionResult`) carries a `seeded` summary
  (destination, dates) for the opening; `chat-router.ts` `renderDocumentOffer`
  (`:1307`) takes it and the organizer's name.
- `control-plane/api/src/intake-copy.ts`: new he/en strings for the seeded
  opening line ("Hi {name} — let's set up {destination}, {dates}.") placed
  before the existing introduction text; the rest of the introduction is
  unchanged.
- **Name rule (proposal, Open question 2):** the Telegram account's first name
  from the verified update (`telegramName`, already passed to `startSession`);
  if absent, no name. `users.display_name` is not used, for the reason
  `introductionReturning` already records.
- `relay/dispatch.ts:745`: passes the seed and the name through; no other
  relay change.
- No migration, no route change, no change to the dashboard.

## Non-goals

- Checking that the destination is a real place, or offering its main cities
  (#485, dashboard-first step 2). Any text the interview would accept from a
  typed answer is seeded.
- Month-and-year dates (#484). Today the card holds exact days or none; #484
  extends the seed and the greeting to a month when it lands.
- Recording the card as a source in `trip_answer_sources` (that table is
  document provenance: `documentId` is required, `answer-provenance.ts:25-35`).
- Retiring the Telegram interview (dashboard-first spec: not planned).

## Security and boundary notes

None of the three invariants in CLAUDE.md "Security-sensitive paths" applies.
The seed is read from the trip the enrollment names, inside the same
transaction, so no value crosses trips. The name in the greeting comes from the
verified Telegram update and is display data only; it is never used as an
identity or routing fact (the rule `startSession`'s own header states for chat
ids). The log line carries question ids, never values.

## Test plan

Written first:
- `control-plane/api/test/interview.test.ts` (unit): `seedAnswersFromCard`
  — `a full card seeds four answers`, `a start date alone seeds only the
  departure`, `an invalid value is not seeded`, `group and other are not
  seeded`.
- `control-plane/api/test/chat-router.test.ts` (DB, only with a `*test*`
  database): `a dashboard trip's session starts with the card's answers and
  asks none of them` (AC-1, AC-3); `a signup trip's session starts empty`
  (AC-7); `the seeded opening names the organizer, the destination and the
  dates in words` (AC-2, he and en).
- `control-plane/api/test/relay-dispatch.test.ts`: `the opening for a seeded
  start carries the seed line and the document offer` (AC-2).
- `control-plane/api/test/interview-transcript.test.ts` or the
  `recap-accepts-new-info-db.test.ts` harness: `a seeded date is corrected in
  words` (AC-4).
- Manual: one dashboard-created trip on Mac staging, interview opened from the
  card on a phone; record the opening text.

Suites: `control-plane/api` unit and DB.

## Rollout and regression

Relay and API restart; affects interviews started afterwards. A trip whose
interview is already running is not touched (its session already exists).
**Per-PR regression plan: needed** (router behaviour in a live interview, and
the session-start transaction).

## Open questions

1. **"Without asking who they are" — `organizer_identity`.** The trip-level
   organizer is already the account that created it. What the interview still
   asks is which traveller on the roster is speaking, and its prompt forbids
   inferring that from who signed up. Proposal: when the greeting name matches
   exactly one roster entry (`organizerMatch`, `interview.ts:381`), offer it as
   a one-tap confirm ("You're Dana on the list — right?") instead of the open
   question; otherwise ask as today. This relaxes a deliberate rule, so it is
   Dror's call. **No AC above depends on it**; adopting it adds an AC-9.
2. **Name source.** Telegram first name (proposed), the account's display name
   (the email's local part for a password signup), or a name asked on the
   dashboard form? **AC-2 depends on it.**
3. **Trip type `group` and `other`.** The interview has no plain "group"
   (`group_of_families` or a free-text "other"). Proposal: seed `family` and
   `couple` only, and ask the type for `group`/`other`. Alternatively, align
   the dashboard's options with the interview's. **AC-1's type half and AC-3
   depend on it** for those two values.
4. **Card follows the interview?** The card is never updated after the
   interview corrects a value (no writer, see Problem), which leaves two
   answers for one trip — against the dashboard-first guardrail "never two
   sources of truth". Write the confirmed destination and dates back to the
   card on intake confirm, in this item or a follow-up? No AC depends on it
   unless it is pulled in.
5. **"Could not be resolved" (round-2 wording).** This spec seeds whatever a
   typed answer would accept and leaves place recognition to #485. Is that the
   intended reading for Sprint 8? No AC depends on it.
