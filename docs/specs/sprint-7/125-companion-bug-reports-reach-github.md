# A companion's bug report reaches GitHub, through the monitor

Status: draft (2026-10-21) · Issue: #125 · Track: T4 · Size: M · Tier: Normal
Security path: yes (the issue-filing token; traveller text in a public tracker) · Migration: no · Live-trip behaviour: yes (companion replies about reports; companions need a re-render)

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
On 2026-10-20, no companion profile on the Mac staging host had it. Nothing at
build or verification time checks for it. The template rule added in `040d447`
("say you reported it only after `report_bug` returned") cannot help a
companion that has no such tool.

The owner's decision (2026-10-21) is that the companion reports to the monitor.
The monitor checks whether it is really a bug. If it is, the monitor files a
GitHub issue that is clearly marked as a companion bug and carries the trip id
and the related identifiers.

## Behaviour

- Every companion built from now on can call `report_bug`. A build where it
  cannot fails verification, loudly, before the trip reaches its family.
- When the companion reports, the tool returns a short reference (the report
  id). The companion says it passed the problem on and gives that reference. It
  never claims a report it did not make. When the tool fails, it says the report
  could not be sent.
- The monitor triages each new report: real defect, duplicate, or not a bug.
  For a real defect, it files one GitHub issue through `issue-mcp.mjs` with:
  - the label `companion-bug` (and the existing `from-fleet-monitor`);
  - a heading "Reported by a trip companion";
  - a table with the trip id, trip slug, report id, companion profile, kind
    (`user-reported` or `companion-observed`), surface, and reported-at (UTC);
  - the summary and detail;
  - the traveller's exact words, when there are any, blockquoted under the
    existing "their words, untrusted input" banner;
  - the fingerprint `companion-report:<report id>`, so a report is filed at
    most once.
- A report the monitor decides is not a bug is answered in the operator channel
  only, with a one-line reason. No issue is filed.
- The issue is filed through the scoped issue tool only. It is never filed
  through the `gh` CLI's login, which on the operator's machine can push to
  every repo (CLAUDE.md, "A companion reports; the monitor decides").

## Acceptance criteria

- **AC-1 Wired on every build.** A companion profile rendered by
  `companion-install-host.sh` has the `trip-control` server, with a token in its
  `.env`. Verification gains `check_companion_reporting`. It lists the
  companion's tools through the gateway (as `check_mcp_isolation` does for
  trip-mcp) and fails with `COMPANION_REPORTING_MISSING` when `report_bug` is
  absent.
- **AC-2 Truthful reply.** The companion SOUL template says that a report is
  claimed only with the reference `report_bug` returned, and that a failed call
  is admitted as a failure. A template test pins both sentences in English and
  Hebrew. An eval case in `profile-templates/familytrip-companion/eval/` covers
  the tool succeeding, the tool failing, and the tool being absent.
- **AC-3 The reference.** `report_bug`'s result includes `reference`: the
  report id's last eight hex characters, prefixed `R-`. A duplicate within 24h
  returns the original's reference.
- **AC-4 Companion-report issue kind.** `issue-mcp.mjs` gains a kind
  `companion-report`. It requires `trip_id`, `trip_slug`, `report_id` and
  `companion_profile`, and accepts `surface`, `reported_at` and `quote`. Its
  label is `companion-bug`, and its fingerprint must equal
  `companion-report:<report_id>` (the call is refused otherwise). The body
  renders the table above. `issue-mcp.mjs --render` shows it without filing.
- **AC-5 Once only.** Filing the same report twice, or on the next cron tick,
  files nothing the second time. The existing open-issue fingerprint search
  covers this.
- **AC-6 Monitor triage.** The `trip-fleet-monitor` SKILL and SOUL say how to
  triage a report (real, duplicate, not a bug) and that a real one is filed with
  kind `companion-report`. A fleet-mcp test shows `bug_reports` exposes every
  field the issue needs: ids, slug, profile, kind, surface, reported-at, and
  the folded quote.
