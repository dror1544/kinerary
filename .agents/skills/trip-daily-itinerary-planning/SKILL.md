---
name: trip-daily-itinerary-planning
description: Build low-stress family day plans around fixed anchors, travel buffers, rest windows, and simple place explanations.
---

# Trip daily itinerary planning

Use this skill whenever the user asks for:
- today's or tomorrow's trip plan
- a compact day schedule in one city
- how to fit restaurants, reservations, games, shows, tours, or drives into a day
- a plan that avoids being late, missing deposits, or overpacking the day
- a rewritten day plan after the user adds one more constraint (parking, showers, sports bar, coffee stop, kids/seniors, etc.)

This skill is for **practical day-of/day-before planning**. Optimize for calm execution, not maximal sightseeing.

## Core planning rule: anchor-first

Build the day around the **hardest-to-move anchors first**.

## Current-time and current-location rule

Before proposing a plan for **today**, anchor it to the actual time of the request and the family's current location.

Use the **travelers' local timezone** (the city where the family is now or where the activity occurs), not the host machine's timezone. If the user says “after 07:30,” treat 07:30 as the stated local planning boundary and schedule departure only after realistic preparation time.

Workflow:
1. Get the current date/time with a tool when the timing matters.
2. If the user provides a current location pin or explicitly says where the group is, use that exact location as the route origin.
3. If no current location is available, use the current hotel's verified address as a provisional origin.
4. If neither a current location nor a reliable hotel origin is available, ask the user to share their location before calculating a route.
5. Never schedule a departure at or before the current time when the user asks for a plan after that time. Add realistic preparation, parking, regrouping, and loading time.
6. State the assumed departure time only after this check, and keep any unverified location/time assumption explicit privately rather than silently presenting it as fact.

Examples of hard anchors:
- restaurant reservation times
- events with a start time (sports match, show, tour, ferry, ticket entry)
- long drives
- check-in / check-out windows
- airport/train departures
- anything with a deposit, late-cancel penalty, or short grace period

Workflow:
1. List the fixed-time anchors in chronological order.
2. For each anchor, add a **real arrival target** that is earlier than the official start.
3. Add the travel segment before it.
4. Add a buffer for parking / Uber pickup / walking / group wrangling.
5. Only then fill the free blocks with optional sightseeing.

## Reservation protection rule

If the user says things like:
- "don't let us be late"
- "they take a deposit if we're late"
- "there's only a short grace period"

then treat the reservation as the day's governing constraint.

Workflow:
1. Surface the exact late-risk rule if known (for example a 10-minute grace period).
2. Recommend an **arrival window**, not just a departure time.
3. Back-calculate a conservative departure.
4. If parking is uncertain, say so directly and either:
   - move departure earlier, or
   - recommend Uber/taxi as the lower-risk option.
5. Keep the user's real goal explicit: **protect the booking**.

Good pattern:
- "Reservation is 19:30, they hold only 10 minutes, so aim to arrive 19:05-19:15."

Bad pattern:
- "Leave around 19:20, should be fine."

## Add the human buffer

For family travel, a good schedule is not only drive time.
Always consider:
- showers
- changing clothes
- rest at the hotel
- bathroom/snack stops
- time to gather everyone
- elevator/lobby/Uber coordination for larger groups

If the evening includes a nicer dinner or timed booking, explicitly reserve a **hotel reset block** before departure.

Default pattern for family dinner nights:
- return to hotel about **1.5-2.5 hours** before departure when possible
- label the block clearly: **rest / showers / change / regroup**

## One-heavy-block rule

When a day already includes one or two anchors, avoid stacking too many extra neighborhoods or attractions.
Prefer:
- one scenic block in the morning
- one urban/walkable block later
- then hotel reset and dinner

If a user starts adding more items, simplify instead of expanding.

## User sequencing and deferral rule

When the user says a place should be **saved for another day** (for example: "leave Chinatown for Monday"):
1. treat that as a planning decision, not a soft preference
2. remove that place from the current-day plan completely
3. do not keep reintroducing it as an optional filler for the same day
4. when useful, explicitly note where it moved (for example: "Chinatown stays for Monday")
5. when giving the final cleaned-up plan, present only the surviving stops so the user can forward it as-is

