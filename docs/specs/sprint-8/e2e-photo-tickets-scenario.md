# E2E scenario: the manual Sprint 8 staging test, with the tickets sent as photos

Status: draft 2026-11-12; approval at merge · Issue: none yet (the lead files it) · Track: Sprint 8 staging-test fixes · Size: M · Tier: Small-to-Normal (test harness only)
Security path: no (the Telegram stand-in still binds loopback only and still receives the bot token path unlogged) · Migration: no · Live-trip behaviour: none (a test harness; it reads and builds a staging trip, it ships to nobody) · Surface row: scripts (test harness), no runtime clock

Requested by Dror, 2026-11-12. Related: #543, #544, #546, #548, #549 (the defects the staging test found), #438 (the seeded interview it exercises), #412 and #414/#415 (the same flight booked twice).

## Problem

On 2026-11-12 Dror walked the Sprint 8 interview by hand on Mac staging (trip `gatecity-2026-2`): a dashboard trip, a Hebrew interview, two flight tickets sent as **photos** in one album, a correction at the summary, the build, and a look at Reservations and Plan. It found five defects (#543, #544, #546, #548, #549), each fixed by a different developer in parallel. Nothing re-runs that walk after the fixes: it is an hour of a person's time and it was a person's eyes on the screen.

The existing harness (`scripts/e2e-full-cycle.py`, `control-plane/api/tools/auto-organizer.ts`, the Bot API stand-in `control-plane/api/tools/fake-telegram.ts`) cannot replay it, for three reasons:

- **The stand-in cannot send a photo.** It has `/_control/document` (one file, one message) and nothing for the compressed `photo` array Telegram sends for a camera-roll picture, nor for an **album**, which Telegram delivers as one message per picture joined by `media_group_id`. Every defect in #543 and #544 lives on that path: the relay's handling of a photo is not the handling of a PDF.
- **Every scenario starts at signup.** The interview is opened from an enrollment issued with the password header. The manual test opened it from the dashboard's own interview link, on a trip made there, which is what seeds destination, dates and type (#438) and what makes the greeting a *seeded* greeting.
- **The organizer cannot do the rest of the walk.** It never sends an album, never taps an offer made outside a question ("add these passengers?"), and never corrects the summary in words before confirming.

And the existing scenarios assert what the site holds, not what the organizer was told (the greeting, how many replies, how many confirmations).

## What the scenario does

Name: `gatecity`. Run: `scripts/preflight-deploy.sh --deploy --auto --scenario gatecity` or `scripts/e2e-full-cycle.py --scenario gatecity --auto`. It is **not** part of `--scenario all`: it judges fixes that are being built, so it is red until they merge, and `all` is what hands-off runs use (the same reason `star` is left out).

1. Signup, as every scenario does (the e-mail sign-up needs a mailbox nobody here has; the account it makes is the same kind). Its own placeholder trip is never interviewed or built.
2. **The dashboard half**, over the dashboard's own routes with a session cookie and CSRF token: sign in, name the account `Arlo` (`POST /v1/account/name`), create the trip with destination `Gatecity`, type `family`, 14 to **21** Nov 2026 (`POST /v1/trips`), ask for its interview link (`POST /v1/trips/:id/interview-link`) and use the token in it.
3. The Telegram stand-in is started and the relay pointed at it (unchanged).
4. The organizer opens the link, in Hebrew. The two ticket **photos are drawn at run time** into the run's temp directory and sent as **one album**.
5. It answers what the interview still asks, taps the offer to add the second ticket's passengers (`y:travelers`), taps Yes on the organizer-name confirm ("אני רק מוודא שאתה הוא …") and on the one-stop confirm, and at the summary **types the return date in words** (`בעצם אנחנו טסים חזרה ב-22 בנובמבר`). Whether the interview answers with a draft to apply or applies it outright, the organizer applies it if asked, then confirms.
6. The trip builds; the run reads the finished trip the way a traveller does (the site's own API) and judges it.

### The tickets

Two e-tickets for the **same** flight on the same day, two couples, two bookings (the same facts as `control-plane/api/test/fixtures/two-parties-same-flight/`). All names are invented.

| | Ticket 1 | Ticket 2 |
|---|---|---|
| Airline / flight | SKYLINE AIR, SL 482 | SKYLINE AIR, SL 482 |
| Route | Harbortown (HBT) to Gatecity (GCY) | the same |
| Date, times | 14 NOV 2026, departs 09:40, arrives 12:05 | the same |
| Booking reference | QX7P2M | ZT3K9D |
| Passengers | ARLO VESPER, LENA VESPER | BRIA TALLIS, COLE TALLIS |

`control-plane/api/tools/ticket_photos.py` draws them: a 5x7 bitmap font and a minimal baseline JPEG encoder, standard library only (the reason `make_documents.py` gives: a fixture generator that needs `pip install` is one that gets skipped). The result is a clean black-on-white ticket on a grey table, about 1380 by 600 pixels and 75 KB, a real JPEG (Telegram re-encodes every photo to JPEG and the relay declares photos `image/jpeg`). **Nothing is committed** (hard rule 3): the files exist only in the run's directory, and a test asserts none sits beside the generator.

### The stand-in's new surface

- `POST /_control/photo {chatId, base64, caption?}`: one compressed photo, as the camera roll sends it.
- `POST /_control/album {chatId, photos: [{base64}], caption?}`: one message per photo, consecutive message ids, one shared `media_group_id`, the caption on the first only. All updates are queued together before any waiting `getUpdates` is woken, so one poll sees the whole album.
- Each photo lists **two sizes**, smallest first (`normalize.ts` takes the last). The smaller one is the same picture with a different digest (a marker after the JPEG's end), so a relay that stores the wrong size fails a byte comparison instead of passing by luck.
- `getFile` and the `/file/` download serve every size, with `image/jpeg` as the content type: the relay reads the photos through the same path it reads them on real Telegram.

`TELEGRAM_API_ROOT`'s https-or-loopback rule lives in the relay and is untouched; the stand-in still binds `127.0.0.1` only.

## Acceptance criteria

Each check is its own named verdict, **named by the issue it protects**, so a red run says which fix regressed. All are printed as they are judged, again in one scorecard at the end, and only then does the run fail; a failing check never stops the checks after it, and none is deferred (red is the point).

What the organizer was told (read off the stand-in's own record of the chat):

- AC-1 `greeting_shape_548`: The first message is the opening line plus a short explanation: at most 2 non-empty lines and 320 characters, no buttons; the document offer (`c:nodoc`) is one of the next two messages, on its own. (Judged on shape, not words; the copy is the product's.)
- AC-2 `greeting_names_in_hebrew_546`: The greeting contains Hebrew and does not contain the organizer's or the destination's English spelling (`Arlo`, `Gatecity`): the native-name translation did not fall back.
- AC-3 `greeting_clean_548`: The greeting says no "welcome back" (first trip of a new account) and prints no ISO date.
- AC-4 `seeded_values_not_reasked_438`: The organizer's own record of the questions it answered contains none of destination, departure date, return date or trip type.
- AC-5 `ticket_replies_once_543`: After the album, no two bot messages share text and buttons (messages under 20 characters may repeat). The window opens at the sequence number the organizer recorded just before sending.
- AC-6 `confirmation_once_543`: Exactly one message matching the "building your trip site now" confirmation, in either language.

What the finished trip serves:

- AC-7 `photo_QX7P2M_attached_544` and `photo_ZT3K9D_attached_544`: For each ticket, the reservation that carries its reference has a ticket attached, and the bytes the site serves for it are **the photo that was sent**, byte for byte (sha256 compared), not merely "some file".
- AC-8 `flight_twice_on_reservations_549`: SL 482 is on Reservations exactly twice, once per booking.
- AC-9 `reservations_tell_bookings_apart_549`: Each of the two rows names its own passengers (a surname of its own ticket) and not the other ticket's.
- AC-10 `flight_once_on_plan_549`: The active itinerary has exactly one item for SL 482 on 2026-11-14.
- AC-11 `trip_dates_14_22_nov`: The trip runs 2026-11-14 to 2026-11-22: the return date **as corrected at the summary**, not as the dashboard seeded it.
- AC-12 `travellers_from_both_tickets_412`: The confirmed intake's roster holds all four passengers.

Behaviour of the harness itself:

- AC-13 A run in which several checks fail prints every one of them by name with what was found, and ends with a scorecard (`N of M checks pass, K fail`). A run that stops early (the organizer stalls, a stage cannot run) still reads back what the bot had said up to that point and prints the scorecard so far.
- AC-14 `--dry-run` (with `--scenario gatecity` only) touches no stack: it draws the photos, starts the stand-in, sends the album, reads it back as the relay does (`getUpdates`, the last size, `getFile`, the download) and compares bytes; it names the checks a real run judges.
- AC-15 `--scenario gatecity` without `--auto` is refused, in `e2e-full-cycle.py` and in `preflight-deploy.sh`.

## Non-goals

- Fixing any of #543 to #549. The scenario reports them; other developers fix them. No file under `control-plane/api/src`, `site/` or `trip-web/` is touched.
- Judging the wording of the greeting, the replies or the confirmation, or the accuracy of the model's reading of a ticket. Shape and facts only.
- Joining a media group in the relay, or any other product behaviour for albums. If the product handles an album differently from what #543 expects, the checks say so; they do not encode a design.
- A second family of scenarios for photos of other documents (hotel, car). One scenario, the one Dror walked.
- Putting `gatecity` in `--scenario all`. That is a one-word change the day it is green and wanted nightly.
- Tearing down the signup placeholder trip. `--teardown` removes the trip the interview built (the dashboard's), as before; the placeholder is a draft with nothing provisioned.
- Running it. The real run is the lead's, after the fixes merge, against staging. Nothing in this change deploys or restarts anything.

## Test plan

- `control-plane/api/test/fake-telegram-media.test.ts`: the album's shape (one message per photo, consecutive ids, one `media_group_id`, caption on the first only, thumbnail first and full size last, thumbnail bytes different); and the running stand-in, asked the way the relay asks: one poll returns the whole album, `getFile` and the download return each photo byte for byte as `image/jpeg`, a lone photo has no group, an empty album is refused.
- `control-plane/api/test/organizer-gatecity.test.ts`: the scenario answers every required question, agrees with the python half on dates, the correction and the travellers; the Apply-button pattern matches what the router emits and nothing else.
- `tests/scripts/test_e2e_gatecity.py`: the glyph table and the encoder (the output is a baseline JPEG of the stated size; an independent decoder written in the test reads the bit stream back to within quantisation; the OS decodes it where `sips` exists; nothing is committed beside the generator); every check on fabricated transcripts and trips, passing and failing, including the staging symptoms (the old greeting body after the opening, English names, a reply sent twice, a reservation with no ticket, a photo attached to the wrong reservation, the flight twice on the plan, the uncorrected return date); the scorecard names every failing check and raises once, at the end; each verdict carries its issue number; the CLI wiring.
- A dry run, `scripts/e2e-full-cycle.py --scenario gatecity --dry-run`, with its output in the handover.
- **Not covered offline, said plainly:** the organizer's live loop (the album send, the offer taps, the summary correction) and the dashboard half run only against a real stack; they are type-checked and their pure parts are unit-tested, and the first real run is the lead's.

Compatibility: scenario-selection changes only add a word; every existing scenario takes the same path as before (`stage_interview` falls back to issuing the enrollment when the dashboard has not).

## Decisions

- **The dashboard seeds a return date one day short (21 Nov), not 22.** The brief has the dashboard at 14 to 22 Nov and the summary correction "actually we fly back on 22 November". Seeded at 22, the correction repeats what is held and tests nothing (and the interview may answer a no-op with no draft at all). Seeded at 21, the correction is a real change and AC-11 can only pass if it was applied. If Dror wants the dashboard at 22, it is one constant (`seed_return_date` in `ticket_photos.py`) and the correction becomes a no-op.
- **Sign in over the password route, not the e-mail sign-up.** The e-mail sign-up route needs a mailer and a token from a mailbox. `POST /v1/signup` (what every scenario already uses) makes an account with a password credential, `POST /v1/auth/email-password` gives the session and CSRF cookies the dashboard routes need, and from there the calls are exactly the dashboard's. Rejected: reading the token out of the database (a path the product does not have).
- **Judge the chat from the stand-in's record, not the relay's log.** The relay's log has no timestamps (#543); what the person on Telegram was sent is what the stand-in recorded. Rejected: grepping the relay log.
- **Not deferred, and not in `all`.** `star` defers known gaps so it can be listed; here the whole point is to be red until the five fixes land, and a deferral list would hide exactly that. Rejected: a `deferred` map.
- **JPEG, not PNG.** Telegram always sends JPEG and the relay declares photos `image/jpeg`; a PNG body under that label is a path real Telegram never takes. The encoder is hand-written (standard library only) because the alternative was a dependency this repo's fixture generators have refused.
- **Duplicates are "same text and buttons twice after the album", not "exactly two replies".** The product decides what a reply per ticket looks like; a count of recognised reply copy would encode today's wording. The cost: a verbatim re-ask of an unanswered question would also be flagged, which the interview should not do anyway.
