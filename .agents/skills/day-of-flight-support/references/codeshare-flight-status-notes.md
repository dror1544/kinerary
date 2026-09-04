# Codeshare flight-status notes

Use these notes when a family member asks about a live flight and the booking uses a marketing carrier number plus an operating carrier number.

## Source priority for live ops

1. User-specified source URL, if they gave one
2. Operating carrier's current-day tracker record
3. Marketing carrier / codeshare tracker record
4. Airport or airline app display for confirmation when available

## FlightAware pattern

FlightAware pages often include multiple historical instances of the same flight in page source.
When scraping or inspecting the source:
- identify the current-day `permaLink`
- match the current date, route, and scheduled time
- prefer the current-day instance's:
  - `gateDepartureTimes`
  - `takeoffTimes`
  - `landingTimes`
  - `gateArrivalTimes`
  - origin/destination `gate` and `terminal`

Do not quote gate/time values from an older instance just because they appear first in the source.

## Messaging rule

If two sources disagree, say so in one short sentence and state which source you are trusting for live ops.
Example: "FlightStats still shows on time, but Delta/FlightAware for DAL496 shows a 21-minute delay, so I'm using the Delta operating-flight data."

## Official-airline-site fallback

If the user specifically asks for the airline's own site and it cannot be read programmatically, say that directly and recommend trusting:
- the airline app
- airport departure board
- agent at check-in/gate

Do not claim the official site was checked successfully if it was not.
