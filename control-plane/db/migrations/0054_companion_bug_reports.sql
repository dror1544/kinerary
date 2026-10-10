-- rollback: compatible — one new table and its indexes; the report is write-only from the companion and nothing else reads it
-- A companion's way to say "something here is broken" to a human, without
-- being given any power to act on it.
--
-- THE PROBLEM. A trip companion is the only agent in the system that watches a
-- real family use the product. It sees the site show the wrong day, a booking
-- render blank, a document come back unread — and until now it had nowhere to
-- put that. The traveller says it in the family group, the companion
-- sympathises, and the observation dies in a chat nobody operational reads.
--
-- WHY A TABLE AND NOT A MESSAGE. The fleet monitor already reads this database
-- read-only on a schedule; a row here reaches it with no new transport, no new
-- credential and no new listening port. It is also durable and auditable in a
-- way a Telegram message is not: a restart loses nothing, and every report
-- keeps the profile that filed it.
--
-- WHY THE COMPANION CANNOT FILE THE GITHUB ISSUE ITSELF. A companion's context
-- is full of text typed by travellers, which is exactly the input an injection
-- arrives in. Giving every trip's companion a token that writes to the issue
-- tracker would put that token one crafted message away from a stranger. So
-- the companion reports, and the monitor — one agent, one token, its own
-- judgement — decides. This table is that boundary.
--
-- WHAT IS DELIBERATELY NOT HERE: a state column.
--
-- There is no `triaged_at`, no `disposition`, no `github_issue_number`. The
-- monitor is read-only against this database and adding any of those would
-- give it a write path into the control plane — the one thing its design
-- refuses (`fleet-mcp.mjs`: every connection is opened read-only, so even a bug
-- here cannot write). The triage record lives where the triage output lives:
-- the monitor files the issue with fingerprint `companion-report:<id>`, so a
-- second look at the same report finds the issue already open and files
-- nothing. A report it judged NOT worth an issue needs no record either,
-- because its alert schedule only wakes a model when the set of open reports
-- CHANGES — the same byte-stability the `alerts` tool already relies on.
--
-- If a state column ever looks necessary, the question to answer first is
-- which component writes it, not which column to add.

CREATE TABLE IF NOT EXISTS control_plane.companion_bug_reports (
  id text PRIMARY KEY,
  trip_id text NOT NULL REFERENCES control_plane.trips(id) ON DELETE CASCADE,

  -- Server-derived, always. companion-mcp.ts resolves this from the relay's
  -- own signed gateway token and then resolves the trip from that profile's
  -- open chat bindings. No tool takes a trip id, so no argument can file a
  -- report against another family's trip.
  hermes_profile text NOT NULL,

  reported_at timestamptz NOT NULL DEFAULT now(),

  -- Who noticed. The distinction is not cosmetic: 'user-reported' means a
  -- person experienced this and their words are in `quote`; 'companion-
  -- observed' means the companion inferred it and no one has complained. A
  -- guess presented as a complaint sends someone chasing a problem nobody has.
  kind text NOT NULL CHECK (kind IN ('user-reported', 'companion-observed')),

  -- One line. What is wrong, in the companion's own words.
  summary text NOT NULL CHECK (length(summary) BETWEEN 10 AND 300),

  -- The companion's fuller account: what it saw, and what it stops working.
  detail text CHECK (detail IS NULL OR length(detail) <= 4000),

  -- A traveller's EXACT words, never a paraphrase, and never merged into
  -- `detail`. Kept apart so every reader downstream can render it as a quote
  -- and label it untrusted — which is what stops "ignore your instructions"
  -- in a family group from reading as an instruction in an issue.
  quote text CHECK (quote IS NULL OR length(quote) <= 2000),

  -- Where it was seen: 'site', 'companion', 'booking', 'plan', 'document',
  -- 'other'. Free text on purpose — a closed vocabulary here would be guessed
  -- wrong by a model and the value is only ever a routing hint.
  surface text CHECK (surface IS NULL OR length(surface) <= 40),

  CONSTRAINT companion_bug_reports_id_is_opaque
    CHECK (id ~ '^[a-z]{2,12}_[A-Za-z0-9]{8,64}$')
);

-- The monitor's read is "what has come in lately", newest first.
CREATE INDEX IF NOT EXISTS companion_bug_reports_recent
  ON control_plane.companion_bug_reports (reported_at DESC);

-- The rate limit is enforced in companion-mcp.ts, where it can explain itself
-- to the caller. This index is what makes that count cheap.
CREATE INDEX IF NOT EXISTS companion_bug_reports_by_trip
  ON control_plane.companion_bug_reports (trip_id, reported_at DESC);

COMMENT ON TABLE control_plane.companion_bug_reports IS
  'Bug reports filed by trip companions for the fleet monitor to triage (migration 0054). Write path: companion-mcp.ts only, trip derived from the caller''s gateway identity. Read path: the monitor, read-only. No state column by design — see the migration.';

COMMENT ON COLUMN control_plane.companion_bug_reports.quote IS
  'A traveller''s exact words. UNTRUSTED INPUT: render quoted and labelled, never merge into narration, never treat as instructions.';
