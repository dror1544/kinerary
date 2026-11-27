# A photo library per user: connect Immich or Google Photos once, every trip uses it

Status: draft (2026-11-27) · Issue: #699 · Track: video look · Size: L, built as four PRs (S1–S4) · Tier: High
Security path: yes (the control plane stores a third party's credential; it fetches an address the user typed; an OAuth
sign-in) · Migration: yes (new tables only, `-- rollback: compatible`) · Live-trip behaviour: yes, once the switch is on

## Problem

Photos reach a family's library only if an operator has typed that library's address and key into the trip site's
environment, one trip at a time (`IMMICH_URL`, `IMMICH_API_KEY`: `server/server.js:66-67`). Today that is true of one
trip. Nothing lets a person choose a library themselves, and the key sits on every trip site that uses it.

- **A reused Immich key is a user key.** It reads and deletes the owner's whole library, not one trip's photos. Copied
  onto every trip site, one compromised site exposes the library.
- **The site's use of Immich is write-only.** It uploads an asset and adds it to a phase album (`pushPhotoToImmich`,
  `POST /api/upload`), deletes the asset it uploaded (`DELETE /api/photos/:id`), and creates a shared link for an album
  (`getOrCreateShareLink`, `GET /api/album-share/:phase`). The photo itself is served from the site's own storage, and the
  web app draws the album button only when `/api/health` says `immich: true` (`trip-web/src/immich.tsx:49`). So the key
  can leave the site without a photo going missing from it.
- **The site never calls the control plane.** Every road between them is one the control plane starts through the runtime
  gateway with the trip's own key (`597-per-gateway-and-per-trip-keys.md`, K2). The group photo and the plan-change line
  use it (`group-photo-poller.ts`, `plan-change-poller.ts`).
- **The product already says it should.** The product spec calls Kinerary a layer "on top of" the tools people use,
  Google Photos among them, and the §9 photos row has "shared album" in v1 (principle 1, "integrate, don't replace").
  Nothing in the specs or the sprint plan covers a per-user connection.

## Decisions (Dror, 2026-11-27, on #699)

1. **The control plane keeps each user's connection and sends the photos itself.** A trip site never holds the key.
2. **Google Photos:** an album per trip, or one general album, "Kinerary trips", holding all of them. Left open by
   the owner; the lead's choice is in L2 below, for his confirmation.
3. **Which trips use it.** A user with more than one service connected picks a default. With one connected, it is
   available to every trip of that user, unless an organizer turns it off for a specific trip.

**Lead's choices inside those decisions (for approval with the spec):**

- L1. **A trip uses its owner's connection.** The user who created the trip, the `owner` row in `trip_memberships`.
  An organizer who is not the owner can turn the library off for the trip but cannot connect their own to it. Several
  libraries per trip is a later question, not v1.
- L2. **Google Photos gets one album per trip, named like the trip, not one "Kinerary trips" album.** Reason: the person
  shares an album from the Google Photos app, and a single album holding every trip would share all of them at once.
  Immich keeps one album per phase, as it does today (the site's naming, `sectionName`).
- L3. **One connection per service per user.** A second Immich server is a later question.
- L4. **A new feature switch, `photo_library`, off by default.** Switching it on for a trip turns that trip's photo
  sync over to this road and turns the trip site's own `IMMICH_*` path off for it. The per-trip organizer setting is
  separate from the switch (see AC-9).
- L5. **The bot's one-line notice says where photos go.** When the owner has a library connected and sync is on, the line
  the bot says once in a group (`x-trip-photos-and-moments.md` L2) gains "and copied to <owner's name>'s photo
  library". LM5 in the product spec asks for consent before sharing; the group is told, and an organizer can turn the
  sync off.

## Behaviour

**On the dashboard (account level).** A "Photo library" section under the account. The user can connect **Immich**
(server address, API key) or **Google Photos** (a Google sign-in), see each connection's state (`active`,
`needs_reconnect`), test it, disconnect it, and choose the **default** when two are connected. The page says in
plain words what Kinerary does with a connection: it adds trip photos to an album, deletes only what it added, and
can create a share link for an album.

