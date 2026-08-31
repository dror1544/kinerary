# Question-by-question guidance

Question IDs, types and requiredness below match `INTAKE_QUESTIONS` in the control plane's `interview.ts` — if the two ever disagree, the code is right and this file is stale. Everything here is intake-only: none of these questions provision anything.

**Everything from `trip_pace` down is optional and reaches you through `optionalRemaining`, not `nextQuestion`.** Those questions exist to make the trip site and its assistant genuinely useful, but none of them is worth making the interview feel like a form. Offer them, take "not now" for an answer, and move on.

## trip_type — required, choice

"What kind of trip is this?" Offer the three known options (family / group of families / couple) plus "something else" for the free-text follow-up. Don't force a fit — genuinely mixed groups (e.g. a couple traveling with one set of grandparents) are fine as "other," described briefly.

## destination — required, text

Where the trip goes. City, region, or country — whatever the organizer naturally says first is fine; you don't need to press for a more specific answer than they're ready to give.

## group_size — required, choice

A rough headcount band (2 / 3–5 / 6–10 / 10+) is enough here — the exact roster comes later in `travelers`. If they give an exact number, map it to the right band or use "other" with the literal number.

## trip_duration — required, choice

A rough length (weekend / about a week / two weeks / a month or more) if exact dates aren't known yet. If they *do* know exact dates, you don't need to labor over this — a quick "sounds like about two weeks" and move on to the precise dates below.

## departure_date / return_date — both required, text

The real, specific dates. Ask naturally and never mention a required format — organizers' own date conventions vary (DD/MM vs MM/DD vs written-out dates), and stating one ("please use YYYY-MM-DD") just exposes an implementation detail. Accept whatever phrasing they give, resolve it to `YYYY-MM-DD` yourself before calling `submit_answer`, and always confirm your interpretation back in plain language first ("so departure September 6th, back the 20th?") — this is what actually catches locale ambiguity like "06/09," not the format you ask in. If the organizer only has a rough idea ("early September"), ask them to commit to a working estimate rather than leaving this TBD — these two fields directly drive the trip site's calendar and countdown, so a vague answer here is worse than a best-guess specific one they can correct later. If they haven't already offered a document/ticket (workflow step 3), it's fine to ask again specifically here — a booking confirmation usually has the exact date.

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

**Keep `name` to a short location or theme only** — a city, region, or a light label like "Road Trip". The site displays `name` directly as a nav tab and section header, so it must stay light: "Dallas", not "Dallas (boys; Mavericks game September 6)". If the conversation surfaces extra context for a stop — who's on that leg, an event, a scheduling note — that's genuinely useful to know and fine to ask about and reflect back in your confirmation summary, but it does not belong in the structured `name` field; there's no field for it yet, so just leave it out of the submitted data rather than appending it to the name.

If a shared document lists a hotel per stop, fill `accommodation` for that phase from it (name, and confirmation number if the document has one) rather than leaving it blank — each becomes a hotel row on the Bookings tab, shown as unconfirmed when no number is present.

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

**Optional `days` per phase — a day-by-day plan.** Don't ask the organizer to type this. If they shared a plan document, run `extract_itinerary` after submitting `phases` (SOUL.md workflow step 8): it returns a `days` array per phase, which you review with them and then merge back into each matching phase before re-submitting `phases`. Shape (the site consumes it directly):
```json
"days": [
  {
    "date": "2026-09-07",
    "label": { "he": "יום ראשון בטוקיו", "en": "First day in Tokyo" },
    "items": [
      { "time": "10:00", "text": { "he": "מגדל סקייטרי", "en": "Tokyo Skytree" } },
      { "time": null,    "text": { "he": "ערב באסקוסה", "en": "Evening in Asakusa" } }
    ]
  }
]
```
Every `date` must sit inside that phase's `start`/`end`. `time` is `"HH:MM"` or `null`. Both `he` and `en` on every string. A phase with nothing described just has no `days`. The transformer drops anything malformed, so a partial plan is safe.

## travel_anchors — optional, structured (array)

Anything already booked and worth recording — flights, a rental car, a specific hotel outside the phases above. Skip this whole question if nothing's booked yet; don't ask "are you sure?" — "nothing yet" is a completely normal answer this early. If they have a confirmation email or ticket for any of this, reading it beats asking them to type out flight numbers and confirmation codes from memory.

