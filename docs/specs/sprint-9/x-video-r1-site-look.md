# Video Release 1, parts 1A and 1B: the trip site looks like the video, and updates are obvious on it

Status: draft for approval (2026-11-16) · Issue: none yet (`x-` until filed) · Track: video plan, Release 1 · Size: L (two slices) · Tier: High
Security path: yes (new member-visible data on `/api/itinerary/active` and `/api/today`; two entries in `shared/feature-switches.js`) · Migration: no · Live-trip behaviour: no, until a switch is turned on for a trip

Decision behind it: the approved plan "Make Kinerary match the marketing video" (Dror, 2026-11-14),
Release 1 parts 1A and 1B; the owner's spec v0.2 (`$KINERARY_NOTES_DIR/specs/2026-11-14-video-to-product-plan.md`),
section 3 rows 0–1 and section 6 "Design inputs". Delivery follows `567-feature-switches.md` and
`568-trip-rollout.md`.

## Problem

The marketing video (`$KINERARY_NOTES_DIR/specs/kinerary-marketing-50s-en.mp4`, 11–17s) shows a light
phone screen: "Alsace 2026 / Colmar · Today", a skyline header, pill tabs **Today · Plan · Bookings ·
Photos**, one card "Thursday · Wine Route" listing the whole day as rows of time, title and a **Go** chip.
Dinner moves from 20:00 to 19:00, the row turns coral with an **Updated** badge, and under the card member
avatars and "**Updated for everyone ✓**". The Modern site does not look or behave like that.

**1A: the layout.**

- The tabs are Today · Journey · Moments · More (`trip-web/src/App.tsx:118`, labels 188-196). Bookings
  and Photos are modules reached from a shortcut list (`App.tsx:198-209`), not tabs. The bottom bar shows
  the four tabs at every width (`App.tsx:2788-2803`, `trip-web/src/styles.css:772-800`).
- Today does not list the day. `TodayView` (`App.tsx:662-726`) renders only the next item, through
  `UpcomingActivity` (`App.tsx:634-660`, used at 691). The whole day is already served:
  `/api/today` returns `events`, every item for today (`server/living-journey.js:1237`, built in
  `buildTodayContext`, 1198-1240). trip-web types the field (`trip-web/src/api.ts:241`), and nothing
  outside the tests reads it.
- The header (`Hero`, `App.tsx:398-499`) shows the logo, the trip title, the signed-in user and the
  active phase name. It shows no "<place> · Today" line. It has a hero photo
  (`heroCandidates`/`useHeroPhoto`, `App.tsx:421-423`; organizer-uploaded hero,
  `living-journey.js:989-1001`), and when there is no photo it falls back to nothing in particular.
  `shared/brand/` holds logo and mark SVGs only, with no skyline motif.
- Navigation links are built inline in each place, with no shared helper. `UpcomingActivity` always
  gives a Google Maps link, falling back to a search on title + destination (`App.tsx:643-644`), and adds
  Waze when there is a URL (645). The Journey row, `TimelineItem`, shows Map and Waze only when the item
  carries a URL (`App.tsx:529-530, 557-558`).
- The brand already matches the video: navy `--kit-ink` #10263a, teal #0e8f86 / #5fd3c4, coral
  #f26b3a, paper #faf8f5, DM Sans / Manrope (`shared/brand-tokens.css:1-25`). This is layout and
  component work, not a new brand.

**1B: updates are invisible to the family.**

- Every plan write already makes an immutable version. `cloneWith(db, author, note, transform)`
  (`living-journey.js:833-856`) copies the active rows, writes a new `itinerary_plan_versions` row with
  `author` and `created_at` (schema 156-166, immutable by trigger 259-264) and moves the active
  pointer (`trip_itinerary_state`, 204-209). `item_uid` survives the copy, so an item can be followed
  from version to version.
