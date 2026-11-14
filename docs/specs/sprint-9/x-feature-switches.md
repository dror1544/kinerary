# Per-trip feature switches

Status: draft (2026-11-14) · Issue: none yet · Track: delivery · Size: L (three slices) · Tier: High
Security path: yes (`shared/config-visibility.js`, `server/server.js`, an admin route) · Migration: yes · Live-trip behaviour: no, until a switch is turned on

Decision behind it: `CLAUDE.md`, "Faster delivery (owner's decision, 2026-11-14)", item 1;
`docs/agent-team-plan.md` §9, decision 12.

## Problem

A feature reaches a trip only by deploying code to it, so "who gets it" is decided by
who was redeployed. There is no way to give a feature to one trip, to every trip, or
only to trips created from now on.

- No switch mechanism exists. The things that behave like switches are each their own
  shape: environment variables on the site (`server/server.js:849-856`), a closed set
  in the trip's config (`shared/agent-schema.js:29-35`, `PROACTIVE_KEYS`), one
  hand-set column (`trips.companion_reply_capture_enabled`, migration `0053`, which no
  code writes), and a per-group level (`telegram_chat_bindings.proactive_level`).
- The site reads `trip.config.json` once at boot (`server/server.js:179-185`) and
  nothing reloads it, so a value in that file changes only with a restart.
- The control plane is the only place that knows every trip, and the relay already
  reads it on every message (`control-plane/api/src/relay/chat-router.ts:377-423`).

## Behaviour

- A feature is written behind a named switch. The name is declared once, in a closed
  registry, with one line saying what it turns on. A feature whose code is on a trip
  and whose switch is off behaves exactly as if the code were absent.
- An operator sets a switch at one of three scopes:
  - **one trip**: on or off for that trip;
  - **every trip**: on or off for all trips, present and future;
  - **future trips**: on for trips created after the moment it is set.
- The value for a trip is resolved in this order: the trip's own setting, then the
  every-trip setting, then the future-trips setting if the trip was created after it,
  then **off**.
- Off is the answer whenever anything is uncertain: a name the registry does not
  hold, a stored value that is not a boolean, a failed read, a missing table.
- Every change is recorded: which switch, which scope, old and new value, who, when.
- The operator can list every switch with its value for a trip, and for each one
  where the value came from (trip, every trip, future trips, default).

Slices, each useful alone:

1. **S1: the store, the operator command, the relay.** A switch is live for
   relay-side features (interview, group handling) the moment it is set.
2. **S2: the site.** The worker writes the resolved switches into the trip when it
   provisions or rolls out, and the site serves them to its pages. A change reaches a
   running site at the next rollout (see the trip-rollout spec).
3. **S3: the site, live.** The control plane pushes a change to a running site, and
   open pages pick it up without a reload. Where a trip cannot be pushed to, the
   operator command says the change is waiting for a rollout.

## Acceptance criteria

S1

- AC-1 Given a switch name that is not in the registry, when it is resolved for any
  trip, then the answer is off, and when an operator tries to set it, the command
  refuses and names the registry file.
- AC-2 Given no stored row for a registered switch, when it is resolved for any trip,
  then the answer is off.
- AC-3 Given a switch set on for trip A only, when it is resolved for trip A and for
  trip B, then A is on and B is off.
- AC-4 Given a switch set on for every trip and off for trip A, when it is resolved,
  then A is off and every other trip is on.
- AC-5 Given a switch set on for future trips at time T, when it is resolved for a
  trip created before T and one created after T, then the first is off and the second
  is on.
- AC-6 Given the resolver's database read fails, when the relay asks for a switch,
  then the relay takes the off branch and logs `feature_switch.read_failed` with the
  switch name and no trip data.
- AC-7 Given any successful set, when the history table is read, then it holds one new
  row with switch, scope, trip id or null, old value, new value, a `sha256:` digest of
  the actor and a timestamp, written in the same transaction as the change.
- AC-8 Given a trip past `ready_private`, when an operator sets a trip-scoped switch
  without `--live`, then the command refuses and says the trip is in use. Given
  `--all` or `--new-trips`, the same refusal applies without `--live`.
