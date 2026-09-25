# Changelog

## How this file works

- Newest sprint on top. Inside a sprint, newest entry first (by merge date; ties by PR number, highest first). There are no version tags: the sprint is the version unit.
- Every entry says what changed and for whom, and why it matters. New features lead with the value; fixes lead with the problem. References follow on one line: issue (`#n`), PR (`PR #n`), or a short commit hash only when neither exists.
- Each sprint is an H2 with a bold status line. A closed sprint gets a CLOSED status line (date and merge commit) and a boundary marker at the bottom of its section, so an entry from a different sprint is visibly across a line.
- To open the next sprint: add a new `## Sprint N` section ABOVE the previous one, separated by `---`, and change the previous sprint's status line to CLOSED.

---

## Sprint 6 — Verification, explicit activation, dashboard, and demo rehearsal (2026-09-20 → open)

**OPEN — unreleased. On integration/sprint-6; not yet on main, not deployed.**
Baseline: `97582b6`. Release: none yet. Scope and track breakdown: `docs/sprint6-tracks.md`.

### New

- **Activities the family can vote on now appear on a new trip.** A trip built from an interview lists its not-yet-booked attractions on the "Activities and places" tab as votable items; attractions already booked stay on Bookings only. Votes survive a re-provision. Benefits travellers and organizers. #169, PR #171. (Classic site's RSVP section still cannot render; tracked in #170.)
- **Each phase of a new trip gets a season-appropriate packing list.** A short bilingual list chosen from the destination's hemisphere and the phase's start month, with no network or model call. It is coarse by design (city-only destinations, multi-country strings and some spellings are not handled well); #167 is the follow-up. Benefits travellers. #162, PR #165.
- **A real "Other" button on the trip-type question in the interview.** Tapping it makes the organizer's next typed message the answer, kept as written rather than as the word "other". Only that one question allows it, because the other answers must be bilingual on the site. The multi-select "Done" half of #42 is not built. Addresses #42 (partly; still open), PR #150.
- **Health, Money and Communication on the Info tab are now filled.** The tab used to render three empty lists. The control plane now keeps this information per country, re-checks it monthly, and a new trip picks it up when it is provisioned; hospitals and age notes are deliberately left out. Existing trips do not change until re-provisioned. Known gap: a destination only gets data if the interview looked up that country (#159). #156, PR #160.
- **Operator: an organizer can be handed an interview link without a password.** The operator (or the monitoring bot on their say-so) creates the trip and gets a ready-to-forward message in English or Hebrew; a returning organizer gets a short "welcome back" that says their earlier trip is untouched. Off unless the operator key is configured; rate-limited, audited, no password reset anywhere. A trip now remembers its own companion, so `/switch` back to an earlier trip no longer lands on "still finishing your assistant". PR #95.
- **Operator: `create-trip-link` is now in the repository.** One address in, a production account plus a Telegram interview link out; safe to repeat. It was previously a single untracked file. PR #148.
- **A new trip's stored data (photos, bookings, site database) is filed under the trip's id, not its slug.** A reused slug can no longer meet a previous family's data. Existing trips keep their current directory. PR #89.
- **Uploaded documents are kept, reconciled and handed to the trip (Slice B of #92).** Original files are stored once and read once per version; documents are merged with what the organizer already said and disagreements are reported rather than overwritten; documents reach the provisioned trip behind authentication; a super admin's `/model` override is now re-read from the database every 30 seconds by the running relay (before, it was recorded but never applied). Migrations are timestamp-named with a rollback header. Keeping originals needs a document-store directory: a deployment that sets the "required" flag refuses to start without a real mounted volume, any other run only warns and works without keeping originals. Whether any deployment sets it is not stated here. #92, PR #145 (forward-ported to this branch; no separate PR number).
- **Documents can add to an interview answer instead of being refused (Slice A of #92).** A document about a question that already has an answer now fills gaps and adds entries without replacing anything, and readers cope with spreadsheets whose dates are numbers, JSON exports holding JSON as text, and PDFs whose text is split up. PR #136 addresses #49, #52, #53, #54, #55, #59, #60 (its description says each was verified against its own test; the GitHub issues stay open until the sprint merges to main) and advances #51 and #56. #92.

### Fixed

- **A torn-down trip could still be attached to a chat.** After teardown, a chat (or a group binding link valid for 7–30 days) could be bound to the retired trip, leaving a companion that could never connect: the operator's release verify stayed red and every relay restart waited 40 seconds for it. Both routes now refuse retired trips, and teardown revokes still-live group links (ordering chosen to avoid a database deadlock). A narrow timing race remains between the retired-trip check and a concurrent teardown; it is documented in the code. Benefits the operator. Addresses #105 (still open) and #175, PR #174, PR #176.
- **Documents with no type or name from Telegram were refused.** A PDF sent as a phone "share/save as PDF" arrived typeless (as `.bin`) and was rejected on a live trip. The file type is now recognised from the file's own bytes (PDF, JPEG, PNG, GIF). Files with a genuinely malformed PDF trailer still fail; that is separate. Benefits travellers. #163 (still open), PR #166.
- **A chat could be bound to a trip on an unverified hint.** Bindings and companion introductions now come only from a verified Telegram identity or the chat the interview ran in; without one the bind is refused and the reason recorded. The unverified id may still be used to send a notification, never to route or authorize. Security fix. Addresses #32 (still open on GitHub), PR #149.
- **Operator: model calls for the interview ran with more of the machine's environment than needed.** The Claude CLI path now passes an allowlisted set of variables, and the Codex path is isolated from shell, web and tool access and from relay secrets. Reduces what a crafted document could reach. Addresses #58, which stays open; a startup check for the Codex version is present but not wired. PR #91, PR #144.
- **Teardown adopted an IP pool it never uses.** A pool set in the environment could be picked up by teardown, colliding with a range the live control plane reserves. Teardown now carries none. Benefits the operator. PR #108.
- **Ticketed events, shuttles and parking were filed as "other".** A booked event, shuttle or parking stopped reading as a booking on the site. They are now treated as bookings, matching a fix already on main. Benefits organizers and travellers. PR #143.
- **Journey, Today and weather views disagreed with the trip's dates.** During a trip Journey now opens on the current day and phase; Today no longer shows a past activity when nothing is upcoming; weather follows the trip from the first destination through later phases. Benefits travellers. Already on main. PR #152 (merged to main; carried here as `59ed025`).

### Changed

- **Cost and token usage shown per model configuration in the document-extraction benchmark**, so the cost/quality comparison for track 3 has its numbers. Benefits the team. #155, PR #158.
- **The migration-name check no longer blocks a legacy migration arriving through a merge**, which had stopped a correct merge of already-shipped work. Newly added badly named migrations are still blocked. PR #147.
- **Documentation and agent-team process updates** (sprint 6 track plan, integrator and role rules, dry-run findings, handoff notes). PR #111, #138, #139, #140, #141, #142, #151; commits `f02997b`, `eec6bbb`, `ba2189a`, `e31b79d`.

<!-- Sprint 6 boundary: when the sprint closes, change the status line above to CLOSED with the date and merge commit, then add Sprint 7 above it. -->
