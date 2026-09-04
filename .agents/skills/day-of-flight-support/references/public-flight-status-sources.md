# Public flight-status sources

Use these for day-of operational answers after identifying the exact segment from the trip plan.

## FlightStats
- Good for terminal, gate, baggage, scheduled time, estimated time, and `operatedBy`.
- The public tracker page often contains embedded structured JSON that is easier to parse than the rendered HTML.
- Useful fields:
  - `departureAirport.terminal`
  - `departureAirport.gate`
  - `arrivalAirport.terminal`
  - `arrivalAirport.gate`
  - `arrivalAirport.baggage`
  - `times.scheduled`
  - `times.estimatedActual`
  - `operatedBy`

## FlightAware
- Good secondary cross-check for route identity and overall live tracking.
- Can confirm airport pair and general status when another source is ambiguous.

## Airport / airline pages
- Use when terminal context or connection instructions are needed.
- Helpful for verifying whether a same-terminal connection avoids AirTrain/shuttle.

## Codeshare reminder
- If the trip plan shows a marketing flight number but the tracker exposes `operatedBy`, prefer the operating carrier's live status details for gate/terminal guidance.

## Messaging reminder
- For family chat or direct WhatsApp support, answer with the operational takeaway first:
  1. on time / delayed / early
  2. gate / terminal
  3. connection impact