- The only change marker compares with the **original** plan, not with the recent past.
  `markProvenance` (`living-journey.js:643-658`) gives each item `added`, `updated_from_original` or
  `original`. trip-web shows it as a teal kicker on Journey rows ("Updated from original" / "Added",
  `App.tsx:551-552`, `styles.css:330`). A change made an hour ago looks the same as one made a month
  ago, and Today shows neither.
- The live refresh exists. `trip-web/src/live-updates.ts` listens on `/api/events` (SSE, 96), polls
  every 60s (89-91), and invalidates `itinerary` and `today` on an itinerary change (5-23). Nothing
  animates.
- No competitor documents this. The owner's competitor audit (2026-10-04, notes vault `insights/`,
  covering Wanderlog, Mindtrip, TripIt and Layla from public pages only) found:
  - for every product, no what-changed log and no undo (C1);
  - no per-edit attribution (C2). Wanderlog's only trace of a change is an email notice;
  - no group alert when the itinerary changes (D3). The alerts that exist are flight alerts, or a
    traveller-only notice.

  Showing *what* changed, to everyone, on the plan itself is the differentiation. Showing *who* changed
  it is not part of it (see Security and boundary notes).

## Behaviour

Two slices, each behind its own switch, both off by default (`567-feature-switches.md`). With both off,
the Modern site is byte-for-byte what it is today. The Classic site (`site/classic.html`, `site/app.js`,
chosen by `trip_ui_settings.design_variant`, `living-journey.js:133, 283`; redirect in
`site/index.html:83-94`) does not change in either slice.

### 1A: the trip site looks like the video (switch `site_video_layout`)

**Look.** A light screen: `--kit-paper` page, white cards, navy text. Teal is the header and the active
tab. Coral is used only for "something changed / act now" (1B). The navy-and-glow backdrop belongs to the
landing page (1E) and is not used here.

**Header.**

- The trip logo and title (`config.meta.title`).
- Under them, "<place> · <tab>", for example "Colmar · Today". The place is the current phase's title.
  Before the trip it is the first phase's title, and after the trip the last phase's.
- The background is a teal gradient (`--kit-teal` to `--kit-teal-light`) over the trip's hero photo when
  one exists (the existing candidates, `App.tsx:421-423`). When there is none, the gradient sits over a
  generic skyline motif, drawn in code as an inline SVG like the existing brand marks, with no raster
  file.
- On the end side, the signed-in user's avatar and a **More** button. More opens the existing menu
  (`AppMenu`, `App.tsx:2584-2683`), which gains the modules that are no longer tabs.

**Tabs.** **Today · Plan · Bookings · Photos**, as pills in one row directly under the header that stays
in view on scroll (see Open question 2).

- **Plan** is Journey renamed, with the SmarTrip structure listed below.
- **Bookings** is the existing bookings module.
- **Photos** is the existing photos module. Moments becomes a section inside Photos.
- **More** (the header button) lists Map, Budget, Readiness, Account, Group activities, Lost & Found,
  Trivia, Plan tools, "Who is coming" (`App.tsx:2440-2458`), the language toggle, and the organizer's
  link to Classic (`App.tsx:2478-2480`).
- Old addresses keep working: `#journey` opens Plan, `#moments` opens Photos, and every module hash opens
  as before (`App.tsx:2686-2688, 2720-2733`).

**Today.** One card for the day, titled "<weekday> · <day label>", for example "Thursday · Wine Route"
or "יום חמישי · דרך היין".

- The day label is the plan day's `label_en`/`label_he`, falling back to the phase title.
- The card lists every item of the day from `/api/today`'s `events`, ordered as served.
- One row is the time (or the rough-time word, as `itineraryTimeLabel` gives it today), the title, and
  a **Go** chip.
- The item that `next` names carries a quiet "Next" marker. Its separate "Up next" card is no longer
  shown.
- Tapping a row opens it in Plan, as the "Up next" title does today (`App.tsx:651`).
- Before the trip, the card shows the first trip day with "Starts in N days". On a trip day with no
  items, it says so and links to Plan. After the trip, no day card is shown and the page is as it is
  today.
