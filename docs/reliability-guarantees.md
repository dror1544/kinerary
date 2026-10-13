# Reliability guarantees: state consistency and constraint preservation

Two guarantees Kinerary makes to a trip's organizer. Each has a product metric
and a set of scenarios that are meant to run as regression tests, not only to be
counted after something went wrong.

| | Guarantee | Metric |
|---|---|---|
| **A. State consistency** | Once a correction is approved and committed, everything downstream uses the new value, and an older state never overwrites a newer one. | Stale-state incidents per trip; target zero. |
| **B. Constraint preservation** | A change keeps every fixed commitment and yields a feasible schedule; if it cannot, the conflict is explained and the organizer is asked, and nothing is silently altered. | Share of applicable mid-trip changes that meet all four conditions below. |

An **incident** for A is any time the companion or the trip site presents
information that was previously corrected, even when the database already holds
the right value. A **successful change** for B (a) keeps every fixed commitment
unless the organizer explicitly authorizes changing or removing it, (b)
introduces no conflict, counting transfer times and safety buffers, (c) does not
silently drop or alter a commitment to make the new plan look valid, and (d)
asks the organizer, naming the conflict, when the request cannot satisfy the
existing constraints. Rejected and unresolved proposals are reported next to
applied ones, so refusing every hard change cannot score perfectly.

Measurement today uses data that already exists; nothing here adds tracking. The
definitions are in the product requirements document, section 5.

## Scenarios and where they stand

Status: **covered** (a test asserts it), **partial** (the path is tested, the
scenario is not), **todo** (stated as a `todo` test or an issue; the product does
not yet honour it), **open** (not yet written).

### A. State consistency

| Scenario | Status | Where |
|---|---|---|
| A1 Flight time corrected; later plan, site and agent show the new value | partial | Held answers: `typed-changes-flow-db.test.ts` ("applied exactly on confirmation"). Regeneration: `test_transformer.py` (`test_a_corrected_time_replaces_the_old_one_on_regeneration`). Not yet: served `/api/config` and the companion's `get_config` after a correction. |
| A2 Booking updated; previous details not shown as current | partial | `tests/server.test.js` (PATCH). Not yet: the linked plan item shows the new details. |
| A3 Consecutive corrections; older cannot overwrite newer | covered (organizer side), partial (live site) | `typed-changes-*-db.test.ts` (stale confirmation applies nothing), `document-correction-flow.test.ts`, `reliability-guarantees.test.ts`; live site: `modern-parity.test.js` (If-Match 409). Bookings and classic plan items have no ordering guard. |
| A4 Consistent after restart, context rebuild or regeneration | partial | `plan-single-source.test.js`, `intake-correction.test.ts`, `test_transformer.py`. Not yet: a document re-read after a typed removal; the companion's rebuilt context. |

### B. Constraint preservation

| Scenario | Status | Where |
|---|---|---|
| B1 Activity extended into the transfer to a fixed reservation | todo | `reliability-guarantees.test.ts`; plan review compares start times only. |
| B2 Move between destinations where travel time conflicts | partial | `plan-review.test.ts` (hop between districts, missing transfer); no test that a move creates the conflict. |
| B3 Destination dates overlapping another destination | covered | `typed-changes.test.ts`, `typed-changes-flow-db.test.ts`. |
| B3 Dates shrunk so a confirmed booking falls outside every stop | todo | `reliability-guarantees.test.ts`; only removed stops are compared with bookings. |
| B4 Remove or reschedule a fixed booking without authorization | partial | Typed changes leave bookings in place and warn (`reliability-guarantees.test.ts`). The live site's `PATCH /api/bookings/:id` has no confirmation step. |
| B5 Unsatisfiable change explained and asked about | covered (stops, travellers), open (live itinerary) | `typed-changes-flow-db.test.ts`, `plan-review.test.ts`. The live-itinerary edit routes record an overlap afterwards instead of asking. |

`reliability-guarantees.test.ts` runs without a database or a model:
`cd control-plane/api && node --import tsx --test test/reliability-guarantees.test.ts`.
A `todo` there is reported and does not fail the suite; when the product
honours the guarantee, remove the `todo` option.

## What needs more than a test

These need product work first and are tracked as issues, not hidden in tests (#382 corrected booking reaching the site, #383 ordering guard, #384 live itinerary conflicts, #385 cross-boundary check):
ordering guards on bookings and classic plan items, a conflict check on the live
itinerary's edit routes, durations in plan review, and the cross-boundary
consistency check (database, generated content, site, agent context) that
detects an outdated fact after a correction has been committed.
