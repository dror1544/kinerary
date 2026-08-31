---
name: trip-daily-planning
description: Trip planning skill — general overview, day-by-day plans, weather, and group-ready messages from verified itinerary data.
version: 1.2.0
author: Nahum / Hermes
license: MIT
metadata:
  hermes:
    tags: [travel, itinerary, daily-plan, recommendations, weather, family-group, briefing, hebrew, maps, cellular, parking]
    category: planning
---

# Trip Daily Planning

Use this skill for all trip planning requests: trip overview, day-by-day plans, morning briefings, recommendations, weather integration, and group-ready messages.

Merged from: `trip-itinerary-briefing` + `group-travel-daily-recommendations`.

---

## When to Use

- "מה יש לנו בטיול?" / "What's on our trip?" / trip overview in any language
- "מה אנחנו עושים היום / מחר?" / "What are we doing today/tomorrow?"
- "תכין הודעה לקבוצה" / "Send a group summary"
- "מה מומלץ לעשות ביום..." / "What should we do on day..."
- "מה מזג האוויר?" / "What's the weather?"
- "תדריך בוקר" / "Morning briefing"
- pre-trip overview or mid-trip operational questions, in any language

**Language note:** Respond in the language the user is writing in. Hebrew examples throughout this skill are illustrative — apply the same logic and structure in English, French, or any other language the organizer uses.

---

## Core Rule: Always Separate Facts from Proposals

| Label | Content |
|---|---|
| **מאומת** | dates, flights, hotels, cars, check-in/out, participants — from `get_config` or `get_bookings` |
| **הצעה** | activities, pacing, restaurant ideas, day plans, tradeoffs |

Never blur the two. If a fact is missing from verified sources, say so plainly.

---

## Step 1: Read the authoritative source first