- AC-9 Given a set command carrying `--live`, when Claude Code runs it, then the
  pre-tool hook asks under hard rule 2 and its text names the switch, the scope and
  the trips. Given a set command for a test trip without `--live`, then the hook is
  silent.
- AC-10 Given `show --trip <slug>`, then every registered switch is listed with its
  resolved value and the source of that value.

S2

- AC-11 Given a provision or a rollout of a trip, when the worker writes the trip's
  files, then a `features` block holds exactly the registered switches that are on
  for that trip, each as the literal `true`, and nothing else.
- AC-12 Given a signed-in member, when they request `GET /api/config`, then
  `features` contains only switches the registry marks as visible to members, and
  only those whose value is the literal `true`.
- AC-13 Given a `features` block in the trip's files that carries an unregistered
  name or a value other than `true`, when the site boots, then that entry is not
  served, and the boot log names it once.
- AC-14 Given the Modern site, when `features.<name>` is absent, then the feature's
  entry points do not render. The parity schema accepts the `features` key.

S3

- AC-15 Given a running site with a control-plane identity, when an operator sets a
  switch for its trip, then within 60 seconds `GET /api/config` on that site reflects
  it without a restart, and an open Modern page reflects it without a reload.
- AC-16 Given a push whose trip id is not the site's own, then the site answers
  `TRIP_MISMATCH` and changes nothing.
- AC-17 Given a trip that cannot be pushed to, when an operator sets a site-surface
  switch for it, then the command prints that the change waits for a rollout, and
  `show` marks the switch as pending for that trip.

## Contracts

**Registry: `shared/feature-switches.js`** (new). A frozen list; each entry has
`name` (`^[a-z][a-z0-9_]{2,40}$`), `summary`, `surfaces` (any of `relay`, `site`,
`companion`) and `memberVisible` (boolean, default false). It ships with one entry,
`delivery_probe` (surface `site`, member-visible), which renders nothing and exists so
that S2 and S3 can be proved end to end on staging.

**Migration: `<timestamp>_feature_switches.sql`**, header
`-- rollback: compatible — new tables and one function only`.

- `control_plane.feature_switch_settings (switch text, scope text CHECK (scope IN
  ('trip','all_trips','new_trips')), trip_id uuid NULL REFERENCES trips, enabled
  boolean NOT NULL, effective_from timestamptz NOT NULL DEFAULT now(), changed_by
  text NOT NULL, changed_at timestamptz NOT NULL DEFAULT now())`, with a CHECK on the
  switch-name shape, `trip_id` required exactly when scope is `trip`, and one row per
  (switch, scope, trip).
- `control_plane.feature_switch_history`, append-only, the AC-7 columns.
- `control_plane.feature_enabled(trip uuid, switch text) RETURNS boolean`, the
  resolution order above, returning false when no row applies.
- Modelled on `model_task_settings` (`20260918110131_model_task_settings.sql`).

**Control plane API (`control-plane/api/src/`)**

- `feature-switches.ts` (new): `featureEnabled(db, tripId, name)` checks the registry
  first, then calls the SQL function, and returns false on any error;
  `setFeatureSwitch(...)` and `describeFeatureSwitches(db, tripId)`.
- Admin routes behind the existing `adminAuth` (`app.ts`):
  `GET /v1/admin/feature-switches?trip=<id>` and `POST /v1/admin/feature-switches`.
  No organizer route, no companion tool.
- `feature-cli.ts`, `npm run feature -- list | show --trip <slug> | set <switch>
  on|off (--trip <slug> | --all | --new-trips) [--live] [--by <name>]`.

**Relay**: features call `featureEnabled`; no new wire field.

**Worker** (`control-plane/worker/control_plane_worker/provisioner.py`,
`transformer.py`): writes `features` into `trip.config.json` from
`describeFeatureSwitches` at provision and rollout (S2).

**Site** (S2): `shared/config-visibility.js` gains a `features` node built from the
registry (closed set, literal `true` only, member-visible entries only);
`trip-web/src/parity-schema.ts` accepts it; `site/app.js` and `trip-web` read
`cfg.features.<name>`. Server-side code gates with one helper,
`featureOn(name)`, never by reading the raw config.