- The panels already on Today (trip clock and daily message, weather, flights, companion, readiness;
  `App.tsx:586-632, 696-723`) follow the card, unchanged.

**Go chip.**

- **Go** opens Google Maps at the item's `location_url`, else its booking's `location_url`, else a place
  search on title + destination. This is the same order as `UpcomingActivity` (`App.tsx:643-644`).
  Building it moves into one helper, used by both the Today row and the Plan row.
- Waze is the second option: it appears in the row's expanded detail when a Waze URL exists
  (`App.tsx:645`).
- Items of type `free_time`, `task` and `note` get no Go chip (types: `living-journey.js:18`). A search
  for "Free evening" is not a place.
- In Hebrew the chip reads **ניווט**.

**Plan (SmarTrip structure, video colours).**

- A day strip across the top, grouped by phase. Each phase is a city, so a Colmar trip shows one group.
- Each day has a date column (day number, month, weekday) beside the day's card.
- The night's hotel line comes from the existing `lodging_context` on the day (`living-journey.js:168-178`).
- A small **Booked** tick appears on an item with an approved booking attached. Only approved bookings
  are served (`living-journey.js:664-666`).
- The teal "Updated from original" / "Added" provenance moves from the row kicker into the item's
  expanded detail (1B).

**Language and width.**

- Hebrew sets `dir="rtl"` as today (`App.tsx:2711-2714`). Times and the struck-through old time are
  isolated left-to-right inside right-to-left text, so "19:00" never renders as "00:19".
- At 880px and wider (`styles.css:853`) the pill tabs sit in the header. Today keeps its two columns,
  with the day card first and the panels beside it (`styles.css:94`).
- The phone layout is the one specified, and is checked at 390px wide.

### 1B: updates are obvious on the site (switch `plan_change_marks`)

**The marker.** When `plan_change_marks` is on for the trip, every item in `/api/itinerary/active` and in
`/api/today` (`events`, `next`, `current`) may carry `recent_change`, which tells what changed recently.

- **kind**: `added` or `updated`.
- **at**: when the change was made.
- **fields**: which fields changed. This is a closed set: `time`, `date`, `title`, `place`, `type`.
- **previous_time / previous_date**: the old values, given only when that field changed.

**How it is worked out.** It is derived from the plan versions that exist, with no new table and no
migration:

- **Baseline.** The baseline is the newest version in the active plan's parent chain created before the
  window start. If there is no such version, the baseline is the original plan, so a freshly built trip
  does not mark every item New.
- **Comparison.** Each active item is compared with its match in the baseline. It is matched by
  `source_ref`, then by `item_uid`, exactly as `markProvenance` matches. `kind` is `added` when the item
  has no match, and `updated` when a tracked field differs. An item changed and then changed back carries
  no marker.
- **When.** `at` is the `created_at` of the newest version in the window that changed that item.

**The window.** It is 24 hours (Open question 1).

**What the page shows.**

- **Updated row.** A coral-tinted row with an **Updated** badge, and the old time struck through beside
  the new one ("~~20:00~~ 19:00"). For a date change, the row on its new day shows "Moved from
  <weekday>". For a title, place or type change, the badge alone.
- **Added item.** A **New** badge: coral outline, no fill.
- **Under the Today card**, when any of its items carries a marker: "**Updated for everyone ✓** · 5 min
  ago" ("עודכן לכולם ✓ · לפני 5 דק׳"), and beside it the avatars of the trip's participants.
  - "How long ago" is the newest `at` on the card, through `Intl.RelativeTimeFormat` in the page's
    language.
  - The avatars are up to five, then "+n". They come from the participants the site already serves
    (`shared/config-visibility.js:197-204`), drawn with `PersonAvatar` (`App.tsx:272-292`).
  - They show the people the plan reaches, **not** the person who made the change.
- **The line means delivered, not read.** "Updated for everyone ✓" means the change is in the one plan
  everyone's site serves, and, once 1C ships, that it was sent to the group. Nobody's reading is tracked
  (Dror, 2026-11-14). There is no read receipt, "seen by", or per-person state.
