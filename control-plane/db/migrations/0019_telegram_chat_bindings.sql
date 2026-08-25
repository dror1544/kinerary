-- Binds a Telegram chat id to a specific trip's Hermes companion profile, so
-- one shared Kinerary bot (the same bot that runs the trip-intake interview)
-- can also serve as every provisioned trip's ongoing companion, without
-- creating a per-trip bot (see docs/onboarding-mvp-sprint-plan.md's Sprint 5
-- goal). Hermes's gateway resolves an inbound chat_id against this table
-- (via a small internal control-plane endpoint — Hermes has no DB access of
-- its own) to pick which profile's HERMES_HOME serves the conversation.
--
-- Written directly by the provisioner (control_plane_worker) once a trip's
-- companion profile exists, using the organizer's chat id already captured
-- at signup (migration 0017's user_identities.provider_subject_id) — no
-- Telegram round-trip needed for the organizer specifically.

CREATE TABLE control_plane.telegram_chat_bindings (
  chat_id        text        PRIMARY KEY,
  trip_id        text        NOT NULL REFERENCES control_plane.trips(id),
  hermes_profile text        NOT NULL CHECK (char_length(hermes_profile) BETWEEN 1 AND 64),
  created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX telegram_chat_bindings_trip_idx ON control_plane.telegram_chat_bindings (trip_id);
