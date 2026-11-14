# The activity-type box speaks the site's language

Status: draft 2026-11-12 — behaviour decided by Dror in #549; approval at merge · Issue: #545 · Track: Sprint 8 staging-test fixes · Size: S · Tier: Normal
Security path: no · Migration: no · Live-trip behaviour: yes (a site-payload change: reaches a trip on its next redeploy)

## Problem

Sprint 8 staging test, 2026-11-12 (`gatecity-2026-2`, Hebrew site), step 12: the
"Type" selection box in the itinerary editor listed its options as `activity`,
`travel`, `free time` … while everything around it was Hebrew.

Cause: `trip-web/src/App.tsx` rendered each option as the stored identifier
(`type.replace("_", " ")`). The same identifier was printed, untranslated, in
two more places that show an item's type: the kicker line on a Plan item card
and the badge on a Map "daily stop" card.

## Decision

The item types are a **closed set of eight** that the server validates
(`server/living-journey.js` `VALID_ITEM_TYPES`, `server/trip-structure.js`
`ITEM_TYPES`). Per the English-native rule ("use an existing translation, else
translate once and cache"), English is the source and the translation is **one
curated table** (`trip-web/src/item-types.ts`) — not a runtime model call: a
fixed eight-word set needs nothing to call and nothing to cache. No existing
translation table covered these words; the site's own `copy(lang, en, he)`
pairs are the idiom this follows.

| value (stored, unchanged) | English | Hebrew |
|---|---|---|
| `activity` | Activity | פעילות |
| `travel` | Travel | נסיעה |
| `meal` | Meal | ארוחה |
| `lodging` | Lodging | לינה |
| `free_time` | Free time | זמן חופשי |
| `booking` | Booking | הזמנה |
| `task` | Task | משימה |
| `note` | Note | הערה |

Only the label is translated. The option's `value` stays the English identifier,
so what the site sends and the server stores does not change. A type the server
learns later falls back to its identifier (underscores to spaces) until it is
added to the table; AC-4 checks the table covers every entry of the list the
site offers.

## Acceptance criteria

- AC-1 Given a Hebrew site, when the itinerary editor's Type box is opened, then
  every option's text is Hebrew and the option values are the eight English
  identifiers.
- AC-2 Given an English site, the options read "Activity, Travel, Meal, Lodging,
  Free time, Booking, Task, Note".
- AC-3 Given a Hebrew site, the type shown on a Plan item card is Hebrew
  ("זמן חופשי", not "free time"). The same label is used on the Map's daily-stop
  badge.
- AC-4 Every type in the list has both an English and a Hebrew label; an unknown
  type is shown as its identifier with underscores replaced by spaces.

## Test plan

`trip-web/src/item-types.test.tsx` — one test per AC, each failing on the
previous `App.tsx` and passing now.

## Rollout

Trip-web only: reaches a trip on the next release payload / redeploy. No data,
route or config change. The Classic site has no itinerary-type box.

## Reservations booking badge (added 2026-11-12)

Each Reservations card's badge printed the raw `booking.type` ("flight") on a
Hebrew site. It now uses the labels the two Reservations Type boxes (add and
edit) already carried inline — flight טיסה, hotel/stay לינה, car רכב,
attraction אטרקציה, other אחר — moved into one table
(`bookingTypeLabel` in `trip-web/src/item-types.ts`) that the boxes and the badge
share, so there is still one set of words, not two. Server list:
`server/text-rules.js` `BOOKING_TYPES`.

- AC-5 Given a Hebrew site, a booking card's badge is Hebrew ("טיסה", "לינה");
  on an English site "Flight", "Stay".
- AC-6 Every booking type has both labels; an unknown type is shown as stored.

## Not in scope

The Reservations filter chips and Classic's booking table, which have their own
labels.
