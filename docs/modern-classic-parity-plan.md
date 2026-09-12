# Modern / Classic parity implementation plan

Prepared 2026-09-11 against `2500e07`; reconciled 2026-09-12 onto fetched Sprint 5 `63f8bcc`.
Worktree: `.claude/worktrees/spa-parity`; branch: `feat/spa-parity`.
Status: Sprint 5 and parity combined in this worktree, conflicts resolved, build and local regression suites passed. Deployed/provider acceptance remains open.
No commit or live deployment performed.

Modern already provides Today/Journey, itinerary item editing, booking
management and extraction, 2D/3D maps, basic budget management, photos with
comments/reactions, and live updates. The older HTML forward plan includes
historical gaps that these implementations have closed.

## Implementation sequence

1. **Readiness and useful information.** Shared task completion, device-local packing,
   emergency/country information, health, hospitals, money, communications,
   and age restrictions. Add a Modern destination under More and contextual
   Today shortcuts. Reuse Classic's canonical data and task API. Accept when
   travelers can find the information without Classic and task completion
   persists across both interfaces.
2. **Account and profile.** Avatar selection/upload/crop, applicable password
   changes, and supported account-link actions/status. Preserve the existing
   identity and permissions. Verify direct and portal sessions separately.
3. **Complete existing modules.** Budget conversion; Journey day swaps and
   labels, import/export, original-plan comparison, and revision/conflict
   handling. Audit remaining booking/photo integration differences, including
   Immich, before assigning implementation scope. Verify equivalent stored
   results without enrichment loss or duplicate items.
4. **Group participation.** Activity RSVPs and venue ratings/comments on the
   relevant cards. Photo reactions/comments already exist. Verify member
   behavior and consistency with Classic and companion writes.
5. **Lost & Found and trivia.** Public reporting and authenticated triage;
   game lobby, questions, answers, live state, scores, and organizer controls.
   Accept a full report/resolution flow and multiplayer game in Modern.
6. **Parity acceptance.** Exercise each workflow on mobile/desktop,
   Hebrew/English, organizer/member, direct/portal sessions, and two clients.
   Keep Classic available until each workflow has a verified equivalent or
   an explicitly accepted exception.

## Rules for each increment

- Inventory actual Classic behavior before implementing its Modern surface.
- Use shared APIs and canonical records rather than copying data into a new store.
- Preserve authorization and private-field visibility; verify refusal paths
  with actual HTTP responses when touching security-sensitive code.
- Include Hebrew/RTL, loading, empty, error, retry, and permission states.
- Include live invalidation for newly introduced mutable resources and protect
  unsaved input from concurrent traveler/companion changes.
- Run focused behavioral tests and browser read-back before marking complete.
- Remove the individual Classic link only after the replacement passes.

Portal/gateway deployed acceptance is tracked separately in the
`spa-acceptance` worktree. It does not block local parity implementation.
Commits and live deployments still require explicit authorization under
`CLAUDE.md`.

## Delivery evidence — 2026-09-11

| Area | Delivered in Modern | Verification |
| --- | --- | --- |
| Readiness | Shared tasks with attribution, Classic-compatible local packing keys, country/emergency/health/hospital/money/communications/age information | UI tests; Hebrew and English browser read-back; task changes propagate between two open tabs |
| Account | Avatar variants, upload with crop preview, reset, password confirmation/change, Google sign-in/link/unlink, enrollment link | Build/typecheck and password validation/success tests; real Google and image-upload browser acceptance still pending |
| Journey | Day labels, atomic day swaps, original-plan comparison, revision history, explicit import/enrich/export actions | HTTP tests prove Classic projection and immutable original; browser day-title save; UI tests verify bilingual edit and revision preconditions |
| Conflicts | Revision preconditions on Modern item/day writes and swaps; conflict feedback; draft protection during live refresh | Actual stale HTTP request returns 409 with `itinerary_changed_reload_before_retry`; concurrent tab comment preserves unsaved text |
| Budget and photos | Currency converter with cross rates/date; conditional Immich album/upload controls with failed-file retry | Converter UI test and browser read-back; existing photo/booking suites pass; real Immich acceptance pending |
| Group participation | Activity RSVPs with notes, venue ratings, comments and own-comment deletion | Browser RSVP, rating and comment saves; two-tab live comment update; HTTP ownership checks |
| Lost & Found | Public submission, authenticated list, resolve/reopen | Browser report-to-resolution flow; UI tests ensure public entry does not fetch private list; live resource events tested |
| Trivia | Authenticated live stream/reconnect and polling fallback, lobby, answer/countdown/pause, scores/history, host controls, question-bank list/add | Browser lobby-to-game-over; two-player HTTP game verifies hidden answers, pause/resume, reveal, leaderboard and history |