**Site, live** (S3): `POST /api/internal/control-plane/features` behind the existing
`internal()` middleware (`server/control-plane-auth.js:121-146`), relayed by the
runtime gateway the way the participant routes are
(`control-plane/runtime-gateway/server.js:218-258`); state kept in the site's SQLite
and overlaid on the boot value; an SSE event so `trip-web/src/live-updates.ts`
refetches `config`.

**Hooks** (`scripts/claude-hooks/match-command.py`, `pretooluse-bash.sh`): a
`feature … set … --live` command classifies as a deploy; without `--live` it is
silent. Tests in `tests/scripts/test_match_command.py`.

## Non-goals

- Pinning a trip to a version, channels and cohorts, organizer spin-offs
  (`docs/future/release-channels-and-organizer-spinoffs.md`, #190). A switch selects
  behaviour inside one version; it does not select a version.
- Percentage rollouts and A/B assignment.
- An organizer-facing way to set a switch.
- Telling the companion's model which switches are on. A companion feature is gated
  where its code runs: the site route, or tool registration in `trip-mcp`
  (`server/trip-mcp/tools.js:150-151`). A read-only `get_features` tool on
  `trip-control` is a later decision.
- Migrating the existing ad hoc switches (`companion_reply_capture_enabled`,
  `agent.proactive`, `proactive_level`).
- Removing a switch once its feature is on everywhere. That is a follow-up rule: a
  switch that has been on for every trip for 30 days is deleted with its off branch.

## Security and boundary notes

- **`sanitizeConfig()` stays an allow-list.** `features` is a named node with a closed
  set of keys taken from the registry, never a pass-through map: a map would serve
  the names of unreleased features to every signed-in child. A switch is served to
  members only when the registry says `memberVisible`.
- **Fail safe.** Every uncertain case is off (AC-1, AC-2, AC-6, AC-13). The one
  existing per-trip boolean defaults to on (`0053`), so it is not the template.
- **A switch never widens visibility or permission.** It may enable a code path; it
  may not change the allow-list, `normalizeVisibility`, or which auth middleware a
  route uses. A feature that needs a new field visible gets that field decided in
  `shared/config-visibility.js` on its own.
- **Trip scope comes from the authenticated context**, never from an argument the
  caller controls: the admin key for the operator route, the site's own identity for
  the push (AC-16).
- **Who may write:** the operator only. On a trip in use a switch is a deploy under
  hard rule 2 (`CLAUDE.md`, "Faster delivery").
- Boundary review is required, with the actual `GET /api/config` responses for a
  member and for the agent key, with a switch off, on, and carrying an unregistered
  name.

## Test plan

Written first, from the criteria.

- `control-plane/api/test/feature-switches.test.ts`: AC-1 to AC-8, AC-10, against a
  `cptest_*` database.
- `control-plane/api/test/relay-feature-switch.test.ts`: AC-6 with a failing database.
- `tests/scripts/test_match_command.py`, `test_claude_hooks_bash.py`: AC-9.
- `control-plane/worker/tests/test_feature_block.py`: AC-11.
- `tests/` (trip-site suite): AC-12, AC-13, including the member and agent-key
  responses the boundary review needs. `trip-web` unit test for AC-14.
- S3: `tests/` for AC-15 and AC-16; `control-plane/api` for AC-17.
- Staging check, by hand, once per slice: set `delivery_probe` for one staging trip
  and read it back at each surface.

## Rollout and regression

- S1 carries a migration: a regression plan is needed (risk class). It adds tables
  and a function and changes no existing row; no live trip feels it.
- S2 and S3 touch `server/server.js` and `shared/`: boundary review, and a rollout of
  each trip before the site half works there. With every switch off a rolled-out
  trip shows no difference.
- Order: S1, then S2 together with the trip-rollout spec's first slice, then S3.

## Open questions

1. **Member-visible by default?** Proposed: no. A switch is served to members only
   when its registry entry says so.
2. **S3 or not.** Without S3 a site switch changes at the next rollout, which the
   rollout command makes one step. Proposed: build S1 and S2 first, and decide S3
   after the first two features have shipped behind switches.
3. **Which trips have a control-plane identity** (needed for S3's push)? To be read
   from the fleet before S3 is briefed.
4. **The 30-day removal rule** in Non-goals: adopt it now, or leave switches in place?
