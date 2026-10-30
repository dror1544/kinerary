# A second ticket's travellers are read, not dropped

Status: draft, refreshed against 4510301 (2026-10-30) · Issue: #412 · Track: T1 · Size: M · Tier: Normal
Security path: no · Migration: no · Live-trip behaviour: yes (the interview, for new trips)

> **Sprint 8 (2026-10-30): in scope.**

Related: #414 has a **separate** root cause and its own spec
(`414-reservation-carries-its-travellers.md`), which builds on this one's
fixture. #413 is what happened next in the same run.

## Problem

Owner's gate-3 run, 2026-10-18 (`france-2026`; run note
`$KINERARY_NOTES_DIR/run-notes/2026-10-18-gate3-manual-test.md`). Two flight
tickets were uploaded with the same dates and different couples. The first
couple was read; the second was not, and the organizer had to type them.

The run's own `interview.document_committed` log and `trip_answer_sources` rows
were not read for this spec, so the cause is **narrowed, not proven**. What the
code allows (`control-plane/api/src/`):

- **Every document is read on its own**, against every document-answerable
  question, `travelers` included (`document-intake.ts:384-470`, `:416`;
  `interpret.ts:1807-1817`). All readings of a burst then pass **one gate**
  (`document-gate.ts:64-149`).
- **Candidate 1: a low-confidence second slice is dropped silently.** In
  `decideStructured`, each slice of a structured answer is judged on its own
  merits first. A slice below the 0.7 floor (`interpret.ts:773`) is rejected
  `LOW_CONFIDENCE`. It is kept as a suggestion **only when no slice for that
  question passed** (`interpret.ts:1068-1070`). Still true on 4510301. With the first ticket's travellers
  passing, the second ticket's are rejected and not suggested. Nothing asks
  about them, because `travelers` is now answered.
- **Candidate 2: evidence.** A proposal must quote its own document
  (`document-gate.ts:78-87`). The traveller rule asks for `name` in the
  interview's script and `name_en` exactly as printed (`travelerNamesRule`,
  `interpret.ts:1376-1400`).
  If the model's evidence is the Hebrew rendering, it is not in the PDF, and
  the slice is rejected `EVIDENCE_NOT_IN_SOURCE`. That is also not asked about
  once `travelers` is answered (`document-gate.ts:120-121`).
- **Not the cause, by reading.** The person matcher (`answer-merge.ts:155-216`)
  needs every word of one name accounted for in the other. Two couples with
  different given names do not merge.
- No test has two tickets for two different travel parties:
  `document-reconcile.test.ts:163-276` covers one person printed two ways;
  `answer-merge.test.ts:114` covers bookings, not travellers.

**What changed on main since this was drafted (03c0e1c → 4510301).**

