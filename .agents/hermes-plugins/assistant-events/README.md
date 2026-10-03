# assistant_events — Hermes plugin

The assistant-side half of the outcome-event pipeline #177/#326 left
`not_measurable`: the relay can see that a reply reached Telegram, never
whether the tool behind it actually worked. This plugin runs inside a trip
companion's own Hermes process, sees every `trip-mcp` / `trip-control` tool
call's result directly, and reports a verdict — `grounded_answer`,
`failed_tool`, or `missing_data` (the tool call worked; the trip's own data
had nothing to answer with — the missing-information control loop's
detection signal, docs/sprint6-tracks.md decision 22) — plus which tool,
to the control plane's `POST /internal/assistant-events/tool-outcomes`
(`control-plane/api/src/app.ts`, `hermes-ingest.ts`), which writes it into
`control_plane.assistant_events` as `source_service: "hermes"`,
`event_type: "tool_call_completed"`.

Read `__init__.py`'s own module doc first — it explains what is sent, what
is never sent, and why the outcome is `grounded_answer` and not `answered`
(`control-plane/api/src/analytics/contract.ts` bans the literal word, for
every source, on purpose). `classify_tool_outcome`'s docstring is the
classification heuristic.

## This repo is the source of truth; `~/.hermes` is not

Same discipline `CLAUDE.md`'s "Hermes skills: capture before you deploy"
section states for skills: this directory
(`.agents/hermes-plugins/assistant-events/`) is the versioned copy. A live
Hermes installation's own `plugins/` tree has no git history of its own, so
edit here and install outward, never the other way around.

## Where this plugin is NOT auto-discovered, and why

`.agents/hermes-sync.tsv` and `scripts/install-hermes-skill.sh` both only
know how to place content **inside one profile's own directory**
(`profiles/<profile>/skills/travel/<name>` or an explicit SOUL pairing). A
Hermes *plugin*, by contrast, lives in the shared package tree —
`hermes-agent/plugins/<namespace>/<name>/` — alongside `hermes-agent`
itself, not under any one profile, and is then turned on **per profile** via
that profile's own `plugins.enabled` list (see the `langfuse` plugin,
`hermes-agent/plugins/observability/langfuse/`, for the precedent this one's
shape is copied from). Neither existing tool models that. This is reported
here rather than silently forced into `hermes-sync.tsv`'s shape — see the
handover for this task.

## Install (manual, until a provisioning step exists)

1. Copy this directory's `__init__.py` to
   `<HERMES_HOME>/hermes-agent/plugins/kinerary/assistant_events/__init__.py`
   on whichever host runs the trip's companion (the Mac today; VM 110 for
   production, per `CLAUDE.md`'s control-plane VM section).
2. Add `assistant_events` (or whatever this plugin registers itself as under
   its parent framework's naming) to that trip's **own** profile's
   `plugins.enabled` list — every trip has its own profile
   (`docs/per-trip-gateway-architecture.md`: `~/.hermes/profiles/<trip-name>`),
   so this is a per-trip step, not a one-time global one, until the
   provisioning pipeline (`companion-install-host.sh` /
   `.agents/skills/create-trip/driver.mjs`, or their private
   `kinerary-deploy` counterparts) is taught to do it automatically.
3. Set, in that profile's env (or wherever its process inherits environment
   from — the same place `HERMES_LANGFUSE_PUBLIC_KEY` reaches the `langfuse`
   plugin today):

   | Variable | Required | Meaning |
   |---|---|---|
   | `ASSISTANT_EVENTS_INGEST_URL` | yes | Full URL of the control-plane API's ingest route, e.g. `http://127.0.0.1:4310/internal/assistant-events/tool-outcomes` |
   | `ASSISTANT_EVENTS_INGEST_KEY` | yes | Must equal the control-plane API's own `ASSISTANT_EVENTS_INGEST_KEY` |
   | `ASSISTANT_EVENTS_HERMES_PROFILE` | no | Overrides the profile name this plugin reports as; see `_resolve_profile_name`'s docstring for why one might be needed |
   | `ASSISTANT_EVENTS_TIMEOUT_S` | no | POST timeout, default 3.0s |
   | `ASSISTANT_EVENTS_DEBUG` | no | `1` to log each attempt |

   Both required variables unset is the safe, inert default — see
   `_configured()`.

Neither step above was performed as part of this change: step 1 touches a
live, uncommitted Hermes installation (`~/.hermes`), and step 2's
provisioning pipeline is outside this repo's owned paths for trip-specific
deployment detail (`kinerary-deploy`, hard rule 6). Both are named in the
handover as carry-forward.

## Testing

```bash
python3 .agents/hermes-plugins/assistant-events/test_assistant_events_plugin.py -v
```

Pure-logic unit tests only (classification, config-gating, the delivery
thread never raising) — nothing here talks to a real control-plane API or a
real Hermes process; see the ingest route's own tests
(`control-plane/api/test/hermes-ingest.test.ts`) for the server side against
a real Postgres.