Validation executed against disposable fixtures:

- Full runtime suite: **452 tests / 85 suites passed**, no failures or skips.
  This run included the first seven parity HTTP tests.
- Final focused HTTP suite: **8/8 passed**, including the subsequently added
  two-player trivia test.
- Final Modern suite: **53/53 passed** across six test files.
- TypeScript and production build passed; generated `site/modern` assets updated.
  Existing runtime-base script and large map chunk build warnings remain.
- `git diff --check` passed.
- Browser checks covered direct organizer login, the workflows above, two tabs,
  Hebrew/English, and a 390×844 mobile viewport. Member/anonymous authorization
  was checked through real HTTP: day edits return 403/401 respectively.

## Remaining acceptance before retiring Classic

This is a completed local implementation, not a claim that every combination
in step 6 has passed. Keep the Classic fallback until the following are verified:

- Real Google sign-in/link/unlink and avatar upload/crop browser round trip.
- Configured Immich album access/upload and provider failure recovery.
- Deployed portal/gateway sessions, member browser navigation, and the full
  mobile/desktop × Hebrew/English × organizer/member acceptance matrix.
- Import/enrichment/export round trips with representative deployed data and
  companion writes. Local runtime tests pass, but those deployed workflows were
  not executed as part of this parity run.

The disposable preview can be started from this worktree with
`node scripts/spa-parity-preview.mjs` after building Modern. It serves
`http://127.0.0.1:4197/modern/` using fixture accounts `alice` and `bob`, password
`1234`; it does not read a real trip's configuration or secrets. Stop it with
Ctrl-C to remove its temporary data.

## Journey regression — 2026-09-12

The user reported a blank page when opening Journey after login. Reproduced
in the production preview: React rejected a lodging name shaped as `{he, en}`
because Journey rendered it directly. The API type incorrectly declared that
name as string-only. Journey now uses the existing language-aware text helper,
and the lodging type accepts bilingual values, plain strings, and null.

Five regression cases cover Hebrew, English, a missing translation, a plain
string, and null. Three failed with the original rendering; all now pass.
The complete SPA suite passes **58/58**, and the production build passes.
Browser read-back after a fresh fixture login shows the hotel and itinerary
in Journey. No server change, commit, or deployment was needed.

## Sprint 5 reconciliation audit — 2026-09-12 (historical; resolved below)

Compared the parity worktree at `2500e07` (including its uncommitted work)
with local `origin/integration/sprint-5-plus` at `63f8bcc`, also checked out in
`cp-vm`. The integration tip contains 95 commits beyond the parity base.
The only uncommitted change in `cp-vm` at audit time was run-14 notes.
Remote fetch was blocked by automatic approval review; this audit establishes
local branch contents, not that the remote has no newer commits.

**Correction to the delivery summary:** the parity preview is not current
with Sprint 5. Passing 58 tests on the older base does not prove that the
combined branch works. Reconcile before calling this ready for integration.

| Area | Sprint 5 already implements | Parity disposition |
| --- | --- | --- |
| Live updates and gateway | Existing SSE, draft guards, runtime session bridge were already in the parity base | Reuse them; parity adds only task/RSVP/Lost & Found events and feedback invalidation |
| Login roster | `19ad955`: public traveler picker on the login screen | Carry forward, do not build a second picker |
| Login recovery | `15e47a5`, `a9792c5`: organizer restores a traveler's trip password or generates a one-time enrollment link | Carry forward; this complements the parity self-service account/password/enrollment screen |
| Session and identity | `b1de9c7`: rejected sessions return to login; current identity visible in the header | Carry forward into parity login and shared API handling |
| Journey phase structure | `0daf16a`, `078237c`, `f184cd3`: phases and venue links without scheduled days, all dates in a phase, out-of-range date warning | Use Sprint 5 Journey structure as the baseline; retain parity day tools, revision preconditions, and bilingual hotel fix |
| Venue schema | Sprint 5 preserves optional venue IDs, tickets, and phase date ranges | Reconcile with `phaseParityFields`; its required IDs and missing tickets/date range must not overwrite Sprint 5 behavior. Feedback writes need stable IDs; display-only places must still render |
| Remaining parity modules | No new counterparts found in the integration diff for readiness, converter, avatar/Google controls, RSVP/feedback, Lost & Found, trivia, Immich, or plan tools | Retain these additions, using shared Sprint 5 APIs and navigation |