- **Plan tab.** The same Updated / New treatment on its rows. The teal original-plan provenance moves
  into the item's detail, so the two never sit side by side.
- **Live.** A change made while the page is open arrives through the existing live refresh
  (`live-updates.ts`). A row whose `recent_change.at` is newer than anything the page has already shown
  plays a short coral highlight, and its old time slides into strikethrough. With
  `prefers-reduced-motion` (`shared/brand-tokens.css:27-33`) the final state appears without motion. An
  open editor still holds refreshes as it does today (`live-updates.ts:48-51`).
- **Expiry.** Markers drop out after the window, at the next refresh, with no reload needed.

## Acceptance criteria

Switches and isolation

- AC-1 Given `site_video_layout` and `plan_change_marks` both off for a trip, when a member loads the Modern
  site and calls `/api/itinerary/active` and `/api/today`, then the page renders the current layout and
  both JSON bodies are byte-for-byte what `main` at the base commit serves for the same data (no
  `recent_change` key anywhere).
- AC-2 Given either switch in any state, when the Classic site is loaded, then `site/classic.html` and
  `site/app.js` are unchanged in the diff and Classic renders as before.
- AC-3 Given `shared/feature-switches.js`, then it holds two new entries, `site_video_layout` and
  `plan_change_marks`, each `surfaces: ['site']`, `memberVisible: true`, with a one-line summary, and the
  registry's load-time shape check passes.
- AC-4 Given `plan_change_marks` on and `site_video_layout` off, then the server serves `recent_change`
  and the current layout ignores it without error.

1A layout

- AC-5 Given `site_video_layout` on, when the site is opened at 390px width, then the tabs read Today ·
  Plan · Bookings · Photos (Hebrew: היום · תוכנית · הזמנות · תמונות) and More is a header button whose
  menu lists Map, Budget, Readiness, Account, Group activities, Lost & Found, Trivia, Plan tools and Who
  is coming.
- AC-6 Given an address ending `#journey` or `#moments`, when it is opened with the switch on, then Plan
  or Photos opens respectively; every module hash in `moduleShortcuts` still opens its module.
- AC-7 Given a trip day with N dated items, when Today is opened, then one card titled "<weekday> · <day
  label>" lists exactly those N items in served order, each with its time and title, and the `next` item
  carries the Next marker; no separate "Up next" card renders.
- AC-8 Given a day with no label, then the card title falls back to the phase title; given a day with no
  items, the card says nothing is planned and links to Plan; given a date before the trip, the card shows
  the first trip day with "Starts in N days".
- AC-9 Given an item with `location_url`, then Go opens that URL; given none but a booking with one, then
  the booking's; given neither, then a Google Maps search on title + destination; given a Waze URL, then
  Waze appears in the expanded row; given `item_type` `free_time`, `task` or `note`, then no Go chip.
  Every link passes `safeExternalUrl`.
- AC-10 Given a trip with a hero photo, then the header shows it under the teal gradient with "<place> ·
  Today"; given none, the gradient sits on the skyline motif, and no raster image is added to the repo.
- AC-11 Given Hebrew, then `dir` is `rtl`, the tab order, header and day card mirror, and every time
  (including a struck-through one) renders in its correct digit order.
- AC-12 Given a width of 1280px, then the tabs sit in the header, Today shows the day card and the
  existing panels in two columns, and there is no horizontal scroll at 390px or 1280px.
- AC-13 Given the Plan tab, then it shows the day strip grouped by phase, a date column per day, the
  night's lodging line where `lodging_context` exists, and a Booked tick only on items with an approved
  booking.

1B marker and treatment

- AC-14 Given an item whose time changed from 20:00 to 19:00 one hour ago, when a member reads
  `/api/itinerary/active` and `/api/today`, then that item carries `recent_change` = `{kind: "updated",
  at: <that version's time, ISO UTC>, fields: ["time"], previous_time: "20:00"}`, and no other item
  carries a marker.