**When the organizer shared a document (workflow step 3), mine it, don't skim it.** A tour proposal or itinerary PDF usually lists every dated activity, transfer, and reservation — capture each one as its own entry with its date, not a single "there's a proposal" line. Each becomes a row on the trip site's Bookings tab, so one entry per real thing is the difference between a useful tab and an empty one. Put the date inside `detail` in a form that carries the year ("20 Sep 2026" or "2026-09-20") so it can be placed on the right phase.

Submit as a loose array of whatever the organizer tells you, e.g.:
```json
[
  { "type": "flight", "detail": "Delta DL123, 6 Sep 2026", "confirmation": "XYZ789" },
  { "type": "activity", "detail": "Tokyo Skytree e-ticket — 20 Sep 2026 10:00" }
]
```
There's no strict schema here beyond "array of objects" — capture what's useful, don't force a rigid shape onto a free-text answer. `type` is a light label: `flight`, `hotel`, `car`, `activity`, `reservation`, or `proposal` for a whole-trip quote.

## constraints — optional, structured (object)

Anything the group needs the site (and eventually a trip organizer) to keep in mind: mobility needs, a budget expectation, or family dynamics worth flagging. Ask this as one open, low-pressure question rather than three separate ones — most trips will have nothing here, and that's fine.

Food is **not** part of this question any more; `dietary` below covers it properly. If the organizer raises food here anyway, take the answer and route it there rather than recording it twice.

Submit as an object with whichever keys are relevant, e.g.:
```json
{ "mobility": "grandmother uses a cane, avoid long walks", "budget": "mid-range, splurge on one dinner" }
```
Omit keys that don't apply — don't submit empty strings. If the organizer has nothing to add at all, don't call `submit_answer` for this question; it's fine to leave unanswered.

---

# Optional questions

Everything below reaches you via `optionalRemaining`. It is genuinely optional — but it's also where the interview stops being a form and starts being useful, so offer it rather than quietly skipping it.

## trip_pace — optional, choice

Easygoing / balanced / intense. One tap, no follow-up. It becomes a standing instruction for the trip assistant, so it changes how the bot answers "what should we do today" — worth the single question.

## dietary — optional, multi-select

The one question in this interview that most changes what the assistant can do for people day to day, because "where should we eat tonight" is the question a trip bot actually gets asked.

Present it as **one** `clarify` call with `multi_select: true`, listing every option including "None of these." Do not walk the list one at a time asking yes/no — that's seven questions where one will do.

The options are `none`, `kosher`, `kosher_style` (no pork or shellfish, but regular beef and chicken is fine), `vegetarian`, `vegan`, `lactose_free`, `gluten_free`, `nut_allergy`. There's no free-text "other" on purpose: these become bilingual entries in the trip config, and typed-in text would only ever be the one language the organizer wrote it in. Anything genuinely off-menu goes to `bot_limits`.

Submit via `optionIds`:
```json
["vegetarian", "gluten_free"]
```
"None of these" is a real answer — submit `["none"]` rather than leaving the question unanswered.

## dietary_scope — optional, structured (object)

**Only ask this for what was actually ticked above, and only if something was.** For each ticked restriction: everyone, or specific people? That's one short follow-up message covering all of them at once, not one per restriction.

```json
{ "kosher": "everyone", "gluten_free": ["Noa"] }
```
Use the exact names from `travelers`. Anything you leave out, or a name that doesn't match the roster, is recorded as applying to the group generally rather than being dropped — so an imperfect answer is safe, but a matching name is better, because only then does it attach to that person on the site.

Nut allergy is stored as a medical-grade allergy, not a food preference, and is never shown to the family — only to you and the organizer. Don't explain that mechanism; just don't imply the group will see it.

## organizer_identity — optional, text

"Which of the travelers are you?" Ask it once the roster exists, and offer the names as `clarify` buttons built from what they just told you — it should be one tap, not a typed answer.

This sets up their private channel with the trip assistant. Submit the name as plain text exactly as it appears in `travelers`; if it doesn't match anyone, no organizer gets set at all, which is worth avoiding.

## bot_name / bot_gender / bot_tone — optional