This matters especially after a long back-and-forth: the final version should reflect the latest agreed sequence, not every earlier idea.

If the user explicitly corrects a misplaced neighborhood/stop (for example: "בלי Chinatown בראשון — כולם הולכים ביחד בשני"), update both affected day buckets immediately: remove it from the wrong day and add/confirm it on the right day. Do not wait for another summary request.

## Confirmed-itinerary state preservation rule

When the user says **"save this"**, **"this is the final itinerary"**, **"this is Sunday"**, **"this is Monday"**, or corrects a prior mix-up:
1. Treat the corrected message as the authoritative itinerary state for that day.
2. Do **not** reconstruct the day from the original trip plan or older assistant messages unless the user asks to revise it.
3. Keep separate day buckets in working notes: Sunday, Monday, missing items, restaurant choice, transportation notes.
4. When asked "what is the schedule for Sunday and Monday?", answer from the latest saved/corrected buckets, not from memory of earlier proposals.
5. If there is a conflict between the latest user-supplied schedule and an earlier trip-plan source, explicitly prefer the latest user correction and mention only if relevant: "using your latest saved version."
6. Preserve important details the user corrected repeatedly (restaurant name + time, dessert/cafe stop, split groups, departure time for parking). Do not summarize them away.

Strong frustration signals like "you're mixing it up", "this is not it", or "this is what we built" mean stop expanding and restate only the corrected plan compactly before doing anything else.

## Single-day scope discipline

If the user says to focus on **one specific day only** (for example: "let's go back just to Monday" or "don't touch Sunday"):
1. freeze the other day's plan
2. do not continue reshuffling the frozen day while discussing the current one
3. answer only within the requested day scope unless the user explicitly asks to compare days again
4. if a new idea would affect the frozen day, mention it only as an optional note, not as an automatic rewrite

This is especially important after several rounds of itinerary edits; once the user narrows scope, respect that boundary.

## Preserve-original-anchors rule during live replans

When the user says some new routing or transport change should be added **to the original day** (for example: "add what I said to the original Monday schedule"):
1. start from the latest user-approved version of that day
2. preserve the original core anchors unless the user explicitly removes them
3. integrate the new constraint around those anchors instead of silently dropping stops
4. if an anchor no longer fits, say that plainly and ask whether to cut it rather than removing it on your own

Examples of anchors that should not disappear just because the route changes:
- Pier 39 / sea lions
- Lombard Street
- a fixed dinner reservation
- a promised split point for grandparents/rest

Bad pattern:
- user asks to add Cable Car + Chinatown and the assistant accidentally drops Pier 39 or Lombard without permission.

Good pattern:
- "Keeping Pier 39 and Lombard, and moving Cable Car + Chinatown to the later block after the car is returned."

## Meal-density rule

When the day includes multiple food-related stops (coffee, snack market, dessert stop, dinner, sushi idea, cheesecake stop, etc.), do not treat them as independent wins.

Workflow:
1. Ask what each food stop is meant to do: full meal, light snack, dessert, coffee, or just an experience.
2. Prevent stacking two filling stops too close together unless the user explicitly wants that.
3. If a major dessert stop sits inside another activity zone (for example Cheesecake Factory at Union Square), schedule it as a **small shared stop** unless the plan intentionally uses it as the meal.
4. If adding one food experience would make a later anchor feel too heavy, move it to another day or drop it.
5. Say the tradeoff plainly: "If we do Kura first, Cheesecake later may feel too heavy."

Good pattern:
- use Chinatown later in the day when the user wants light browsing and nibbling
- keep Cheesecake Factory as coffee + shared slice when dinner is still ahead

Bad pattern:
- stacking sushi, cheesecake, and dinner in one window without checking whether the user wants a real meal or just a taste

## Co-locate nearby activities

When two activities are in the same area, say so plainly and group them together.
Examples:
- square + cable car turnaround in the same zone
- restaurant + nearby dessert/coffee stop
- viewpoint + bridge overlook on the same drive

Use this to reduce unnecessary cross-city zigzags.

## Explain places in plain trip language

If the user sounds unfamiliar with the city or asks for explanations, do not name places only.
For each main stop, briefly explain:
1. what it is
2. what you do there
3. why it fits this day

