# Companion conversations reset again: install the session-reset plugin, and warn when Hermes ignores a config key

Status: draft (2026-10-30) · Issue: #493 · Track: T3 · Size: S–M · Tier: Normal
Security path: no (no `sanitizeConfig`, visibility or auth change). It does add third-party code to every companion gateway; see the security notes · Migration: no · Live-trip behaviour: yes (companion conversation length, after a refresh)

## Problem

A companion profile sets `session_reset: {mode: both, at_hour: 4,
idle_minutes: 1440, notify: false}` in
`profile-templates/familytrip-companion/templates/config.overlay.yaml.tpl:145-149`.
The reasons are stated beside it: the site is the source of truth, stale history
invites answers from memory, and every turn re-sends the whole thread.

The installed Hermes no longer reads that key. The Mac staging companions run
revision `4097709b0c`, which is also the #380 fixture revision and
`control-plane/deployment/hermes-patches/BASE_REV`. At that revision:

- **Core stopped rotating conversations on timers.**
  `hermes_cli/session_reset_retirement.py`'s module doc says core "reads
  nothing under `session_reset`". The idle and daily behaviour moved to the
  community catalog plugin `hermes-session-reset-policy`
  (`plugin-catalog/hermes-session-reset-policy.yaml`):
  - pinned at sha `bb618e08…`, version 0.2.0, `requires_hermes >=0.21`;
  - it provides one hook, `pre_gateway_dispatch`, and no tools;
  - it reads the same top-level `session_reset` block unchanged.
- **The gateway warns once, at startup, per served profile.** The warning
  (`gateway/run_startup.py` `_start_log_retired_session_reset`) goes into the
  gateway's error log, and only when that plugin is not enabled. Found on
  colmar2026 on 2026-10-30:
  `Profile colmar2026: session_reset.mode: both is no longer applied: … run hermes plugins install hermes-session-reset-policy`.
  `hermes doctor` reports the same (`hermes_cli/doctor_config.py`
  `_check_retired_session_reset`).
- **Nothing in this repo reads that log line.** `companion-install-host.sh`
  merges the overlay (`merge_overlay`, `:467`), enrolls the relay, starts the
  gateway, and reports `INSTALLED` either way. The companion's conversations
  now grow without bound.
- **The overlay's own comment is stale.** It says Hermes defaults
  `SessionResetPolicy` to `none`. Core now has no such policy at all.

