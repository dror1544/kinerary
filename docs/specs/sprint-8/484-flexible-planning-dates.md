# Flexible planning dates: month and year until execution needs exact days

Status: draft (2026-10-30) — **blocked on three product questions** (Open questions 1–3) · Issue: #484 · Track: T1 · Size: L · Tier: High
Security path: no (expected; re-check once the data shape is chosen) · Migration: yes (expected: the trip's date kind) · Live-trip behaviour: yes (new trips; the interview; the dashboard)

> **Sprint 8 (2026-10-30): in scope at lower priority** — after the hardening items, sequenced after #382/#383 because it touches trip dates. Not to be approved or built until Dror answers the three product questions below. #484 is the first item to slip if the sprint runs long.

Product spec (goal, rule, the gate, reasons): notes folder,
`specs/2026-10-30-flexible-planning-dates.md`. This file is the implementation
side only and does not restate or decide the product rules.

## Problem

Exact days are demanded everywhere today, from the first form onwards, so an
organizer who knows only "Japan, April 2027" has to invent dates, and the
invented dates spread into everything built from them (product spec, "Why").

Where exact days are assumed today (traced on 4510301, 2026-10-30):

- **Dashboard card.** `POST /v1/trips` accepts only `YYYY-MM-DD` for
  `startDate`/`endDate` (`control-plane/api/src/portal.ts:1321-1322`); the
  columns are `date` (`control-plane/db/migrations/0020_web_portal.sql:7-8`,
  ordering check `:11`). The card shows "Dates are flexible" when they are
  empty (`web/src/pages/ProductApp.tsx:136`), so "no dates" exists but "a
  month" does not.
- **Interview.** `departure_date` and `return_date` are **required**
  questions (`control-plane/api/src/interview.ts:642-660`); the re-ask copy
  asks for "a day and a month" (`:2233-2251`); `datesInOrder` (`:372-378`)
  compares ISO days.
- **Site build.** The worker resolves the trip's days from those answers and,
  when they are missing, **invents** a departure 90 days from today
  (`control-plane/worker/control_plane_worker/transformer.py:235-258`) — the
  invented-date failure the product spec describes, already in code.
- **Companion daily features.** The handoff schedules a morning briefing in
  the trip's timezone (`transformer.py:896-900`), which needs real days.
- **Stops.** Dated stops and a hotel set as a stop's accommodation validate
  day ranges (`server/trip-structure.js:410`, `validateDates`; `rangeError`,
  `:956`).
- **Lifecycle.** `generatePlan` (`control-plane/api/src/planner.ts:34`) moves a
  confirmed intake toward a build; nothing there asks whether the dates are
  exact.
- **#438** (dashboard trip seeds the interview) seeds exact dates only; the
  owner's #438 comment says a month-only card must be greeted with the month
  and no question about days, which needs this item.

## Behaviour

To be written once the three product questions are answered. What is already
fixed by the product spec and is not reopened here: a trip's dates are
**approximate** or **exact**; the gate (building the site, the companion's
daily features, dated stops and a hotel set as a stop, moving to execution)
needs exact days; a booking with dates proposes exact dates and is never
applied silently; a mismatch with the approximate month is said out loud.

## Acceptance criteria

Not written yet: several depend on the open questions (a span of months or
one month; whether the interview offers exact days; what a built trip does).
The ones below do not, and are expected to survive in some form:

- AC-A (draft) Given a trip whose dates are approximate, when a site build is
  requested, then the build is refused with a named reason and the organizer is
  asked once for exact dates, with what they unlock — the worker never invents
  a date (`transformer.py:250-258`'s 90-day fallback is not reached for such a
  trip).
- AC-B (draft) Given a confirmed booking whose dates fall in or near the
  approximate period, then exact dates are **proposed** to the organizer and
  stored only on their confirm.
- AC-C (draft) Given exact dates outside the approximate month, then the
  proposal says so ("you planned April; this flight is in May") and the
  organizer's answer is accepted.
- AC-D (draft) Given a trip created today with exact dates, then nothing about
  its interview, build or site changes (regression pin for every existing
  path).

## Contracts (candidates, not decisions)

To be chosen in the approved version; listed so the questions can be answered
with their cost in view:

- `control-plane.trips`: a date kind plus an approximate period (for example a
  month, or a month span, depending on Open question 1) beside the existing
  `start_date`/`end_date`. A migration, `YYYYMMDDHHMMSS_*.sql` with its
  `-- rollback:` header (`docs/migrations.md`).
- `portal.ts` `POST /v1/trips` and the card (`ProductApp.tsx`): accept and
  show a month.
- `interview.ts`: the date questions accept an approximate answer and are no
  longer required for every intake; the gate moves to the build.
- Worker: the build refuses an approximate trip instead of inventing days.
- `server/trip-structure.js`: unchanged for exact trips; an approximate trip
  has no built site to reach it (if Open question 3 is answered "not
  allowed").
- #438's seed and greeting: say the month, ask no days.

## Non-goals

- Nights-per-city routing and the seasonal insight on the dashboard (#485,
  #486; dashboard-first steps 2–3).
- #433 (date control defaults and direction) — related, separate.
- #464 (planned-trip sites sleep) — pairs with it, separate.

## Security and boundary notes

Expected none of the three invariants: dates are already served by
`/api/config` through the allow-list, and an approximate trip has no site
until its dates are exact. Re-check when the data shape is chosen; if a new
config field reaches a site, it is a `shared/config-visibility.js` allow-list
decision.

## Test plan

To be written with the acceptance criteria. Expected suites:
`control-plane/api` (unit and DB, with the migration), worker,
`web`, `tests/` only if a site field changes.

## Rollout and regression

New trips only; existing trips keep exact dates. **Regression plan: needed**
(a migration, interview behaviour, and the build gate). Sequenced after
#382/#383 so the date-touching work lands on one settled base.

## Open questions — blocking (from the product spec, not answered here)

1. Is a span of months allowed ("April–May 2027"), or only one month?
2. Should the interview offer "do you know the exact days yet?", or never ask?
3. What does a trip that is already built show if its dates later become
   approximate again? (The product spec proposes "not allowed: once a site is
   built, its dates are exact"; it is not decided.)

Each changes the data shape, the interview's questions or the build gate, so
no acceptance criterion beyond AC-A to AC-D is written until all three are
answered.
