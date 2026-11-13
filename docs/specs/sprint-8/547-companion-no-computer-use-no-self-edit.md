# A companion exposes no desktop, browser or connector tools; skill writes stay held

Status: draft 2026-11-12; approval at merge · Issue: #547 · Track: Sprint 8 staging-test fixes · Size: S · Decision recorded 2026-11-12 (Dror): Hermes's background skill review stays ON
Security path: yes (what a model can be talked into calling; boundary-reviewer) · Migration: no · Live-trip behaviour: yes, but only for a companion whose profile is re-rendered (see Rollout)

## Problem

Found in the Sprint 8 staging test, 2026-11-12, on the Mac staging companion of
trip `gatecity-2026-2` (log `agent.log`, 12:02–12:04 IST). The tester pasted a
Terminal command (`cd ~/kinerary-deploy && … ./setup-mcp.sh <slug>`) into the
companion's private chat by mistake. In that turn the companion:

1. called `computer_use` — it failed (`computer_use backend unavailable:
   cua-driver session setup failed`) only because the host has no driver, not
   because anything forbade it;
2. after answering, Hermes ran its **background skill review** on the same turn
   (`origin=background_review`, prompt "Review the conversation above and update
   the skill library. Be ACTIVE"). That fork called `skill_manage` on
   `familytrip-companion-operations` — refused once (`Refusing background curator
   patch … not curator-managed`) — and then called it again to create a new skill
   `mcp-tool-availability`. The second call "completed (226 chars)".

What the evidence shows (read-only look at the profile, 2026-11-12):

- **The completed `skill_manage` call changed nothing on disk.** It was *staged*:
  `pending/skills/67a1a75e.json`, `action: batch`, one `create`, `origin:
  background_review`. `skills/` holds no `mcp-tool-availability`; the profile's
  `familytrip-companion-operations/SKILL.md` has mtime 31 Oct 19:05, before the
  incident. The staging is `skills.write_approval: true` (#314) doing its job.
- **The tool surface is the real finding.** Resolving the rendered overlay
  through Hermes's own resolver (before `check_fn` filtering) gives **38 tools**
  for `telegram` and `cron`, including `computer_use`, all 18 `browser_*` tools
  (navigate, click, type, `browser_cdp`, and the password-vault tools),
  `manage_connections`, `write_file`, `patch` and `skill_manage`. The overlay
  disabled only `terminal` and `code_execution`. `computer_use` and `browser`
  ride in the `hermes-telegram` bundle. They are inert on a host with no driver
  or browser, and live on one with.

A companion's context is full of text travellers typed; acting on pasted shell text
is the injection shape the companion/monitor split exists to contain.

## Decision (Dror, 2026-11-12)

The companion is meant to evolve through the trip, so **Hermes's background skill
review stays on.** The first draft of this spec switched it off
(`skills.creation_nudge_interval: 0`, `auxiliary.background_review.enabled: false`);
those two keys are not in the template, and there is no test for them.

State it plainly, because it is the trade being made:

- **The review drafts skills from conversation text**, and conversation text is what
  travellers typed (and what documents and web pages they pasted or had fetched).
- **`skills.write_approval: true` is the only barrier** between those drafts and the
  companion's own skills. Each draft is staged under `<profile>/pending/skills/` and
  nothing applies it. If the hold is lifted, a traveller's words can become a standing
  instruction in the companion's skills. A known gap in this barrier is tracked
  privately; it is not described here.
- **The same review also drafts memory, and that is not held.** The review's toolset is
  `memory` and `skills`; `memory.write_approval` is not set in the overlay and Hermes
  defaults it to off, so the review's memory writes apply. This change does not alter
  that: memory is a tool the companion keeps on purpose, and the question of holding its
  review writes is left open for a decision.
- Whether the hold on skills stays or becomes automatic apply is a separate decision
  Dror has not made. `write_approval` is left exactly as it was.

## Acceptance criteria

- **AC-1.** A companion profile rendered from `profile-templates/familytrip-companion`
  resolves to no `computer_use`, no `browser_*` and no `manage_connections` tool, on
  `telegram` and `cron`. It still resolves `skill_view`, `read_file`, `web_search` and
  `memory` (the tools it is used for).
- **AC-2.** The rendered overlay's `agent.disabled_toolsets` lists `computer_use`,
  `browser` and `connections` as well as `terminal` and `code_execution`, and does not
  list `file`, `memory`, `cronjob`, `skills` or `web`.
- **AC-3.** `skills.write_approval` stays `true`, unchanged, and the review is not
  switched off. The template says beside the key that the review is on by decision, that
  it drafts from conversation text, that the key is the only barrier to skill edits, and
  that a known gap in it is tracked privately.
- **AC-4.** A pasted shell command is answered as text. This follows from AC-1 (no tool
  to run it with) and the existing `terminal`/`code_execution` removal; no SOUL change is
  needed. Not separately asserted — see Test plan.

## Non-goals

- Removing `skill_manage` from the tool list. Not possible from config: it shares the
  `skills` toolset with `skill_view`, which the companion reads its skills through
  (about 36 production calls). `disabled_toolsets` and `platform_toolsets` take toolset
  names only (an unknown name is "Unknown toolset" in `_apply_toolset_selection`), so
  disabling `skills` would break every companion to remove a tool whose writes are
  already staged. Rejected.
- Switching the skill review off, or changing `write_approval` or `memory.write_approval`
  (Decision above).
- Existing companions. `merge_overlay` never overwrites a top-level key the profile
  already has, and the `ALREADY_PRESENT` path merges the overlay file already in the
  profile, so this reaches new companions only. See Rollout.
- The curator (`curator.enabled`, a weekly archive pass over agent-created skills). It is
  not a conversation, and it refused the user-owned skill in this very incident
  (`created_by=None`).
- `write_file` / `patch` (confined by `HERMES_WRITE_SAFE_ROOT`, #314) and `image_generate`.
  Other findings from the boundary review are separate work and are not fixed here.

## Decisions

- **Deny `browser`, not just `computer_use`.** The brief names "other desktop/browser
  control". The companion has never called a `browser_*` tool; it reads the web through
  `web`. Rejected: leaving `browser` for later — it holds a CDP escape hatch and a
  password-vault unlock.
- **Deny `connections` too** (boundary review). `manage_connections` can authorise and
  install a connector; if connectors ever become available on a host, it could add an MCP
  server with no approval card, in a chat anyone in the family can type into. Companions
  do not use it.
- **Leave the skill review on, and `write_approval` as is.** Dror, 2026-11-12 (see
  Decision). Rejected, in this spec's first draft: switching the review off with
  `skills.creation_nudge_interval: 0` and `auxiliary.background_review.enabled: false`.
- **No installer change.** The renderer and `companion-install-host.sh` already carry
  the overlay; the change is in the overlay. Changing `merge_overlay` to deep-merge
  deny lists for existing profiles is a separate, riskier decision (it overrides a
  profile's own choice) and is left to a decision.

## Security notes

- The toolset change removes capability and adds none. The deny list is read by Hermes at
  tool resolution and applied last, at tool granularity (`model_tools._select_tool_names`).
- **Accepted exposure, by decision:** the background review reads conversation text and
  proposes skill and memory edits from it. For skills, the only control is
  `skills.write_approval: true`, which stages rather than applies. Nothing else in the
  profile confines `skill_manage`: it is not covered by `HERMES_WRITE_SAFE_ROOT` (it
  writes through `atomic_write_text`). The gate also fails open if Hermes's
  `tools.write_approval` module cannot be imported. Lifting the gate is therefore a
  security-relevant change and needs boundary review of its own.
- Staged proposals accumulate in `pending/skills/` until someone approves or discards
  them; nothing reads that directory today.
- Not proven: that `computer_use`'s `check_fn` ever passes on a VM (it does not resolve
  there today). On a Mac host with `cua-driver` it passes, which is the case this closes.

## Test plan

`profile-templates/familytrip-companion/tests/test_template.py`:

- `test_rendered_overlay_exposes_no_desktop_or_browser_control` — AC-2 on the rendered overlay.
- `test_rendered_overlay_resolves_to_no_desktop_browser_or_connector_tool_in_hermes` — AC-1 against
  Hermes's real resolver. Skipped when no Hermes venv exists (CI). Failed before the
  change: 38 tools including `computer_use`, 18 `browser_*` and `manage_connections`.
- `test_rendered_overlay_gates_skill_manage_writes` — AC-3: `write_approval` is `true`, and
  nothing the companion reads through was disabled.
- The first draft's tests for the two review switches were deleted with the switches.

`control-plane/worker/tests/test_companion_profile.py::test_skill_manage_writes_are_staged_and_toolsets_are_unchanged`
— the same template, exact deny list.

AC-4 is not asserted end to end: it needs a live model turn. It was the observed behaviour
that the tool surface above caused; the surface is what is asserted.

## Rollout

Companion templates reach a companion only when its profile is re-rendered or newly
installed. The installer does NOT update an existing companion: `merge_overlay` keeps any
top-level key the profile already has, and the `ALREADY_PRESENT` path merges the overlay
file already in the profile, so re-running it changes nothing here.

Existing companions that need the edit by hand:

- Mac: `alsacefrance2027`, `bakuazerbaijan2026`, `banskobulgaria2026`, `colmar2026`,
  `colmar20262`, `gatecity20262`, `italy2027`, `japan2027`.
- VM: to be listed at release, from the VM's profiles.

The edit, in each profile's `config.yaml`, under `agent.disabled_toolsets` (keep the two
entries already there):

```yaml
agent:
  disabled_toolsets:
    - terminal
    - code_execution
    - computer_use
    - browser
    - connections
```

Then restart that profile's gateway. Nothing else changes: `skills.write_approval` stays
`true`, and the skill review stays on.