**Would #380 have caught it? No, as written.** The fixture
`control-plane/api/test/fixtures/hermes-mirror.json` (PR #489) records Hermes'
config keys by symbol, and `session_reset` is **absent** from `config_keys`.
That absence is the drift.

- AC-2b (`control-plane/api/test/hermes-mirror.test.ts:154`) checks only a
  hand-picked `OVERLAY_KEYS` list of four keys: the `display.*`,
  `context_file_max_chars` and `compression.*` ones.
- A one-off check of every key the overlay sets against the fixture (run
  2026-10-30 for this spec) found:
  - the five `session_reset*` keys, all missing;
  - keys that are legitimately absent because they sit under open maps:
    `model.*`, `fallback_providers[].*`, `mcp_servers.*` and
    `onboarding.seen.*`.

So the fixture already holds the evidence, and only the test's scope missed it.

## Behaviour

- **Every companion install enables the plugin.** That covers a fresh install
  and a refresh of an existing profile (the `ALREADY_PRESENT` path). It happens
  before the gateway starts.
  - The plugin comes from a pinned, reviewed source (see Contracts). An install
    that cannot enable it prints one loud line and carries on.
  - The companion still answers, but `INSTALLED` / `ALREADY_PRESENT` is
    followed by `WARN SESSION_RESET_INACTIVE <profile>`, which the worker
    surfaces.
- **After the gateway starts, the install reads the gateway's own log from this
  start.** It looks for Hermes' "no longer applied" warning. If the warning is
  there, it prints
  `WARN CONFIG_KEY_IGNORED <profile> session_reset.mode` with the Hermes line
  quoted. This is the runtime check that the fix actually took, read off the
  gateway rather than inferred from the plugin directory.
- **Any key the overlay sets that the pinned Hermes does not know fails CI.** It
  fails naming the key and the overlay line. The only exceptions are a key on an
  explicit open-map list, or a key on an explicit plugin-provided list. The
  plugin-provided list names the plugin that honours the key, and that plugin
  must be one the install enables.
- **The overlay comment says what is now true:** core ignores `session_reset`,
  and the plugin honours it.
- **The behaviour a family sees is the one the template already documents.**
  After 04:00 or after a day of silence, the next message starts a fresh
  conversation, silently (`notify: false`, if the plugin honours it; see the
  open questions).

## Acceptance criteria

- **AC-1** Given a fresh install on a host whose Hermes is the pinned revision,
  then:
  - the plugin is installed for the profile and appears in that profile's
    enabled plugin set **before** `start_gateway`;
  - the gateway's error log from that start has no "is no longer applied" line
    (`tests/scripts` with a fake `hermes` and fake log).
- **AC-2** Given an `ALREADY_PRESENT` profile without the plugin, then
  re-running the install enables it and restarts the gateway, and reports
  `ALREADY_PRESENT` with no warning. Re-running again changes nothing, which
  shows it is idempotent.
- **AC-3** Given a plugin install that fails (no network, a sha mismatch,
  `hermes` exits non-zero), then the install still completes, prints
  `WARN SESSION_RESET_INACTIVE <profile> <reason-code>` on stdout after the
  result line, and exits 0. The worker's companion step logs it as a
  structured warning with the profile name and reason code.
- **AC-4** Given a gateway error log, written after this start, that contains
  Hermes' retirement stem ("is no longer applied"), then the install prints
  `WARN CONFIG_KEY_IGNORED <profile> <config path>`. A line written before this
  start is not counted.
- **AC-5** Given the fixture, then the generalised AC-2b holds: every leaf key
  path the companion overlay sets is in one of three places:
  1. `config_keys`;
  2. `OPEN_MAP_PREFIXES`, which is `model.`, `fallback_providers.`,
     `mcp_servers.` and `onboarding.seen.`;
  3. `PLUGIN_PROVIDED_KEYS`, which today maps `session_reset.*` to
     `hermes-session-reset-policy`.

  Any other key fails naming the key and the overlay line. The same test runs
  over the interviewer's `.agents/skills/trip-intake-interviewer/config.yaml.template`
  (with its own open-map list), so that the same drift cannot hide there. The
  trip-monitor profile has no config template in the repo; that gap is noted,
  not fixed, here.
- **AC-6** Given `PLUGIN_PROVIDED_KEYS`, then every plugin it names is in the
  install's plugin list (`companion-install-host.sh` reads one list; the test
  reads the same file). A plugin named but not installed fails.
