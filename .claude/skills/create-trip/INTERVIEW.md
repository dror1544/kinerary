# Trip creation interview

You are turning a conversation into an `answers.json` for `driver.mjs generate`
(shape documented in [answers.example.json](answers.example.json)). The person
you're talking to is planning a real trip — not filling out a form. Keep it
conversational, ask in small batches, and **never block on a field they don't
have yet** — use a sensible default or `"TBD"` and move on. You can always
regenerate later; `generate --force` overwrites cleanly.

## 0. Two independent choices, upfront

### Starting point — do they already have notes?

Ask in plain language: "Do you already have this trip planned somewhere —
Obsidian notes, a doc — or are we starting fresh?"

- **Fresh** → skip to Style below.
- **From existing notes** (Obsidian vault with numbered `00_`–`08_` markdown
  files, per `FRAMEWORK.md`) → run the importer first, then treat the rest of
  this interview as *filling gaps*, not starting from zero:
  ```bash
  node scripts/obsidian-to-config.js "/path/to/vault/trip-folder" /tmp/imported
  ```
  Read `/tmp/imported/trip.config.json` back. It's a skeleton with `FILL_IN`
  markers and empty `lat`/`lng` — walk the person through only the gaps
  (confirm participants/families it parsed correctly, ask for map
  coordinates, dates it couldn't find, hero photos). Translate what you read
  into the same `answers.json` shape rather than hand-editing its output —
  the importer's field names don't all match what `driver.mjs` expects
  (e.g. it emits `stats[].label`, not `description` — see Gotchas in
  [SKILL.md](SKILL.md)).

### Style — how much depth to collect

This is the "not everything is mandatory" axis. Ask with **AskUserQuestion**,
single-select:

| Option | What it includes | Best for |
|---|---|---|
| **Lean & organized** (Recommended) | Trip basics, participants, phases with dates/accommodation, tasks, known bookings. No trivia, no RSVP voting, no budget breakdown. | Couples, solo trips, small groups who just want a shared, correct logistics hub. |
| **Balanced** | Everything in Lean, plus a handful of venues/POIs per destination and a lightweight budget (big-ticket items only: flights, hotels). | Small families, a few optional activities worth tracking. |
| **Full family experience** | Everything in Balanced, plus the trivia game (real questions), RSVP voting on optional activities, full per-category budget, richer packing lists. | Multi-family group trips with kids — the flagship use case this framework was built for. |

Remember their answer as `style` — it only controls which sections you ask
about next. It is **not** written into `trip.config.json`; nothing in the
framework gates features by a style flag (every tab always exists — see
Gotchas). Picking "Lean" just means those tabs stay empty until someone adds
content later, which is fine.

## 1. Trip basics (always ask)

- Trip name → becomes the URL slug and folder name (`trips/<slug>/`). Ask
  something memorable ("Italy 2027", "Ben's Bar Mitzvah Trip").
- Departure date/time and return date. If they only know the date, default
  the time to a plausible morning departure and say so.
- Default language: he or en. Ask once — "Hebrew-first with English toggle,
  or English-first?" Both languages are always present in the UI either way.

## 2. Participants & families

Ask for a simple list: **name, age, which family/household group**. Don't
ask for usernames or colors — derive them:
- `username` = first name, lowercased, no spaces/accents.
- `color` = assign round-robin from `['#3B82F6','#8B5CF6','#10B981','#F59E0B','#EF4444','#06B6D4']`
  (blue, purple, green, orange, red, cyan) — one color per family group, not
  per person.
- Age matters beyond decoration: `renderFamilies()` splits each family card
  into "adults" (age ≥ 25, shown bold) vs. "kids" (shown grouped, smaller).
  If someone's age is genuinely unknown, 30 is a safe adult default.

Families are auto-derived from participants' family groups if you don't
explicitly ask for family names/descriptions — but a one-line family
description ("Marco & Giulia", "The Cohen family") is cheap and worth asking
for since it shows on the home tab.

**Don't ask about avatars — there's nothing to set up.** The site already
falls back to a colored circle with the person's initial (drawn client-side,
using the `color` you just assigned) whenever no photo has been uploaded
yet. Real photos go in later through the site's own upload/crop flow — this
skill never needs to touch `avatars/`.

