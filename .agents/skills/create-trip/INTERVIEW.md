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
| **Lean & organized** (Recommended) | Trip basics, participants, phases with dates/accommodation, tasks, known bookings. No RSVP voting, no budget breakdown. | Couples, solo trips, small groups who just want a shared, correct logistics hub. |
| **Balanced** | Everything in Lean, plus a handful of venues/POIs per destination and a lightweight budget (big-ticket items only: flights, hotels). | Small families, a few optional activities worth tracking. |
| **Full family experience** | Everything in Balanced, plus RSVP voting on optional activities, full per-category budget, richer packing lists, and a trivia bank drafted during the interview. | Multi-family group trips with kids — the flagship use case this framework was built for. |

Two things are asked at **every** style, regardless of what they pick: the
escort agent (§9) and whether they want trivia on (§8). Style controls how
much *content* you collect for trivia, not whether it's offered — a Lean trip
can still have the game switched on with an empty bank the organizer fills by
chat later.

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

## 8. Trivia — offer it to everyone, don't gate it on style

Offer trivia even on a Lean trip. It's the one feature people don't ask for
and then use most, and the cost of saying no is one sentence:

> "There's also a multiplayer trivia game — questions about the group and the
> destinations, everyone plays from their phone. Want it on? You don't have to
> write any questions now."

If they hesitate, that last clause is the whole pitch — say it explicitly.
**The bank does not have to be full at scaffold time.** The organizer can add
questions later just by telling the trip's bot, in normal conversation, and
they land live:

> "Once the site is up, you can add a question any time by messaging the bot —
> something like *'add a trivia question: who's most likely to lose their
> passport? Options: Marco, Giulia, Luca, Dana — the answer is Luca.'*
> It writes both languages, saves it, and it's in the next game. No restart,
> no editing files."

That path is the `add_trivia_question` MCP tool (see `mcp/README.md`) — it
persists to `trivia_questions.json` and takes effect immediately. Mention it
by capability, not by tool name; they don't care what it's called.

**Set `total_questions` to what they actually want the game to be**, default
`min(participants × 2, 40)`. Do not set it to the number of questions written
today — a config claiming 10 questions over an empty bank is how the trivia
tab silently disappears, since the server only advertises trivia when the bank
is non-empty. If the bank will start empty, say so out loud: *"the tab shows up
once the first question exists."*

Then pick one of the ways to get initial content — don't leave it at just
"add later" if a faster path is available:

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
- **Add later, via chat** — leave `trivia.questions: []` and tell them the
  bot path above. This is a legitimate finished state, not a punt: it's the
  right answer for anyone who says "I'll think of good ones later", because
  they will, and they'll be better questions than anything drafted cold in
  an interview. If they already have an Obsidian trivia doc (one
  `## <person>` section per participant, `-` question bullets, `- **bolded**`
  correct answers), point them at
  `python3 scripts/sync_trivia.py <notes.md> trips/<slug>` instead.

## 9. The escort agent (always ask — it's the part people didn't know to want)

Most trips here get a bot in the family's group chat that answers "where are
we eating tonight", sends a morning briefing, and gives the organizer a
private operator channel. Its *behavior* is fixed and identical for every
trip — the two-mode group/organizer boundary, source precedence, the rule
that proactive messages stay rare, the no-inventing-itinerary-facts rule.
None of that is asked here or stored per trip.

What this section collects is only the layer that differs per family. Open by
saying that plainly, because otherwise people try to describe the whole bot:

> "There's a bot that rides along with the trip — in your group chat for the
> family, and in a private chat just for you. How it behaves is already set.
> I just need to know what you want to call it, and anything specific about
> *these* people it should keep in mind."

### 9.1 Identity (ask together, one batch)

- **`name` / `name_en`** — what the family calls it. Push for something they'd
  actually type; a name nobody says out loud means nobody talks to the bot.
- **`gender`** — `male` / `female` / `neutral`. **Ask this explicitly for any
  Hebrew-speaking trip and do not guess.** Hebrew conjugates verbs by gender,
  so the bot cannot form a sentence without it, and getting it wrong is
  noticeable in literally every message. `neutral` means "prefer
  gender-avoidant phrasing" — legitimate, but tell them it makes the Hebrew
  read slightly stiffer.
- **`tone`** — `warm` (default) / `playful` / `dry`. One word, don't
  workshop it.
- **`default_language`** — usually mirrors `meta.defaultLang`. Offer it as a
  confirmation, not an open question.

### 9.2 Who is the organizer (`organizers`)

**Default to the person you're interviewing.** Whoever is sitting here
scaffolding a trip site for their family is the organizer until they say
otherwise — that's true in essentially every run of this interview, and
asking it as an open question invites a confused "…me?".

So confirm, don't ask — and leave room for a co-organizer without making it
sound like a rare option:

> "I'll set you as the organizer — that's the private channel where the bot
> tells you what it actually knows, and takes itinerary corrections from.
> Is there anyone else, a partner planning this with you, who should be in
> that same private channel?"

Match each name to its own `participants[]` entry and use that username.
Default to just the interviewee if they don't name anyone else — don't press
for a second name once they've answered. If someone they name hasn't put
themselves in the participant list, that's the real thing to fix — an
organizer who isn't on the trip is almost always an oversight, so ask before
working around it.

Say what the choice costs, because it isn't obvious: **everyone else gets
group mode only.** Every name listed here shares the same private channel
and sees the same organizer-only material — there's no way to give one
organizer more visibility than another.

Write it as a list even for one person — `organizers: ["alice"]` — since
that's the current field name. (The older `organizer: "alice"` string is
still accepted on existing configs, normalized on read, but don't write new
configs with it.)