- **AC-7** Given the capture script on a Hermes tree, then the fixture gains
  `retired_config_notice_stems`, captured from `format_notice` in
  `hermes_cli/session_reset_retirement.py` by symbol, as #380 already does for
  other strings. AC-4's matcher reads the stem from a single place shared with
  the test. A missing anchor fails the capture (#380 AC-6).
- **AC-8** Given the rendered companion template, then
  `profile-templates/familytrip-companion/tests/test_template.py` still passes,
  and the overlay comment no longer claims a core default.

## Contracts

**Plugin source.** Recommended: vendor the plugin.

- A reviewed copy of `hermes-session-reset-policy` at the catalog's pinned sha
  goes into `.agents/hermes-plugins/session-reset-policy/`. It carries the
  upstream licence and a `PIN` file holding the upstream repo and sha.
- The install copies it into the profile's plugin directory and enables it by
  name. This is the same "this repo is the source of truth" rule as
  `.agents/hermes-plugins/assistant-events/README.md`, and it involves no
  network fetch at install time.
- The alternative is `hermes --profile <name> plugins install
  hermes-session-reset-policy`, which uses the catalog's reviewed pin. It needs
  network on the install host. See open question 1.

**`scripts/companion-install-host.sh`.**

- New `enable_hermes_plugins <profile>`, called after `merge_overlay` and before
  `start_gateway` on both paths (`:1261` and `:1276`).
  - It reads the plugin list from
    `profile-templates/familytrip-companion/hermes-plugins.txt`, a new file with
    one plugin name per line and today one line.
  - It installs or refreshes each plugin, then confirms enablement. To confirm,
    it reads the profile's own `plugins.enabled` back, or
    `hermes --profile <p> plugins list`; whichever is chosen is recorded in the
    PR with evidence from the pinned revision.
  - It never edits another profile.
- New `check_ignored_config <profile> <start-offset>`, called after the gateway
  is up. It scans `logs/gateway.error.log` from the byte offset recorded just
  before start.
- Output contract: the existing last-line results (`INSTALLED`,
  `ALREADY_PRESENT`, `WIRED`) are unchanged, so existing parsers
  (`mcp_bridge.py`, `gateway_reconcile.py` read the `companion-install-host: `
  prefix) still match. The new `WARN …` lines come before the result line, on
  stderr with the script's prefix, plus one machine line on stdout:
  `WARN <CODE> <profile> <detail>`.

**Worker.** It logs a `WARN` line as
`companion_install.warning {code, profile}` and does not fail the step. This
uses the same stance as a bridge failure: the trip finishes with the fact
visible. It does not change the step's outcome.

**Tests.**

- `control-plane/api/test/hermes-mirror.test.ts`: AC-2b is generalised (AC-5,
  AC-6), and `OVERLAY_KEYS` is removed.
- `scripts/capture-hermes-mirror.py`: gains the `retired_config_notice_stems`
  anchor (AC-7).
- `control-plane/api/test/fixtures/hermes-mirror.json`: re-captured at the same
  revision with the new field. The fixture's `schema` is bumped only if #380's
  test requires it.

**Template.** In `config.overlay.yaml.tpl`, only the comment above
`session_reset` changes. The block itself stays: the plugin reads it unchanged.

**Hermes image (VM).** If the VM's Hermes runs a revision that has retired the
key, the plugin is either installed by the same script inside the container, or
baked into the image (`control-plane/deployment/build-hermes-image.sh`). This
is decided once the VM revision is read; see the rollout.

## Non-goals

- **No reset logic of our own in the relay.** The relay does not decide when a
  Hermes conversation ends; that stays Hermes' (or its plugin's) business, per
  the #380 principle "control-plane-owned, not coupled to Hermes internals".
- **No change to the reset policy itself.** `both`, 04:00 and 24 h idle stay.
- **No change to the interviewer's sessions.** The router clears those
  (`fresh-interview.py`).
- **Not every Hermes notice.** Only the "this config key is ignored" class is
  detected, and of that class only the stem Hermes uses today. A future
  retirement with new wording is caught by AC-5 in CI, not at runtime.

## Security and boundary notes

- **This adds third-party code to every companion gateway, and it sees every
  inbound message.** The plugin is a community-tier plugin with a
  `pre_gateway_dispatch` hook, so it runs on every message a family sends. That
  is why it is pinned to a reviewed sha and, recommended, vendored, so the code
  that runs is the code in this repo's history.
- **Before the plugin is adopted**, the PR records a read of its source at the
  pin. The read must confirm four things:
  1. no network calls;
  2. no file writes outside the profile's session store;
  3. no tool registration;
  4. no logging of message text.

  A finding on any of them blocks the item.
- **It must not run with a shell or code execution.** The companion's
  `disabled_toolsets` (`terminal`, `code_execution`) are unaffected; the plugin
  must not need either.
- **No secrets.** None are in the plugin, the list file or the log scan. The
  log scan prints only the Hermes line that matched, which is an operator
  message with no user text.

## Test plan

Tests are written first.

- **`tests/scripts/test_companion_install_plugins.py`** (new) runs the install
  script against a temp `HOME` with a fake `hermes` binary and fake logs. It
  covers:
  - AC-1, the fresh install;
  - AC-2, already present and idempotent;
  - AC-3, the failure modes: no network, sha mismatch, non-zero exit;
  - AC-4, a stale log line before the offset is ignored, and a line after it is
    reported.

  It follows the existing `tests/scripts` harness style for this script, and
  needs no real Hermes.