Integration order:

1. Preserve the uncommitted parity work and reconcile it onto the Sprint 5
   integration baseline. Do not replace the full `App.tsx` or `api.ts` with
   either branch's copy.
2. Resolve the shared schema, login, Journey, styles, and server changes;
   retain the bilingual lodging crash fix (Sprint 5 still renders that name
   directly in the inspected tip).
3. Run Sprint 5's `journey-structure`, `phase-places`, `login-roster`,
   `member-logins`, and `session-state` tests alongside the parity suite.
   Recheck real HTTP reset-password authorization and the revision guards.
4. Rebuild and browser-check fresh/expired sessions, phases with no plan,
   partially planned date ranges, member recovery, and parity modules.

This audit updates the scope; it does not claim the branches have been merged,
that the combined tests ran, or that anything was deployed.

## Combined implementation — 2026-09-12

Fetched `origin` successfully for this merge; `integration/sprint-5-plus` remains
at `63f8bcc`. Fast-forwarded only `feat/spa-parity` to that baseline, then
reapplied and manually reconciled the parity work. No new commit, push, or
deployment. The prior parity snapshot remains in the named stash
`spa-parity-before-sprint5-reconcile-2026-09-12` as a recovery copy.

Technical decisions:

- Keep Sprint 5's traveler picker, organizer recovery, session rejection, and
  header identity; retain bilingual parity login, Google, account and enrollment.
  Invalid Google credentials do not invalidate a good trip session, and a late
  401 from an older session cannot erase a replacement token.
- Keep Sprint 5's complete Journey calendar and unscheduled places. Share date
  generation with Plan Tools, so both screens offer the same empty dates.
  Explicitly naming an empty day persists only that day, with revision checks,
  hotel context, Classic projection, and no invented activities. Untitled empty
  dates remain derived. Retain the bilingual hotel crash fix.
- Use one venue schema with optional IDs and ticket/map/Waze links. Places
  without stable IDs render normally but do not issue ratings/comment writes.
  Existing places with IDs retain parity participation controls.
- Keep the existing live-update transport and extend its resource map; revision
  history refreshes with itinerary edits. Preserve the other parity modules.
- Rebuild `site/modern` from the resolved sources. No conflict markers or
  unmerged index entries remain.

Final verification:

- **90/90 SPA tests**, including Sprint 5 and parity regressions.
- **456/456 runtime tests**, 85 suites, zero failures/skips on the final run.
- Separate focused run: **13/13** (nine parity HTTP cases and four Sprint 5
  phase-render cases).
- TypeScript/production build and `git diff --check` pass. Existing build
  warnings about runtime-base and the map chunk remain.
- Browser: Hebrew traveler picker login, header identity, Journey's four-day
  New York range and seven-day Colorado phase count, bilingual hotel rendering,
  matching Plan Tools dates, and a separate member login rejected by the
  organizer-only Plan Tools screen.
- Actual fixture HTTP tests verify anonymous day-title PATCH → 401, member
  day-title PATCH → 403, member reset-password POST → 403, and stale day/item
  edits → 409 (`itinerary_changed_reload_before_retry`). Calendar-only title
  writes preserve all item content and the original immutable plan.

One pre-existing booking-seeding test failed intermittently in an earlier full
run, then passed alone (9/9) and in the final complete run. An additional manual
password-reset refusal probe was rejected by automatic approval review and was
not executed; authorization evidence above comes from the approved HTTP suite.

Combined disposable preview: `http://127.0.0.1:4198/modern/`, fixture accounts
`alice` / `1234` (organizer) and `bob` / `1234` (member). Reproduce with
`SPA_PREVIEW_PORT=4198 node scripts/spa-parity-preview.mjs` after building.
The Google/Immich/deployed-session acceptance items above remain outstanding;
this merge does not retire Classic.

## PR preparation — 2026-09-12

