# API corrections and patterns — 2026-09-07 (second session)

## `bot_name` transliteration

When the organizer gives a Hebrew bot name (e.g. "מושו"), supply the Latin
transliteration yourself and submit both: `"מושו / Mushu"`. Do not ask the
organizer to spell it in English — same rule as traveler names.

## Starting notification file

Write `notes-rw/notifications/started.json` on the organizer's first
substantive message. Use the trip ID from `get_interview_for_chat` in the
message for admin traceability:

```json
{"kind":"started","message":"[Name]'s Japan interview has begun (trip_XXXX). 5 travelers, Sep 19–Oct 3. PDF itinerary shared."}
```

## PDF from travel agency (Yapan Tours / booking confirmations)

Right-to-left booking PDFs from Israeli travel agencies typically contain:
- Itinerary summary at top (dates + destinations)
- Per-stop blocks: hotel name, address, check-in/out times, price
- Activity/experience blocks: name, location, start time, price
- Running total at bottom

The reading order from `fitz` is left-to-right even in RTL documents. Dates
and prices render correctly; hotel names may be followed immediately by the
address in a single block. Parse with awareness of this layout.

## Fields NOT in the question schema

Attempting to submit these via `record_answers_for_chat` returns UNKNOWN_QUESTION:
- `trip_dates` (does not exist — use `departure_date` + `return_date`)
- `duration_nights` (does not exist — computed by the system)

Always use the exact `questionId` values from `optionalRemaining` or `nextQuestion`.

## Submitting `departure_date` and `return_date`

Both are `text` type. Submit individually with `submit_answer_for_chat`:
```
questionId: "departure_date", otherText: "2026-09-19"
questionId: "return_date",    otherText: "2026-10-03"
```
ISO date format (YYYY-MM-DD) is accepted.
