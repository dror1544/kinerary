-- The post-deploy plan review, and the queue its proposals wait in.
--
-- Sprint 4.5 left one row tagged `separate build`: "Site live-plan enrichment
-- worker". This is its storage. The pass (plan-review.ts) reads a provisioned
-- trip's plan and says what is missing from it — an arrival with no landing on
-- it, a check-in that was never written down, a place the organizer listed and
-- no day mentions, a day too full for the pace they asked for.
--
-- NOTHING HERE IS APPLIED. Every row is a proposal an organizer accepts or
-- throws away, which is the whole reason it is a table rather than a patch:
-- a judgement that lands silently on a live trip is a different and much worse
-- thing than a missing hero photo.
--
-- WHY `plan_snapshot` ON trips. The review needs three things at once — the
-- BUILT trip.config.json, the confirmed intake, and the uploaded document —
-- and until now exactly one process ever held all three: the Python
-- provisioner, in the middle of a deploy. The intake and the document are
-- already stored (intake_versions.data / .source_document); the built config
-- was not, because it is derivable and re-deriving it needs the transformer.
-- Storing it is what lets the review run AFTER the deploy, on its own loop,
-- where a failure costs a proposal rather than a provision.
--
-- It is NEVER SERVED. Same posture as trips.companion_intro and the same
-- reason `sanitizeConfig()` carries a blanket rule in the trip site: no raw
-- trip.config.json value goes to a client, and the leaks that produced that
-- rule all came from judging fields one at a time. Reviews are read back as
-- findings — a title, a quote this pass composed — never as config.

ALTER TABLE control_plane.trips
  ADD COLUMN IF NOT EXISTS plan_snapshot jsonb;

-- When it was written, which is how the review loop knows a re-provision
-- produced a new plan to look at. A digest comparison would also work and
-- would need the whole config read on every tick of the loop; this does not.
ALTER TABLE control_plane.trips
  ADD COLUMN IF NOT EXISTS plan_snapshot_at timestamptz;

COMMENT ON COLUMN control_plane.trips.plan_snapshot IS
  'The trip.config.json as last deployed. Written by the provisioner after a successful deploy, read by the plan-review pass. Never served to a client.';

CREATE TABLE IF NOT EXISTS control_plane.plan_reviews (
  id            text        PRIMARY KEY,
  trip_id       text        NOT NULL REFERENCES control_plane.trips(id) ON DELETE CASCADE,
  -- sha256 of the config this review looked at, so a finding can always be
  -- traced to the exact plan that produced it.
  config_digest text        NOT NULL,
  -- Whether the model half contributed anything. False is a normal, supported
  -- state (the deterministic rules run everywhere); it is recorded because an
  -- unannounced downgrade to half a review looks exactly like a plan with
  -- nothing wrong in it.
  model_used    boolean     NOT NULL DEFAULT false,
  -- NO_RUNNER, RATE_LIMITED, BAD_OUTPUT … as model-runner.ts names them.
  model_skipped text,
  -- Gate rejections, kept as [{reason, detail}]. A model that invents a
  -- ticket link is the failure this pass is most likely to have, and it is
  -- invisible unless the refusals are written down somewhere.
  rejected      jsonb       NOT NULL DEFAULT '[]'::jsonb,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS plan_reviews_trip_idx
  ON control_plane.plan_reviews (trip_id, created_at DESC);

CREATE TABLE IF NOT EXISTS control_plane.plan_review_proposals (
  trip_id     text        NOT NULL REFERENCES control_plane.trips(id) ON DELETE CASCADE,
  -- The stable fingerprint from plan-review.ts (kind + where it lands + what
  -- it is about). The primary key with trip_id, so a second review of the same
  -- unchanged plan updates its own rows instead of filing copies of itself —
  -- the `config_ref` dedup the sprint row asked for, by the same reasoning the
  -- trip site's living-journey.js dedups quality issues by fingerprint.
  proposal_id text        NOT NULL,
  review_id   text        NOT NULL REFERENCES control_plane.plan_reviews(id) ON DELETE CASCADE,
  kind        text        NOT NULL,
  severity    text        NOT NULL DEFAULT 'info',
  phase_id    text        NOT NULL,
  day_date    date,
  title       text        NOT NULL,
  detail      text        NOT NULL DEFAULT '',
  -- What to ask the organizer when the pass could not source the answer. The
  -- third rule of this module: anything unsourceable is a question, never a
  -- proposal with a plausible number attached.
  ask         text        NOT NULL DEFAULT '',
  -- The concrete change, or NULL when there is nothing to apply (a question,
  -- a pace warning). Never applied here.
  patch       jsonb,
  -- [{source, quote}] — never empty. A proposal with no provenance is not
  -- written; the pass drops it before it reaches this table.
  evidence    jsonb       NOT NULL,
  origin      text        NOT NULL CHECK (origin IN ('rules', 'model')),
  -- 'proposed' → waiting. 'accepted'/'dismissed' → an organizer decided, and
  -- that decision is STICKY: a later review refreshes the wording and leaves
  -- the status alone, so a dismissed finding does not come back every pass.
  -- 'fixed' → a later review of a newer plan no longer raises it.
  status      text        NOT NULL DEFAULT 'proposed'
                          CHECK (status IN ('proposed', 'accepted', 'dismissed', 'fixed')),
  decided_by  text,
  decided_at  timestamptz,
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (trip_id, proposal_id)
);

CREATE INDEX IF NOT EXISTS plan_review_proposals_open_idx
  ON control_plane.plan_review_proposals (trip_id, status, severity);