1. Call `get_config` via trip-mcp for the live config.
2. Extract: trip dates, party size, destinations in order, hotel per phase, movement days, flights, cars, pending tasks.
3. Compute the **current local date/time at the active destination** (not the organizer's timezone, not UTC).
4. Identify the **active phase** based on that local date.
5. **If planning is for today:** note the current local time and treat it as the starting point — do not plan from 00:00 or from morning if it is already afternoon or evening. Only suggest activities and logistics that are still reachable and open from now.
6. Proceed with phase-aware, time-aware answers only.

---

## Step 2: Weather (when relevant)

**Always include weather** in:
- Morning briefings (when active)
- Ski / winter / mountain trips — always, unless organizer explicitly opted out

**Include weather only if asked** in:
- Beach, city, leisure trips (unless morning briefing is active)

**How:** Fetch from Open-Meteo using the active phase's coordinates. Use `forecast_days=7`. Summarize concisely: temperature range, rain risk, any conditions relevant to the day's plan.

---

## Step 3: For daily recommendations — verify attraction hours

Before recommending a specific attraction or venue:
1. `web_search` the attraction name + "שעות פתיחה" or "hours" + the visit date.
2. Prefer the official site over aggregators.
3. If closed or uncertain — note it clearly and offer an alternative.

---

## Step 4: Parking — check and advise

### When to run this check
Run whenever you generate a navigation link (Google Maps or Waze) to an **urban destination or urban attraction**. Urban = city centers, tourist districts, theme parks with paid parking, beach boardwalks, concert venues, busy museums.

**Skip** for: rural roads, national park wilderness, remote beaches with free lots, hotel drop-off only.

### How to check
`web_search` → `"[attraction/area name] parking tips"` or `"[attraction name] parking problems"` or `"[attraction name] parking lot near"`
- Prioritize: official site parking page, city parking authority, travel blogs, Reddit.
- Look for: known shortage, high prices, paid garage vs street, recommended lots.

### Decision logic

**If parking is known to be problematic** (shortage, very expensive, event-day congestion):
1. Warn clearly — before the nav link, not after:
   > 🅿️ חניה: [שם האיזור] ידוע בבעיות חניה. מומלץ להגיע מוקדם או להשתמש בחניון מאורגן.

2. Find **1–2 nearby parking lots** using the `maps` skill:
   ```bash
   python ~/.hermes/skills/maps/scripts/maps_client.py nearby --near "[attraction name]" --category parking --limit 5
   ```
   Select the 1–2 closest results by `distance_m`. Prefer covered/structured garages over street parking for a family group.

3. Build a navigation link **to the parking lot** (not the attraction) as the primary nav:
   - Google Maps: `https://www.google.com/maps/dir/?api=1&destination=[parking+lot+name+or+address]&travelmode=driving`
   - Waze: `https://waze.com/ul?q=[parking+lot+name]&navigate=yes`

4. Format the output:
   ```
   🅿️ חניה: חנייה באיזור [שם] עמוסה / יקרה. מומלצות:
   • [חניון 1] — [X] מטר הליכה — [קישור ניווט]
   • [חניון 2] — [Y] מטר הליכה — [קישור ניווט]
   [אם ידוע מחיר גבוה / עומס אירוע — ציין זאת בקצרה]
   ```

**If parking is tight but manageable** (some street, some paid, no crisis):
Add a light note:
   > 🅿️ חניה: יש חניות בתשלום באיזור — כדאי להגיע לפני 10:00 או להשתמש ב[חניון X].
   > [קישור ניווט לחניון →](...)

**If parking is fine** (free lots, ample space, suburban setting):
No mention needed.

### Ranking parking options
Priority order:
1. **Walking distance** — closest first (use `distance_m` from maps skill)
2. **If two options are close in distance** — prefer the one without known congestion or very high price
3. **Price note** — mention only if clearly above average (e.g. >$30/day in a context where $15 is normal), don't invent prices

### Navigation link formats

**Google Maps to destination:**
```
https://www.google.com/maps/dir/?api=1&destination=[place+name+or+address]&travelmode=driving
```

**Google Maps multi-stop route:**
```
https://www.google.com/maps/dir/[start]/[stop1]/[destination]
```

**Waze to destination:**
```
https://waze.com/ul?q=[place+name]&navigate=yes
```

**Waze by coordinates:**
```
https://waze.com/ul?ll=[lat],[lon]&navigate=yes
```

Always offer **both** Google Maps and Waze links when generating a navigation link, unless the user specified one.

---

## Step 5: En-route stops — gas, restrooms, coffee

### When to use
When the user asks about stopping along the way for:
- דלק / תחנת דלק / gas
- שירותים / restrooms / bathroom
- קפה / cafe / coffee / snack
- כל "עצירה בדרך" שאינה יעד עיקרי

### Core constraint: ON the route, not a detour
The stop must be **in the direction of travel** — on the route itself or a minor divergence.

**Never suggest:**
- Backtracking (going back the way you came)
- A detour that adds more than ~10 minutes round-trip, unless the user explicitly asked for "the fastest/closest stop no matter what" (`עצירה הכי מהירה`)

**Always ask yourself:** is this stop on the way, or does it require going off-route and returning?

### How to find on-route stops

**Option A — Maps skill along the route**
Use the `maps` skill `nearby` with coordinates of a **midpoint on the route** (not the origin, not the destination):
```bash
python ~/.hermes/skills/maps/scripts/maps_client.py nearby [midpoint_lat] [midpoint_lon] gas_station --limit 5
python ~/.hermes/skills/maps/scripts/maps_client.py nearby [midpoint_lat] [midpoint_lon] cafe --limit 5
```
Pick results whose coordinates are roughly between origin and destination (same corridor), not perpendicular or behind.

**Option B — Google Maps waypoint URL**
Build a route URL with the stop as a waypoint — the user can open it and Google Maps will route through it:
```
https://www.google.com/maps/dir/[origin]/[stop]/[destination]
```
Example (gas on the way to Hana):
```
https://www.google.com/maps/dir/Kahului/Shell+Gas+Paia+Maui/Hana+Town
```

**Option C — web_search for known stops on a specific road**
For famous routes (Road to Hana, Pacific Coast Highway, etc.):
`web_search` → `"[road name] best stops gas coffee restrooms"`
These often have curated lists of on-route stops.

### Output format

**Standard (stop is on-route):**
```
⛽ עצירה בדרך — [סוג] ב[שם מקום]:
• [שם תחנה/קפה] — בדיוק על הדרך, ~[X] ק"מ מהיציאה
• [קישור ניווט עם עצירה בדרך →](https://www.google.com/maps/dir/[origin]/[stop]/[destination])
```

**If two good options exist at different points on the route:**
```
⛽ עצירות מומלצות בדרך:
• מוקדם יותר: [שם] ב-[X ק"מ] — [קישור]
• מאוחר יותר: [שם] ב-[Y ק"מ] — [קישור]
```

**If only off-route options found** (and user did NOT say "fastest"):
> לא מצאתי עצירה ישירות על הדרך ל[יעד]. הכי קרוב שמצאתי הוא [שם] — סטייה של כ-[X] דקות. רוצה שאציג אותו בכל זאת?

**If user said "הכי קרוב/מהיר" explicitly:**
Show the nearest result regardless of detour, and note the detour time:
> ⛽ הכי קרוב: [שם] — [X] מטר / [Y] דקות (כולל חזרה למסלול)
> [קישור ניווט →](...)

### Detour threshold
| Detour round-trip | Action |
|---|---|
| < 5 min | Show without comment |
| 5–10 min | Show + note "סטייה קצרה של ~X דקות" |
| > 10 min | Do not suggest unless user explicitly asked for closest regardless |

### Category → maps skill category mapping
| בקשה | maps category |
|---|---|
| דלק / gas | `gas_station` |
| שירותים בלבד | `gas_station` or `restaurant` (most have restrooms) |
| קפה / coffee | `cafe` |
| אוכל קל / snack | `cafe` or `restaurant` |

---

## Step 6: Cellular dead zones — check and navigate

### When to check
Run this check whenever the recommendation involves:
- Remote roads, scenic drives, mountain routes, forest areas, national parks
- Island interiors, rural countryside, desert areas
- Any route clearly away from urban centers

**Do not skip for routes like:** Road to Hana, Waimea Canyon, Big Sur, national park scenic drives, canyon roads, ski mountain access roads.

### How to check
`web_search` → `"[area/road name] no cell service"` or `"[area/road name] dead zone cellular coverage"`
- Also try: `"[park/road name] offline maps recommended"`
- Prioritize travel blogs, Reddit r/travel or r/[destination], official park sites.

### If dead zone confirmed or likely
1. **Warn prominently** — before the route details, not at the bottom:
   > ⚠️ קליטה: ב[שם האיזור] אין קליטה סלולרית ברוב המסלול. מומלץ להוריד מפות אופליין לפני היציאה.

2. **Build a Google Maps route link** with all planned stops pre-loaded, so the family opens it **before** losing signal:

   **URL format:**
   ```
   https://www.google.com/maps/dir/[stop1]/[stop2]/[stop3]/[destination]
   ```
   - Use known confirmed place names (URL-encode spaces as `+`)
   - Stops = confirmed or recommended waypoints for that day
   - Example (Road to Hana):
     `https://www.google.com/maps/dir/Kahului/Twin+Falls/Wailua+Falls/Hana+Town/Oheo+Gulch`

3. **Add offline download reminder:**
   > 📲 לפני היציאה: פתחו Google Maps, חפשו את האיזור, לחצו "הורד" — עובד גם בלי קליטה.

### If coverage is uncertain (no clear result found)
Add a lighter note:
> 📶 הקליטה באיזור זה עשויה להיות חלשה — כדאי להוריד מפות אופליין ולשמור את קישור הניווט לפני היציאה.
> [קישור ניווט מוכן →](https://www.google.com/maps/dir/...)

### If coverage is fine (urban / suburban route)
No mention needed — don't add noise.

---

## Day-Type Heuristics

### Arrival day
Default: check-in, short walk nearby, dinner, early rest. Only suggest light activity if close and low-friction.

### Full city/destination day
One anchor activity (theme park, museum cluster, beach district). Alternate: lower-commitment neighborhood day.

### Nature / island / outdoor day
Do not overpack multiple far-apart sites. One scenic outing + recovery time.

### Transfer / flight day
Keep intentionally light. Avoid timed tickets unless user asks. Mention car return / check-out times prominently.

### Post-red-eye / late arrival day
Recommend recovery first. Avoid long drives or rigid morning plans.

---

## Family/Group Fit Rules
- Large groups move slower: avoid chaining too many stops.
- At least one flexible/reserve day in longer stays.
- For beach destinations, a "rest day" is a feature, not a gap.
- Teen-friendly/high-energy option as lead; calmer fallback as alternate.
- Arrival and departure days should never be overpacked.

---

## Group planning — who can suggest, who can approve

**Anyone in the group can participate in planning** — suggest activities, propose routes, vote on options. This is welcome and should be encouraged.

**Only the organizer ($ORGANIZER_REF) can approve writing to the trip site.** If a group member proposes a plan that others seem to agree with, still present a summary to the organizer privately and wait for their explicit approval before updating the site.

**Flow when planning involves the group:**
1. Engage the group in the planning — present options, invite reactions, note what people prefer.
2. Once a direction is clear, summarize the proposed plan and address the organizer:
   > "[Organizer name], הקבוצה נוטה ל-[option]. רוצה שאעדכן את המסלול באתר?"
3. Write to the site only after the organizer approves.

---

## Site update offer — after every daily plan

After generating a day plan (pattern C or D), always offer to update the trip site's daily schedule with the plan:

1. **Summarize what would be written** — one line per day item in plain language, as it would appear on the site.
2. **Ask for confirmation before writing — address the organizer:**
   > "רוצה שאעדכן את המסלול הזה באתר? הנה מה שיירשם: [summary]"
   > / "Want me to update today's plan on the site? Here's what will be written: [summary]"
3. **Write only after explicit organizer approval** — "כן" / "yes" / "תעדכן" counts as approval. Do not write speculatively or based on group consensus alone.
4. After writing, **read back the updated day entry** from the site and confirm it matches the approved plan.
5. If the site still shows the old plan after writing, say so explicitly and do not claim success.

**When NOT to offer a site update:**
- Ultra-short or overview requests (patterns A, B, E)
- When the organizer explicitly said "just a suggestion" or "don't update"
- When the plan covers a day that has already passed

---

## Choices and options — structured replies

When the answer to a question is a known set of options (activity choices, timing options, route variants, restaurant picks), present them as a numbered or lettered list so the group/organizer can reply with just a number or letter.

**Always add a free-text option at the end** ("אחר / Other — כתבו מה שתרצו") so anyone can propose something outside the list.

**Format:**
```
1. [Option A] — [one-line reason]
2. [Option B] — [one-line reason]
3. [Option C] — [one-line reason]
אחר — כתבו מה שבראש שלכם 🙂
```
or in English:
```
1. [Option A] — [one-line reason]
2. [Option B] — [one-line reason]
3. [Option C] — [one-line reason]
Other — feel free to suggest anything else 🙂
```

**When to use this pattern:**
- "מה עושים היום?" / "What should we do today?" with multiple reasonable options
- Activity or restaurant choice when 2–4 options are plausible
- Timing choices ("11:00, 13:00, or whenever we're ready?")
- Route variants

**When NOT to use this pattern:**
- When there is clearly one right answer (a confirmed booking, a flight time)
- When the question is open-ended with no obvious bounded set of answers
- When the organizer is asking a private operational question (not a group choice)

---

## Output Patterns

### A. "מה יש לנו בטיול?" — Trip overview
Return:
- trip overview (dates, party size, destination sequence)
- route table (phase → hotel → dates)
- flights / cars / transitions
- open tasks / missing confirmations
- explicit "מה שאין לי מאומת" section

### B. "תכין הודעה לקבוצה" — Paste-ready group message
Format:
- short opening line with emoji
- route by stop (dates + hotel)
- major flights/transfers
- upbeat closing line

Hebrew tone: warm, simple, scannable. Emojis sparingly but visibly.

### C. "מה היום / מחר?" — Daily operational brief
**Time awareness:** if planning for today, start from the current local time — skip activities that are no longer reachable or already closed.

For each day:
```
📅 [date] — [phase/city]  [🕐 current local time if today]
מאומת: [flights / car return / check-in if any]
🅿️ חניה: [parking warning + lot links — if urban attraction]
⚠️ קליטה: [dead-zone warning + Maps link — if remote route]
הבחירה המובילה: [attraction + verified hours]
חלופה: [lighter or closer option]
שיקול: [one-line — time, distance, group fit]
🌤️ תחזית: [temp range + rain risk — if applicable]
```
→ After delivering: offer to update the site (see "Site update offer" section).

### D. תדריך בוקר — Morning briefing
```
🌅 בוקר טוב! יום [N] ב[יעד]

📋 מה קורה היום: [verified logistics + leading activity]
⏰ זמנים קריטיים: [any flight / transfer / reservation]
🎒 מה להביא: [practical 2-3 items]
🌤️ מזג אוויר: [temp + rain + one note]
🅿️ חניה: [parking note + lot links — if urban day]
⚠️ קליטה: [dead-zone note + Maps link — if relevant today]
💡 טיפ: [one practical note]
```
→ After delivering: offer to update the site with today's plan (see "Site update offer" section).

### E. Ultra-short version
If user asks for shorter: duration + destination sequence + hotel names + key transition dates only.

---

## Good Hebrew Phrasing
- `מה שמאומת:`
- `הצעה שלי:`
- `הבחירה המובילה:`
- `חלופה:`
- `שיקול קצר:`
- `הנה גרסה לקבוצה:`

---

## Pitfalls
- Do not blur confirmed logistics with speculative plans.
- Do not invent flight times, booking refs, or attraction hours.
- Do not recommend far-flung attractions without checking driving time from the hotel area.
- Do not present a travel/transfer day as a full sightseeing day.
- Do not recommend an attraction without verifying it is open on the relevant date.
- If a maps/geocode lookup fails by hotel name, retry with the confirmed area/city name.
- Do not overload first and last days of a trip.
- A "rest day" on beach/island destinations is a valid and useful plan.
- Do not bury parking or dead-zone warnings at the bottom — they must appear before route/activity details.
- Do not build a Maps link with invented place names; use known confirmed stop names only.
- Do not suggest en-route stops that require backtracking or >10 min detour — ask first instead.
- Do not invent stop names; use maps skill or web_search results only.
- Do not plan from the start of the day if it is already afternoon or evening — start from the current local time.
- Do not suggest activities that are already closed or unreachable given the current local time.
- Do not write to the trip site without explicit organizer approval — always summarize first and wait for "yes".
- Do not invent parking prices — only mention price if found in a web source.
- Always offer both Google Maps and Waze nav links (unless user specified one).

---

## Verification Checklist Before Sending
- [ ] All stated logistics directly supported by the live config?
- [ ] Suggested activities clearly framed as suggestions?
- [ ] Each day respects arrival/departure/check-in realities?
- [ ] Missing data mentioned instead of guessed?
- [ ] Major travel times checked?
- [ ] Attraction hours verified via web for specific recommendations?
- [ ] Weather included where required by trip type or briefing setting?
- [ ] Active phase/date computed from live config, not memory?
- [ ] If planning for today: does the plan start from the current local time, not from morning?
- [ ] Site update offered after daily plan (C or D)? Summary shown before writing? Approval received?
- [ ] Parking checked for urban attractions? Warning + lot links included if problematic?
- [ ] En-route stops (gas/coffee/restrooms): on-route or minor detour only? Detour time noted if 5–10 min?
- [ ] Dead-zone check done for remote/scenic routes? Warning shown + Maps link built if confirmed?
- [ ] Both Google Maps and Waze nav links provided?
