---
name: trip-flight-status-check
description: Check live flight status for the family trip, especially codeshares, with correct source priority and conflict handling.
version: 1.0.0
author: Hermes Agent
created_by: agent
---

# Trip flight status check

Use this when Dror or a family member asks about a flight's live status, delay, gate, terminal, or connection risk.

## Goal

Give the most reliable current answer for:
- departure time
- arrival time
- delay status
- gate / terminal
- connection practicality

Especially avoid false "on time" answers on codeshare flights.

## Core rule

For codeshare flights, prefer the **operating carrier flight** over the marketing flight number.

Example:
- `LY4281` operated by `Delta 496`
- check `DAL496` / `DL496` first
- use the El Al codeshare page only as a secondary source

## Source priority

Use sources in this order when available:
1. **Official screenshot / airline app / airport board** provided by the user
2. **Operating carrier live status page**
3. **Airport live departures/arrivals page**
4. **Marketing/codeshare page**
5. Aggregators only as supporting evidence

If a user sends a screenshot, analyze it immediately and prioritize it over older web results.

## Workflow

### 1) Identify the actual flight
Extract:
- marketing carrier + flight number
- route
- date
- likely operating carrier if shown in trip plan or web results

If the trip plan says "codeshare" or a tool result says "operated by", switch to the operating carrier lookup.

### 2) Check the operating flight first
Look up the operating flight on a live tracker / airline page.
Capture separately when available:
- gate departure time
- takeoff time
- scheduled departure
- estimated departure
- scheduled arrival
- estimated arrival
- departure gate + terminal
- arrival gate + terminal

If the user later corrects the flight number, rerun the lookup directly on the corrected number immediately instead of trusting an earlier airport departure-board search. Departure-board listings can omit or lag the exact flight you need, while a direct flight-number lookup often resolves the ambiguity fast.

Implementation note for current public trackers:
- FlightStats may expose the live payload as a `__NEXT_DATA__ = {...};` inline assignment rather than a `<script id="__NEXT_DATA__">` tag. When parsing it programmatically, cut the JSON at the `;__NEXT_LOADED_PAGES__` marker instead of assuming the whole script block is pure JSON.
- When FlightStats shows `flightNote.phase` like `Cruising` plus `hasDepartedGate=true` / `hasDepartedRunway=true`, treat that as confirmation the flight already departed even if another status label still says `Scheduled` or the actual timestamp fields are still blank.

### 3) Check the marketing/codeshare page second
Use it only to compare, not as the primary truth source.

### 4) Handle source conflicts explicitly
If two sources disagree, do **not** flatten them into a confident single answer.
Say clearly:
- which source shows the delay/change
- which source still shows old data
- which one you trust more and why

Default trust rule:
- official airline / airport / user screenshot beats aggregator
- operating carrier beats codeshare listing
- if Google/Gemini/user-reported airport info already shows a delay, escalate immediately to official/operator verification instead of repeating the older "on time" reading

If the user says they already see a delay or points to a screenshot/app/board, treat that as a signal to re-check now from higher-priority sources, not as a minor disagreement.

### 5) For connection questions
Compute:
- scheduled connection time
- updated connection time based on latest estimate
- whether same terminal or terminal transfer is needed

Also mention:
- immigration / bags / recheck if arriving in the US from abroad
- whether AirTrain / shuttle / train is needed between terminals

### 6) For user-facing replies
Lead with the operational answer first:
- delayed or on time
- current gate
- terminal
- what to do next

Then optionally note uncertainty or source conflict in one short line.

### 6.5) Baggage belt / claim checks after landing
If the user asks about the baggage belt / baggage claim / belt number:
- re-check it live at answer time; do **not** rely only on an older snapshot or an earlier sent message
- prefer the source that exposes an explicit baggage/claim field for the arrival airport
- if the belt changed after landing, say the updated belt plainly and treat it as the current answer
- when drafting a group-facing arrival message, include the belt only if it is currently present in the live result

### 7. If the user asks for ongoing monitoring
When the user asks to keep checking until landing / until status changes:
- create or update a TODO for the monitoring task
- schedule a recurring check cadence that matches the request (for example every 5 minutes)
- for a two-minute request, use a bounded poller that emits only the initial state and material changes, not a message on every unchanged poll
- stop only when the flight is no longer airborne or the requested milestone is reached; for a pre-departure request, stop after confirmed gate/runway departure
- send a concise update when the state materially changes (delay estimate, gate assigned, departed, landed)
- if the user corrects the flight number, discard the prior lookup and restart the monitor for the corrected flight/date/route immediately; never carry the earlier flight's status into the corrected answer

## Required behavior with images

If the user sends an image of:
- airline SMS/email
- airport board
- app screenshot
- boarding pass

Use vision immediately and extract the updated operational facts before answering.

## Pitfalls

- Codeshare pages can lag behind the operating carrier.
- Aggregators may show stale "on time" while the operator page already reflects a delay.
- Historical flight pages can be mistaken for today's flight; verify date and route.
- Gate departure and airborne departure are different; do not mix them.
- In the US, same terminal does not mean an easy connection if immigration/recheck is required.
- A public tracker can sometimes surface the same flight number in the **opposite direction** from the itinerary entry. If the booking says `EWR -> DFW` but live sources show `DFW -> EWR`, do **not** force a confident answer about whether the family's flight departed.

## Reverse-direction mismatch handling

If the itinerary/booking says one direction but live trackers show the same flight number in the reverse direction:
1. check an airport departures board for the stated origin airport on the travel date
2. confirm whether the exact flight number appears in departures at all
3. if the reverse-direction mismatch remains unresolved, answer explicitly that departure is **not yet verified**
4. ask for a boarding pass screenshot, airline app screenshot, or PNR to lock the exact live segment

Preferred wording: the itinerary says `EWR -> DFW`, but current public trackers for that flight number show the reverse segment, so I cannot confirm departure yet.

## Verification checklist

Before replying, verify:
- right travel date
- right route
- whether this is today's flight, not yesterday's
- operating carrier identified correctly
- delay claims grounded in current source data
- gate/terminal labeled as current or estimated

## Recommended wording pattern

- Status: delayed / on time
- Flight: marketing + operating carrier if relevant
- Departure: terminal, gate, updated time
- Arrival: updated time, gate if known
- Connection note: enough time / tight / same terminal / transfer needed
- Source conflict note if relevant