Good pattern:
- "Battery Spencer — תצפית על גשר גולדן גייט מלמעלה; עוצרים ל-20-40 דקות בשביל הנוף והתמונות."
- "Union Square — הכיכר המרכזית של אזור הקניות; נוח לשלב שם את הרכבל, חנויות, ועצירת קפה."

Keep the explanation short and useful, not like a travel brochure.

## Coffee-stop rule

If the user asks for a relaxed morning coffee stop:
- treat it as a real part of the plan, not a throwaway suggestion
- prefer a non-chain cafe when the user explicitly rejects Starbucks
- place coffee at the start of the day or at a natural reset point near a later activity
- if the day has an early timed anchor, keep the coffee stop simple and low-risk

## Sports game / live viewing rule

If the day includes watching a live match at a sports bar/pub:
1. treat the match start as a fixed anchor
2. add time to get seated **before kickoff/tipoff**
3. avoid planning a far-away activity immediately before the game unless the travel buffer is comfortable
4. after the match, choose one compact nearby activity rather than a second big cross-city loop

## Snack-neighborhood timing rule

If the user values an area mainly for:
- street snacks
- bakery stops
- dessert/cake stops
- market-style browsing

then do **not** automatically schedule that area early in the day.

Workflow:
1. Ask what the user wants from the neighborhood if it is not obvious.
2. If the answer is "to nibble / browse / not get too full", move it to late lunch or mid-afternoon.
3. Keep the formal meal lighter before it.
4. Say the logic plainly so the user can approve the sequence.

Good pattern:
- "Let's save Chinatown for later since you want the stalls and small bites there."

## Mixed-energy split rule

For larger family groups, proactively offer a **split point** when the day has already covered the main sights.
This is especially useful when some travelers may want to rest before dinner.

Workflow:
1. Build one shared plan until a clear checkpoint (for example 15:00).
2. After that, present two branches:
   - **return to hotel** for rest/showers
   - **continue nearby** in a low-logistics area
3. Keep the continue-nearby option simple: park, square, cafe strip, dessert, or gentle neighborhood walk — not another major attraction.
4. Re-converge the group at the hotel before dinner unless the user explicitly wants to meet at the restaurant.
5. For a 19:30 dinner, default the latest comfortable hotel return for the late group to about **17:30** when showers/changing are expected.

Good pattern:
- "Until 15:00 everyone together; after that, grandparents can head back while others do a light North Beach/Washington Square loop and still be back at the hotel by 17:30."

## Restaurant-decision timing rule

When the user is still shaping the day and says things like:
- "let's plan the day first"
- "leave the restaurant for the end"
- "first decide what people do after 15:00"

then do **not** keep trying to finalize dinner early.

Workflow:
1. Freeze the restaurant choice temporarily.
2. Finish the day structure first: anchors, sightseeing order, split point, return-to-hotel time.
3. Only after the day shape is agreed, return to the dinner choice.
4. Recommend the restaurant in the context of the finished day: neighborhood, energy level, price sensitivity, seniors, and whether everyone reconverges at the hotel first.

This prevents the planning thread from bouncing between logistics and restaurant comparisons before the route is stable.

## Single-recommendation rule for indecisive choice threads

If the user shows decision fatigue or says things like:
- "just recommend one"
- "עזוב"
- "don't give me so many options"
- "just tell me where to eat"

stop expanding the option tree.

Workflow:
1. Give **one clear recommendation**.
2. Support it with only 2-4 short reasons tied to the user's constraints.
3. Mention a backup only if truly necessary.
4. Do not reopen the full comparison unless the user asks.

Good pattern:
- "Osha Thai — best fit here: varied menu, easier for mixed tastes, not too heavy, close to the hotel."

Bad pattern:
- listing five more restaurant candidates after the user already asked for one answer.

## Transport choice rule

When deciding between driving and Uber/taxi:
- choose based on **lateness risk**, not just distance
- a short drive can still be risky if parking is uncertain
- if the destination has a known parking lot, driving becomes more viable, but still include walking and arrival buffer
- if Uber removes the main uncertainty, say that plainly

## Must-have store / outlet verification rule

When recommending a mall, outlet, supermarket, or shopping stop, first identify whether the family has a **must-have store or brand** (for example Ralph Lauren/Polo, Ulta, Nike, or a specific youth brand). Treat that as a hard routing constraint.

