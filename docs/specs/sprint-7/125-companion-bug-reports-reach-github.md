# A companion's report reaches GitHub through the monitor, and the reporter hears back

Status: draft (2026-10-22; all open questions answered by Dror 2026-10-22, awaiting approval) · Issue: #125 · Track: T4 · Size: L (three slices) · Tier: High
Security path: yes (the issue-filing token; traveller text in a public tracker; a new monitor write path) · Migration: yes (verdicts, beta flag) · Live-trip behaviour: yes (companion replies; companions need a re-render)

## Problem

A companion told its organizer twice, in Hebrew, that it had reported a fault
("דיווחתי על כך"). It had filed nothing: `companion_bug_reports` was empty (#125).

The reporting path exists:
- `report_bug` in `control-plane/api/src/companion-mcp.ts` writes
  `companion_bug_reports` and returns `{ok, id}`.
- The fleet monitor reads `bug_reports` and `alerts` (`fleet-mcp.mjs`).
- It files through `issue-mcp.mjs`, whose fine-grained token can only create
  issues on one repo.

But a companion cannot reach `report_bug` unless its profile carries the
`trip-control` MCP server
(`profile-templates/familytrip-companion/templates/config.overlay.yaml.tpl`).
On 2026-10-20, no companion profile on the Mac staging host had it. Nothing
checks for it at build or verification time.

**Owner decisions (2026-10-21 and 2026-10-22):**

1. The companion reports to the monitor. The monitor checks whether it is a bug,
   and files a GitHub issue marked as a companion bug, with the trip id and the
   related identifiers.
2. A traveller's exact words may appear in the public issue, quoted and marked
   untrusted, as today, but **no private data may be exposed**.
3. When the monitor decides it is **not a bug**, the person gets an explanation:
   - how to do it properly;
   - that it is not supported;
   - or that it is a future feature not built yet.
4. **Certain users, for example beta testers, may suggest improvements**, and a
   suggestion is filed as well.

## Behaviour

### Reporting (every trip)

- Every companion built from now on can call `report_bug`. A build where it
  cannot fails verification before the trip reaches its family.
- `report_bug` returns a short reference (`R-xxxxxxxx`). The companion says it
  passed the problem on and gives that reference. It never claims a report it did
  not make. A failed call is admitted as a failure.

### Triage (the monitor)

Each new report gets one verdict:

| Verdict | Meaning | What happens |
|---|---|---|
| `bug` | a real defect | one GitHub issue, labelled `companion-bug` |
| `how_to` | the product does it, but differently | an explanation goes back to the reporter |
| `not_supported` | the product does not do this, and nothing is planned | an explanation goes back to the reporter |
| `planned` | a known future feature | the person is told the request has also been raised by other users and is in the product's plan for the future; no date, no issue number |
| `duplicate` | already reported or already filed | the person is told it has already been reported and is being looked at; no reference |

### The answer back

- The verdict and a short explanation are recorded against the report.
- The companion picks them up with a new tool, `report_status(reference)`, or
  through a proactive note on its next turn in the chat where the report was
  made. It tells the person in their own language, for example: "I checked:
  you can do that from the trip site's Plan tab, by …", or "That isn't supported
  yet; it's on the list of planned features."
- **No issue numbers or technical data in the chat**, for any verdict (owner,
  2026-10-22): no issue number, link, report id, label, error code or internal
  name, and never another trip's data. The person hears plain language only.
  For `planned`, that means something like: "Other travellers have asked for
  this too, and it's part of what we plan to build." The issue number stays with
  the operator.

### Suggestions (beta testers only)

- A **trip** can be marked **beta** by an operator (owner, 2026-10-22: per trip).
  Every member of a beta trip may suggest. Per-person beta is a later change.
- On a beta trip, the companion offers `suggest_improvement` as well as
  `report_bug`. On any other trip, that tool is absent, and a request to "suggest
  a feature" gets a polite "I've noted it" with no filing.
- The monitor merges similar suggestions and files one GitHub issue each, with
  the labels `suggestion` and `from-beta`, carrying the same redacted quote and
  identifiers as a bug.

### Privacy in the public issue

The public issue never carries:
- **names:** traveller or organizer names, which are replaced by `[traveller]`
  or `[organizer]` from the trip's own roster;
- **the slug:** the trip slug can contain a family name, so only the opaque trip
  id appears. The slug and profile stay in the operator channel;
- **contact details:** phone numbers, email addresses, street addresses;
- **booking secrets:** booking or confirmation codes, passport or ID numbers,
  dates of birth, and card-like numbers;
- **links:** URLs (these may carry tokens), which are replaced by `[link]`;
- **children's ages tied to a name.**

The redaction is **deterministic**, not left to the model. If the redactor cannot
run (for example the roster cannot be read), nothing is filed. The report waits,
and the operator is told.

## Acceptance criteria

### Slice 1: reporting works, bugs are filed, nothing private leaks

- **AC-1 Wired on every build.** A profile rendered by
  `companion-install-host.sh` has `trip-control` with a token in its `.env`.
  Verification gains `check_companion_reporting`, which lists the companion's
  tools through the gateway and fails with `COMPANION_REPORTING_MISSING` when
  `report_bug` is absent.
- **AC-2 Truthful reply.** The SOUL template claims a report only with the
  returned reference, and admits a failed call. A template test pins this in
  English and Hebrew. Eval cases cover a successful call, a failed call and a
  missing tool.
- **AC-3 Reference.** `report_bug` returns `reference` (`R-` plus the last 8 hex
  characters of the id). A duplicate within 24h returns the original's reference.
- **AC-4 Redaction.** `fleet-mcp.mjs`'s `bug_reports` returns `quote_redacted`,
  `summary_redacted` and `detail_redacted`.
  - Names come from the trip's own roster (organizer and travellers, both
    languages).
  - The pattern classes listed above apply.
  - A redactor that cannot read the roster returns `redaction: "unavailable"`
    and no text.
  - Test fixtures: a Hebrew and an English quote containing a roster name, a
    phone number, an email, a booking code (`GG-48213`-shaped), a URL and
    "my son Ella, 9". Each comes out clean, while the meaning ("the hotel card
    is blank") survives.
- **AC-5 Companion-report issue kind.** `issue-mcp.mjs` gains kind
  `companion-report`. It requires `trip_id`, `report_id` and `verdict: "bug"`,
  and accepts redacted text only.
  - It **refuses** a call whose text still matches any pattern class, which
    gives a second, independent check.
  - It refuses a slug-shaped value in `trip_id`.
  - The label is `companion-bug`, and the fingerprint must be
    `companion-report:<report_id>`.
  - `--render` shows the body without filing.
- **AC-6 Once only.** A repeat call, or the next cron tick, files nothing.
- **AC-7 End-to-end.** A fake companion call → the monitor's `bug_reports` (a
  fixture database) → `issue-mcp.mjs` against a stub GitHub API gives one issue
  with the label, the identifiers and the redacted blockquote. Nothing private
  appears anywhere in the created body, checked against the fixture's full
  roster and pattern list. A repeat creates nothing.