## 3. Phases / destinations

For **each** destination, ask:
- Name (city/region) and date range.
- Accommodation: place name + confirmation number if already booked (skip if
  not booked yet — leave `confirmation` unset, not a fake placeholder).
- Which participants are present for this phase (default: everyone, if it's
  not a split trip).

Don't ask for map coordinates or a weather key — **you know them.** Look up
the destination's lat/lng yourself and fill `mapStop`. Use a short lowercase
`weatherKey` (city name is fine, e.g. `"rome"`, `"kyoto"`).

For the hero photo: ask if they have a preferred image URL; if not, leave
`hero.photo` blank rather than guessing a URL — a placeholder is better than
a broken/unrelated image. If you do go find one yourself (see the hard rule
below), it's fine — just don't type one from memory.

**Hard rule — never type an Unsplash (or any) photo URL from memory,
including "confident" ones.** `images.unsplash.com/photo-<id>` ids are
opaque; a plausible-looking one is as likely to 404 or resolve to a
completely unrelated photo as a real one. Every photo URL that ends up in a
config in this workflow was found with `WebSearch` and confirmed with a
real HTTP request first:
```bash
curl -sI "https://images.unsplash.com/photo-<id>?w=1600&q=80" | head -3
# expect: HTTP/2 200  and  content-type: image/jpeg
```
This isn't hypothetical — building this skill produced one fabricated URL
that 404'd and one that resolved but was the wrong photo, both caught only
because they were checked. Don't skip the check.

### If style ≥ Balanced: venues

Ask for 2–5 "must-see" spots per phase (name + a maps/tickets URL if handy).
Keep it short — this list grows organically after the trip is created; it
doesn't need to be exhaustive at scaffold time.

### If style = Full: RSVP activities

Ask which phases have an **optional** activity worth a headcount (a paid
tour, a reservation with limited spots). Each becomes an
`rsvp_activities[]` entry people can vote yes/no/maybe on. Don't force one
per phase — only where a real headcount decision exists.

## 4. Country info (always do this, don't ask — just run it)

Don't ask the user for emergency numbers, currency, or a calling code —
same principle as map coordinates: you can get this yourself. For every
**distinct** country the phases visit (not per phase — a 4-city US trip is
one lookup, not four), run:
```bash
node scripts/country-info.js "<country name>"
```
and put the JSON form (`--json`) into `answers.travel_info.countries["<Country Name>"]`.
This is a live lookup against two free, keyless APIs (`countries.dev`,
`emergencynumberapi.com`) — both carry their own "no accuracy guarantee"
disclaimers, so mention to the user that it's a solid starting point, not
a substitute for checking before departure. There's no automated source
for electrical plug type/voltage or which side of the road people drive on
— if the user cares about those, ask them directly or leave it out.

If the lookup returns "no country found" or picks the wrong one from
several matches (it prints alternatives when ambiguous — e.g. querying
just "Georgia" could mean the country or the US state), retry with a more
specific name rather than guessing a fix yourself.

The rest of `travel_info` is freeform and organizer-provided — not
automatable, don't over-collect it. Ask only if style is Balanced/Full and
keep it brief:
- `health[]` — anything genuinely trip-specific (altitude, known allergies) — bilingual `{he,en}` strings.
- `hospitals[]` — one entry per phase worth naming, `{ area: {he,en}, name: "..." }`.
- `money[]` — tipping norms, cash culture, card acceptance — bilingual strings.
- `communication[]` — eSIM/connectivity tips — bilingual strings.
- `age_notes[]` — `{ who: {he,en}, note: {he,en} }`, grouped by age bracket
  ("young drivers 18–23"), never by name — matches how the site already
  renders these.

Skip any of these entirely if nothing comes to mind — `renderInfo()` hides
each block when its list is empty, so there's no "looks broken" downside
to leaving one out.

## 5. Trip-wide hero photos (home tab + map tab)