Workflow:
1. Search the **official center directory or official brand store locator** for the exact store name, including alternate names such as `Polo Ralph Lauren Factory Store`.
2. Do not conclude that a store is absent merely because a dynamic directory page or generic map search did not expose it; verify with a second authoritative path before ruling it out.
3. If the must-have store is confirmed, recommend the center that satisfies it even if another outlet is generally larger or closer.
4. Compute the actual route in the proposed sequence using exact addresses: origin → stop 1 → shopping center → hotel. Give both drive time and a realistic stop/traffic buffer.
5. Be explicit about the tradeoff: a store-first choice may be less convenient than the original recommendation, but it prevents a wasted detour.

Good pattern:
- "If Polo Ralph Lauren is the goal, choose the center whose official directory confirms Polo Ralph Lauren Factory Store; the earlier youth-brand ranking is secondary."

Pitfall:
- Do not recommend a “best youth outlet” and only later discover that the named must-have brand is at a different center.

### Branded sports-equipment availability

When the requested item is a specific combat-sports brand or model (for example **Venum shin guards**), do not answer with generic sporting-goods stores as though they satisfy the request.

Workflow:
1. Separate the requirement into **item + exact brand + size + urgency** (for example: shin guards, Venum, medium, needed today).
2. Check the brand's official site/store-locator or verified retailer listings first; distinguish an online product listing from a physical store with pickup inventory.
3. For same-day purchases, require **store-level stock confirmation** or tell the family plainly that stock is unverified. Provide a tap-to-search maps link only as a lead, not as proof that the brand is available.
4. If no nearby physical stock is verified, give the practical fallback: order to the next hotel, use a verified same-day retailer, or buy an alternative brand only if the family approves.
5. After the family gives their current city, re-search from that city and avoid repeating an unverified “there may be a store” answer for multiple cities.

Pitfall:
- “MMA store near Los Angeles” does **not** establish that it carries Venum, and an official Venum product page does **not** establish local pickup. Say exactly which part is verified.

## Urban parking-anchor rule

When a city itinerary includes getting out of the car and walking:
1. Route to a **nearby parking garage, public lot, or verified legal parking area** as the navigation destination—not merely to the attraction or neighborhood name.
2. Choose the parking anchor to minimize walking to the planned pedestrian area, while considering height limits, likely availability, cost, and family mobility.
3. In dense/high-demand areas where parking is expensive or scarce, state the parking option first and then the walking route from it.
4. If no parking option is verified, do not imply that street parking will be easy; say so and offer valet, a garage, or rideshare as the lower-friction alternative.
6. For every parking-based stop, state the approximate walking time from the parking location to the actual attraction/entrance. If the walk is **more than 5 minutes**, flag it clearly and, when practical, look for a closer parking option or offer valet/rideshare as an alternative.

Good pattern:
- "Park at Brighton Garage; Rodeo Drive is about 3 minutes on foot."
- "The sign is about 12 minutes from this garage, so this is not the closest practical option."

## Route-time consistency rule

Before stating a transfer duration:
- route between the **actual booked hotel addresses**, not broad city labels
- distinguish **routing-engine drive time** from a realistic family travel estimate
- include traffic, parking, restroom/food stops, and shopping time separately
- if a previous estimate conflicts with a verified route, acknowledge and correct the number instead of repeating the old estimate

## Road-trip provisioning / supermarket stop rule

When the user asks about stocking up on food before a hotel or national-park stay:
1. First identify the **next lodging** from bookings/trip plan and the route segment for tomorrow.
2. Verify room food facilities from the booking document or hotel source before saying they can cook. Distinguish clearly between:
   - **light food / storage / reheating**: refrigerator, microwave, coffee maker
   - **real cooking**: kitchenette, stove, oven, cookware
3. If facilities are not verified, say “I’d plan for light meals/reheating, not full cooking” rather than overpromising.
4. Recommend a grocery stop **before remote/tourist areas** when practical, prioritizing full supermarkets in the last real town on-route over small park-area markets.
5. Give a compact shopping list matched to the confirmed/likely facilities and family convenience.

## Transfer-day simplification rule