`driver.mjs` hard-fails on any name in the list that isn't in
`participants[]`, and it should — a typo here means that person silently
never qualifies as organizer, and the bot quietly treats them as a group
audience for material they were supposed to see.

### 9.3 Proactive messages (`proactive`) — opt in, don't opt out

Read the list and let them pick. Default everything they don't mention to
`false`; a bot that talks too much gets muted in week one, and a muted bot is
worse than no bot.

| Key | What it sends | Value |
|---|---|---|
| `morning_briefing` | Today only, one or two reminders max | `"07:30"` or `false` |
| `tomorrow_preview` | Short evening look-ahead | `"21:00"` or `false` |
| `photo_recap` | Grounded in actual new uploads | `"21:00"` or `false` |
| `flight_changes` | Only when materially actionable | `true` / `false` |
| `packing_reminders` | Weather/activity-driven, day-before | `true` / `false` |

Times are local to `timezone` (ask for it, or infer from the first phase's
country — travelers' local morning, not the server's).

### 9.4 Standing instructions (`standing_instructions[]`) — the actual point

This is the "anything specific about these people" question. Ask it as an
open prompt and expect the good answers to arrive late in the conversation:

> "Anything the bot should know about this group that isn't on the itinerary?
> Things to keep in mind, or things to stay away from."

Answers cluster into: pace and mobility, food, family dynamics, topics to
avoid, and running jokes. Capture each as a separate entry with bilingual
`text` — not one long paragraph, because visibility is set per instruction.

**Visibility is the part you must get right.** Every instruction defaults to
`organizer` — it is not served to the family at all. Only mark one `group`
when the text is something you'd be comfortable reading aloud at the dinner
table:

```json
{ "visibility": "group",     "text": { "he": "...", "en": "..." } }
{ "visibility": "organizer", "text": { "he": "...", "en": "..." } }
```

Two rules, both non-negotiable:

1. **Never volunteer that group visibility exists.** Ask the question, write
   everything as organizer-only, and only promote an entry if the person
   explicitly says the family should see it. The failure mode is asymmetric:
   an over-hidden instruction is a mildly less helpful bot, an over-shared one
   is a private thing about a named family member on an endpoint that
   `/api/config` serves **with no authentication at all**.
2. **Medical and accessibility details belong in `participants[].needs`, not
   here.** If they start describing someone's condition, redirect — that field
   is per-person, typed, severity-ranked, and already organizer-gated. A
   standing instruction is about *behavior* ("keep walks short"), the need is
   about the *person* ("uses a cane"). The bot reads both; only one of them
   belongs to an individual.

If they have nothing, omit the `agent` block entirely rather than writing an
empty persona — a bot with a name and no instructions is fine, a bot with an
empty name is not.

## 10. Generate and verify

Assemble everything into one JSON file matching
[answers.example.json](answers.example.json), then hand off to the driver —
see [SKILL.md](SKILL.md) for the exact commands. Report back to the user
with what was created and the concrete next steps from the generator's own
output (avatars, Logo.png, trivia content, how to preview it).

## 11. Hand back an onboarding pack, not just "done"

The interview ends with a working site nobody has logged into yet. Close by
writing the organizer something they can forward to the family as-is — this
is the deliverable, and it's the step most likely to get skipped.

Produce it as one short message, in the trip's `defaultLang`, covering:

**1. How each person gets in the first time.** Their username (from
`participants[]`), the site URL, and the seeded password — every participant
starts on the same default, `1234`. Say plainly that it is a doorknob, not a
lock: the first thing each person should do is open the side menu → their
avatar → 🔑 Change password. Never send a real password around; the seeded
one exists precisely so nothing sensitive is in the forwarded message.

**2. How to add the bot to the group chat.** The persona name from §9.1, and
that it belongs in the family's existing group — not a new one. Also state the
thing people get wrong: the bot has a *private* channel with the organizer,
and family members should not expect it to DM them.

**3. What to tell the bot first.** Two concrete openers work better than a
feature list — e.g. *"what are we doing tomorrow?"* and, if trivia is on,
adding a first question by chat (§8). One example of each beats a manual.

**4. What is still TBD.** Read it off the config, don't guess: unbooked
accommodation, `"TBD"` confirmations, empty trivia bank, missing avatars.
The organizer should leave knowing exactly what is still theirs to do.

Keep it forwardable. No internal paths, no `trip.config.json`, no talk of
MCP, JSON, or containers — the family is not the audience for any of that.

## 12. Mention, don't block: Google Sign-In and AI agent access

These are both optional, both configured outside `trip.config.json` (`.env`
+ server restart, not part of the generated file), and neither should hold
up finishing the trip — just tell the user they exist and where to look
once the site is up and confirmed working:

- **Google Sign-In** — lets participants log in with Google instead of (not
  instead of — *in addition to*) the seeded password. Needs the user to
  create their own Google Cloud OAuth client ID (an interactive step only
  they can do), then set `GOOGLE_CLIENT_ID` in `.env` and restart the
  server. Point them at the "Connecting Google Sign-In" section of the
  top-level [README.md](../../../README.md) for the exact steps — don't
  duplicate them here.
- **AI agent access (Claude Cowork or a local always-on agent)** — lets an
  agent manage the trip day-to-day (bookings, RSVPs, trivia control)
  through `mcp/`, separately from this skill (which only scaffolds the
  trip once). Point them at [mcp/README.md](../../../mcp/README.md),
  specifically the Cowork custom-connector steps if they mention wanting
  to manage the trip remotely or "from my phone."
