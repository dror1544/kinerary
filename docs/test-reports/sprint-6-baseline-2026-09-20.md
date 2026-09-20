# Sprint 6 baseline — manual run, 2026-09-20

**Purpose.** Establish what already works on `integration/sprint-6` before the
sprint's new work lands. Everything below is merged into the branch and has not
been verified by a person. Anything off is raised, and triaged as **fix on the
baseline / mark for this sprint / defer**.

**Build:** `a4f046c` · agentless (`INTERPRET_PATH_DEFAULT=1`, claude-sonnet-5,
effort medium) · bot **@Tripinterviewer_bot** · no documents · Hebrew.

> **Two branches, not one.** The control-plane API and worker serve
> `integration/sprint-6`; the companion and its bridge were built from
> `fix/organizer-identity-roster` via the SSH forced command (#127).
> Section D and anything about trip tools describes the older branch.

**Trip:** Vietnam, 5–20 March 2028 · דרור, שירן, נועם, יעל, משה · assistant
`פאם` · family / female / warm / balanced / kosher-style.

**Deliberate rough edges:** nothing booked; Hanoi 4 days and Ha Long 2 known,
the other 10 undecided; an explicit request for help; one late correction.

---

## Results

`PASS` · `FAIL` · `PARTIAL` · `—` not reached. Fill `Observed` in your words;
precision matters more than brevity, and "felt mechanical" is a valid result.

### A — The interview

| # | What is being verified | Merged as | Observed | Result |
|---|---|---|---|---|
| A1 | Destination is understood, trip named by its country | `a4f046c` | | |
| A2 | Dates in any phrasing: `בתחילת מרץ` → `5.3.28` → `until March 20` | — | | |
| A3 | `YYYY-MM-DD` is never shown to the organizer | — | | |
| A4 | An English line mid-Hebrew does not switch the language | — | | |
| A5 | Button questions answered in words: `נקבה` · `חמים` · `מספיק` | merged | | |
| A6 | A boundary answered in words: `אנחנו עוד לא בטוחים` | `#101` | | |
| A7 | A dietary need scoped to one traveller: `רק נועם צמחוני` | `e21e510` | | |
| A8 | Out of scope stays out: `תזמין לי טיסות`, `כמה זה יעלה?` | — | | |
| A9 | The recap matches what was actually said | — | | |

### B — Known-weak, expected to fail (#114 / #117)

Recorded so the baseline states the gap rather than discovering it later.

| # | What is being verified | Observed | Result |
|---|---|---|---|
| B1 | One message carrying several facts — are they all captured? | | |
| B2 | An explicit request for help is acknowledged at all | | |
| B3 | A late correction (`נזכרתי…`) reaches the answer it corrects | | |
| B4 | A returning leg (back to Hanoi at the end) is representable | | |

### C — The site

| # | What is being verified | Merged as | Observed | Result |
|---|---|---|---|---|
| C1 | Map shows **4 of 4** phases pinned | `ae397fd` | 2 stops, both with real coordinates. Only 2 phases exist to pin | `PARTIAL` — geocoding works; the missing phases are #117 |
| C2 | Trip is titled by its country, not "Family Trip 2028" | `a4f046c` | `Vietnam 2028 — Family`, brand `VIETNAM 2028` | `PASS` |
| C3 | Venue links anchor on the venue + its own city + Vietnam | `ae397fd` | `Thang Long Water Puppet Theatre, Hanoi, Vietnam` — venue, own city, country, no duplication | `PASS` (#112 fix holds) |
| C4 | Phases carry days and something to do | — | Both phases carry days and venues with maps/waze. No venue carries a ticket or website `url` | `PARTIAL` |

### D — The companion

| # | What is being verified | Merged as | Observed | Result |
|---|---|---|---|---|
| D1 | `המפה לא עובדת` reaches the monitor as a report | `76ce2dc` | The companion has only `trip-mcp` wired — no `trip-control`, so `report_bug` was never reachable | `—` not testable (#127) |
| D2 | The companion **cannot** file a GitHub issue itself | `76ce2dc` | Vacuously true — it could not file anything at all | `—` not testable (#127) |
| D3 | Group: untagged reply within 150s of its question is heard | `64309a1` | Never heard. The window has never opened — `awaiting_reply_since` is NULL on all 43 bindings | `FAIL` (#122) |
| D4 | Group: a *second* untagged message is ignored | `64309a1` | Ignored — but so is the first, so this passes for the wrong reason | `—` not testable |
| D5 | Group: an untagged message *after* 150s is ignored | `64309a1` | Same: everything untagged is ignored | `—` not testable |
| D6 | `/trips` and `/switch` respond in a private chat | `c3ac940` | | |

---

## Raised

One row per thing that was off. Triage is Dror's.

| # | What happened | Why it matters | Triage | Where it went |
|---|---|---|---|---|
| R1 | The companion could not read its own trip — "I can't reach the live plan" to every request, for hours, while staying fluent and in character | Provisioning had *verified* it could: `/health` returned ok, the worker logged `mcp_bridge_wired`. The site's key was then replaced ~60s later and nothing looked again. A bridge failure is also caught, logged at WARNING and recorded nowhere | `baseline-fix` (Dror, 2026-09-20: "requires a fix as part of the preparation of the sprint") | #119 |
| R2 | The companion told the organizer twice, unprompted, that it had **reported the problem** — in Hebrew, "ודיווחתי על כך" | `companion_bug_reports` is empty. It filed nothing. A false claim of having reported is worse than silence: it stops the person from reporting it themselves | *pending* | #125 |
| R3 | The confirmed plan holds two phases covering 6 of 16 days; the other nine days, and two named cities the organizer gave, are absent | **Refined:** the interview DID capture it — `planning_help` holds the request verbatim. Nothing downstream reads that field. The site's own return flight departs Saigon, a city it does not believe they visit | *pending* | #117 (commented) |
| R4 | `timezone` on the built trip is the string `Vietnam`, not an IANA zone | Free text, copied through unvalidated. `agent.proactive.morning_briefing` is 07:30 in a zone that does not resolve | *pending* | #123 |
| R5 | **Corrected — it is the opposite way round.** The hero strip claims "4 booking(s) already confirmed" on a trip where nothing is booked | The stat counts `travel_anchors`; none carries a confirmation. The map stops on the same page render `conf: "–"`. My earlier note of `bookings: 0` was wrong | *pending* | #124 |
| R6 | No venues on either plan option | **The data is present and correct**: three venues, each with well-formed maps + waze links. So this is about a surface, not the build. "Both options" suggests generated plan options rather than the phase pages — needs one detail from Dror before it can be filed | *needs one detail* | — |
| R7 | `/trips` in a DM listed every trip ever owned, torn-down ones included — 39 of 40 `ready_private` rows on this database are `retired-` | Teardown renames the slug and closes the bindings but never marks the trip row, and the list filters on membership alone. The list is unusable and offers dead rows as real choices | *pending* | #121 |
| R8 | Tapping a live trip in that list was refused with "we're in the middle of setting up a trip" — from a chat where a companion was answering | `switchChatToTrip` calls a session live on `state <> 'confirmed'`; `resolveChatRoute` also requires `expired_at IS NULL`. Every non-confirmed session on this database is expired, so `/switch` is refused permanently and nothing clears it | *pending* | #120 |
| R9 | `/switch` with no argument behaves identically to `/trips` | Intended (`dispatch.ts:649` — the list with a button per row). Recorded so it is not re-raised | `not-a-bug` | — |
| R10 | In the group the companion asked a question; an untagged answer got no reply. It answers only when its name appears | `64309a1` landed the receiving half only — its own commit message says the Hermes-side stamp is "a separate, cross-repo follow-up". Nothing in the repo sets `metadata.expects_reply`, and the window has never opened on any binding | *pending* | #122 |
| R11 | Group replies read as incoherent across turns | Structural, and worth a decision rather than a fix: an unaddressed group message is `NOT_ADDRESSED` and never forwarded, so the agent never sees what the family said between two messages aimed at it. Its view of the thread has holes by design | *pending* | — |
| R12 | The companion is built with `default_language: "en"` on a Hebrew trip | Hardcoded at `transformer.py:1019`. `meta.defaultLang` on the same file says `he`. Found while reading the config, not reported — worth noting that a full run did not surface it | *pending* | #123 |
| R13 | `expect_anchor_text` was declared in the e2e fixtures and asserted nowhere | A fixture key that reads like a check and never ran. Wired up 2026-09-20 while adding the `vietnam` scenario | `fixed` | this branch |
| R14 | **The companion half of this run was never sprint-6.** The SSH forced command names the `organizer-hotfix` worktree (`fix/organizer-identity-roster`), 12 commits behind on that path | No `/health` (#104) and no `trip-control`/`report_bug` (`76ce2dc`). The worker logged `mcp_bridge_wired` because the script prints it, not because anything checked. Nothing anywhere records which checkout built a companion | *pending* — **gates the rest** | #127 |

## Triage, and what was fixed (2026-09-20)

Dror's decision at the recap: **#117 is the only item deferred** to later in
sprint 6. Everything else is fixed on `integration/sprint-6` before the
sprint's own work starts.

| Raised | Issue | State |
|---|---|---|
| R1 (half) | #119 | **fixed** — a bridge failure now records a reachability fact instead of only a WARNING |
| R2 | #125 | **fixed** — the SOUL no longer teaches "I've reported it" as an unconditional answer |
| R3 | #117 | **deferred**, by decision. Asserted by the e2e and reported as a known gap |
| R4 | #123 | **fixed** — the zone is derived from the destination; free text that is not a zone is dropped, not carried |
| R5 | #124 | **fixed** — only anchors carrying a confirmation count, and the stat disappears at zero |
| R6 | #128 | **fixed** — venues take their website from the geocode already being made (`extratags=1`) |
| R7 | #121 | **fixed** — torn-down trips excluded by the two markers teardown writes |
| R8 | #120 | **fixed** — one shared `LIVE_INTAKE_SESSION_PREDICATE`, used by both readers |
| R10 | #122 | **fixed (interim)** — the relay infers a question when the gateway states nothing; an explicit value still wins |
| R11 | — | **fixed** — unaddressed group turns are held and carried onto the next addressed one |
| R14 | #127 | **partly fixed** — provenance is recorded and reported; repointing the forced command is an operator step |

Rows marked *pending* above kept their text as raised; this table is the
outcome.
| R15 | **An organizer who types their own name is never understood.** The interview re-asks `organizer_identity` forever and no trip is built | Found by the `vietnam` e2e on its first run. `interpret` returned zero proposals twice; the deterministic matcher that gets it right was never reached, because it acts on a STORED answer. Only the button worked | `baseline-fix` | #129 |
| R16 | The e2e's own teardown failed, leaving a provisioned trip on shared infrastructure | **Not a defect** — the script chooses its interpreter correctly (f1f4ba4); it was invoked by its shebang, which handed it a Python with no CA store. Run it as `~/.cache/kinerary-preflight/venv/bin/python scripts/e2e-full-cycle.py` | `not-a-bug` | — |
| R17 | A vague departure date (`בתחילת מרץ 2028`) is answered differently on identical input | Two runs gave `2028-03-01` (wrong — the trip starts on the 5th) and `unclear`. Removed from the e2e fixture: a required field that depends on model whim cannot gate a build. Loose date parsing needs its own assertion, not the end-to-end gate | *pending* | — |

Rows marked *pending* are raised and awaiting Dror's triage at the recap.

Triage values: `baseline-fix` (fix before the sprint's work) · `sprint-6`
(this sprint, tracked) · `defer` (future sprint) · `not-a-bug`.

---

## Known before starting

Stated so the run is not spent rediscovering them.

- **#114 / #117** — the interview cannot hold an organizer thinking out loud.
  Section B is expected to fail; the value is confirming it reproduces here and
  capturing *how it feels*, which no test asserts.
- **Slug derivation is nondeterministic.** The same fixture has produced
  `japan-2026`, `tokyo-2027` and `tokyo-hakone-kyoto-osaka-japan-2027`. A
  surprising slug is not automatically a bug.
- **Country naming is list-backed.** `a4f046c` recognises a trailing country
  only if it is in the fifteen-entry currency map; Vietnam was added for this
  run. An unlisted country still falls back to "Family Trip". Known limit, not
  a finding.
- **`japan` scenario is barred** while a real Japan trip is live on the VM —
  its fixture derives that trip's slug.