- AC-15 Given an item added one hour ago, then it carries `{kind: "added", at, fields: []}`; given an item
  changed 25 hours ago and not since, then it carries none; given an item changed and changed back inside
  the window, then it carries none.
- AC-16 Given a trip whose whole history is younger than the window (just provisioned), then items present
  in the original plan carry no marker.
- AC-17 Given an item moved to another day, then on its new day it carries `fields` including `date` and
  `previous_date`, and the row reads "Moved from <weekday>".
- AC-18 Given a change only to `website_url`, `ticket_url`, `booking_id`, `confirmation_state`,
  `duration_minutes`, `sort_order` or `extra_links`, then no marker is produced.
- AC-19 Given both switches on and an Updated item on Today, then its row is coral-tinted with the
  Updated badge and "~~20:00~~ 19:00", a New item shows the New badge, and under the card "Updated for
  everyone ✓ · <how long ago>" appears beside the participants' avatars (at most five, then "+n").
  Badge text meets 4.5:1 contrast against its background.
- AC-20 Given the same item on Plan, then it carries the same Updated treatment and the teal
  "Updated from original" appears only in the item's expanded detail.
- AC-21 Given an open Today page, when the organizer changes dinner from 20:00 to 19:00 through the trip's
  connector (`update_plan_item`), then within 5 seconds and without a reload the row animates into the
  Updated state; with `prefers-reduced-motion: reduce`, it reaches the same state without animation.
- AC-22 Given an Updated row whose change leaves the window, then at the next refresh (at most 60s) the
  marker is gone without a reload.

Boundary

- AC-23 Given a member's session, when `/api/itinerary/active` and `/api/today` are read with markers
  present, then no `recent_change` contains an author, username, note, version id, or any key outside
  `kind`, `at`, `fields`, `previous_time`, `previous_date`; and `/api/itinerary/revisions` still answers
  a member 403 (`organizerOrAgentRequired`, `living-journey.js:1427`).
- AC-24 Given an unapproved (review) booking attached to an item, then attaching or changing it produces
  no marker and nothing about it is served to a member.
- AC-25 Given `/api/config` for a member, then the allow-list in `shared/config-visibility.js` is
  unchanged by this work except for whatever `features` node `567-feature-switches.md` S2 defines.

Verification (from the approved plan)

- AC-26 Given the built site against the Alsace trip on Mac staging with both switches on, then
  screenshots of Today at 390px width, in English and in Hebrew, are set beside the video's frames at 12s
  and 16s, and the owner judges them a match. The screenshots and frames are stored with the run's test
  report in the notes vault, never in the repository (hard rule 3).
- AC-27 Given that page open, when dinner is changed 20:00 → 19:00 through the trip's connector, then
  the row turns coral with 20:00 struck through, as AC-21; changing it back removes the marker (AC-15).

## Contracts

**Switch registry: `shared/feature-switches.js`** (exists, `delivery_probe` only, entry shape at
14-20). Two entries are added:

```js
{ name: 'site_video_layout', summary: 'Modern site: video layout (Today · Plan · Bookings · Photos, day card, Go chip)', surfaces: ['site'], memberVisible: true },
{ name: 'plan_change_marks', summary: 'Plan items carry recent_change; Updated/New badges and "Updated for everyone" on the site', surfaces: ['site'], memberVisible: true },
```

`memberVisible: true` because the member's own page has to know which layout to draw.

**Served item field** (in `/api/itinerary/active` items and `/api/today` `events`/`next`/`current`, only
when `featureOn('plan_change_marks')`):

```json
"recent_change": {
  "kind": "updated",
  "at": "2026-12-03T14:05:00Z",
  "fields": ["time"],
  "previous_time": "20:00"
}
```

- `kind` is `added` | `updated`.
- `fields` is a subset of `time`, `date`, `title`, `place`, `type`. They map to the columns `time`;
  `date`; `text_he`/`text_en`; `location_url`/`waze_url`; `item_type`.
