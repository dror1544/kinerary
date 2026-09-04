---
name: trip-confirmation-intake
description: Extract booking details from traveler-supplied confirmations, match them to the family trip plan, and update the trip website or leave a verified local handoff when blocked.
version: 1.0.0
author: Hermes Agent
license: MIT
---

# Trip confirmation intake

Use this when the user sends a PDF, screenshot, email export, or other booking artifact and asks to add it to the trip site, match it to the itinerary, or summarize the reservation.

## Goal

Turn a raw confirmation file into a verified trip artifact with:
1. extracted fields,
2. a match to the correct trip phase/date/item,
3. a website update when credentials/MCP access allow it,
4. and a local handoff note when the final write is blocked.

## Sources and authority

Prefer sources in this order:
1. the uploaded confirmation file,
2. the local read-only trip plan (`trip-plan-readonly/`, `obsidian-readonly/`),
3. the trip website / MCP data,
4. memory only as a last resort.

Do not invent booking details, prices, passenger counts, confirmation numbers, or page matches.

## Workflow

### 1) Extract the document contents
- For PDFs, use the document/OCR workflow first.
- If lightweight Python extraction is enough, a terminal-side extraction path is acceptable.
- For traveler-forwarded confirmation PDFs, expect Gmail/email wrapper pages around the actual reservation. Extract the reservation body and ignore browser chrome like `mail.google.com`, timestamps, and footer/legal text unless they help verify provenance.
- If a direct file read shows mostly PDF internals/binary noise, switch immediately to terminal-side PDF text extraction rather than trying to parse the raw file contents in-chat.
- Keep the original file path in your notes.
- Extract only grounded fields; if a field is absent, mark it unknown.

Typical fields to capture:
- booking/vendor name
- confirmation number
- reservation holder
- date / start date / end date
- time
- location / address
- passenger or guest counts
- price / total cost / currency
- contact info
- ticket or voucher class/counts
- for lodging: room type, check-in/check-out windows, and room-specific facilities (refrigerator, microwave, kitchenette, stovetop, etc.); distinguish amenities stated for the booked room from amenities that exist only in some room categories
- for flights specifically: distinguish clearly between the agency/travel reservation code and the airline booking code used for check-in; when both appear, capture both and prefer the airline booking code in the booking `confirmation` field if the user says that is the operational code they need

### 2) Match to the itinerary
- Search the read-only trip plan for the venue/activity/hotel/route name.
- Match by date first, then city/phase, then activity type.
- For flights, file the booking under the phase/city the family is departing from, not the arrival city.
- For transportation between phases, assign the booking to the **arrival phase/city** when the booking represents the handoff into the next stop (for example, EWR→DFW on the Dallas transfer day belongs under `dallas`, not `nyc`).
- If two subsets of travelers on the same nominal flight have different **airline booking codes**, do not force them into one booking entry. Split them into separate site bookings when needed so each entry has one operational check-in code.
- Record the exact file and section/day that supports the match.
- If the mapping is not obvious, write a confirmation-matching note before any site write.

### 3) Choose the website destination
- `flight` for air legs
- `hotel` for lodging
- `car` for rentals / transfers if represented as cars
- `attraction` for tickets, timed entries, shuttles, tours, rail rides, etc.
- `other` only when none of the above fit cleanly

### 4) Attempt the trip-site update
- If MCP website access is available, add or update the booking in the matching phase.
- When the user sends a **replacement confirmation for an existing booking** (for example the same hotel but with a corrected checkout date, new Booking.com confirmation number, or updated room count), prefer updating the existing site entry instead of creating a duplicate.
- For replacement hotel confirmations, update the fields most likely to change together: `date_from`, `date_to`, `confirmation`, `pin`, `passengers`, `cost`, and `conf_file`.
- If the confirmation includes practical day-of details the family will care about — especially parking, number of units, or in-room food facilities like refrigerator / microwave / kitchenette / stovetop — add a short verified note to the booking rather than leaving those facts trapped in the PDF.
- If you discover an existing booking is in the wrong phase, first check whether the available update tool can change `phase`. If it cannot, do **not** silently delete/recreate. Tell the user phase is immutable through the current MCP tools and ask before recreating the booking in the correct phase.
- Include concise notes with the operational details the family will need day-of.
- Prefer one clean booking entry rather than a long narrative dump.

### 5) If website write is blocked
- Do **not** pretend the site was updated.
- Save a handoff note under `notes-rw/confirmation-matches/` containing:
  - source file path
  - extracted facts
  - matched itinerary item
  - suggested booking payload / site placement
  - blocker encountered (for example: auth required)
- Tell the user exactly what succeeded and what remains blocked.

## Output format for the user

Keep the reply compact and mobile-friendly:
- one-line status,
- matched itinerary item,
- extracted essentials in a short list or table,
- explicit blocker if the site write failed.

## Pitfalls

- A forwarded email PDF may contain Gmail wrapper text around the actual reservation; extract the reservation body, not just the email chrome.
- Shuttle/tour confirmations often imply `type=attraction`, even when they also look like transportation.
- Airline tickets may show both an agency reservation code and an airline booking code. Do not assume they are interchangeable; if the user cares about check-in, explicitly identify the airline booking code and preserve the agency code in notes.
- If multiple travelers share the same route but not the same airline booking code, merging them into one booking makes check-in harder later. Prefer separate entries or very explicit per-subgroup notes.
- For return flights, do not overwrite an overall booking confirmation with mixed or partially verified codes. Keep verified per-passenger/per-subgroup airline booking codes in notes and label any unverified code as not yet confirmed from source.
- If the return-phase booking is sparse, check the related outbound / international-ticket PDFs for the return segment before declaring seats unknown. In this trip, the LAX→TLV seats were recoverable from the earlier TLV→US ticket PDFs because the same documents included the return leg.
- If the API returns unauthorized, stop claiming success and switch to a verified local handoff note.
- Preserve passenger composition details (for example adults/children/seniors) in notes even if the site has only a plain passengers field.

## Verification

Before finishing, verify:
- confirmation number matches the source exactly,
- date/time aligns with the trip plan day,
- phase is correct,
- cost is numeric and currency-normalized when possible,
- the user-facing status distinguishes completed site writes from blocked attempts.

## References

- `references/booking-field-checklist.md` — concise extraction checklist and note template for trip confirmations.