- **AC-8 No token in the companion.** The rendered companion config and `.env`
  contain no `GITHUB`/`GH_` key.

### Slice 2: the answer back

- **AC-9 Verdict write path.** A separate, single-purpose MCP server,
  `report-verdict-mcp.mjs` (like `issue-mcp.mjs`, never part of the read-only
  `fleet-mcp`), records one verdict per report.
  - It calls the control plane's operator route
    `POST /internal/operator/companion-reports/:id/verdict` with
    `{verdict, explanation, related_issue?}`.
  - `verdict` must be one of `bug`, `how_to`, `not_supported`, `planned` or
    `duplicate`.
  - `explanation` is limited to 600 characters, in English; the companion
    translates it.
  - The route is behind the operator key, unmounted when the key is unset, and
    insert-only: a second verdict for the same report is refused.
- **AC-10 Migration.** A new table,
  `companion_report_verdicts(report_id PK FK, verdict, explanation, related_issue, decided_at)`.
  The report row itself stays unchanged and append-only, so migration 0054's
  reasoning still holds. The migration header is
  `-- rollback: compatible — new table, nothing older reads it`.
- **AC-11 Companion pickup.** `report_status(reference)` on `companion-mcp.ts`
  returns `{state: "waiting"|"answered", verdict?, explanation?}`, scoped to the
  caller's own trip through gateway identity, exactly as `report_bug` is. A
  reference from another trip is reported as "not found". The SOUL template tells
  the companion to check its open references at the start of a turn in the chat
  where each was reported, and to tell the person once.
- **AC-12 Wording per verdict.** A template test and eval cover each verdict in
  English and Hebrew:
  - `how_to` gives the steps;
  - `not_supported` says it plainly;
  - `planned` says other users raised it too and it is in the future plan, with
    no promise;
  - `duplicate` says it was already reported.
  A test asserts that no reply contains an issue number, `#`-number, URL,
  `R-`/`cbr_` id, label or error code, and none leaks another trip's data.