- `previous_time` is present only when `time` is in `fields`, and `previous_date` only when `date` is.
- The key is absent when there is no change.
- `at` is the version's `created_at`, which SQLite stores as a UTC `datetime('now')` and is served as ISO
  8601 with `Z`.

**Server**

- `server/recent-changes.js` (new) provides `recentChanges(db, { now, windowMs })`. It returns a
  `Map(item_uid → recent_change)` for the active plan.
  - It walks the active plan's `parent_revision_id` chain back to the baseline and loads versions with
    the existing `getVersionRows` (`living-journey.js:616-636`).
  - The walk is bounded at 200 versions. Past the bound, `at` is the oldest walked version's time.
  - The result is memoised per (active revision id, minute).
  - It reuses `markProvenance`'s matching (`source_ref`, then `item_uid`). It reads `author` and `note`
    nowhere.
- `server/living-journey.js`: the `/api/itinerary/active` handler (1372-1385) and `/api/today`
  (1693-1696) attach the field after serializing, behind `featureOn`. `buildTodayContext` itself stays
  unchanged, so its other callers are untouched. The ETag stays over the payload: a marker expiring
  changes the ETag, and that is correct.
- `featureOn(name)` is the site-side helper `567-feature-switches.md` S2 defines. This spec does not
  build it (see Dependencies).

**Client (`trip-web/src/`)**

- `App.tsx`: the tab model (`Tab`, labels, icons, routes), `Hero`, `TodayView`, a new `DayCard` and
  `DayRow`, `TimelineItem` (provenance moved into the detail), and Plan's day strip and date column.
  Every one of these branches on `features.site_video_layout`.
- `nav-links.ts` (new): the one Go/Waze/search link builder.
- `recent-change.tsx` (new): the badges, the struck-through time, the "Updated for everyone" line, and
  the highlight on arrival.
- `api.ts`: the item schema gains an optional `recent_change`.
- `parity-schema.ts`: accepts `features`, per #567 S2.
- `styles.css`: the new layout, under a root class set only when the switch is on, so nothing leaks into
  the current layout.
- `site/modern/` (`trip-web/vite.config.ts:12`) is rebuilt and committed in the same PR. The committed
  bundle is what a rollout ships, and a stale bundle drops `features`, which zod strips
  (`shared/config-visibility.js:20`). #567 S2's build hit exactly that.

**No migration.** No new table, no column, no change to `itinerary_plan_versions`.

**Dependencies**

- `567-feature-switches.md` **S2**: the worker writes `features`, `sanitizeConfig` serves the node,
  `featureOn` exists, and the parity schema accepts it. Not built today: there is no `features`
  reference in `server/`, `trip-web/src` or `shared/config-visibility.js`. Without S2 a site cannot read
  either switch.
- `568-trip-rollout.md` **R1**: the `site` step exists (`scripts/trip-rollout.py`, steps at 88-95). The
  `switches` step is not built, so a switch reaches a running site at its next rollout, through S2's
  worker write.

## Non-goals

- **The group line (1C), the morning briefing (1D), the landing page (1E), the share fix (1F).**
  "Updated for everyone ✓" names the group only once 1C ships.
- **Who changed it.** No author, avatar-of-editor or "changed by" anywhere a member sees.
- **Who looked.** No read receipts, "seen by", or per-person unread state (Dror, 2026-11-14).
- **Removed items.** An item that is gone cannot carry a marker. Saying so is 1C's group line.
- **Undo or a version browser for members.** The versions exist. Showing them is a later decision.
- **The Classic site, and the navy landing look**, which is 1E.
- **From SmarTrip, deliberately out or deferred:**
  - **Transit pills** ("metro · 15 min · ¥200" between stops). They need a travel-time source the plan
    does not have, and the rule is never to show minutes without one (v0.2 decision 4). Wanderlog has
    route and travel-time tooling ("See time and distance between places", competitor audit D2), so this
    is a known gap to close in Release 3 with a chosen source, not here.
  - **Numbered stops.** The time already orders the day, and the video shows time-first rows.
  - **Dashed open meal slots with a search button.** They are suggestions, which belong to Release 3's
    suggest-then-approve flow.
  - **A photo behind every stop.** No per-item image source exists. Stock fetching would be a new
    dependency, and photos of the place are not what the video shows.
  - **Prices in two currencies, and a "trip ready · all prices final" line.** Items carry no prices. The
    readiness band already exists on Today (`App.tsx:708-723`), and a summary line on top of it is
    deferred.
  - **Falling-leaf / seasonal particles.** Battery and reduced-motion cost for no information. The sense
    of place comes from the hero photo or skyline.