User authorized commit/push and a PR to `integration/sprint-5-plus`. The parent
was fetched again and remains `63f8bcc`. Required staged preflight checks pass
with existing warnings about an unmirrored profile skill and absent generated
directories. Source whitespace checks pass; the generated JavaScript retains
Zod's whitespace inside code-generation template strings, as emitted by Vite.

## Mobile follow-up — 2026-09-12

Journey uses a labeled native day dropdown at widths up to 880px, sharing the
same selected date and complete phase dates as the desktop strip. The side menu
is constrained to the viewport and scrolls independently, with background page
scroll locked while it is open and restored on close.

Verified in a 390×844 browser: selecting March 12 changes Journey to the empty
selected day; the 1195px menu content scrolls within an 844px panel, reaching
Sign out at the bottom while page scroll stays at zero. All 90 SPA tests and
the production build pass. No server changes.

## RSVP on Journey activity cards — 2026-09-12

Removed the separate Journey activity/RSVP link. Marked activities expose an
RSVP button alongside their existing card actions; it expands Going/Maybe/Not
going and the optional note inside the card, using the existing RSVP API.
A phase's `rsvp_activities` entry can set `item_uid` to explicitly link the
itinerary item. Existing entries can match a unique item by phase, exact ISO
date, and exact title in either language. Ambiguous or unmarked items receive
no RSVP action; stable links survive day/title edits. Group participation
remains available under More for entries without a matching itinerary card.
Build and all 93 SPA tests pass, including inline submission and matching rules.

## Ratings on activity cards — 2026-09-12

Journey cards linked to a venue now offer Rate alongside RSVP. Ratings and
comments expand inside the card and reuse the venue's existing records,
including the current user's selected stars and own-comment controls. A venue
can link by `item_uid`, or by an unambiguous exact title within the phase;
venues without IDs and ambiguous matches do not create rating actions.
The fresh disposable demo on port 4200 enables both actions on Breakfast,
New York, March 11. All 95 SPA tests and the production build pass.

## Star rating control — 2026-09-12

Replaced numbered rating buttons with five cumulative star icons: hover previews
without saving, selecting a star saves the rating, and the saved stars remain
filled. Native radio inputs provide keyboard interaction and accessible labels;
44px targets and RTL ordering support phones and Hebrew. Pending submissions
disable the control. Tests verify preview/selection, saved state, RTL labels,
and inline API submission. All 97 SPA tests and the build pass. Browser preview
inspection timed out during this follow-up; no visual browser pass is claimed.

## Collapsing activity panels — 2026-09-12

Expanded rating and RSVP panels now show an explicit Collapse control; the
original action also changes to Hide while open. Collapsing returns keyboard
focus to that action and preserves unsaved panel input for reopening. Content
is fetched only after first opening. All 98 SPA tests and the build pass.

### Document access demo — 2026-09-12

- Journey's attached booking confirmation now offers both view and download in the activity actions, matching Bookings.
- The disposable preview generates a sample PDF outside git, attaches it to Breakfast through the booking/plan APIs, and checks the active Journey includes it. Regular member document GET returns 200; anonymous GET returns 401.
- Verified the Hebrew action controls as Bob in Chrome and rendered the sample PDF with Quick Look. Browser automation did not confirm opening the popup or completing a download; those click outcomes remain a manual check.
- Validation: SPA build and all 98 tests pass; fresh preview setup succeeds with the Journey attachment assertion.

### Mobile selector sizing — 2026-09-12

- Select elements inherit the site font and keyboard focus treatment. Mobile form selectors use 16px text and a 52px minimum height; Journey's day picker uses 18px text and a 56px minimum height.
- Validation: production build passed. At a 390px Chrome viewport, the Hebrew day picker measured 56px tall with 18px text; selecting March 12 updated the selected day and displayed its empty itinerary state.

### Mobile editor sizing follow-up — 2026-09-12

- Inspected the user's existing Chrome tab with DevTools at 400px: editor selectors still used 16px text, unlike the day picker. All mobile selectors now use 20px text, 60px height and a 24px arrow with RTL placement. Editor labels and text/date fields use 18px text; inputs have a 56px minimum height. Native selection and forced-colors appearance are retained.
- Verified the actual open tab after rebuilding: all four selectors measured 20px/60px and the screenshot showed the larger editor controls. Choosing exact time displayed its input; restored the initial selection without saving. Production build passed.
