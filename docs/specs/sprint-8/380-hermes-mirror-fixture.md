# The relay's Hermes mirror, pinned to a captured fixture

Status: draft, refreshed against 4510301 (2026-10-30) · Issue: #380 · Track: T3 · Size: M · Tier: Normal
Security path: no (touches the leak filter's tests, not its rules; see notes) · Migration: no · Live-trip behaviour: no (unless the comparison finds drift, see Rollout)

> **Sprint 8 (2026-10-30): in scope.**

## Problem

The relay depends on how Hermes classifies and words its own messages, and
copies that knowledge by hand. Every copy was read at `ab0d98414`; the target
Hermes is `4097709b0c` (the revision the patch set is rebased onto,
`control-plane/deployment/hermes-patches/README.md:17`), and nobody has compared
them. A Hermes upgrade that changes any of these changes companion behaviour
with every test still green, because the tests assert against the copy, not
against Hermes.

| What the relay assumes | Where the copy lives | Read at |
|---|---|---|
| Hermes' error classifier: `_is_timeout_error`, `_is_retryable_error`, `_RETRYABLE_ERROR_PATTERNS` (`gateway/platforms/base.py`) | `control-plane/api/test/relay-connector.test.ts:365-382` (mirror predicates); the phrase chosen to satisfy it, `GATEWAY_TIMEOUT_ERROR`, `control-plane/api/src/relay/connector.ts:40-54` | `ab0d98414` (`relay-connector.test.ts:369`) |
| The gateway's outbound wait, `_OUTBOUND_TIMEOUT_S = 30.0` | the budget argument for `REQUEST_TIMEOUT_MS`, `control-plane/api/src/relay/telegram-api.ts:88-98` | `ab0d98414`, Mac checkout only (`telegram-api.ts:94`) |
| The approval prompt's wording ("Dangerous command requires approval … Reply /approve …") | leak stems inside `GATEWAY_STATUS_PHRASES`, `control-plane/api/src/relay/internal-leak.ts:113-127` | live incident 2026-09-12 |
| The gateway's own status lines (busy acks, model fallback, sethome) | `GATEWAY_STATUS_PHRASES`, `internal-leak.ts:81-112` | live incidents 2026-09-05, 2026-09-10 |
| **New since 03c0e1c:** Hermes' Codex auto-compaction notice ("auto-compaction was raised …", "hermes config set compression.codex_gpt55_autoraise …") | `internal-leak.ts:129-145` (#65, `ab4184b`) | staging, new companions' first group reply |
| **New since 03c0e1c:** Hermes' context-file truncation warning ("Context file SOUL.md TRUNCATED … context_file_max_chars …") | `internal-leak.ts:146-156` (#481, `6436c5b`) | staging organizer, 2026-10-29 |
| **New since 03c0e1c:** the Hermes config keys the companion overlay sets to switch those messages off at the source — `display.interim_assistant_messages`, `display.suppress_warning_notifications`, `context_file_max_chars`, `compression.codex_gpt55_autoraise_notice` | `profile-templates/familytrip-companion/templates/config.overlay.yaml.tpl:52-60`, `:196` | not recorded; Hermes ignores an unknown key, so a renamed key silently undoes the fix |
| The relay contract: `contract_version`, descriptor fields, which ops a gateway may send | `control-plane/api/src/relay/protocol.ts:30-80`, `:309-330` | not recorded |
| Hermes log lines read as evidence: MCP tool registration (`MCP server '%s' (%s): registered %d tool(s): %s`) and tool completion (`tool %s completed (%.2fs, %d chars)`) | release verify regex `INTERVIEW_REGISTERED_RE`, `control-plane/deployment/vm-release.py:187`; fleet monitor tool usage, `.agents/skills/trip-fleet-monitor/fleet-mcp.mjs:480-580` (`toolUsageScript`, `:529`) | not recorded |

The 2026-10-03 Hermes regression plan (notes folder,
`regression-plans/2026-10-03-vm-hermes-upgrade-to-4097709b0c.md`, F5–F7) read
the target by hand and found: contract version unchanged; additive `delete` and
reaction-ack ops; outbound frames now echo the routed profile (an extra field
the connector must ignore); a 4401 re-dials once with a fresh token; both log
formats unchanged. Those are readings, not tests — this spec turns them into
tests.

`docs/sprint6-tracks.md:1018` records the rule "a Hermes upgrade that changes it
must change the mirror by hand". Nothing enforces it, and nothing records which
revision a copy describes except a comment.

**What moved on main since 03c0e1c (checked 2026-10-30).** Nothing here was
built. The copies grew instead: #65 and #481 each added Hermes-worded stems to
the leak filter, and #481 added Hermes config keys to the companion overlay
(three new rows in the table). `relay-connector.test.ts`, `connector.ts`,
`protocol.ts` and `hermes-patches/` are unchanged; `telegram-api.ts` gained
code (#478) but its `_OUTBOUND_TIMEOUT_S` argument is unchanged (`:88-98`).
The verify regex moved (`:187`), and so did the fleet monitor's parser
(#295/#304, the SSH bound, #478). #461's gateway reconciler reads no Hermes log
line and adds no new copy. #470 is CI-only and unrelated.

## Behaviour

What the relay assumes about Hermes is a **fixture captured from a named Hermes
revision**, committed in this repo. Tests assert the relay's behaviour against
the fixture, not against a hand copy. Moving the target revision without
recapturing fails a test; recapturing a revision whose wording or classifier
changed fails the tests that depend on it, by name. The coupling becomes a list
someone can read, rather than knowledge spread across comments.

The relay's runtime code does not read the fixture. The fixture is a test
input: Hermes stays a black box at runtime, and the relay keeps owning its own
rules (position-paper principle: control-plane-owned, not coupled to Hermes
internals). This is a tripwire, not an import.

## Acceptance criteria

- AC-1 Given the fixture for the target revision, when the API suite runs, then
  `GATEWAY_TIMEOUT_ERROR` is classified as a timeout and as not retryable by the
  fixture's timeout and retryable patterns, and `"NETWORK"` is classified as
  retryable (the two verdicts `relay-connector.test.ts:384-414` assert today).
- AC-2 Given the fixture, when the API suite runs, then every approval-prompt
  string and every gateway status string in it — including the compaction
  notice (#65) and the context-file truncation warning (#481) — is caught by
  `detectInternalLeak()` (each one listed by name on failure).
- AC-2b (if Open question 3 keeps it) Given the fixture's list of Hermes config
  keys (read from Hermes' config defaults by symbol), when the suites run, then
  every key the companion overlay sets in the table's config-keys row exists in
  it; a key missing from the fixture fails naming the key and the overlay line.
- AC-3 Given the fixture's outbound timeout, when the API suite runs, then the
  worst-case `sendMessage` duration computed from `REQUEST_TIMEOUT_MS` and
  `RETRY_AFTER_CAP_SECONDS` (the arithmetic in `telegram-api.ts:88-93`) is below
  it.
- AC-4 Given the fixture's relay contract (contract version, descriptor field
  names, op names), when the API suite runs, then `TELEGRAM_DESCRIPTOR`
  advertises only fields and ops the fixture knows, its `contract_version`
  equals the fixture's, and every op in the fixture is answered by
  `parseOutboundAction` or by the `UNSUPPORTED_OP` result (never dropped); an
  outbound frame carrying a field the fixture lists and the connector does not
  use (the routed-profile echo) is accepted unchanged.
- AC-4b Given the fixture's log formats, when the API and `tests/scripts` suites
  run, then a line rendered from each format matches the release verify regex
  (`vm-release.py:187`) and the fleet monitor's tool-usage parser
  respectively.
- AC-5 Given the fixture's `revision` differs from the patch set's base revision
  (single source: `control-plane/deployment/hermes-patches/BASE_REV`), when the
  API suite runs, then a test fails naming both revisions and the capture
  command.
- AC-6 Given a Hermes source tree in which any anchor the capture script looks
  for is missing or ambiguous, when the capture script runs, then it exits
  non-zero naming the anchor, and writes no fixture (a missing anchor is drift,
  never an empty list).
- AC-7 Given a Hermes source tree, when the capture script runs with `--check
  <fixture>`, then it exits 0 when the extraction equals the fixture and 1 with a
  readable diff otherwise.
- AC-8 Given the comparison against `4097709b0c` is done, then the fixture is
  committed with that revision, the hand copies at the sites above are
  replaced by reads of the fixture in tests, and their comments name the
  fixture instead of `ab0d98414`; any behaviour difference found is either fixed
  in this PR with a test or filed as its own issue and named in the PR body.

## Contracts

- **New** `scripts/capture-hermes-mirror.py` — stdlib only, reads a Hermes source
  tree (`--source DIR`), uses `ast` on Python files (no import, no execution of
  Hermes code; run with `python3 -I`), writes JSON (`--out`) or compares
  (`--check`). Anchors are by symbol name, not line number.
- **New** `control-plane/api/test/fixtures/hermes-mirror.json`:
  ```json
  { "revision": "4097709b0c", "captured": "2026-10-..", "source_files": {"gateway/platforms/base.py": "<sha256>", ...},
    "error_classifier": { "timeout_substrings": [...], "retryable_substrings": [...] },
    "outbound_timeout_seconds": 30.0,
    "approval_prompt_strings": [...], "status_strings": [...],
    "relay_contract": { "contract_version": 1, "descriptor_fields": [...], "ops": [...], "outbound_frame_fields": [...] },
    "log_formats": { "mcp_registered": "...", "tool_completed": "..." },
    "config_keys": ["display.interim_assistant_messages", "..."] }
  ```
  Strings are recorded lower-cased as Hermes compares them; templated strings are
  recorded as their fixed stems with placeholders removed.
- **New** `control-plane/deployment/hermes-patches/BASE_REV` — one line, the
  upstream revision the patch set applies to. `hermes-patches/README.md:17` and
  `tests/scripts/test_hermes_patches.py:33` (both unchanged since 03c0e1c) refer to it instead of repeating the
  hash.
- **Changed** `control-plane/api/test/relay-connector.test.ts` (the mirror
  predicates become functions over the fixture), `control-plane/api/test/internal-leak.test.ts`,
  comments in `connector.ts:40-54`, `telegram-api.ts:88-98`, `internal-leak.ts`,
  `config.overlay.yaml.tpl` (comment only);
  `vm-release.py` and `fleet-mcp.mjs` only in the comment naming the fixture.
- **Changed only if drift is found:** `internal-leak.ts` stems, `GATEWAY_TIMEOUT_ERROR`,
  `protocol.ts` descriptor.

## Non-goals

- The #346 approval lane. This spec records the approval prompt's wording and
  the prompt ops the target relay contract defines (so the lane can be designed
  from a captured contract), but adds no prompt op, no leak-filter exception and
  no button. Nothing here makes that lane harder: the fixture's `ops` list is
  exactly what #346 will need to advertise against.
- Carried Hermes patches (`0001` tool-call aliases, `0002` media dir, `0003`
  PostgreSQL client). They are
  already proven against the target tree by `tests/scripts/test_hermes_patches.py`.
- Reading Hermes at runtime, vendoring Hermes code, or importing it in CI.

## Security and boundary notes

The leak filter (`internal-leak.ts`) is the fail-safe that kept an approval
prompt out of a family group on 2026-09-12. This spec only adds assertions that
it catches what the target Hermes actually emits; any change to a stem is a
widening (more caught), never a removal, unless the fixture proves the old
wording no longer exists — and even then the old stem stays (an older gateway
may still be running during a rollback). The capture script parses untrusted
upstream source with `ast` and `-I`; it never imports or runs it.

## Test plan

Written first:
- `control-plane/api/test/hermes-mirror.test.ts` — AC-1..AC-5 and AC-2b, one test per AC,
  each failure naming the fixture field and the relay constant.
- `tests/scripts/test_hermes_log_formats.py` — AC-4b for the release verify
  regex and the fleet monitor parser, reading the same fixture.
- `tests/scripts/test_capture_hermes_mirror.py` — a synthetic mini source tree
  (a `base.py` with the three symbols, a status-string module, a relay protocol
  module): extraction is exact (AC-7 equal), a renamed symbol fails (AC-6), an
  edited pattern produces a diff (AC-7 differ).

Suites: `npm test --prefix control-plane/api` (the relay connector and leak
tests run without a database), `python3 -m pytest tests/scripts/test_capture_hermes_mirror.py tests/scripts/test_hermes_patches.py`.

Manual, once: run the capture against a `4097709b0c` source tree (a throwaway
checkout, never a live profile's install), commit the fixture, and record in the
PR body every difference from the `ab0d98414` copy.

## Rollout and regression

No runtime change unless drift is found. If the comparison changes a leak stem
or the timeout phrase, that is relay behaviour on every live companion and
needs a per-PR regression plan; otherwise "assessment: not needed (test and
fixture only)". Reaches nobody until the next control-plane release.

## Open questions

1. When the target revision moves again, is recapture a step in the Hermes bump
   checklist (the #189 rehearsal) only, or also a preflight check that runs when
   a Hermes source tree is present on the machine?
2. If the target Hermes reworded the approval prompt, keep the old stems for one
   release (recommended, rollback safety) or indefinitely?
3. (New, 2026-10-30) Include the overlay's Hermes config keys (AC-2b) in this
   item, or leave them to the #189 rehearsal? A renamed key fails silently in
   the same way as a reworded status line, so the fixture is the natural home;
   it adds a small AST read of Hermes' config defaults (size stays M).
4. (New) The #65/#481 stems were read from messages seen on staging, from
   whatever Hermes the Mac runs, not from `4097709b0c` source. The capture must
   find them in the target tree. If the target words them differently, which
   revision's wording does the fixture pin?
