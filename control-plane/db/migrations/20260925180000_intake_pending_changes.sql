-- rollback: compatible — one new table and its indexes; nothing existing changes shape, and nothing reads the table until the typed-change flow (#206, slice 3) ships

-- A typed change to held stops or travellers, waiting for the organizer's yes.
--
-- The contract (#206): a typed correction is interpreted into a structured diff,
-- validated against the whole trip, SHOWN, and applied exactly as shown only
-- after explicit confirmation. This row is the "shown, waiting" part — and,
-- once resolved, the audit record of what was proposed, what the person saw and
-- what they decided. There is no separate provenance table for typed changes.
--
-- WHY A TABLE AND NOT `intake_sessions.ui_state`: `ui_state` is parsed through
-- an allowlist in both directions, and a field added to one but not the other is
-- written and then silently dropped on the next read (that is how `deferred`
-- was lost). A pending change is worth more than that. Same reasoning as
-- 20260918110130_answer_provenance.sql's `trip_answer_conflicts`.
--
-- ONE OPEN DRAFT PER SESSION, enforced below. A follow-up message is MERGED into
-- the open draft by target (same target replaces, different targets accumulate),
-- never silently superseded: "Ruth is 71" followed by "Avi is 40" is two changes,
-- both shown. So there is no `superseded` status, and no `applying` one either:
-- apply is a single transaction (compare-and-swap from `base` to `result`), so
-- there is no half-applied state to represent.
--
-- `base` is the held answer of each touched question AS PROPOSED; apply refuses
-- (STALE) if any of them has changed since, and the draft is rebuilt from `ops`
-- against what is held now and shown again. `result` is the validated answer
-- that would be stored — computed THROUGH validateAnswer, so the preview shows
-- what will be stored. `preview` is the field-level difference (with its
-- warnings) as data, rendered at SEND time in the session's current language.
--
-- `interpretation_ids` is the idempotency key. The relay resumes from stored
-- proposals after a crash, so the same interpretation can reach the draft twice;
-- creating a draft is an upsert on it, and an id already recorded on ANY draft of
-- the session (open or resolved) is a replay that does nothing — otherwise a
-- replay arriving after the draft was applied would raise it from the dead.
--
-- Deleting the session (scripts/fresh-interview.py) or the trip cascades here,
-- as it does for interview_interpretations (0048).

CREATE TABLE IF NOT EXISTS control_plane.intake_pending_changes (
  id                  text PRIMARY KEY,
  session_id          text NOT NULL REFERENCES control_plane.intake_sessions(id) ON DELETE CASCADE,
  trip_id             text NOT NULL REFERENCES control_plane.trips(id) ON DELETE CASCADE,
  interpretation_ids  text[] NOT NULL DEFAULT '{}',
  -- Per touched question: the held answer at proposal time (null = unanswered).
  base                jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- The operations so far, accumulated across follow-ups (typed-changes.ts `Op`).
  ops                 jsonb NOT NULL DEFAULT '[]'::jsonb,
  -- Per touched question: the validated resulting answer. Empty while the draft
  -- cannot yet be confirmed.
  result              jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- The field-level diff base -> result, with warnings, as { key, params } lines.
  preview             jsonb NOT NULL DEFAULT '[]'::jsonb,
  -- References that named nothing or several held entries: a question, not a guess.
  unresolved          jsonb NOT NULL DEFAULT '[]'::jsonb,
  -- A conflict (an overlap, a move of a dated stop, a refused value): asks; cannot be confirmed.
  blocked             jsonb NOT NULL DEFAULT '[]'::jsonb,
  -- The prompt this draft displaced from the screen, to put back once it resolves.
  displaced_prompt    text,
  status              text NOT NULL DEFAULT 'pending',
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  resolved_at         timestamptz,
  resolved_by         text,

  CONSTRAINT intake_pending_changes_id_is_opaque
    CHECK (id ~ '^[a-z]{2,12}_[A-Za-z0-9]{8,64}$'),
  CONSTRAINT intake_pending_changes_status_check
    CHECK (status IN ('pending', 'applied', 'cancelled', 'failed')),
  CONSTRAINT intake_pending_changes_resolved_shape
    CHECK ((status = 'pending') = (resolved_at IS NULL))
);

-- The one-open-draft rule, and the lookup the router makes on every typed message.
CREATE UNIQUE INDEX IF NOT EXISTS intake_pending_changes_one_open_idx
  ON control_plane.intake_pending_changes (session_id)
  WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS intake_pending_changes_session_idx
  ON control_plane.intake_pending_changes (session_id, created_at DESC);
