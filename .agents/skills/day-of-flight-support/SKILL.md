---
name: day-of-flight-support
description: Answer live flight-status, gate, terminal, and connection questions for the family trip using verified public sources plus the local trip plan.
version: 1.0.0
author: Hermes Agent
license: MIT
---

# Day-of flight support

Use this when the user asks operational flight questions such as:
- What gate are we leaving from?
- Is the flight delayed?
- Is the connection safe?
- Same terminal or do we need AirTrain / shuttle / train?
- Check again close to landing.

This skill is for **live, day-of travel support**. Prefer short, decisive answers suitable for WhatsApp/Telegram.

## Goals

1. Identify the exact flight segment from the trip plan or booking data.
2. Verify live status from current public sources.
3. Answer the user's concrete question first.
4. Add only the minimum extra logistics needed for a low-stress connection.

## Source order

1. local trip plan / booking data for the intended segment
2. live public flight-status source
3. airport/airline source if needed for terminal context
4. memory only as a last resort

Do not guess flight numbers, terminals, or gates.

## Workflow

### 1) Identify the exact segment
- Check the trip plan and booking notes first.
- Confirm date, route, and marketing vs operating carrier.
- For codeshares, keep both visible when useful, but use the **operating flight** for gate/terminal/status when public trackers expose it more clearly.
- If a narrow booking filter comes back empty, broaden to all flight bookings before concluding the segment is missing; some site entries are stored under a different trip phase than the city the traveler is asking about.

### 2) Pull live status
- Prefer a live tracker page that exposes structured status data.
- If the user points you to a specific source or URL (for example a FlightAware page), check that source directly rather than answering from a different tracker first.
- For **terminal-only departure questions** (for example, "which terminal do we go to?"), check the airport's own airline directory before or alongside a live tracker.
  - Example: Newark's official airline page (`/flights/airlines`) exposes airline-to-terminal mapping in the page's embedded `__NEXT_DATA__` JSON. For American Airlines at EWR, the record includes `"terminals":["A"]` and `"optionalColumnInfo":"Level 2"`.
  - Use the airport directory for the terminal/check-in area, then still treat the gate as live data that can change.
- A reliable pattern for quick verification is to fetch the public FlightStats flight-tracker page and inspect the embedded `__NEXT_DATA__` JSON for fields such as:
  - `flightNote.message`
  - `departureAirport.terminal`
  - `departureAirport.gate`
  - `arrivalAirport.terminal`
  - `arrivalAirport.gate`
  - `arrivalAirport.baggage`
  - `schedule.scheduledDeparture`
  - `schedule.estimatedActualDeparture`
  - `schedule.scheduledArrival`
  - `schedule.estimatedActualArrival`
  - `operatedBy`
- For codeshares, check the **operating flight's own public tracker page first** when the user is asking about delays, gates, or live departure status. Example: for LY4281 operated by Delta, inspect **DAL496 / DL496** directly rather than trusting only the LY page.
- FlightAware pages for the operating flight often expose the most current gate and delay data inside the page source, including fields like origin/destination `gate`, `terminal`, `takeoffTimes`, `gateDepartureTimes`, `landingTimes`, and `gateArrivalTimes` on the current-day flight instance.
- If the marketing-flight page and the operating-flight page disagree, say that explicitly and prioritize the **operating carrier's current-day record** for live ops.
- If the user asks for the airline's own site, try the official site/app path. If the site is blocked by anti-bot or cannot be read programmatically, say so plainly and fall back to the airline app/airport display or the best available public tracker; do not imply you verified the airline site if you could not.
- If one source is thin, cross-check with another public tracker before answering.
- If the itinerary/booking screenshot clearly identifies the segment but public trackers map the same flight number to the reverse direction or fail to list it in departures, treat that as an unresolved identity mismatch. Confirm the itinerary details from the booking, but do **not** claim the family's flight already landed or departed based on the opposite-direction record alone.
- In that mismatch case, prefer the next higher-trust operational source: airline app, airport board, gate screenshot, boarding pass, or airline SMS.

### 3) Answer in mobile-first order
For flight-status questions, use this order:
1. direct answer to the asked question
2. flight number / route if needed for orientation
3. scheduled vs estimated time
4. terminal / gate
5. one short connection implication

### 4) Connection guidance
- For US first-entry international arrivals, assume the family may still need immigration/customs and often security re-clearance.
- Distinguish clearly between:
  - **same terminal**
  - **same concourse / different concourse**
  - **different terminal needing AirTrain / shuttle / train**
- Do not tell the user they need a train unless you verified the terminals differ or the airport layout requires it.

### 5) If the user asks to check again later
- Add a todo for the follow-up check.
- When you report back later, re-verify times and gate because gates change.

## Response style

- Keep it short.
- Lead with the operational answer, not the process.
- When the status is on time or early, say that plainly.
- Compare **scheduled** and **estimated** explicitly; do not vaguely imply "delay" when the estimate is actually on time or early.
- If the user challenges your phrasing, tighten the answer and restate the facts directly.

## Travel-term disambiguation

In this trip profile, words like `terminal`, `gate`, `arrival`, `departure`, `boarding`, `connection`, and `check-in` should default to the **travel/airport meaning**.

Especially important:
- if the user says `terminal` in the context of flights, airports, pickups, departures, or arrivals, interpret it as the **airport terminal** first
- do **not** jump to the shell/command-line `terminal` tool unless the user clearly signals computing intent with cues like `command`, `bash`, `shell`, `ssh`, `logs`, `machine`, or explicit Hermes/system troubleshooting
- if a question could plausibly mean either airport terminal or shell terminal, prefer the airport meaning first and answer the travel question before considering technical tooling

## Good pattern

- "כן — אותו טרמינל. כרגע LY7 נוחתת ב-JFK טרמינל 4 בערך 14:53, וההמשך ל-DFW יוצא מטרמינל 4, שער A11 ב-17:59. כלומר אין צורך ב-AirTrain, אבל עדיין יש הגירה ובידוק מחדש."

## Pitfalls

- Do not rely only on the marketing flight number when a codeshare is operated by another airline.
- Do not trust a codeshare page's "on time" banner if the operating carrier's live page shows a delay or a newer gate; the operating carrier can update first.
- When scraping tracker pages with multiple historical flight instances, make sure you are reading the **current-day instance/permalink**, not a previous day's gate/time block.
- Do not mix scheduled and estimated times without labeling them.
- Do not say "looks delayed" or offer to check delay when the flight is currently on time/early.
- Do not over-explain airport mechanics when the user asked only about gate/terminal.
- Gates can change close to departure; for later re-checks, always refresh live status.

## References

- `references/public-flight-status-sources.md` — concise notes on public sources and what fields are useful.
- `references/codeshare-flight-status-notes.md` — source-priority and current-day-instance notes for codeshare/live tracker checks.
- `references/airport-terminal-directory-notes.md` — airport-directory lookup patterns for terminal/check-in questions such as EWR airline-to-terminal mapping.
- `references/den-airport-rental-and-dropoff.md` — DEN-specific notes for Jeppesen Terminal drop-off, Budget return address, and the shuttle-back flow after car return.