- **`control-plane/api/test/hermes-mirror.test.ts`**: AC-5, AC-6 and AC-7 against
  the fixture. AC-5 must fail on today's tree before the change, naming
  `session_reset.mode` at line 146. That failure is the regression test for this
  issue.
- **`profile-templates/familytrip-companion/tests/test_template.py`**: AC-8.
- **`control-plane/worker` unittest**: the `WARN` line becomes
  `companion_install.warning`, and the step outcome is unchanged.
- **Manual (staging, Mac)**:
  1. Refresh one staging companion, colmar2026.
  2. Confirm the startup log has no retirement line, and `hermes --profile
     colmar2026 doctor` says "is applied by the session reset plugin".
  3. Send a message, wait past the idle window (or set `idle_minutes` low on a
     scratch profile), and confirm the next message starts a new conversation.

## Rollout and regression

- **The fix reaches a companion only when it is refreshed.** Re-running the
  install on an existing profile (`ALREADY_PRESENT`) is the refresh (AC-2), and
  it restarts the gateway.
  - **Mac staging companions** may be refreshed freely; Mac trips are
    pre-approved.
  - **VM companions** need, in order:
    1. A read-only probe, which needs no approval under MVP rule 2: the Hermes
       revision in the running container, and whether each companion's gateway
       log carries the same line.
    2. The image or install decision above.
    3. A refresh of each live companion. That is a deploy, so hard rule 2
       applies, and it is scheduled outside a live conversation.
- **On the first message past the boundary after the refresh**, a family's
  companion starts a fresh conversation. The site and the companion's memory
  are untouched, so answers come from the site, which is the template's
  intent. Long-running trips will see a different-feeling first reply after the
  first reset, and live organizers should be told before their companion is
  refreshed.
- **Per-PR regression plan: needed.** The change alters the behaviour of every
  live companion once it is refreshed, and adds code to the gateway's message
  path. The plan names which live trips get refreshed and when. CI-only parts
  (the AC-5 test, the fixture field) alone would be "not needed (test and
  fixture only)", but they ship together.
- **Interaction with #349 / PR #461 (gateway reconciler, open).** If the
  reconciler lands first and restarts gateways itself, the plugin must already
  be enabled in the profile. Otherwise a reconcile restart does not fix
  anything. Sequence this item first, or have the reconciler call the same
  `enable_hermes_plugins`.

## Open questions

Decisions for Dror before approval.

1. **Vendor or install from the catalog?** Vendor a reviewed copy into
   `.agents/hermes-plugins/` (recommended: reviewable, no network at install,
   history in this repo), or `hermes plugins install` from the catalog pin?
   Vendoring needs the upstream licence to allow it, which is to be checked in
   the PR.
2. **Should a missing plugin or an ignored key fail the install, or warn?**
   *Recommendation:* warn (AC-3, AC-4). Failing would stop a trip from being
   built because of a Hermes upgrade, while the companion still works, just
   with long conversations. CI (AC-5) is where it fails hard.
3. **`notify: false`.** The catalog entry lists `mode`, `idle_minutes` and
   `at_hour`, not `notify`. Does the plugin announce a reset in the chat? If it
   does, and cannot be silenced, is a visible "new conversation" line in a
   family group acceptable, or does that block adoption?
4. **Multiplexed gateway on the VM.** Is a multiplexed gateway serving several
   profiles from one process? Hermes checks `reset_plugin_enabled()` per
   process, so the plugin may need enabling where the serving process loads
   plugins, not only in each profile. This is to be read off the VM in the
   rollout probe before choosing between image and per-profile install.
5. **Who watches the `WARN` lines?** The worker logs them. Should the fleet
   monitor also raise `companion_install.warning` as an alert?
   *Recommendation:* yes, as a follow-up issue, since the monitor's MCP is a
   separate surface.
