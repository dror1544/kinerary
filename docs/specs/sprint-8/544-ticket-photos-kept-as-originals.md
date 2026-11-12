# A ticket photo is kept as an original, like a PDF, and says so when it is not

Status: draft 2026-11-12; approval at merge · Issue: #544 · Track: Sprint 8 staging-test fixes · Size: S · Tier: Normal
Security path: no (no route, visibility or `server/` change; see Security notes) · Migration: no · Live-trip behaviour: yes (an interview held on a relay with a document store; a relay restart ships the log lines)

## Problem

Found on Mac staging, 2026-11-12, trip `gatecity-2026-2`. The flight reservation
built from two ticket photos exists, but the photos are not attached to it. The
relay log shows `interview.document_read … "stored":false` for both photos.

**It is not a photo problem.** The same relay log shows `"stored":false` for
every file of an earlier run on the same relay — a Markdown file, a spreadsheet,
text files. `stored:false` means the relay kept the bytes nowhere, and the only
way that happens without a `document.store_failed` line is that the relay has no
document store: `DOCUMENT_STORE_DIR` is unset on that relay
(`documentStoreFromEnv()` returns nothing and `ingestDocument` then reads and
registers the file but writes no bytes — `document-intake.ts`, `if (!stored &&
ctx.store)`). A PDF sent to that relay would have been dropped the same way.

Everything downstream of a stored photo already accepts one, and is covered:

- storage: `png|jpg|webp|gif` are in the store's extension list
  (`document-store.ts`), and `document-vision-db.test.ts` /
  `document-intake-flow.test.ts` ("a photographed voucher … kept as the photo")
  assert a stored `.jpg`;
- the confirmed version's manifest names it (`stored:true`, mime) and records
  which entry it supplied (`confirmedSources`);
- the worker's handoff takes the same extensions (`document_handoff.py`
  `STORAGE_KEY`), links an anchor's document as the booking's `conf_file`, and
  writes it into `documents.json`;
- the trip site serves it: `GET /api/bookings/confirmation/:fn` maps `.jpg/.png/
  .webp/.gif` to `image/*` (inline, `nosniff`), and `GET /api/trip-documents`
  lists it (`server/server.js`).