- **From SmarTrip, in:** the day strip grouped by city, the date column beside each day, the hotel card
  for the night, a booked marker, bottom-tab-level promotion of the four main areas, and a header that
  carries the place.
- **Later ideas from the owner's notes, not in 1A/1B:** typical weather for the trip's dates, and a
  summary of restaurant and hotel reviews.

## Security and boundary notes

- **A member never learns who changed an item.**
  - `recent_change` is built from `itinerary_plan_versions` but never reads `author` or `note`, and the
    response carries only the five keys of AC-23.
  - The revision list with authors stays organizer-or-agent (`living-journey.js:1427-1429`).
  - The avatars under the card are all participants. They are not the changer.
- **Pre-existing, found while writing this spec:** served plan items already carry `created_by`. For an
  item added through the site it is the adder's username (`living-journey.js:1508, 1751`). `publicItem`
  removes only `keep_both_with` (`living-journey.js:54-58`), so a member can already see who *added* an
  item. This spec adds nothing to that. Whether to drop `created_by` from the member projection here is
  Open question 3.
- **No organizer-only data through the marker.**
  - `fields` is a closed list of columns a member already sees on the item itself.
  - `previous_time` and `previous_date` are earlier values of fields the member could read in that
    earlier version.
  - Bookings are not tracked (AC-18, AC-24), because a booking under review is not member-visible
    (`living-journey.js:664-666`).
  - Organizer-only additions (seed flags, plan conflicts, `living-journey.js:1379`) are not inputs to
    the marker.
- **The allow-list is not loosened.** `shared/config-visibility.js` gets no new field from this work. The
  only change there is #567 S2's `features` node, built from the registry, literal `true`, member-visible
  entries only. `recent_change` is not config: it is served on the itinerary routes, which are behind
  `authRequired` as today.
- **Fail safe.** If the switch cannot be read, there is no marker and the current layout. If the version
  walk errors, `/api/itinerary/active` and `/api/today` serve without markers and log
  `recent_changes.failed` with no trip data, rather than failing the route.
- **Boundary review is required** (CLAUDE.md, "Security-sensitive paths"). It needs real request and
  response pairs:
  - a member and the agent key reading both routes, with the switch off and on;
  - an Updated and an Added item;
  - an unapproved booking attached;
  - showing that no author appears.

## Test plan

Tests are written first, from the criteria.

- `tests/` (trip-site suite): `recent-changes.test.js` covers AC-14 to AC-18, AC-22's expiry (with an
  injected `now`) and AC-24. `itinerary-recent-change-boundary.test.js` covers AC-1 (byte-identical
  when off) and AC-23, as a member and as the agent key, and is the evidence the boundary review uses.
- `trip-web` (vitest):
  - `tabs-video-layout.test.tsx`: AC-5, AC-6, and AC-1's "current layout when off";
  - `day-card.test.tsx`: AC-7, AC-8;
  - `nav-links.test.ts`: AC-9;
  - `recent-change.test.tsx`: AC-19, AC-20, AC-21 (with a faked live invalidation and reduced motion);
  - `rtl-times.test.tsx`: AC-11.
- The registry's own test covers AC-3. A `git diff --stat` check in the PR covers AC-2.
- Build check: `npm run build` in `trip-web`, and `site/modern/` committed. `scripts/preflight-deploy.sh`
  before the merge to `main`.
