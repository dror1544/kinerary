-- rollback: compatible — two new tables and their indexes; nothing existing changes shape, and the prior version neither reads nor writes either of them

-- Which companion gateways SHOULD be running, what the control plane saw, and
-- what it did about the difference (#349, docs: "Which gateways run is the
-- control plane's decision").
--
-- WHY THE CONTROL PLANE. A Hermes host starts its gateways from whatever each
-- profile last recorded (`hermes -p <profile> gateway start` writes an intent
-- that the container reads at boot), and newer Hermes starts named profiles
-- stopped unless told otherwise. Nothing in this system said which companions
-- are meant to be up, so "stopped on purpose" and "broken" looked identical to
-- the fleet monitor and to anyone reading the host. The worker's
-- GatewayReconcileSweep (control_plane_worker/gateway_reconcile.py) decides —
-- one pure function over facts this database already holds — records the
-- decision here, and, only when it is switched to `enforce`, starts and stops
-- gateways through the existing forced command. It ships in `observe`: it
-- records and reports, and touches no process.
--
-- THE RULE IT DECIDES BY, in one paragraph (the order is in decide()):
-- the interviewer is always up; a retired or torn-down trip is down; an
-- operator pin wins over everything automatic; an organizer has at most ONE
-- running companion, the trip their Telegram DM is bound to (/switch moves
-- it); that trip runs until 14 days after it ends; a family message to a
-- stopped companion starts it for 2 days alongside; and nothing is stopped
-- within 6 hours of a conversation.
--
-- WHAT IS NOT HERE IS THE POINT, as in assistant_events (20260925143012):
-- every column is a number, a timestamp, an id or a value from a closed set
-- CHECKed below. No free text, no message content, no Telegram id, no host
-- name, no path, no command output. A reason is a CODE; the sentence for it
-- lives in the fleet monitor's rendering. The fleet monitor reads these
-- tables through its column-level grant (monitor-db-role.sql) and never
-- writes: the only writer is the worker, plus teardown-trip.py's pin.
--
-- `pin` is the one value somebody other than the sweep sets: 'on'/'off' by an
-- operator (`python -m control_plane_worker reconcile-gateways --pin`), and
-- 'teardown' by scripts/teardown-trip.py as its first step, under the same
-- advisory lock the sweep holds, so a reconciler cannot restart a gateway
-- between teardown stopping it and the trip being retired (design F7).
--
-- In this schema, not another: the DB-backed suites reset with
-- DROP SCHEMA control_plane CASCADE, and a second schema would survive it.
-- trip_id is ON DELETE SET NULL for the same reason assistant_events' is: a
-- row about a running process must outlive the trip row it was decided for.

CREATE TABLE control_plane.companion_gateways (
  hermes_profile  text PRIMARY KEY CHECK (hermes_profile ~ '^[a-z0-9][a-z0-9-]{1,62}$'),
  trip_id         text REFERENCES control_plane.trips(id) ON DELETE SET NULL,
  kind            text NOT NULL CHECK (kind IN ('interviewer', 'companion')),

  -- The decision. `confirmations` counts consecutive sweeps that reached the
  -- same `desired` (capped at 2): a STOP is acted on only when it has been
  -- decided twice running, so a facts flap (a switch and an immediate switch
  -- back) never darkens a companion. It is written only until it reaches the
  -- cap, so a steady fleet writes nothing.
  desired         text NOT NULL CHECK (desired IN ('running', 'stopped')),
  reason          text NOT NULL CHECK (reason IN (
    'INTERVIEWER', 'PIN_ON', 'PIN_OFF', 'TEARDOWN', 'RETIRED',
    'CURRENT_TRIP', 'IN_WINDOW', 'WAKE', 'MIDTRIP_PROTECTED', 'QUIET_WINDOW',
    'NOT_CURRENT_TRIP', 'TRIP_ENDED'
  )),
  decided_at      timestamptz NOT NULL DEFAULT now(),
  confirmations   smallint NOT NULL DEFAULT 1 CHECK (confirmations BETWEEN 1 AND 2),

  -- An operator's or teardown's override, set under the advisory lock.
  pin             text CHECK (pin IN ('on', 'off', 'teardown')),
  pin_set_at      timestamptz,
  CONSTRAINT companion_gateways_pin_pair CHECK ((pin IS NULL) = (pin_set_at IS NULL)),

  -- What the host said last time it was asked: `duplicate` is two independent
  -- gateway processes for one profile; `absent` is no such profile on the host.
  observed        text CHECK (observed IN ('running', 'duplicate', 'stopped', 'absent')),
  observed_count  smallint CHECK (observed_count BETWEEN 0 AND 99),
  observed_at     timestamptz,

  -- What the sweep did about it, and how it went. `failures` is consecutive
  -- failed actions; the next attempt waits until `next_attempt_at`.
  last_action     text CHECK (last_action IN ('start', 'stop')),
  last_action_at  timestamptz,
  last_result     text CHECK (last_result IN ('ok', 'failed', 'refused', 'not_converged')),
  failures        smallint NOT NULL DEFAULT 0 CHECK (failures BETWEEN 0 AND 99),
  next_attempt_at timestamptz,

  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT companion_gateways_action_triple
    CHECK ((last_action IS NULL) = (last_action_at IS NULL) AND (last_action IS NULL) = (last_result IS NULL))
);

CREATE INDEX companion_gateways_trip_idx ON control_plane.companion_gateways (trip_id);

-- One row per FACT worth keeping: a decision that changed, an observation that
-- changed, an action attempted, a pin set, and one SWEEP row per sweep (the
-- heartbeat the fleet monitor uses to say "the reconciler has not run" instead
-- of showing stale health). Pruned to 90 days by the sweep itself.
CREATE TABLE control_plane.companion_gateway_events (
  id             bigserial PRIMARY KEY,
  occurred_at    timestamptz NOT NULL DEFAULT now(),
  event          text NOT NULL CHECK (event IN ('DECIDED', 'OBSERVED', 'ACTION', 'PIN', 'SWEEP')),
  mode           text CHECK (mode IN ('observe', 'enforce')),
  hermes_profile text CHECK (hermes_profile ~ '^[a-z0-9][a-z0-9-]{1,62}$'),
  trip_id        text REFERENCES control_plane.trips(id) ON DELETE SET NULL,
  desired        text CHECK (desired IN ('running', 'stopped')),
  reason         text CHECK (reason IN (
    'INTERVIEWER', 'PIN_ON', 'PIN_OFF', 'TEARDOWN', 'RETIRED',
    'CURRENT_TRIP', 'IN_WINDOW', 'WAKE', 'MIDTRIP_PROTECTED', 'QUIET_WINDOW',
    'NOT_CURRENT_TRIP', 'TRIP_ENDED'
  )),
  observed       text CHECK (observed IN ('running', 'duplicate', 'stopped', 'absent')),
  action         text CHECK (action IN ('start', 'stop')),
  pin            text CHECK (pin IN ('on', 'off', 'teardown', 'clear')),
  result         text CHECK (result IN (
    'ok', 'failed', 'refused', 'not_converged',
    'host_unreachable', 'lock_busy', 'error'
  )),
  -- SWEEP: how many profiles were decided / acted on. Nothing else.
  profiles       smallint CHECK (profiles BETWEEN 0 AND 9999),
  actions        smallint CHECK (actions BETWEEN 0 AND 9999),

  -- Each event carries what it is about. CASE, not AND/OR: Postgres does not
  -- promise to evaluate AND left to right.
  CONSTRAINT companion_gateway_events_shape CHECK (
    CASE event
      WHEN 'DECIDED'  THEN hermes_profile IS NOT NULL AND desired IS NOT NULL AND reason IS NOT NULL
      WHEN 'OBSERVED' THEN hermes_profile IS NOT NULL AND observed IS NOT NULL
      WHEN 'ACTION'   THEN hermes_profile IS NOT NULL AND action IS NOT NULL AND result IS NOT NULL
      WHEN 'PIN'      THEN hermes_profile IS NOT NULL AND pin IS NOT NULL
      WHEN 'SWEEP'    THEN mode IS NOT NULL AND result IS NOT NULL AND profiles IS NOT NULL AND actions IS NOT NULL
      ELSE false
    END
  )
);

CREATE INDEX companion_gateway_events_time_idx ON control_plane.companion_gateway_events (occurred_at);
CREATE INDEX companion_gateway_events_profile_idx ON control_plane.companion_gateway_events (hermes_profile, occurred_at);

COMMENT ON TABLE control_plane.companion_gateways IS
  'Which companion gateway should run (desired + a closed reason code), what the host reported, and what the worker did. Closed-code columns only. Written by the worker''s GatewayReconcileSweep, teardown-trip.py (pin) and the reconcile-gateways CLI (pin).';
COMMENT ON TABLE control_plane.companion_gateway_events IS
  'Append-only history of companion_gateways changes plus one SWEEP heartbeat row per sweep. Closed-code columns only; pruned to 90 days.';
