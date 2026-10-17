-- rollback: compatible — one new table (trip_clear_archives), no existing
-- shape changes; nothing reads this table until the operator clear routes
-- ship, and nothing before this migration ever wrote to it

-- Issue #378: an operator-key-gated HTTP capability to force-revoke/clear a
-- trip, bypassing two existing "no --force" guardrails on purpose —
-- scripts/fresh-interview.py's confirmed-intake-version refusal and
-- scripts/teardown-trip.py's past-ready_private refusal — with an archive as
-- the safety net those two scripts don't need because they simply refuse
-- instead.
--
-- CORRECTED (boundary review round 12, 2026-10-15): this used to say "in ANY
-- lifecycle state (draft through live)," written before round 8's scope cut.
-- The capability this table backs is now scoped, unconditionally, to a trip
-- that was NEVER provisioned — see trip-clear.ts's own module doc for the
-- full reasoning (a provisioned trip's companion-attach phase runs outside
-- any database transaction, so no Postgres-side locking in that file can
-- race-close against it; that case is split out to #390). This table itself
-- is unaffected by the scope cut — it still archives whatever a successful
-- clear touches, for whichever trips this capability actually reaches.
--
-- WHY A NEW TABLE, NOT control_plane.audit_events. `audit_events.evidence` is
-- an ALLOW-LIST at read time (admin-dashboard.ts's own module doc, after the
-- 2026-09-27 boundary review, F1): every key ever let through it is "opaque,
-- machine-generated, or a closed enum — never traveler, organizer, or even
-- operator free text" by construction, because that column IS exposed, via
-- /v1/admin/audit, to the admin dashboard. A trip's archived rows — roster
-- names and ages, intake answers, chat ids, document extractions — are
-- exactly the traveler data that invariant exists to keep out of a served
-- column. So the full archive gets its OWN table, one nothing ever serves
-- through a route (same posture as trip_suspension_history, migration
-- 20261003060350: "no route reads this table — restricted history for an
-- operator to query directly"). The AUDIT record of "who cleared which trip,
-- when, what was archived where" still goes through audit_events — see
-- admin-dashboard.ts's EVIDENCE_ALLOWLIST, which gets one new action
-- (operator.clear_trip) carrying only opaque ids, booleans and closed enum
-- values, never a copy of this table's payload.
--
-- `payload` is one JSON object keyed by control_plane table name, holding
-- every row this trip had in each table this operation touches or removes —
-- trips, trip_memberships, interview_enrollments, intake_sessions,
-- interview_agent_turns, interview_interpretations, intake_pending_changes,
-- intake_versions, telegram_chat_bindings, telegram_group_binding_tokens,
-- organizer_invitations.
--
-- CORRECTED (boundary review round 12, 2026-10-15): this used to say the
-- list above was "built from plain SELECTs" and omitted
-- interview_interpretations/intake_pending_changes entirely — both wrong by
-- the time this migration was actually written (F1 added the two missing
-- tables, R7-4/R8-1 replaced the plain-SELECT capture with one that locks
-- and returns each row via the SAME statement that mutates or deletes it,
-- never a separate earlier read — see trip-clear.ts's own module doc for
-- why that distinction is load-bearing, not cosmetic). `slug_at_archive` and
-- `lifecycle_state_at_archive` are pulled out as their own columns, not left
-- buried in the JSON, because they are the two facts an operator most often
-- needs to find the right archive row without parsing payload first.
--
-- What this archive does NOT cover, named here so the gap is a decision, not
-- a surprise: a provisioned trip's `trip.config.json` (roster, bookings),
-- document originals and the Hermes profile's own conversation history all
-- live outside control-plane's Postgres — on the deploy host's filesystem, a
-- different process's local sqlite, or behind Proxmox/Cloudflare/NPM — none
-- of which control-plane/api can reach. See trip-clear.ts's module doc.
CREATE TABLE control_plane.trip_clear_archives (
  id                        text PRIMARY KEY
    CHECK (id ~ '^[a-z]{2,12}_[A-Za-z0-9]{8,64}$'),
  trip_id                   text NOT NULL REFERENCES control_plane.trips(id),
  slug_at_archive           text NOT NULL,
  lifecycle_state_at_archive text NOT NULL,
  payload                   jsonb NOT NULL,
  created_at                timestamptz NOT NULL DEFAULT now(),
  -- Opaque actor reference, same shape as audit_events.actor_ref — today
  -- always 'operator:api-key' (there is one trusted operator; see
  -- AdminDependencies's own module doc in app.ts for why that is not a reason
  -- to skip recording who), kept as a column rather than inlined in payload
  -- so a future second operator does not require a payload-shape migration.
  created_by                text NOT NULL CHECK (char_length(created_by) BETWEEN 1 AND 64)
);

CREATE INDEX trip_clear_archives_trip_id_idx ON control_plane.trip_clear_archives (trip_id);