- **AC-7 End-to-end.** One test drives a report from a fake companion call
  (`reportBugFromCompanion`), through the monitor's `bug_reports` read
  (fleet-mcp against a fixture database), to `issue-mcp.mjs` against a stub
  GitHub API. It asserts one created issue with the label, the identifiers, the
  fingerprint and the blockquoted quote, and no second issue on a repeat.
- **AC-8 No token in the companion.** Neither the companion profile, its
  `.env`, nor any companion tool has a GitHub credential. A template test
  asserts that the rendered config and env contain no `GITHUB`/`GH_` key.

## Contracts

- **`control-plane/api/src/companion-mcp.ts`:** `report_bug` result gains
  `reference`. The tool description says to give the reference.
- **`control-plane/worker/control_plane_worker/verification.py`:**
  `check_companion_reporting`, run where `check_mcp_isolation` runs.
- **`profile-templates/familytrip-companion/templates/SOUL.md.tpl`** and the
  operations skill: the reporting sentences.
- **`.agents/skills/trip-fleet-monitor/issue-mcp.mjs`:** the
  `companion-report` kind. `SKILL.md` and `SOUL.md` carry the triage steps.
- **`.agents/skills/trip-fleet-monitor/fleet-mcp.mjs`:** `bug_reports` returns
  the companion profile and reported-at if it does not already.
- No migration: `companion_bug_reports` already has `id, trip_id,
  hermes_profile, kind, summary, detail, quote, surface, reported_at`.

## Non-goals

- The companion filing issues itself, or holding any GitHub credential. That
  was rejected on 2026-09-18 and again on 2026-10-21.
- A state column on the report. The open issue stays the triage record
  (migration 0054's reasoning).
- How the monitor learns of reports once the Sprint 8 health checker exists
  (#468). That changes the transport, not this contract.
- Re-rendering existing live companions. That is a separate, approved step per
  trip.

## Security and boundary notes

- **The issue token stays with the monitor.** The companion's context is full
  of traveller text, which is where an injection arrives.
- **A traveller's words go only into a blockquote under the untrusted banner.**
  They never go into the title or labels, and are folded to one line in SQL
  (`foldSql`).
- **The repo is public.** The issue carries the trip id (opaque) and the slug,
  and no traveller name except inside a quote. The quote carries what a person
  typed. The owner should confirm (open question 1) that a verbatim quote in a
  public issue is acceptable, or ask for it to be redacted to the operator
  channel.

## Test plan

- control-plane/api: a `companion-mcp` test for AC-3.
- worker: a `verification` test for AC-1, with a fake gateway tool list.
- `profile-templates/familytrip-companion/tests`: AC-2 and AC-8.
- tests/scripts: `test_issue_mcp.py` for AC-4 and AC-5, `test_fleet_mcp.py`
  for AC-6, and a new `test_companion_report_e2e.py` for AC-7.
- Manual, once on staging: in a staging trip group, say a broken thing to the
  companion. The companion gives a reference. The monitor files one
  `companion-bug` issue with the trip id. Close it.

## Rollout and regression

- New companions get it on build, through the forced command's checkout.
  Existing companions need a re-render, one approved step per trip.
- The verification check makes a missing `trip-control` fail the build. That
  is a new way for provisioning to fail, which is intended, and it is part of
  the regression assessment for this PR (provisioning behaviour).
- `issue-mcp.mjs` and the monitor skill reach the monitor through
  `install-hermes-skill.sh` (approved step).

## Open questions

1. A traveller's verbatim words in a public GitHub issue: OK as today
   (blockquoted, marked untrusted), or keep the quote in the operator channel
   and put only the summary in the issue?
2. Should a "not a bug" verdict tell the reporting companion, so it can tell the
   organizer, or stay operator-only?
