# Fleet health: production watches itself

Status: draft (2026-10-21) · Issue: #468 · Track: T4 · Size: L (five slices) · Tier: High
Security path: yes (a new authenticated operator route; alert text built from trip data) · Migration: yes · Live-trip behaviour: no (operator-facing only)

## Problem

Production monitoring is a Hermes profile (`trip-monitor`) on a machine outside
production. A cron runs `.agents/skills/trip-fleet-monitor/fleet-mcp.mjs`, which
evaluates about a dozen alert rules (`loadAlerts`, `alertSections`: unreachable,
reachability check stale, built without an organizer chat, failed jobs,
verification failed, companion bridge check failed, awaiting organizer approval,
confirmed but never built, interview waiting on us, model failing mid-interview,
undelivered notifications, reported by a companion). Each rule is SQL run over
its own SSH session against the control-plane database, through a read-only role
(`control-plane/deployment/monitor-db-role.sql`).

Observed on 2026-10-19/20 (#468):

1. **Fragile transport.** Eleven or twelve concurrent `ssh … psql` sessions
   exceeded the VM's sshd `MaxStartups`. One reset handshake failed the whole
   run, about once an hour. #453 caps concurrency as a stopgap; the
   shape is unchanged.
2. **A model in the alert path.** Delivery and failure notices go through the
   Hermes cron runner. The operator was told "the AI model service did not
   respond" for what was an SSH reset.
3. **Wrong place.** The monitor runs where production is not. When that machine
   sleeps or reboots, nothing is watched, and nothing says so.
4. **Rules live outside the system they judge.** They are SQL strings in a skill
   file. They are tested against a fake psql only, and every stack needs a
   matching read-only role, SSH key and config entry.

## Behaviour

When this is done:

- The control plane evaluates its own health rules on a fixed interval, in
  process, against its own database. It needs no SSH, no second database role
  and no model.
- Each finding is an **alert** with a stable fingerprint. It opens when the
  condition first holds and resolves when it stops holding. A condition that
  persists is one alert, not one per run.
- The operator receives a short, deterministic Telegram message when an alert
  opens, when it resolves, and as a reminder at most once per reminder interval
  while it stays open. Messages are batched per run and respect quiet hours
  (critical alerts excepted).
- `GET /internal/operator/fleet/health` (operator key) returns the latest
  evaluation: when it ran, the open alerts, and per-trip status counts. It
  contains no traveller text.
- The Hermes monitor reads that one endpoint (one HTTPS call) for the digest and
  for triage. If the monitor is down, alerts still arrive.
- Every evaluation run pings an external heartbeat URL. If the pings stop
  (the control plane is down, the scheduler is wedged, or the host is off), the
  heartbeat service alerts the operator from outside.
- Staging runs the same checker against its own stack, so the nightly exercises
  it.

## Acceptance criteria

- **AC-1 Rule parity.** Given a database seeded with one positive and one negative
  fixture per rule that `loadAlerts` implements today, an evaluation opens
  exactly the positive fixtures' alerts. A table in the test maps each old
  section title to its new rule id.
- **AC-2 Open/resolve by state.** A condition that holds across three
  consecutive runs produces one `open` alert, with `first_seen` from run 1 and
  `last_seen` from run 3. When the condition clears, the next run sets
  `resolved_at`, and exactly one resolve notification is enqueued.
- **AC-3 Fingerprint stability.** The fingerprint is derived from the rule id
  and the subject id (trip id, job id, report id), never from text or
  timestamps. Re-running an evaluation with no state change writes no row and
  enqueues no notification.
- **AC-4 No model, no SSH.** The checker and the delivery path import nothing
  from the model runner and spawn no process. A test asserts the module graph
  (or a spawn spy) for this.
- **AC-5 Delivery through the outbox.** Open, resolve and reminder messages are
  rows in the existing notification outbox, sent by the existing dispatcher
  (`control-plane/api/src/outbox-dispatcher.ts`), to the operator chat named by
  config (`OPERATOR_ALERT_CHAT_ID`). If that is unset, the checker still runs,
  records alerts and logs one boot warning. It fails loud, not silent.
- **AC-6 Batching and quiet hours.** One run that opens three alerts enqueues one
  message listing them. During quiet hours (`OPERATOR_ALERT_QUIET_HOURS`, local
  time range), only alerts of severity `critical` are sent immediately. The rest
  are held and sent in one message when quiet hours end.
- **AC-7 Reminder cap.** An open alert is reminded at most once per
  `OPERATOR_ALERT_REMIND_HOURS` (default 12). Resolving and then re-opening
  starts a new alert with a new id and the same fingerprint.
- **AC-8 Health endpoint.** `GET /internal/operator/fleet/health`:
  - without the operator key: 401;
  - with it: 200 and `{evaluated_at, run_id, open_alerts:[{id, rule, severity, subject:{kind, id, slug}, first_seen, last_seen}], counts:{…}}`.
  - Every value is from an allow-list of columns. Free-text columns (bug report
    quotes, error messages) are never included, only their ids. It is unmounted
    when the operator key is unset, exactly as the invitation routes are.
- **AC-9 Heartbeat.** Each completed run makes one GET to `HEALTH_HEARTBEAT_URL`
  with a 5s timeout. A failed ping is logged and never fails the run. A run that
  throws pings `…/fail` if the provider supports it, otherwise nothing.
- **AC-10 Stale-evaluation self-alert.** If the previous run is older than three
  intervals when a run starts (the process was down), the run opens a
  `checker.gap` alert with the gap's start and end.
- **AC-11 Thin MCP client.** `fleet-mcp.mjs`'s `alerts` and digest tools read the
  endpoint over HTTPS, with one request per call. The SQL-over-SSH path for those
  tools is removed. The read-only DB role stays only for the remaining ad-hoc
  read tools, which slice 5 decides about.
- **AC-12 Staging parity.** The nightly's stack preflight asserts the checker ran
  at least once after deploy (`evaluated_at` newer than the deploy).

## Contracts

- **Migration** `YYYYMMDDHHMMSS_fleet_health_alerts.sql`, header `-- rollback: compatible — new tables only; nothing reads them on an older release`:
  - `control_plane.health_runs(id, started_at, finished_at, ok, error_code)`.
  - `control_plane.health_alerts(id, fingerprint, rule, severity, subject_kind, subject_id, first_seen, last_seen, resolved_at, last_notified_at)`, with a unique partial index on `fingerprint WHERE resolved_at IS NULL`.
- **Rules** are a typed table in `control-plane/api/src/health/rules.ts`: id, severity, a SQL query returning `(subject_kind, subject_id)`, and an operator-facing title per language. They are pure, tested in `test/health-rules-db.test.ts`.
- **Checker:** `control-plane/api/src/health/checker.ts`. The interval comes from `HEALTH_CHECK_INTERVAL_SECONDS` (default 300). It runs in the API process under an advisory lock, so only one replica evaluates.
- **Delivery:** `control-plane/api/src/health/notify.ts` writes outbox rows of a new kind `operator_alert`.
- **Route:** `GET /internal/operator/fleet/health` in `app.ts`, next to the invitation routes, behind `operatorAuth`. Slice 3 switches both operator and admin checks to `timingSafeEqual` (#277).
- **Config,** all optional and unset by default: `OPERATOR_ALERT_CHAT_ID`, `OPERATOR_ALERT_QUIET_HOURS`, `OPERATOR_ALERT_REMIND_HOURS`, `HEALTH_CHECK_INTERVAL_SECONDS`, `HEALTH_HEARTBEAT_URL`. Real values live in `kinerary-deploy`.
- **MCP:** `.agents/skills/trip-fleet-monitor/fleet-mcp.mjs` gains a `health_url` per stack plus an operator-key file reference. It reads the endpoint with `fetch` and drops the `alerts` SQL.

## Slices (in order; each is its own PR with its own tests)

1. **Rules and checker** (M): the migration, `rules.ts` ported from `loadAlerts` with AC-1 parity, `checker.ts`, AC-2/3/4/10. No delivery yet; alerts are visible only in the database and logs.
2. **Delivery** (M): `notify.ts`, outbox kind, batching, quiet hours, reminders. AC-5/6/7.
3. **Endpoint** (S): AC-8, with `timingSafeEqual` for the operator and admin keys. Boundary review.
4. **Heartbeat** (S): AC-9, plus the runbook entry for creating the external check.
5. **Retire the SSH path** (S–M): AC-11 and AC-12. The Hermes monitor's crons switch to the endpoint. Decide which ad-hoc read tools still need SQL; for those, keep the read-only role and #453's limiter. Close #295, #370 and #291 as superseded where they are.

## Non-goals

- Metrics, dashboards or time series (Prometheus and the like). This is alerting
  on discrete conditions.
- Trip-site usage and access health (#106). It can later add rules here, but it
  needs its own privacy design.
- Auto-remediation. Restarting gateways is #349 or #187, and the owner's decision.
- Changing what the Hermes monitor does with companion bug reports (#125's
  path). It keeps reading them; only how it learns of them changes.

## Security and boundary notes

- **The operator route is an authenticated surface.** Unmounted without the key;
  constant-time compare; allow-listed output; no traveller free text. The blanket
  rule behind `sanitizeConfig` applies in spirit: only named fields leave.
- **Alert messages are built from rule ids, titles and slugs only.** No bug-report
  quote and no error text goes into a Telegram message. This keeps the
  `foldSql` lesson (traveller text forging rows) out of the new path entirely.
- **Delivery goes to one operator chat.** The checker can never message a
  family group or an organizer.
- **The heartbeat URL is a capability.** It lives in config (`kinerary-deploy`),
  never in the repo or in logs.

## Test plan

- `control-plane/api`: `health-rules-db.test.ts` (AC-1, per rule),
  `health-checker-db.test.ts` (AC-2/3/10, with an injected clock),
  `health-notify-db.test.ts` (AC-5/6/7), `health-endpoint.test.ts` (AC-8 auth
  matrix and allow-list), `health-isolation.test.ts` (AC-4). All are DB-backed
  through `testPool()`.
- `tests/scripts/test_fleet_mcp.py`: the thin-client tools against a stub HTTPS
  endpoint (AC-11).
- Nightly: the AC-12 assertion in the stack preflight.
- Manual, once per slice that reaches staging: force one condition (for example
  a failed job row on staging) and watch the open message, then the resolve
  message.

## Rollout and regression

The change is operator-facing only; no traveller or organizer sees anything
different. Slices 1–4 are additive and can ship with any release. Slice 5
changes the monitor's crons, which is a Hermes profile install and an approved
step. The VM gets this only as part of a complete sprint release (the MVP VM
upgrade gate of 2026-10-03). Each slice needs a regression assessment for the
migration (slice 1) and the auth route (slice 3); slices 2, 4 and 5 are recorded
as "assessment: not needed (operator-only)" unless the review says otherwise.

## Open questions

1. **Alert channel:** the operator's private chat through the main bot (as the
   outbox does today for signup approvals), or a separate monitoring bot?
2. **Heartbeat watcher:** an external uptime service (needs an account and a URL
   in `kinerary-deploy`) or the Mac (already there, but it sleeps)?
3. **Severity:** which of today's rules are `critical`, sent during quiet hours?
   Proposed: unreachable live trip, failed provisioning job on a real trip, model
   failing mid-interview, checker gap.
4. **Quiet hours:** default range, for example 23:00–07:00 local?
5. **Sprint:** confirm this is Sprint 8, and whether slice 1 may start in Sprint 7
   if capacity allows.