When the family is **leaving one base and relocating to the next hotel/city the same day**:
1. Treat the transfer as the day's main anchor.
2. Prefer **one low-detour stop** on the route, not a second half-day attraction.
3. If the origin city/park has already been "done," avoid squeezing in one more substantial hike just because there are a few morning hours left.
4. Recommend an **arrival-side decompression stop** near the new base when useful (for example a short waterfront stroll, viewpoint, or easy shopping/food strip after check-in).
5. If the user asks for places "on the way but not too much longer," bias toward:
   - route-native coffee/restroom stops after ~45-90 minutes
   - one practical mid-drive break
   - then a short, easy first stop near the destination
6. Make the tradeoff explicit: arriving with energy for the new place is usually better than extracting one last moderate attraction from the old place.

Good pattern:
- Yosemite → Monterey: skip another real Yosemite hike, make one easy coffee/rest stop on-route, then do Lovers Point / Cannery Row after arrival.

Bad pattern:
- keeping a long national-park hike on the same day the family still wants a pleasant arrival evening in the next city.

## Completed-plan rollover rule

When a user asks for **tomorrow's** plan right after discussing a specific route/day plan, do not assume that earlier plan is still pending.

Workflow:
1. Check whether the user indicates the earlier plan was already done (for example: "עשינו את זה היום").
2. If yes, treat the prior route as **completed** and pivot immediately to the next logical Yosemite day instead of repeating the same plan.
3. Build the next-day recommendation around what remains undone and the user's stated sequencing (for example keeping Mist Trail for the following day).
4. If the user asks what to tell the family, summarize only the **new** day plan, not the already-completed one.

Pitfall:
- After several Yosemite back-and-forth turns, it is easy to repeat today's Glacier Point / Valley View / Mariposa sequence when the user has actually already done it. Once the user says they already did it, stop reusing that plan for tomorrow.

## Low-signal national-park navigation rule

For Yosemite or similar low-reception park days, when the user asks for navigation links:
1. Prefer a **single Google Maps directions URL** with origin, destination, and ordered waypoints for the main route.
2. If the day could reasonably be shortened, also provide **one backup route link** with the optional stop removed.
3. Mention briefly that the family should open the link and save offline maps before entering the park.
4. For group-post versions of the itinerary, include the single main link directly in the message so it can be reused without further chat context.

Good pattern:
- full-day one-link route
- shorter backup one-link route
- one short note about offline maps / weak reception

Bad pattern:
- a long list of separate pins when the user explicitly asked for one route because there is no signal in the park.

## Yosemite trail-distance verification rule

When planning Yosemite hikes such as **Mist Trail / Vernal Fall**:
1. Prefer the **official NPS trail page** over memory, trip-plan shorthand, or another model's estimate.
2. Distinguish carefully between:
   - **one-way distance to a landmark**
   - **round-trip distance**
   - **distance to the footbridge** vs **distance to the top of Vernal Fall**
3. If the user challenges the distance with another source, verify immediately and correct the itinerary before reusing it in group posts.
4. For the common short version of Mist Trail, use the official NPS framing:
   - **Vernal Fall Footbridge = 1.6 mi / 2.6 km round trip**
   - **Difficulty: Moderate**
   - **Time: 1–1.5 hours**
5. Treat the old shorthand in the trip notes (`3 ק"מ לגשר`) as approximate and subordinate to the official NPS trail page when there is a conflict.

Pitfall:
- Do not accidentally turn an approximate note like `3 ק"מ לגשר` into `6 ק"מ הלוך־חזור` unless an official source confirms that interpretation.

### Quick hotel-amenity verification rule

When the user asks a narrow practical question such as:
- "is there a refrigerator in the room?"
- "does the room have a microwave?"
- "is there a kitchenette?"

optimize for a **fast yes/probably/unknown answer** backed by the best available source, not a long intake workflow.

Workflow:
1. Check the current hotel from bookings/trip plan first so you verify the right property.
2. Prefer the **official hotel site** or the booking confirmation if it is already available.
3. If the official site is JS-heavy, sparse, or blocked, use a **search-engine path to alternate official room pages / mirrored official room listings** rather than stopping empty-handed.
4. Answer in one short line first:
   - **yes** when the amenity is clearly listed,
   - **probably** when multiple room descriptions on the official property pages show it but the exact room type is not yet confirmed,
   - **unknown** when you still do not have evidence.
