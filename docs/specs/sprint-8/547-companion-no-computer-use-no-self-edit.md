# A companion exposes no desktop or browser control and cannot start its own skill edits

Status: draft 2026-11-12; approval at merge · Issue: #547 · Track: Sprint 8 staging-test fixes · Size: S–M
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
  (navigate, click, type, `browser_cdp`, and the password-vault tools), `write_file`,
  `patch` and `skill_manage`. The overlay disabled only `terminal` and
  `code_execution`. `computer_use` and `browser` ride in the `hermes-telegram`
  bundle. They are inert on a host with no driver or browser, and live on one with.
- **The skill-writing fork is automatic.** Hermes starts it after turns on its own
  (`skills.creation_nudge_interval`, default 10, and `auxiliary.background_review`,
  default enabled). A traveller's text does not have to ask for it.

A companion's context is full of text travellers typed; acting on pasted shell text
is the injection shape the companion/monitor split exists to contain.

## Acceptance criteria

- **AC-1.** A companion profile rendered from `profile-templates/familytrip-companion`
  resolves to no `computer_use` and no `browser_*` tool, on `telegram` and `cron`.
  It still resolves `skill_view`, `read_file`, `web_search`, `web_extract` and
  `memory` (the tools it is used for).
- **AC-2.** The rendered overlay's `agent.disabled_toolsets` lists `computer_use`
  and `browser` as well as `terminal` and `code_execution`, and does not list
  `file`, `memory`, `cronjob`, `skills` or `web`.
- **AC-3.** A conversation cannot apply a change to the companion's skills:
  `skills.write_approval` stays `true` (writes are staged, never applied), and
  Hermes's automatic skill review does not run: `skills.creation_nudge_interval`
  is the integer `0`, and `auxiliary.background_review.enabled` is the boolean
  `false`.
- **AC-4.** The template says why, beside each key, including why `skill_manage`
  is not simply removed (see Decisions).
- **AC-5.** A pasted shell command is answered as text. This follows from AC-1
  (no tool to run it with) and the existing `terminal`/`code_execution` removal;
  no SOUL change is needed. Not separately asserted — see Test plan.

## Non-goals

- Removing `skill_manage` from the tool list. Not possible from config (below).
- Existing companions. `merge_overlay` never overwrites a top-level key the profile
  already has, and the `ALREADY_PRESENT` path merges the overlay file already in the
  profile, so this reaches new companions only. See Rollout.
- The curator (`curator.enabled`, a weekly archive pass over agent-created skills).
  It is not a conversation, and it refused the user-owned skill in this very
  incident (`created_by=None`).
- `write_file` / `patch` (confined by `HERMES_WRITE_SAFE_ROOT`, #314), `manage_connections`,
  `image_generate`, and the memory review (`memory.nudge_interval`) — the memory tool
  stays and is not what this incident touched.
- The Hermes mirror fixture (#380, `control-plane/api`): `skills.creation_nudge_interval`
  is not in Hermes's config defaults, so the fixture cannot guard it. This spec's
  Hermes-gated test does (below).

## Decisions

- **`skill_manage` is contained, not removed.** It lives in the `skills` toolset
  with `skill_view` and `skills_list`. `disabled_toolsets` subtracts whole toolsets
  (proved again 2026-11-12 against Hermes `4097709b0c`: `platform_toolsets` and
  `disabled_toolsets` accept toolset names only, `resolve_toolset` has no per-tool
  form), and the companion reads its skills through `skill_view` (36 calls in
  production, the largest non-trip tool after web search). Disabling `skills` would
  break every companion to remove a tool whose writes are already staged. Rejected.
- **Switch the review off instead of relying on the gate alone.** The gate stages
  the write; it does not stop the review fork from spending a model call on every
  nth turn proposing one, and a proposal queue nobody reads is a slow leak of
  traveller-derived text into a file. `creation_nudge_interval: 0` stops the counter
  that starts it; `auxiliary.background_review.enabled: false` stops the spawn.
  Both, because the second is read fail-open (anything but a real boolean leaves it
  on) and the first is not in Hermes's defaults.
- **Deny `browser`, not just `computer_use`.** The brief names "other desktop/browser
  control". The companion has never called a `browser_*` tool; it reads the web through
  `web`. Rejected: leaving `browser` for later — it holds a CDP escape hatch and a
  password-vault unlock.
- **No installer change.** The renderer and `companion-install-host.sh` already carry
  the overlay; the change is in the overlay. Changing `merge_overlay` to deep-merge
  deny lists for existing profiles is a separate, riskier decision (it overrides a
  profile's own choice) and is left to a decision.

## Security notes

- This removes capability; it adds none. The deny list is read by Hermes at tool
  resolution and applied last, at tool granularity (`model_tools._select_tool_names`).
- The failure mode to watch is **silent**: `background_review.enabled` fails open and
  `creation_nudge_interval` is an undocumented key. A Hermes upgrade that renames
  either leaves the review running with no sign. `test_hermes_still_reads_the_two_switches_that_stop_the_skill_review`
  (skipped where no Hermes is installed, such as CI) reads both back through Hermes's
  own config loader and checks the readers are still in its source.
- `skill_manage` stays resolvable. Anything that reaches it is staged by the gate
  (`pending/skills/`), not applied. The gate is `skills.write_approval: true`, asserted
  in `test_rendered_overlay_gates_skill_manage_writes` and the worker's template test.
- Not proven: that `computer_use`'s `check_fn` ever passes on a VM (it does not resolve
  there today). On a Mac host with `cua-driver` it passes, which is the case this closes.

## Test plan

`profile-templates/familytrip-companion/tests/test_template.py`:

- `test_rendered_overlay_exposes_no_desktop_browser_or_self_edit_path` — AC-2, AC-3 on the
  rendered overlay (types asserted: `0` not `False`, boolean `False` not `"off"`).
- `test_rendered_overlay_resolves_to_no_computer_or_browser_tool_in_hermes` — AC-1 against
  Hermes's real resolver. Skipped when no Hermes venv exists (CI). Failed before the
  change: 38 tools including `computer_use` and 18 `browser_*`.
- `test_hermes_still_reads_the_two_switches_that_stop_the_skill_review` — AC-3 read back
  through Hermes's loader.
- `test_rendered_overlay_gates_skill_manage_writes` — the gate, and that nothing the
  companion reads through was disabled.

`control-plane/worker/tests/test_companion_profile.py::test_skill_manage_writes_are_staged_and_toolsets_are_unchanged`
— the same template, exact deny list.

AC-5 is not asserted end to end: it needs a live model turn. It was the observed behaviour
that the tool surface above caused; the surface is what is asserted.

## Rollout (the second clock)

Companion templates reach a companion only when its profile is re-rendered or
newly installed. Existing companions keep their `config.yaml` and need an operator's
config edit (add `computer_use` and `browser` to `agent.disabled_toolsets`, set the
two review switches), or a re-render with a deliberate merge. On the Mac that is every
profile under `~/.hermes/profiles` rendered from this template before this change;
`gatecity20262` included (it has the gate, not the switches). On the VM, every live
companion.