- **#339 (`da74f26`, follow-up `b3777c1`) closed the "later upload" half.**
  `suggestFrom` (`interpret.ts:936-975`) now reconciles an unsure reading of a
  structured question that already holds an answer into that answer
  (`reconcileStructured` + `mergeOptionsFor`, the accepted path's own helpers)
  and offers the **union**; a reading that adds nothing is refused
  `NO_NEW_INFORMATION` and not offered. So a later upload whose only reading of
  `travelers` is below the floor is already offered as "held couple + couple 2",
  and a Yes keeps couple 1 (`gate-reconcile.test.ts:196` "travellers: an unsure
  newcomer is offered on top of everybody held"; `relay-poller.test.ts` "held
  phases and travellers survive a Yes (#339)"). That is the old AC-4 at gate
  and tap level.
- **The same-burst half is unchanged.** `decideStructured`
  (`interpret.ts:1058`) still returns early to `suggestFrom` only when
  `passing.length === 0` (`:1070`); with couple 1 passing, couple 2's
  `LOW_CONFIDENCE` slice is rejected and nowhere offered.
- **A second drop in the relay, not seen at drafting.** Even if the gate
  returned couple 2 in `suggested`, the poller keeps a suggestion **only for a
  question this read did not just answer**
  (`relay/poller.ts:2265-2266`, `if (recorded.includes(…)) continue`). So the
  same-burst fix needs the relay too.
- **Where a stored suggestion is shown.** A suggestion is drawn only when the
  router next asks that question (`renderStep`, `relay/poller.ts:2130-2136`).
  For an already-answered `travelers` that may be never; see open question 2.

## Behaviour

Two tickets for two parties, uploaded together or one after the other, give the
interview all four travellers, each with the ticket's printed Latin spelling in
`name_en`. If a ticket's travellers cannot be accepted (low confidence, a
quote that does not match), the organizer is shown them as a suggestion: "The
second ticket also names A B and C D — add them?". They are never dropped
without a word.

## Acceptance criteria

- AC-1 Given two documents in one burst, each proposing `travelers` with two
  different people and confidence ≥ 0.7, then the accepted `travelers` holds
  all four, and `sources.get("travelers")` names both documents.
- AC-2 Given the same burst where document 2's `travelers` slice has confidence
  0.5, then document 2's people are returned in `suggested` (not only in
  `rejected`), and the relay asks about them in the recap.
- AC-3 Given document 2's slice whose evidence is the Hebrew rendering but whose
  `name_en` values appear verbatim in document 2's text, then the slice passes
  the evidence check (evidence may be satisfied by `name_en` as printed).
- AC-4 Given `travelers` already held with couple 1, when a later upload
  proposes couple 2 below the floor, then couple 2 is offered as a suggestion,
  and couple 1 is unchanged. **Gate and tap: already true on main (#339,
  `da74f26`).** What remains is that the organizer actually **sees** the offer
  for an answered `travelers` (same delivery as AC-2); the test here is only
  that delivery.
- AC-5 (fixture) Given `control-plane/api/test/fixtures/two-parties-same-flight/`
  (two invented ticket texts: the same flight and date, different PNRs and
  passengers), when run through `gateDocumentProposals` with recorded model
  readings, then AC-1 holds.

## Contracts

- `control-plane/api/src/interpret.ts` `decideStructured` (`:1058-1151`): an
  unsure slice of a question that also has a passing slice is returned in
  `suggested` for its **new entries only** (entries that do not match a passing
  slice). Build it through `suggestFrom`'s #339 reconcile, with the combined
  passing answer standing in for `held`, so a Yes writes the union and never
  the unsure slice alone.
- `control-plane/api/src/document-gate.ts` (`:78-87`): for `travelers`, a
  slice's evidence check also accepts the case where every proposed `name_en`
  appears in the document. This keeps "each proposal quotes its own document".
- `control-plane/api/src/relay/poller.ts`: keep a `travelers` suggestion even
  when this read recorded `travelers` (`:2265-2266` skips it today), and show
  it to the organizer in the document reply rather than waiting for a question
  the router will not ask again (`renderStep`, `:2130-2136`).
- `control-plane/api/src/intake-copy.ts`: he/en "the second ticket also names …
  add them?".
- New fixture, with invented names only.

## Non-goals

- Tying travellers to their own flight (#414 / #415).
- Asking the model differently. The prompt is left as it is unless the
  fixture's recorded readings show the model never proposed couple 2. If so,
  that becomes an open question here.

## Security and boundary notes

No invariant applies. The fixture names must be invented
(`test_template_sources_use_placeholders_for_people` posture; real family data
stays out of the public repo).

## Test plan

Write first:
- `control-plane/api/test/document-reconcile.test.ts`:
  - `two tickets for two parties give all four travellers` (AC-1, AC-5)
  - `a low-confidence second party is suggested, not dropped` (AC-2)
  - `a traveller slice quoted in the interview's script passes when name_en is printed` (AC-3)
- `control-plane/api/test/interpret.test.ts`:
  `an unsure slice beside a passing one keeps its new entries as suggestions`.
- `control-plane/api/test/relay-poller.test.ts` (DB, only with a `*test*`
  database): `an unsure second party beside an accepted first is shown to the
  organizer` (AC-2) and `a later upload's unsure travellers are shown, not only
  stored` (AC-4's remaining delivery half). The #339 gate/tap tests already
  cover the union.

Suites: `control-plane/api` unit and DB. Manual, before build: read the
france-2026 `interview.document_committed` line's `rejected_questions` /
`suggested` on Mac staging. That is a read-only probe, and it tells which
candidate it was.

## Rollout and regression

Relay restart; affects interviews started afterwards. No trip site changes.
**Per-PR regression plan: needed** (gate behaviour in live interviews, but
narrow: it only adds suggestions).

## Open questions

Size: unchanged (M). #339 removed AC-4's gate work, but the relay half found on
refresh (the `recorded` skip and the delivery of a suggestion for an answered
question) adds about as much.

1. Can the lead read the france-2026 session's commit log line on staging
   before build? It decides between candidate 1 and candidate 2, and the spec
   keeps both fixes only if both turn out to be live.
2. (new) How is an offer for an **already answered** `travelers` shown? Today
   a stored suggestion appears only when the router asks that question again.
   Options: (a) a line plus Yes/No in the document reply itself; (b) at the
   final summary/confirm step; (c) both. (a) is what the Behaviour text
   promises ("The second ticket also names … — add them?").
