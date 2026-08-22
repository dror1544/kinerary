# Question-by-question guidance

Question IDs, types and requiredness below match `INTAKE_QUESTIONS_V1` in the control plane's `interview.ts` — if the two ever disagree, the code is right and this file is stale. Everything here is intake-only: none of these questions provision anything.

## trip_type — required, choice

"What kind of trip is this?" Offer the three known options (family / group of families / couple) plus "something else" for the free-text follow-up. Don't force a fit — genuinely mixed groups (e.g. a couple traveling with one set of grandparents) are fine as "other," described briefly.

## destination — required, text

Where the trip goes. City, region, or country — whatever the organizer naturally says first is fine; you don't need to press for a more specific answer than they're ready to give.

## group_size — required, choice

A rough headcount band (2 / 3–5 / 6–10 / 10+) is enough here — the exact roster comes later in `travelers`. If they give an exact number, map it to the right band or use "other" with the literal number.

## trip_duration — required, choice

A rough length (weekend / about a week / two weeks / a month or more) if exact dates aren't known yet. If they *do* know exact dates, you don't need to labor over this — a quick "sounds like about two weeks" and move on to the precise dates below.

## departure_date / return_date — both required, text ("YYYY-MM-DD")

The real, specific dates. If the organizer only has a rough idea ("early September"), ask them to commit to a working estimate rather than leaving this TBD — these two fields directly drive the trip site's calendar and countdown, so a vague answer here is worse than a best-guess specific one they can correct later. Confirm the format back to them in their own words ("so departure September 6th, back the 20th") rather than reading YYYY-MM-DD at them.

## timezone — optional, text

Only ask if it's not obvious from the destination. For most trips, skip this entirely and let it be inferred later — don't interrupt the conversation's flow for it.

## travelers — required, structured (array)

Who's coming: name, age, and which family/household group they belong to. Ask for a simple list — don't ask for usernames, colors, or anything derived; the control plane computes those.

Submit as:
```json
[
  { "name": "Eitan", "age": 52, "family": "Sagi" },
  { "name": "Noa", "age": 19, "family": "Sagi" }
]
```
`age` is optional per traveler if genuinely unknown — omit the field rather than guessing. `family` should be a short household/family label shared by everyone in that group (e.g. two spellings of the same family name should match exactly, since it's used to group people on the site).

## phases — required, structured (array)

Where the trip goes and when, one entry per stop. Ask for: place name, date range, and — only if already booked — accommodation name and confirmation number. Skip accommodation entirely if nothing's booked yet; don't invent a placeholder.

Submit as:
```json
[
  {
    "name": "Tokyo",
    "start": "2026-09-06",
    "end": "2026-09-10",
    "accommodation": { "name": "Park Hotel Tokyo", "confirmation": "ABC123" }
  },
  { "name": "Kyoto", "start": "2026-09-10", "end": "2026-09-14" }
]
```
For a single-destination trip this is still an array — just one entry.

## travel_anchors — optional, structured (array)

Anything already booked and worth recording — flights, a rental car, a specific hotel outside the phases above. Skip this whole question if nothing's booked yet; don't ask "are you sure?" — "nothing yet" is a completely normal answer this early.

Submit as a loose array of whatever the organizer tells you, e.g.:
```json
[
  { "type": "flight", "detail": "Delta DL123, Sept 6", "confirmation": "XYZ789" }
]
```
There's no strict schema here beyond "array of objects" — capture what's useful, don't force a rigid shape onto a free-text answer.

## constraints — optional, structured (object)

Anything the group needs the site (and eventually a trip organizer) to keep in mind: mobility needs, dietary restrictions, a budget expectation, or family dynamics worth flagging. Ask this as one open, low-pressure question rather than four separate ones — most trips will have nothing here, and that's fine.

Submit as an object with whichever keys are relevant, e.g.:
```json
{ "dietary": "two vegetarians in the group", "mobility": "grandmother uses a cane, avoid long walks" }
```
Omit keys that don't apply — don't submit empty strings. If the organizer has nothing to add at all, don't call `submit_answer` for this question; it's fine to leave unanswered.