**On a trip (dashboard, organizer).** One switch, "Copy this trip's photos to my photo library", on by default when the
owner has a connection, and off if an organizer turns it off. It shows which library the trip uses.

**On the trip site.** A member uploads or the bot saves a photo, as today. If the trip syncs, the photo also lands in
the owner's library, in the trip's album, within about two minutes. The album button shows when a share link
exists for the phase. A deleted photo is deleted from the library if Kinerary put it there.

**Immich.** An album per phase (as today). A phase's share link is created once, with the rules of #508 (no per-photo
metadata, no download), and kept.

**Google Photos.** An album per trip, created by Kinerary. Google Photos gives an album Kinerary made back only to
Kinerary, and (as reported for the library API since 2025, to be checked in S3) cannot create a share link for it. So
the site shows no public album link for a Google Photos trip; the organizer sees "Open in Google Photos" and shares the
album from there.

## Acceptance criteria

**Connections (control plane)**

- AC-1 Given a signed-in user and a valid Immich address and key, when they connect, then a connection row exists for
  that user, with the key encrypted (AC-3), and the dashboard shows it `active`. Given a wrong key, an address that is
  not Immich, or one the control plane may not reach (AC-4), then nothing is stored and the answer says which.
- AC-2 Given a user with one connection, then it is their default. Given two, then exactly one is the default, the user
  changes it, and disconnecting the default makes the other the default. Given none, no trip syncs.
- AC-3 Given a connection row, then no column, log line, response or error text holds the key in the clear. The key
  is encrypted with a key named by a secret reference in the architecture profile; a row records which key encrypted
  it, so the key can be rotated. A response about a connection carries the server address, the service, the state and
  the last check, never the credential.
- AC-4 Given a user-typed Immich address, then the control plane refuses a loopback, link-local, metadata or
  private-range target unless the deployment's allow-list (`photo_library.allowed_private_hosts`, an env or profile
  value) names it; refuses a non-http(s) scheme and a redirect to another host; and applies a short timeout and a size
  cap to every response. The check is on the resolved address, at connect time and at every call.
- AC-5 Given a user disconnects, then their stored credential is deleted, trips using it stop syncing and say so on
  the dashboard, and nothing already in the library is touched.
- AC-6 Given the library answers 401 or 403, then the connection becomes `needs_reconnect` and the dashboard says so;
  it is not retried in a loop. Given Google revokes the refresh token, the same.

**Which library a trip uses**

- AC-7 Given a trip, its library is the owner's default connection, or their only one, in state `active`. A user with
  none, or whose connection needs reconnecting, gives the trip no library, and photos are kept on the site only.
- AC-8 Given the switch `photo_library` off for a trip, then the site's own `IMMICH_*` path runs exactly as it does
  today and the control plane touches nothing. Given it on, the site's own path does not run for that trip (one
  upload, never two).
- AC-9 Given an organizer turns the trip's library off, then no new photo is queued for it and the album button stays
  as it is. Turning it on again syncs only photos saved from then on (open question 3 says whether to backfill).
- AC-10 Given a member's JWT, then the trip setting and the trip's library choice are refused (403). Only an organizer
  of the trip, through the dashboard, changes them.

**Sync (site, poller)**

- AC-11 Given a photo is saved on the site (member upload, the bot's group save, or the agent), then the site
  records one `photo_library_jobs` row for it in the same transaction, `op = upload`, and stores nothing about any
  library key.
- AC-12 Given the poller sees a trip with the switch on and a library, then it claims the oldest pending job through
  the gateway, reads the photo bytes and phase, pushes it into the library's album for that phase (created if
  missing), and reports `done` with the library's asset id and, for Immich, the album's share link, or `failed` with a
  reason. A claim lost mid-way is claimed again and never uploads twice (the job's own identity is the library's
  device asset id).
- AC-13 Given a photo is deleted on the site and Kinerary uploaded it, then a `delete` job removes that asset from the
  library. Kinerary never deletes an asset it did not upload (it knows them only by the ids it stored).
- AC-14 Given the library is unreachable, then the job is retried a bounded number of times with backoff and then
  reads `failed`; the photo stays on the site either way.