What was missing is that **nothing said so**. The relay's start-up store check
ran only when `DOCUMENT_STORE_DIR` was set, so the one configuration that drops
every original was the one with no line at all, and the per-file line
(`stored:false`) was read as a photo defect. Unset is not an error here, it is a
downgrade, and a downgrade has to be said out loud (CLAUDE.md, "The interview has
no agent — and silently grows one back", for the same bug class).

## Behaviour

- A relay with a working document store keeps each photo as an original, exactly
  as it keeps a PDF, under the same content-addressed name; the confirmed intake
  version names it, and provisioning hands it to the trip, where the booking it
  produced carries it as its attachment.
- A relay without a working store says so at start (`relay.document_store_not_ready`,
  warn, with the reason and that originals will be dropped) and, in every burst
  whose files it could not keep, says so again (`interview.originals_not_kept`,
  warn, with the count and the reason). `DOCUMENT_STORE_REQUIRED=1` still refuses
  to start.
- Nothing about who may see an original changes (see Security notes).

## Acceptance criteria

- AC-1 Given a relay with a document store, when two photographed bookings are
  sent, then each is stored as an original (`ingest_state = 'stored'`, key ending
  `.jpg`, bytes on disk) and no `interview.originals_not_kept` is logged.
- AC-2 Given AC-1 and a confirmed intake, then the version's `source_document`
  lists both photos as `stored:true` with their mime, and every photo supports at
  least one answer, including a `travel_anchors` entry (the booking it produced).
- AC-3 Given a relay with no document store, when a photo is sent, then it is
  still read and its answers land, its registry row is `unstored`, and a warn
  `interview.originals_not_kept` is logged with `documents: 1` and
  `reason: "NO_DOCUMENT_STORE"`.
- AC-4 Given `DOCUMENT_STORE_DIR` unset, when the relay starts, then it logs
  `relay.document_store_not_ready` at warn with `reason: "NOT_CONFIGURED"` and
  `keeps_originals: false`; with `DOCUMENT_STORE_REQUIRED=1` it is an error and the
  relay exits; with a ready store it logs `relay.document_store_ready`.
- AC-5 (worker handoff, ad hoc evidence — not pinned by a repo test; see
  Carry-forward) Given a manifest whose `travel_anchors` sources name two `.jpg`
  originals, then `build_document_links` links each as its own booking's
  `conf_file` and `documents_manifest` lists each with a `booking` link.

## Contracts

- New log events: `relay.document_store_ready` (info),
  `relay.document_store_not_ready` (warn/error; was emitted only when the variable
  was set), `interview.originals_not_kept` (warn).
- New pure helper `documentStoreNotice()` in
  `control-plane/api/src/relay/document-store-notice.ts`; `relay/server.ts` now
  calls `checkDocumentStore` unconditionally.
- No schema, route, API or config-key change. No migration.

### Where an original lives, and who sees it

1. Control-plane store: `$DOCUMENT_STORE_DIR/<trip_id>/<sha256-hex>.<ext>`
   (`ext` from the reader's own classification: `jpg|png|webp|gif` for a photo),
   one row per file in `control_plane.trip_documents` (`ingest_state`,
   `storage_key`, `mime`). Content-addressed and write-once; the sender's filename
   is metadata only.
2. At provisioning the worker hard-links (or verified-copies) it into the trip's
   `documents/` directory and writes `documents.json` beside the config;
   `bookings.conf_file` carries the content-addressed name for the booking that
   entry produced.
3. On the trip site: `GET /api/bookings/confirmation/:fn` (inline) and
   `GET /api/trip-documents` (what each file supports), both behind
   `authRequired` — **any signed-in trip member or the agent key**, the same
   rule as a PDF original. **Upload** of a confirmation to a booking
   (`POST /api/bookings/:id/confirmation`) and the trip-MCP byte read-back
   (`get_booking_confirmation`) are **organizer/agent only** (#357); the read-back
   serves PDFs only, so an assistant is pointed to the trip site for a photo.

## Non-goals

- Configuring the staging relay's `DOCUMENT_STORE_DIR` (and the marker file the
  store requires). That is deployment configuration, outside this repository, and
  is the actual fix for the 2026-11-12 trip; this change makes its absence loud.
- Attaching *both* photos when two photos describe the same journey and the
  extraction merges them into one booking: a booking carries one `conf_file`
  (first source wins), as it does for PDFs; the second stays in `documents.json`
  with no booking link. A many-to-many booking link is a worker/site change.
- Re-attaching originals to a trip that was already built without them.
- Letting the trip-MCP read-back return an image.

## Security notes

No security path is touched: no change under `server/`, `shared/`, an
authenticated route, or document visibility. Photos follow #357's existing rules
unchanged: members read, organizers upload and read back through the assistant.
Images are served `inline` with `X-Content-Type-Options: nosniff` and
`Cache-Control: private, no-store`; `.svg` is deliberately not served as an image
(script-capable) and not accepted by the vision reader. The new log lines carry a
session id, a count and a reason — no file name, text or chat id.

## Test plan

Run with `CONTROL_PLANE_TEST_DATABASE_URL` pointing at a `cptest_*` database.

- `control-plane/api/test/document-intake-flow.test.ts`, describe "an album of
  ticket photos (#543, #544)": AC-1 and AC-2 (pin the behaviour with a store —
  they pass before and after; the code was right), AC-3 (fails before: no warning).
- `control-plane/api/test/relay-document-store-notice.test.ts`: AC-4 (fails
  before: the module did not exist; in the old `server.ts` the unset case logged
  nothing).
- AC-5: a one-off run of the worker's handoff on two `.jpg` originals
  (`PYTHONPATH=control-plane/worker python3 <script>`), output pasted in the handover. No test image is committed
  (rule 3): the "photos" are generated bytes with a JPEG header.