### Slice 3: beta suggestions

- **AC-13 Beta flag.** A migration adds `trips.beta boolean NOT NULL DEFAULT false`
  (per trip, the owner's decision of 2026-10-22). An operator sets it through a verb on the existing operator route set
  or the `cpinvite`-style forced command. Default off.
- **AC-14 Tool presence follows the flag.** `suggest_improvement` is offered by
  `companion-mcp.ts` only when the caller's trip is beta. Otherwise the call is
  refused with `NOT_A_BETA_TRIP`, and the tool is not listed.
- **AC-15 Filing.** The monitor files with kind `companion-suggestion`, labels
  `suggestion` and `from-beta`, with the same redaction and the same once-only
  fingerprint (`companion-suggestion:<id>`). Similar suggestions are linked, not
  re-filed.

## Contracts

| Area | Files and changes |
|---|---|
| Companion tools | `companion-mcp.ts`: `report_bug` gains `reference`; new tools `report_status` and `suggest_improvement` |
| Verification | `verification.py`: `check_companion_reporting` |
| Templates | `SOUL.md.tpl` and the operations skill: reporting, answer-back and suggestion wording |
| Fleet monitor | `fleet-mcp.mjs`: redacted fields, and the redactor module `redact.mjs` with tests |
| Issue filing | `issue-mcp.mjs`: kinds `companion-report` and `companion-suggestion`, with the redaction check on input |
| Verdicts | new `report-verdict-mcp.mjs`, and the operator route in `app.ts` |
| Migrations | `companion_report_verdicts`, and the beta flag |

## Non-goals

- The companion filing issues itself or holding any GitHub credential. That was
  rejected on 2026-09-18 and again on 2026-10-21.
- Any state column on `companion_bug_reports`. Verdicts live in their own table.
- Free-form two-way chat between the monitor and a traveller. The answer back is
  one verdict and one explanation.
- Suggestions from non-beta trips being filed.

## Security and boundary notes

- **The issue token stays with the monitor.** The verdict write path is a
  second, separate server with one verb, insert-only, behind the operator key.
  This mirrors how `issue-mcp` is kept apart from `fleet-mcp`, so even a bug in
  the read-only server still cannot write.
- **Redaction runs twice, independently.** First in `fleet-mcp` with the roster,
  then as a pattern check in `issue-mcp`, which refuses rather than filing. If
  either fails, nothing is filed.
- **The explanation reaching a traveller is written by the monitor's model.** It
  is bounded (600 characters, an enum verdict). The companion relays it in its
  own words, in the chat where the report was made, and never into another trip's
  chat. Gateway identity scoping makes a cross-trip reference "not found".
- **The beta flag is set by an operator, never by the companion or a traveller.**

## Test plan

| Area | Tests |
|---|---|
| control-plane/api | `companion-mcp` tests (AC-3, AC-11, AC-14); `report-verdict-route` tests (AC-9, auth matrix, insert-only); a migration test (AC-10, AC-13) |
| worker | `verification` test (AC-1) |
| templates | template tests and eval cases (AC-2, AC-8, AC-12) |
| tests/scripts | `test_redact.py` (AC-4, Hebrew and English fixtures), `test_issue_mcp.py` (AC-5, AC-6, AC-15), `test_report_verdict_mcp.py` (AC-9), `test_companion_report_e2e.py` (AC-7) |

Manual check, once on staging: report something broken (it gets a bug issue
with nothing private in it). Then report something that is a how-to (the
companion comes back with the steps). Then, on a beta trip, suggest something
(it gets a suggestion issue).

## Rollout and regression

- New companions get it on build. Existing companions need a re-render, one
  approved step per trip.
- The verification check is a new way for provisioning to fail, which is
  intended and is part of the regression assessment.
- The two migrations need the usual assessment.
- `issue-mcp`, `report-verdict-mcp` and the monitor skill reach the monitor
  through `install-hermes-skill.sh` (an approved step).

## Decisions (owner, 2026-10-22)

1. **Beta is per trip.** Every member of a beta trip may suggest. Per-person
   beta (which needs the relay's verified sender id) is a later change.
2. **No issue or technical data reaches the chat.** For `planned`, the person
   hears that other users raised it too and that it is in the product's future
   plan. Issue numbers go to the operator only.
3. **The public issue carries the opaque trip id only.** The slug and profile
   go to the operator channel only, as proposed.