5. Add one short caveat only if needed, such as "depends on exact room type."
6. For follow-up grocery/planning advice, distinguish between:
   - fridge/microwave only → snacks, dairy, sandwiches, reheating
   - kitchenette/stove confirmed → light cooking is realistic

See `references/yosemite-provisioning-and-room-facilities.md` for a concrete SF → Yosemite example covering route-aware supermarket choice, low-detour verification, and cautious room-facilities wording when cooking amenities are unverified.
See `references/yosemite-room-amenities-cross-check.md` for a quick Yosemite View Lodge fridge/microwave/kitchenette verification example.
See `references/yosemite-mist-trail-follow-up.md` for a concrete next-day Yosemite pattern after the family already completed the Glacier Point / Valley View / Mariposa day: Mist Trail to the footbridge, then nearby low-logistics follow-ups like Mirror Lake and Yosemite Village, with realistic drive times and one-link navigation.
See `references/monterey-transfer-arrival-example.md` for a Yosemite → Monterey transfer-day example covering low-detour stops, arrival-side decompression, Cannery Row vs Old Fisherman's Wharf framing, and whale-watching follow-up guidance.
See `references/monterey-aquarium-17mile-carmel-day-pattern.md` for a Monterey/Pacific Grove full-day pattern built around coffee near the hotel, Monterey Bay Aquarium timing, a short-stop 17-Mile Drive sequence, Carmel finish, and practical family-facing explanations for each stop.

### Session-specific Yosemite preference note

For **this family trip specifically**, preserve this learned preference from live feedback:
- the short Mist Trail version **only to Vernal Fall Footbridge** may feel **not worth the drive/effort** for this family if they are already committing to the outing
- if recommending Mist Trail again during this trip, prefer framing the meaningful version as **continuing beyond the footbridge up to Vernal Fall** when conditions/energy allow
- if the family wants only a very short outing before a long transfer day, consider skipping Mist Trail entirely and choosing a simpler valley viewpoint stop instead
- carry forward that the user's direct feedback was: **the trail was excellent, but not really worth it unless you reach at least the waterfall**

## Uploaded attraction-ticket verification rule

When the user uploads a PDF ticket or confirmation and asks about admission time, benefits, ID, or how to use it:
1. Extract the document before answering; do not ask the user to paste text that is available in the file.
2. State only what the ticket explicitly says, separating exact terms from general venue practice.
3. If it says “valid during normal operating hours” but gives no opening time, do not invent one; consult the official hours calendar or say the exact time is not printed.
4. Treat “valid photo ID required” as an explicit requirement. Do not invent a child exception, and do not promise that a photo/photocopy will be accepted. For a minor with a passport, advise that an adult can carry the original securely to the gate rather than making the child carry it all day.
5. Distinguish Universal Express/Express Unlimited from Early Access: Express is a shorter line during normal operating hours; Early Access is separate unless explicitly included.
6. Preserve important exclusions such as parking not included and separately ticketed events.

See `references/attraction-ticket-verification.md` for the reusable PDF-extraction and Universal Express example.

## Ticket/payment caution rule

For transit tickets, attraction tickets, app passes, digital-wallet passes, or anything involving money:
1. Do not confidently advise purchase, activation, refund, or cancellation based on assumptions.
2. Read visible screenshot fields carefully. If expiration/date/activation status is ambiguous, ask the user to transcribe the exact line before giving advice.
3. Distinguish **purchase** from **activation/use**. Say exactly which action is safe and which button not to press.
4. If the user already purchased and is worried, focus first on preventing activation/duplicate purchase, then on refund/support options.
5. If you made or might have made a mistake, stop guessing immediately and move to evidence-based recovery.

Good pattern:
- "I can see it is Available and not Active. I cannot confidently read the expiration; please tell me exactly what the Expiration line says before we decide."

Bad pattern:
- assuming a cable-car ticket bought today is valid for tomorrow, then reversing that advice without verifying the visible expiration date.

## Ambiguity and direct-answer rule

When a travel question can reasonably mean more than one thing, identify the ambiguity before recommending a place or changing the itinerary. Ask the smallest useful clarifying question when the distinction materially changes the route or tool lookup.

For route questions, explicitly distinguish:
- **"Is it on the way?"** — verify whether the stop lies on the planned route and whether it adds a meaningful detour.
- **"Is it near the destination?"** — verify distance from the hotel or final stop.
- **"Is it a good shopping option?"** — compare store mix and size, not just geography.