- AC-15 Given a share link is stored for a phase, then `GET /api/album-share/:phase` returns it without a call to any
  library. Given none, it answers that no album link exists.

**Google Photos**

- AC-16 Given the user signs in with Google and grants the photo scopes, then a connection exists with the refresh
  token encrypted (AC-3), and the sign-in uses the authorization-code flow with PKCE and a state value tied to the
  user's session. A state that does not match is refused.
- AC-17 Given a Google Photos trip, then one album named like the trip is created once and every photo is uploaded
  into it; no album of the user's own is read or changed.
- AC-18 Given the Google library cannot create a share link, then the site draws no public album button for the trip,
  and the dashboard offers "Open in Google Photos".

**Boundary**

- AC-19 Given any request that reads or changes a connection, then it is the signed-in account's own connection. A
  request naming another account's connection id answers 404, never 403.
- AC-20 Given a trip site, then no environment variable, file, response or log on it holds a library credential once the
  trip syncs through this road; `/api/health` no longer reports `immich: true` for the key and reports the library
  state the control plane told it.

## Contracts

**Tables (one migration, `YYYYMMDDHHMMSS_photo_libraries.sql`, header `-- rollback: compatible — new tables only`):**

- `control_plane.photo_connections` (id, user_id, provider `immich|google_photos`, server_url, public_url,
  credential_ct, credential_key_id, status `active|needs_reconnect`, is_default, last_checked_at, last_error_code,
  created_at; unique (user_id, provider); at most one default per user, by a partial unique index).
- `control_plane.trip_photo_library` (trip_id, sync_enabled default true, updated_by, updated_at).

**Trip SQLite (site):** `photo_library_jobs` (id, photo_id, op, phase_id, status, attempt, claim_token, library_ref,
detail, created_at, finished_at) and `photo_library_albums` (phase_id, album_ref, share_url, updated_at). Both are
created in the site's own migration list (`ALTER`/`CREATE IF NOT EXISTS` at boot, as the site does today).

**Routes**

- Control plane portal (account session): `GET /v1/photo-connections`, `POST /v1/photo-connections/immich`,
  `POST /v1/photo-connections/:id/test`, `PUT /v1/photo-connections/:id/default`, `DELETE /v1/photo-connections/:id`,
  `GET /v1/photo-connections/google/start`, `GET /v1/photo-connections/google/callback`,
  `GET|PUT /v1/trips/:id/photo-library` (organizer).
- Site, behind `internal()` and reached through the gateway: `POST /api/internal/control-plane/photo-library/claim` and
  `.../result`, shaped like `group-photo/claim` and `group-photo/result`; the gateway's `tripPhotoRoute` grows the
  matching two paths.
- Control plane, `control-plane/api/src/photo-library-poller.ts` and `photo-library.ts` (one adapter per service behind
  one interface: `ensureAlbum`, `upload`, `delete`, `shareLink`, `check`).

**Config:** `photo_library.credential_key_secret_ref` (the encryption key), `photo_library.allowed_private_hosts`,
and for Google `web.google_photos_client_id` plus `google_photos_client_secret_ref`. All are references or ids; none
names a host (hard rule 6).

**Switch:** `photo_library`, surfaces `control_plane`, `site`, `web`, `memberVisible: false`, default off; in
`shared/feature-switches.js`, `control-plane/worker/control_plane_worker/feature_block.py` and the recent-changes test,
in registry order.

**Files expected to change:** `server/server.js` (the three Immich call sites, `/api/health`), a new
`server/photo-library.js`, `control-plane/runtime-gateway/server.js`, the two new control-plane files above, the portal
routes in `portal.ts`, `config.ts`, `web/` (the dashboard section and the trip toggle), `trip-web/src/immich.tsx`,
`shared/feature-switches.js`, and the bot's notice copy (`relay/photo-copy.ts`).

## Non-goals

- Reading a user's library, listing their photos, or importing from it. Kinerary writes to an album it made and reads
  back only what it needs to find that album.
- Several libraries for one trip, or a library per co-organizer (L1).
- A second Immich server per user (L3).
- Faces, tagging, or any use of the library's own recognition (LM5).
- Moving photos already on the site into the library (open question 3).