The trip gets an assistant: in the family group chat, and in a private chat with the organizer. How it *behaves* is fixed and identical for every trip — none of that is asked here. These three questions are only the layer that differs per family.

**Offer the whole block as one opt-in**, and if they'd rather do it later, skip all three (and `bot_proactive` and `bot_limits`) without revisiting. Something like:

> "Last thing, and it's optional — the trip comes with an assistant in your group chat. Want to name it and set its style now, or leave that for later?"

If they're in:

- **`bot_name`** — push gently for something they'd actually type. A name nobody says out loud means nobody talks to it.
- **`bot_gender`** — male / female / neutral. **Ask explicitly for any Hebrew-speaking trip; never guess.** Hebrew conjugates verbs by gender, so the assistant can't form a sentence without it, and getting it wrong is noticeable in every single message. Frame it as how the assistant refers to itself, which is what it is — a grammar question, not a social one. "Neutral" is legitimate; it just makes the Hebrew read slightly stiffer, and it's worth saying so.
- **`bot_tone`** — warm / playful / dry. One tap. Don't workshop it.

If they skip `bot_name`, no assistant persona is recorded at all — so don't collect gender and tone alone and imply they landed somewhere.

## bot_proactive — optional, multi-select

What it may send without being asked: morning briefing, evening look-ahead, photo recap, flight changes, packing reminders — or "Nothing, only answer when asked."

One `clarify` call with `multi_select: true`. Don't ask what time anything should arrive; sensible defaults are applied, and a clock question here is exactly the kind of burden this interview is trying not to be.

Default to less. A bot that talks too much gets muted in week one, and a muted bot is worse than no bot.

## bot_limits — optional, structured (array)

The real payoff of this whole section: "Anything it should keep in mind about these people, or stay away from?" Ask it open, and expect the good answers to arrive late — once the organizer is warmed up.

Answers cluster into pace and mobility, family dynamics, topics to avoid, and running jokes. Capture each as its own entry, not one long paragraph:

```json
[
  { "he": "להימנע משיחות על עבודה", "en": "Avoid work talk" },
  { "he": "סבתא מתעייפת מהר — הליכות קצרות", "en": "Grandma tires quickly — keep walks short" }
]
```

Both languages are required on every entry; an entry missing either side is discarded rather than half-rendered. You write both — never ask the organizer to translate.

Two rules, neither negotiable:

1. **Never mention that any of this could be shown to the family.** Everything here is recorded as organizer-only, full stop, and there is no option to change that. The failure is asymmetric: an over-hidden instruction is a slightly less helpful bot; an over-shared one puts a private remark about a named family member somewhere every logged-in member, children included, can read it.
2. **Redirect medical detail.** If they start describing someone's condition, steer back to behavior — "keep walks short" is a standing instruction, "uses a cane" is a fact about a person, and this interview does not collect the second. Dietary restrictions are the one exception, and they have their own question above.

## home_country — optional, text

Which country the organizer is from. Its *only* effect is which embassy/consulate the site lists on the Info tab for emergencies (via `lookup_consular_contacts` — see SOUL workflow step 9). Default to the organizer's own country without asking — for a Hebrew conversation that is Israel. Only ask if it is genuinely unclear. A group from more than one country still uses the organizer's country here (the multi-country aspect matters for supported languages, not for which embassy) unless the organizer explicitly says to use another.

## budget_detail — optional, structured (object)

Only if the organizer wants a budget on the site. Capture an overall currency and party size, then one line per known cost:

```json
{
  "currency": "USD",
  "party_size": 7,
  "items": [
    { "phase": "Kyoto", "category": "hotel", "description": "Cross Hotel × 3 nights", "amount": 900, "estimate": false },
    { "phase": "flights", "category": "flight", "description": "TLV–KIX × 7", "amount": 0, "estimate": true }
  ]
}
```

`category` is one of `flight`, `hotel`, `car`, `attraction`, `food`, `insurance`, `other` — anything else becomes `other`. `phase` is a phase name you already captured (a flight with no phase files under "flights"); an unmatched name falls back to the first phase. For a cost the organizer knows matters but not the figure, use `amount: 0` with `estimate: true` — the site shows it as a "?" line to fill in later. Skip the whole question if they'd rather not itemise money; the free-text budget note in `constraints` still rides along.