If the user clarifies which interpretation they meant, answer that exact question first in one sentence, then add only the key practical implication. Do not keep defending or elaborating the earlier interpretation. Correct the record plainly when prior answers mixed up two outlets, brands, or routes.

## Output format

For Telegram/direct chat, default to:
- a short heading
- a simple time-ordered bullet list
- 1 short section for "why this works" or practical notes

When the user asks for a version to copy/share (for example "תכתוב לי בלי טבלה שאוכל להעתיק"), avoid tables and use plain chronological bullets with short section headings. Tables are fine for comparisons, but copyable family itineraries should be no-table text.

When the user wants more hand-holding, add compact explanations under the key stops.
Do not turn a day plan into a long essay.

## Family-group addressing rule

When answering inside this family-trip context:
1. Do not default to addressing **only Dror** if another family member is actively asking the question.
2. Answer the current speaker directly and neutrally (for example: "המלון שלכן", "הנה הכתובת", "כן").
3. If the user has explicitly named the assistant persona or gender for this thread (for example **"ויקטוריה"**, feminine voice), preserve that style consistently in follow-ups.
4. Avoid sounding like there is a separate "private planning channel" that outranks the active family speaker unless the user explicitly asks about that.

Practical effect:
- keep replies inclusive and speaker-aware
- do not route answers through Dror by default
- if corrected on persona/name/gender, lock to the corrected form immediately

## Day-of-week verification rule

When mentioning weekday labels together with specific dates (for example "30/7 = Thursday"):
1. verify the weekday from a tool before stating it
2. if a user corrects the weekday, treat that as a verification failure and fix the itinerary wording immediately
3. do not confidently reuse copied weekday labels from earlier draft plans without re-checking the date

This matters in travel plans because a wrong weekday makes restaurant, transfer, and attraction planning feel unreliable even when the date itself is right.

## Verification and grounding

Before finalizing:
- check the current trip phase and booked hotel/location
- verify reservation time, address/area, and any grace-period or parking detail from the source the user provided
- verify travel times with tools when available
- say when a claim comes from the trip plan, the website, or the uploaded screenshot

## Pitfalls

- Do not optimize for seeing "more" at the cost of the timed reservation.
- Do not give departure times without an arrival target.
- Do not ignore parking, Uber wait, or walking from drop-off.
- Do not leave out showers/rest when the user explicitly cares about getting ready.
- Do not answer with unexplained place names when the user signals unfamiliarity with the city.
- Do not split same-area activities into different parts of the day if they naturally combine.
- Do not forget secondary anchors the user mentions later in the thread (for example a sports match after already planning around dinner).

## Session-specific references

See `references/san-francisco-fixed-anchor-example.md` for a concrete example of planning around a sports-bar noon anchor, Union Square/cable car colocation, and a Fort Mason dinner reservation with parking/grace-period constraints.
See `references/san-francisco-split-day-and-snack-sequencing.md` for a concrete example of delaying Chinatown for snacking, adding Lombard/Pier 39, and splitting the afternoon into rest-vs-continue branches before a shared dinner.
See `references/san-francisco-food-stop-and-scope-discipline.md` for a concrete example of freezing one day's plan while revising another, and of avoiding too many filling food stops in the same window.
See `references/san-francisco-itinerary-state-preservation.md` for a concrete example of preserving the user's final corrected Sunday/Monday schedule after repeated mix-ups, including Greens at 19:30, Cheesecake Factory, and Monday restaurant decision state.
See `references/san-francisco-final-two-day-itinerary-state.md` for the latest saved Sunday/Monday SF state from this session, including no-Chinatown-on-Sunday, Joe & The Juice Monday morning, Osha Thai Monday dinner, and Cable Car ticket guidance.
See `references/san-francisco-cable-car-ticket-caution.md` for a cautionary example on MuniMobile/Cable Car ticket purchase vs activation, ambiguous expiration dates, and user-trust recovery after paid-ticket advice.
See `references/san-francisco-live-replan-monday-seniors.md` for a live-replan example where new constraints (08:00 start, Cable Car to Chinatown, grandparents resting at 13:00) must be integrated without dropping original anchors like Lombard and Pier 39.
