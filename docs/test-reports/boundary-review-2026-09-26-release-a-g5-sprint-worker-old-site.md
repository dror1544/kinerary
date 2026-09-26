# Release A gate G5 — a new trip built by the Sprint 6 worker, served by the old site (2026-09-26)

**Written for:** the owner and whoever runs Release A. **What it answers:** after
Release A (decision 44: no release is promoted to `available`), every NEW trip is
*built* by the Sprint 6 worker but *served* by the site code of the current
`available` release, revision `130924b`, whose `sanitizeConfig()` is the pre-#172
deny-list. On 2026-09-22 a data-derived `origin` field reached `/api/config`
through exactly that kind of gap (#156). Can anything the Sprint 6 worker now writes
reach an anonymous visitor or a plain member through the old site that the sprint's
allow-list (`shared/config-visibility.js`) would have withheld?

**Method** (boundary-reviewer, local fixtures only: no VM, no production, no
Postgres): the old site from `git archive 130924b` and the sprint tip's site were
booted side by side with throwaway secrets; every producer output of the worker suite
was captured (443 configs from `transform_intake`, `enrich_config`, `derive_bookings`
and `documents_manifest`) and put through the sprint allow-list; realistic `multi` and
`manual` intakes with hostile marker fields planted (a passport, an email, a PIN,
provenance and evidence fields, `origin: "hermes:…"`, consular emails) were run through
the provisioner's own sequence, and every read route was requested as anonymous, member,
organizer and agent on both sites. The `japan` fixture was not used.

## Result

**The config question holds.**
- 443 configs projected; nothing dropped by the allow-list that the old site would have
  served (`DROPPED: {}`); only the intended withholdings (needs, standing instructions).
- Every leaf path the sprint worker added since `130924b` (`phases[].packing`,
  `rsvp_activities`, `unplanned`, `venues[].url_source`, `accommodation.pdf`,
  `travel_info.{health,money,communication}[]` with `source` and `origin`) is on the
  allow-list; `origin` is clamped at the producer.
- `/api/config`, `/api/config/warnings`, `/versions/1`, `/bookings` and the itinerary
  and plan routes are identical on the two sites for sprint-built configs. The planted
  markers never reached a config, `bookings.json` or `documents.json`: the producers
  build fresh dicts.
- Invariants: 1 (`sanitizeConfig` and warnings) holds for this pairing; 2 (visibility
  fails safe) holds — `shared/needs-schema.js` has no diff between `130924b` and the
  tip; 3 (`authRequired` is not an organizer check) holds for the routes touched.
- The new nginx blocks for `/mcp`, `/oauth/` and `/.well-known/oauth-*` reach an old site
  that has no such routes: it answers its default 404. Nothing is exposed.

**One finding that is not a config field** (low to medium; the reviewer judged it does
not block Release A). The worker now writes `phases[].rsvp_activities` (#169); the old
worker wrote none. On the `130924b` site, `GET /api/rsvps/:activityId` has no guard and
returns the voter's whole user row — including their Telegram id (which both sanitizers
withhold from `/api/config`), their age, family and vote note, and their Google
identifiers if Google sign-in is configured on that trip. The sprint site closes it
(#211: 401 for anonymous, a public projection for a member). It is **not new as a
class**: the old site already returns the same user row anonymously through venue
comments on every trip the old worker has built. **Decided by the owner (decision 45):
accept it.** The one-hunk alternative was to gate the worker's RSVP-activities merge
(`transformer.py`) behind a flag until a release with #211 is `available`; that would
not have closed the venue-comment exposure, which only a promotion does.

**A functional regression, not a security one** (fails closed): hotel-card and booking
document links on a new trip return 404 until a sprint release is promoted, because the
old site does not read the directory the sprint worker hosts documents in. **Accepted by
the owner (decision 46)** for the days between Release A and the promotion.

## Not tested
The real Postgres-backed lookups and `load_trip_documents` (stubs with hostile rows were
used); intake shapes from a live model; nginx itself (reasoned from the config); the VM's
variant of the deploy script (the Mac copy was read); whether production trips set a
Google client id; the connector's `get_config` through the companion bridge.