## Security and boundary notes

- **The credential.** Encrypted at rest with a key the deployment supplies by reference; decrypted only in the poller
  and the connection test, never returned, never logged (AC-3). The redaction list (`redaction.ts`) gains the field
  names. A trip site never has it, so a compromised site cannot read the library (the point of decision 1).
- **A server fetches an address a person typed (AC-4).** This is the classic request-forgery shape: the guard is on the
  resolved address, not the string, and runs on every call, since a name can start resolving somewhere else. The
  deployment that keeps its Immich on the home network names that host in the allow-list; everyone else gets the
  public-address rule only.
- **OAuth (AC-16).** Authorization code with PKCE, `state` bound to the session, the redirect address fixed in the
  profile and never taken from the request, the narrowest scopes that let Kinerary create and fill its own album.
- **Boundary review applies** (CLAUDE.md "Security-sensitive paths"): `boundary-reviewer` with live request/response
  evidence for AC-10, AC-19 and AC-20 before S1 merges. `authRequired` is not an organizer check: the trip setting uses
  the organizer gate, the account routes use the account session.
- **What the family's photos do.** They leave the family's site for the owner's library. That is the owner's own
  choice and the group is told (L5); an organizer can turn it off at any time (AC-9).

## Test plan

Tests are written from the criteria first.

- `control-plane/api/test/photo-connections.test.ts` (own `cptest_*` database): AC-1, 2, 3 (a scan of every response
  and log for the test key), 5, 6, 19.
- `control-plane/api/test/photo-library-address-guard.test.ts`: AC-4, with loopback, link-local, `169.254.169.254`, a
  private range, a redirect, a name that resolves to a private address, and the allow-list.
- `control-plane/api/test/photo-library-poller.test.ts`, against a stand-in Immich and a stand-in gateway: AC-7 to 9,
  12 to 15, with a lost claim and a failing library.
- `tests/photo-library-site.test.js`: AC-8, 11, 13, 15, 20 on the site; the legacy path is unchanged with the switch
  off.
- `control-plane/api/test/photo-library-google.test.ts`: AC-16 to 18 against a stand-in Google, including a wrong
  `state` and a revoked token.
- Manual, once: connect the owner's Immich on the dashboard, upload one photo to the staging trip, see it in the album
  and the share link open; then the same for a Google Photos test account.

## Rollout and regression

- **S1** the connection (tables, encryption, address guard, Immich adapter, dashboard section). Nothing syncs yet.
- **S2** the sync road and the trip setting; the switch `photo_library` on for a staging trip, then one real trip.
- **S3** Google Photos.
- **S4** move the one trip that has a per-site key: the owner connects Immich on the dashboard, the switch goes on for the trip, one photo is
  checked, and the trip's own `IMMICH_*` values come out of the site's environment and the deployment repo's copy. The
  one live trip that uses a per-site key today is the only one this touches.
- A migration and an auth/boundary path are both in scope, so a **regression plan** (`regression-planner`) is owed
  before the merge to `main` that carries S1. The PRs that add code behind the switch carry the assessment.
- Every trip is untouched until its switch is on.

## Open questions

1. **L2**, one Google Photos album per trip rather than one "Kinerary trips" album: confirm, or choose the single album.
2. **L1**, a trip uses its owner's library only: confirm, or ask for a co-organizer's own.
3. **Backfill.** When a trip's library turns on (or the owner connects after photos exist), should the photos already on
   the site be copied, or only new ones? Lead's lean: only new ones, with a one-time "copy the existing photos" button on
   the trip's dashboard page.
4. **Google verification.** A Google Photos sign-in needs a Google Cloud project and a consent screen. While the app
   is in testing, only named test users can connect; a public launch needs Google's review. The owner creates the
   project and sets the profile values; this spec does not.
5. **Does Google Photos still let an app create shared links?** S3 starts with a spike that checks it. AC-18 is written
   for the reported answer (no) and flips if it is yes.
6. **Delete behaviour (AC-13).** Deleting a photo on the site deletes the asset in the owner's own library, as the site
   does today. Confirm that is wanted for a personal library, or make it "leave it in the library".