Once every phase is known, pick two more photos — these are **separate**
from any per-phase `hero.photo` above and go in `meta.homePhoto` /
`meta.mapPhoto`:

- **`homePhoto`** — shown on the Home tab, representing the *whole trip*,
  not any single stop. Prefer an image that captures the trip's throughline:
  a mode of travel shared across the itinerary (a train, a road, a ferry),
  or an iconic shot that combines two of the trip's elements. A Japan trip
  used a train crossing with Mount Fuji in the background — not a photo of
  whichever city happens to be first.
- **`mapPhoto`** — shown behind the interactive route map. An aerial/overview
  shot reads better here than a ground-level one — it should feel like
  "the whole route," not "stop #1." The same Japan trip used an aerial view
  showing both Tokyo and Mount Fuji together.

This only matters if the person cares (skip for a one-city trip where the
phase photo already *is* the trip photo) — but for anything multi-stop, ask
or suggest one; don't leave the framework's generic placeholder by default
if a trip-specific pair is easy to find. Same hard rule as above: search and
verify, never type a photo ID from memory — get this wrong and *every* trip
loads with the same photo regardless of destination, which is the exact bug
that prompted this section (see Gotchas in [SKILL.md](SKILL.md)).

## 6. Tasks & known bookings (always ask, keep it short)

- 2–4 pre-trip to-dos with rough deadlines, if any come to mind. Don't
  interrogate for a complete list — this list grows over time in the app
  itself (it's a live checklist, not a one-time form).
- Any flights/hotels/cars already booked, with confirmation codes. Skip
  entirely if nothing's booked yet.

## 7. If style ≥ Balanced: budget

Ask only for known or estimated big-ticket items (flights, each
accommodation) — `amount` + `is_estimate: true/false`. Skip line-item
granularity (meals, tickets) at scaffold time; the budget tab supports
adding items live once the trip exists.

## 8. If style = Full: trivia

Ask how many questions they want (`total_questions`, default
`min(participants × 2, 40)`) and pick one of three ways to get real question
content — don't leave it at just "add later" if a faster path is available:

- **Generate now, no Obsidian needed** — after `generate` has written
  `trips/<slug>/trip.config.json`, run:
  ```bash
  python3 scripts/trivia_agent.py trips/<slug> --generate 15
  ```
  This drafts bilingual questions directly from the trip's own participants
  and phases (needs `ANTHROPIC_API_KEY` in `.env` — if it's not set, fall
  through to the next option instead of blocking). Prefer this over writing
  questions yourself; it also runs translation + a quality pass automatically.
- **Write a few together now** — draft 5–10 fun family/trip-trivia questions
  conversationally (about the destinations, or inside jokes if this is a
  returning group) directly in `answers.trivia.questions[]`, matching the
  real schema (`driver.mjs` passes this through as-is, unvalidated — get the
  shape right):
  ```json
  {
    "he": "מי הכי צפוי להירדם ראשון בטיסה?", "en": "Who's most likely to fall asleep first on the flight?",
    "persons": "marco", "category": "family",
    "answers": [
      { "he": "מרקו", "en": "Marco", "correct": true },
      { "he": "ג'וליה", "en": "Giulia", "correct": false },
      { "he": "לוקה", "en": "Luca", "correct": false },
      { "he": "אף אחד", "en": "Nobody", "correct": false }
    ]
  }
  ```
  `persons` is a participant username (an "about them" question) or
  `"trip"` (a general destination/logistics question); `category` is
  `"family"` or `"trip"` to match.
- **Add later** — leave `trivia.questions: []`. If they already have an
  Obsidian trivia doc (one `## <person>` section per participant, `-`
  question bullets, `- **bolded**` correct answers), point them at
  `python3 scripts/sync_trivia.py <notes.md> trips/<slug>` instead of the
  generate mode above.

## 9. Generate and verify

Assemble everything into one JSON file matching
[answers.example.json](answers.example.json), then hand off to the driver —
see [SKILL.md](SKILL.md) for the exact commands. Report back to the user
with what was created and the concrete next steps from the generator's own
output (avatars, Logo.png, trivia content, how to preview it).