- Manual, on Mac staging (AC-10, AC-12, AC-13, AC-26, AC-27):
  - Run the built site against the Alsace trip with both switches on.
  - Take screenshots at 390px and 1280px, in English and Hebrew. Set the 390px ones beside the video
    frames at 12s and 16s.
  - Change dinner 20:00 → 19:00 on an open page through the connector, then change it back.
  - The dinner change is made by the organizer on his own trip and reverted in the same session.

## Rollout and regression

- **Risk class: yes.** Both slices add member-visible data on a boundary path, and the registry is in
  `shared/`. A regression plan and the owner's manual test go before the merge to `main` (CLAUDE.md,
  "Faster delivery", 2026-11-14).
- **No live trip feels it on merge.** Both switches are off by default. A trip feels it only after a
  rollout of a release that carries it **and** a switch set for that trip.
- **Target: the Alsace trip (`colmar-2026-2`, bound to the staging control plane on the Mac), live for
  December 2.** The path, in order:
  1. #567 S2 merged (the dependency).
  2. This work merged to `main`, with `site/modern/` rebuilt and committed in it.
  3. A release of that commit made `available` on staging.
  4. `scripts/trip-rollout.py plan --trip colmar-2026-2`, then `execute`. This is a deploy under hard
     rule 2, with one approval naming the commit, the trip and the steps.
  5. Both switches set on for `colmar-2026-2` (`npm run feature -- set … --trip colmar-2026-2`). If the
     trip is at `ready_private` or later this needs `--live`, which is a deploy prompt.
  6. AC-26 and AC-27 on that trip.

  Today is 16 November, so this leaves about two weeks, including S2.
- **Way back.** Switch off (instant at the next rollout, per #567 S2), or roll back to the previous
  release (`trip-rollout.py`, recorded per trip).

## Decisions

Taken by Dror, 2026-11-14, and carried here:

1. The site is very close to the video, and updates are obvious on the site, not only in chat.
2. "Updated for everyone ✓" means delivered to site and group. Nobody's reading is tracked.
3. Alsace (Dec 2–6) is the test bed. Release 1 keeps this order if time runs short: site look and
   Updated treatment first (Dror, 2026-11-16).
4. Structure may come from SmarTrip. Colours follow the video's light phone screen, and navy is the
   landing backdrop only.
5. "Recently changed" is derived from plan versions, with no migration.

Proposed in this draft, not yet approved:

6. Two switches, not one, so 1A can ship without 1B if 1B's boundary review runs late.
7. The Go chip goes straight to Google Maps, with Waze in the row's detail. A choice sheet on every tap
   would add a step the video does not show.
8. No Go chip on `free_time`, `task` and `note`.
9. Coral is reserved for change. The Updated badge is ink text on a coral tint with a coral edge, because
   white on #f26b3a falls below 4.5:1. New is a coral outline.

## Open questions

1. **What does the window mean?** The plan says "24 hours, or since the start of the trip day". The
   trip-day start is always within the last 24 hours, so "or" only changes anything if the intent is to
   *clear* markers at the start of each trip day. Recommendation: a plain 24 hours, so last night's
   22:00 change to today's dinner is still marked at breakfast.
2. **Where do the tabs go on phones?** The video shows pills under the header. SmarTrip and today's
   site use a bottom bar, which is easier to reach with a thumb. Recommendation: pills under the header,
   sticky, as the video shows, because the video is the promise.
3. **Should `created_by` stop being served to members** in this work (`publicItem`,
   `living-journey.js:54-58`)? Today it already tells a member who added an item through the site.
   Recommendation: yes, here. It is the same boundary this spec is promising to keep, and no member-facing
   renderer reads it.
4. **What if #567 S2 is not merged by about 28 November?** Alsace then has no way to read a switch.
   Recommendation: hold 1A/1B for Alsace rather than ship them unswitched. The alternative is a one-off
   build for that trip, which is exactly what the switches were built to stop.
