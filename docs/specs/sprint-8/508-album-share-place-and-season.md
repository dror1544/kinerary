# A shared album shows the place and the season, nothing per photo

Status: draft (2026-10-31) · Issue: #508 · Track: T1 · Size: S · Tier: Normal
Security path: yes (`server/server.js`: what an unauthenticated link exposes) · Migration: no · Live-trip behaviour: yes

## Problem

`getOrCreateShareLink()` (`server/server.js:2088`) creates every phase album's
Immich shared link with `allowDownload: true, showMetadata: true`. The link is
meant to be forwarded, and whoever holds it sees each photo's EXIF data (exact
GPS position and capture time) and can download the originals, which carry the
same data. Family photos include children and are sometimes taken at a hotel
or at home.

An existing link is found and reused as-is (`links.find(...)`, line 2095). Any
link created so far keeps those settings until something changes it.

## Behaviour

Decided by Dror on 2026-10-31 (#508 comments):

- A shared album, **as a whole**, shows **the place** (the phase's place name,
  e.g. "Kyoto") and **the season and year** (e.g. "Autumn 2026").
- **Nothing is shown per photo:** no coordinates, no date and no time. No
  detailed location, only the place.
- **Photos cannot be downloaded** from the link.
- Signed-in travellers inside the trip site are unaffected.

## Acceptance criteria

- AC-1 Given a phase album with no share link yet, when a member asks
  `GET /api/album-share/:phase`, then the link is created with
  `showMetadata: false` and `allowDownload: false`.
- AC-2 Given an existing share link for the album that has
  `showMetadata: true` or `allowDownload: true`, when it is looked up, then it
  is updated (`PATCH /api/shared-links/:id`) to both `false` before its key is
  returned. A link already at both `false` is returned without a write.
- AC-3 Given a phase with `title.en` "Kyoto" (falling back to `title.he`, then
  `mapStop.name`) and `dates.start` 2026-10-12, when the album is created or
  looked up, then its **description** reads "Kyoto · Autumn 2026". The album
  **name** is unchanged, because `getOrCreateAlbum()` finds albums by name.
- AC-4 The season follows the phase's hemisphere, from `mapStop.lat`
  (negative means southern): July is summer in the north and winter in the
  south. Months: Dec–Feb winter, Mar–May spring, Jun–Aug summer, Sep–Nov autumn
  (northern hemisphere). Without a latitude, the northern hemisphere is assumed.
- AC-5 Given a phase with no `dates.start`, then the description is the place
  alone, and nothing is guessed.
- AC-6 No value from a photo's EXIF is read or written by this change. Place
  and season come from the trip config only.
- AC-7 The album-link wording in the policy pages is true at every point. Until
  every live trip site runs this change, the transition sentence in
  `web/legal/privacy.md` §4 and `terms.md` §8 stays ("Links made before this
  change can still show each photo's time and place…", PR #504). **Once the
  change is deployed to every live trip site, a follow-up text PR removes that
  sentence from both pages and both `web/public` mirrors, and bumps the version
  line's date** (this then becomes a new `LEGAL_POLICY_VERSION` for #500).

## Contracts

- `server/server.js`: `getOrCreateShareLink()` and `getOrCreateAlbum()`, plus a
  small pure helper `albumCaption(phase)` → `"<place> · <Season> <year>"`
  (exported for the test, following the file's existing pattern).
- Immich API: `POST /api/shared-links` (settings), `PATCH /api/shared-links/:id`
  (existing links), `PATCH /api/albums/:id` `{ description }`.
- No schema, config key or migration.

## Non-goals

- No per-photo captions and no EXIF stripping service.
- No change to what signed-in members see inside the trip site.
- Captions are English only; a Hebrew caption is a follow-up if Dror wants one.
- No new share view of our own; the Immich share page stays.

## Security and boundary notes

This reduces what an unauthenticated link exposes. The `sanitizeConfig()`
invariant is untouched: the caption is written into Immich, never served from a
raw config value through our API. Phase ids stay looked up against the
config's phases (null-prototype maps, line 2059), as today.

## Test plan

Written first, in `tests/gallery-boundary.test.js` (or a new
`tests/album-share-privacy.test.js`), with Immich stubbed:

- create path: the POST body has both flags `false` (AC-1);
- existing link at `true`: one PATCH sent, key returned (AC-2); at `false`:
  no PATCH;
- `albumCaption` table: northern/southern/missing latitude, missing date,
  he/en/mapStop fallback (AC-3–AC-5);
- the request bodies the stub sees contain no EXIF field (AC-6).

Manual check on Mac staging: open a share link in a private window. It shows
the caption, has no info panel with location or time, and has no download
button. **Verify first what the Immich version in use shows for the album
description on a shared-link page.** If it does not show the description, raise
it before building rather than switching to the album name.

## Rollout and regression

Every live trip site feels it on its next redeploy: existing links are fixed
the first time a member opens the album share after that. A link that nobody
opens again keeps its old settings. So the rollout also runs a one-off pass
that calls the lookup for every phase of each live trip (a script reading the
trip's own config). Redeploying the trip sites is a deploy (hard rule 2: Dror
approves it). Regression plan: per-PR, small. It touches a live-trip boundary
path but no migration.

## Open questions

None. Behaviour decided by Dror 2026-10-31; English-only caption and the
northern-hemisphere default are the spec's recommendations.
