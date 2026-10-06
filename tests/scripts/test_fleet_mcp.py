""".agents/skills/trip-fleet-monitor/fleet-mcp.mjs — what the monitor may read.

The server is a fixed query catalogue, so what is pinned here is the catalogue:
the tools it offers, and the properties of the SQL it sends. Every statement is
captured from a stand-in `psql` (the `argv` escape hatch in fleet-stacks.json),
so none of this needs a database.

Three of these tests exist because the monitor once reported something untrue:

- a session closed for idleness keeps the `state` it held, so filtering on state
  alone kept "INTERVIEW WAITING ON US" alive for conversations that had ended —
  while filtering on `state = 'interviewing'` loses the opposite half, the
  organizer parked at an unanswered recap;
- `NOT IN ('succeeded','completed')` excluded a state that does not exist, so
  every queued or running build was listed as failed or stuck;
- a query that CRASHES must never render as "(none)", or a failed read looks
  exactly like a healthy fleet.

    python3 -m unittest discover -s tests/scripts
"""
from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import tempfile
import unittest
from datetime import date, timedelta
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SERVER = ROOT / ".agents" / "skills" / "trip-fleet-monitor" / "fleet-mcp.mjs"
NODE = shutil.which("node")

#: A psql that answers nothing and records everything it was asked.
FAKE_PSQL = """#!/usr/bin/env python3
import os, sys
sql = sys.stdin.read()
with open(os.environ["FLEET_TEST_SQL_LOG"], "a") as log:
    log.write(sql + "\\n\\x00\\n")
if os.environ.get("FLEET_TEST_FAIL"):
    sys.stderr.write("ERROR:  relation \\"control_plane.trips\\" does not exist\\n")
    sys.exit(1)
fixtures = os.environ.get("FLEET_TEST_FIXTURES")
if fixtures:
    # An ordered list of [marker, rows]; the first marker found in the SQL wins,
    # and a statement nothing matches finds no rows.
    import json
    for marker, marker_rows in json.load(open(fixtures)):
        if marker in sql:
            if isinstance(marker_rows, str):
                # A string is not rows: it is what psql writes on stderr when it fails.
                sys.stderr.write(marker_rows + "\\n")
                sys.exit(1)
            for row in marker_rows:
                sys.stdout.write("\\x1f".join(row) + "\\n")
            break
    sys.exit(0)
rows = os.environ.get("FLEET_TEST_ROWS", "")
if rows:
    sys.stdout.write(rows)"""

TOOLS = [
    ("fleet_overview", {}),
    ("list_trips", {}),
    ("trip_detail", {"trip": "japan-2026"}),
    ("failures", {}),
    ("stalled_interviews", {}),
    ("statistics", {}),
    ("alerts", {}),
    ("bug_reports", {}),
    ("stacks", {}),
]

#: What production looked like on 2026-09-28, as rows, for the three tools the
#: daily digest calls. Ordered: the first marker found in a statement answers it.
FIXTURES = [
    ('to_regclass', [['t']]),
    ('FROM control_plane.trips t GROUP BY 1,2', [['live', 'ready_private', '2'], ['prospect', 'draft', '6'], ['prospect', 'intake_confirmed', '2'], ['prospect', 'intake_in_progress', '3'], ['retired', 'draft', '1'], ['retired', 'intake_in_progress', '7'], ['retired', 'provisioning_approved', '1'], ['retired', 'ready_private', '30']]),
    ('SELECT j.job_type, j.state', [['provision', 'cancelled', '1'], ['provision', 'failed', '1'], ['provision', 'succeeded', '34']]),
    ("n.state = 'failed' GROUP BY 1,2,3", [['retired', 'provisioning_complete', 'failed', '16'], ['retired', 'companion_ready', 'failed', '16']]),
    ('round(max(', [['prospect', '3', '395'], ['retired', '5', '396']]),
    ("t.slug NOT LIKE 'retired-%'\n                    ORDER BY t.created_at", []),
    ('ORDER BY t.updated_at;', [['draft-sreq-98dc40209a03c5b832f31c15d0d05c13', 'prospect', 'intake_confirmed', '16d'], ['draft-sreq-f686fe70bf8ad56759d58a6d811f8584', 'prospect', 'intake_confirmed', '16d']]),
    ('interview_enrollments e\n                     JOIN', [['prospect', 'opened', '4'], ['prospect', 'waiting to be opened', '1'], ['retired', 'opened', '20']]),
    ("'trips created'", [['trips created', '3'], ['interview links issued', '5'], ['links opened', '4'], ['links that expired unopened', '1'], ['interviews started', '3'], ['a document was sent in', '2'], ['interviews confirmed', '1'], ['open right now', '8'], ['closed for idleness', '0'], ['trips reaching ready', '1']]),
    ('SELECT j.state, count(*)::text', [['succeeded', '1']]),
    ("'build minutes", [['build minutes (median, to last heartbeat)', '2'], ['interview minutes (median)', '22']]),
    ('WHERE t.created_at >', [['live', '1'], ['prospect', '2']]),
    ('interview_interpretations\n                    WHERE created_at', [['succeeded', '20'], ['RATE_LIMITED', '2']]),
    ("t.reachability = 'unreachable' AND ", []),
    ("j.state = 'failed' AND", [['trip-j', 'provision', 'PROVISION_TIMEOUT', '3/3']]),
    ("n.state = 'failed' AND", []),
    ('intake_versions', [['draft-sreq-98dc40209a03c5b832f31c15d0d05c13', 'intake_confirmed', '2026-09-11 18:40 UTC'], ['draft-sreq-f686fe70bf8ad56759d58a6d811f8584', 'intake_confirmed', '2026-09-11 18:53 UTC']]),
    ("awaiting = 'machine'", [['trip-b', 'collect', '2026-09-15 10:00 UTC']]),
    ('telegram_chat_bindings', [['trip-c']]),
    ('DISTINCT t.slug', [['trip-b', 'TIMED_OUT']]),
    ('companion_bug_reports r\n', [['trip-d', 'bug', 'The itinerary page shows the wrong day', 'rep_1', '2026-09-27 08:00 UTC']]),
    ('max(e.occurred_at)', [['77', '2026-09-28']]),
    ('x.response_latency_ms', [['trip-a', 'live', '12', '11', '1', '0', '0', '0', '9', '15000', '2', '8', '4', '5', '7'], ['retired-t-20260901', 'retired', '3', '3', '0', '0', '0', '0', '0', '1000', '0', '3', '0', '1', '2']]),
]

#: The agent-facing text of those rows, captured from the commit BEFORE the
#: digest form existed. Hermes hashes the alerts bytes; the agent reads the rest.
TEXT_OVERVIEW = """\
Stack: a control plane  [PRODUCTION]

TRIPS BY CLASS AND STAGE
  live:          ready_private=2
  prospect:      draft=6, intake_confirmed=2, intake_in_progress=3   (real signups, not built yet — check the stage)
  retired:       draft=1, intake_in_progress=7, provisioning_approved=1, ready_private=30   (torn down on purpose — not a problem)
  scaffolding:   none

LIVE TRIPS IN FLIGHT: 0, live and ready: 2

PROVISIONING JOBS
  job_type | state | count
  provision | cancelled | 1
  provision | failed | 1
  provision | succeeded | 34

FAILED NOTIFICATIONS (by trip class — only 'live' deserves attention)
  class | kind | state | count
  retired | provisioning_complete | failed | 16
  retired | companion_ready | failed | 16

UNFINISHED INTERVIEWS (still open — closed-for-idleness sessions are not counted here)
  class | count | max_idle_hours
  prospect | 3 | 395
  retired | 5 | 396

INTERVIEW LINKS
  class | what happened | count
  prospect | opened | 4
  prospect | waiting to be opened | 1
  retired | opened | 20

UNREACHABLE TRIPS (excluding retired)
  (none)

CONFIRMED BUT NEVER BUILT — someone finished answering and no job exists
  slug | class | stage | waiting
  draft-sreq-98dc40209a03c5b832f31c15d0d05c13 | prospect | intake_confirmed | 16d
  draft-sreq-f686fe70bf8ad56759d58a6d811f8584 | prospect | intake_confirmed | 16d"""

TEXT_STATISTICS = """\
Stack: a control plane  [PRODUCTION]   window: last 7 days

FUNNEL
  step | count
  trips created | 3
  interview links issued | 5
  links opened | 4
  links that expired unopened | 1
  interviews started | 3
  a document was sent in | 2
  interviews confirmed | 1
  open right now | 8
  closed for idleness | 0
  trips reaching ready | 1
  links opened: 80%   interview completion rate: 33%

INTERVIEW MODEL CALLS  (a failure is invisible to the organizer — the router just asks its own question)
  outcome | count
  succeeded | 20
  RATE_LIMITED | 2
  model success rate: 91%

TRIPS CREATED, BY CLASS  (retired/scaffolding are test runs, not customers)
  class | count
  live | 1
  prospect | 2

PROVISIONING
  job state | count
  succeeded | 1
  build success rate: 100%

DURATIONS
  measure | value
  build minutes (median, to last heartbeat) | 2
  interview minutes (median) | 22

COMPANION USAGE  (counts only, last 7 days; retired/scaffolding are test runs, not customers)
  trip | class | requests | replies | reply rate | failed | suppressed | lost (gateway) | lost (companion) | chatter ignored | median reply | with media | group | dm | organizer | participant
  trip-a | live | 12 | 11 | 92% | 1 | 0 | 0 | 0 | 9 | 15s | 2 | 8 | 4 | 5 | 7
  retired-t-20260901 | retired | 3 | 3 | 100% | 0 | 0 | 0 | 0 | 0 | 1.0s | 0 | 3 | 0 | 1 | 2
  reply rate = replies delivered / requests. Under 100% means some requests got no delivered reply:
  a failed or suppressed delivery, or a turn lost (gateway unavailable, companion unreachable).
  chatter ignored = group messages not addressed to the assistant. Requests split by channel and role.
  tool usage: not collected on this stack (no hermes_logs_dir configured)"""

TEXT_ALERTS = """\
⚠️ Kinerary fleet — a control plane

BUILT WITHOUT AN ORGANIZER CHAT
  • trip-c — site is up, no private chat bound

FAILED JOBS
  • trip-j — provision PROVISION_TIMEOUT (attempt 3/3)

CONFIRMED BUT NEVER BUILT
  • draft-sreq-98dc40209a03c5b832f31c15d0d05c13 — intake_confirmed, confirmed 2026-09-11 18:40 UTC
  • draft-sreq-f686fe70bf8ad56759d58a6d811f8584 — intake_confirmed, confirmed 2026-09-11 18:53 UTC

INTERVIEW WAITING ON US
  • trip-b — phase collect, waiting on us since 2026-09-15 10:00 UTC

MODEL FAILING MID-INTERVIEW
  • trip-b — TIMED_OUT

REPORTED BY A COMPANION
  • trip-d [bug] The itinerary page shows the wrong day (rep_1, 2026-09-27 08:00 UTC)"""

DIGEST_OVERVIEW = """\
a control plane

**Trips**
• live: 2 ready
• prospect: 6 draft · 2 confirmed · 3 interviewing
• retired: 39 (test runs, ignore) — 1 draft · 7 interviewing · 1 approved · 30 ready

**Provisioning**
34 succeeded · 1 failed · 1 cancelled

**Failed notifications**
• retired: provisioning_complete ×16 · companion_ready ×16 (test runs, ignore)

**Open interviews**
• prospect: 3 (longest idle 395h)
• retired: 5 (longest idle 396h)

**Interview links**
• prospect: 4 opened · 1 waiting to be opened
• retired: 20 opened

**Unreachable**: none

**Confirmed, never built**
• draft-sreq-98dc40209a03c5b832f31c15d0d05c13 — prospect, confirmed, waiting 16d
• draft-sreq-f686fe70bf8ad56759d58a6d811f8584 — prospect, confirmed, waiting 16d"""

DIGEST_STATISTICS = """\
**Last 7 days**
• trips created: 3 (live 1 · prospect 2)
• interview links: 5 issued · 4 opened (80%) · 1 expired unopened
• interviews: 3 started · 1 confirmed (33%) · 2 with a document · 8 open now · 0 closed for idleness
• trips reaching ready: 1
• provisioning: 1 succeeded · build success 100%
• interview model calls: 20 succeeded · 2 RATE_LIMITED · success 91%
• median duration: build 2 min · interview 22 min

**Companion usage**
• ⚠️ trip-a: 12 requests · 11 replies (92%, under 100%) · 1 failed · 0 lost · 9 chatter ignored · median 15s · group 8 / DM 4 · organizer 5 / participants 7 · 2 with media
• retired: 3 requests · 3 replies · 0 chatter ignored (test runs, ignore)"""

DIGEST_ALERTS = """\
**⚠️ Needs attention**
• no organizer chat: trip-c — site is up, no private chat bound
• failed job: trip-j — provision PROVISION_TIMEOUT (attempt 3/3)
• confirmed, never built: draft-sreq-98dc40209a03c5b832f31c15d0d05c13 — confirmed 2026-09-11 18:40 UTC
• confirmed, never built: draft-sreq-f686fe70bf8ad56759d58a6d811f8584 — confirmed 2026-09-11 18:53 UTC
• interview waiting on us: trip-b — phase collect, waiting on us since 2026-09-15 10:00 UTC
• model failing mid-interview: trip-b — TIMED_OUT
• reported by a companion: trip-d — bug, The itinerary page shows the wrong day (rep_1, 2026-09-27 08:00 UTC)"""


@unittest.skipUnless(NODE, "node is not installed")
class FleetMcp(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = Path(tempfile.mkdtemp())
        self.log = self.tmp / "sql.log"
        fake = self.tmp / "fake-psql.py"
        fake.write_text(FAKE_PSQL)
        fake.chmod(0o755)
        config = self.tmp / "fleet-stacks.json"
        config.write_text(json.dumps({
            "default_stack": "prod",
            "stacks": {
                "prod": {"label": "a control plane", "production": True,
                         "argv": [shutil.which("python3") or "python3", str(fake)]},
            },
        }))
        self.config = config

    def call(self, messages: list[dict], env: dict | None = None) -> list[dict]:
        stdin = "".join(json.dumps(m) + "\n" for m in messages)
        proc = subprocess.run(
            [NODE, str(SERVER)],
            input=stdin, capture_output=True, text=True, timeout=60,
            env={**os.environ, "KINERARY_FLEET_CONFIG": str(self.config),
                 "FLEET_TEST_SQL_LOG": str(self.log), **(env or {})},
        )
        return [json.loads(line) for line in proc.stdout.splitlines() if line.strip()]

    def tool(self, name: str, arguments: dict | None = None, env: dict | None = None) -> tuple[str, bool]:
        responses = self.call(
            [{"jsonrpc": "2.0", "id": 1, "method": "tools/call",
              "params": {"name": name, "arguments": arguments or {}}}], env)
        result = responses[0]["result"]
        return result["content"][0]["text"], bool(result.get("isError"))

    def statements(self) -> list[str]:
        """Every statement sent since setUp, comments stripped.

        The comments are stripped because these tests search for column names,
        and this file's comments discuss the very columns it must not read.
        """
        if not self.log.exists():
            return []
        raw = [s.strip() for s in self.log.read_text().split("\n\x00\n") if s.strip()]
        return [re.sub(r"--[^\n]*", "", statement) for statement in raw]

    def all_statements(self) -> list[str]:
        for name, arguments in TOOLS:
            self.tool(name, arguments)
        statements = self.statements()
        self.assertGreater(len(statements), 20, "the tools sent almost no SQL — did they run?")
        return statements

    # ------------------------------------------------------------ catalogue --
    def test_the_catalogue_is_fixed_and_no_tool_takes_sql(self):
        responses = self.call([{"jsonrpc": "2.0", "id": 1, "method": "tools/list"}])
        tools = responses[0]["result"]["tools"]
        self.assertEqual(
            sorted(t["name"] for t in tools),
            sorted(name for name, _ in TOOLS),
        )
        for tool in tools:
            properties = tool["inputSchema"].get("properties", {})
            self.assertNotIn("sql", properties, f"{tool['name']} takes SQL")
            self.assertNotIn("query", properties, f"{tool['name']} takes a query")

    def test_a_trip_reference_is_the_only_free_text_that_reaches_sql(self):
        text, is_error = self.tool("trip_detail", {"trip": "japan'; DROP TABLE trips; --"})
        self.assertTrue(is_error)
        self.assertIn("trip id or slug", text)
        self.assertEqual(self.statements(), [], "a refused reference still ran a query")

    # -------------------------------------------------- what "live" means ----
    def test_every_live_interview_query_excludes_the_ones_already_closed(self):
        """`state` alone outlives the conversation: closure only sets expired_at."""
        seen = 0
        for statement in self.all_statements():
            if "s.state <> 'confirmed'" not in statement:
                continue
            seen += 1
            self.assertIn(
                "expired_at IS NULL", statement,
                "a query treats a session closed for idleness as a live interview:\n" + statement,
            )
        self.assertGreater(seen, 0, "no query filters on a live session at all — has the predicate moved?")

    def test_an_organizer_parked_at_the_recap_is_still_in_an_open_interview(self):
        """`awaiting_confirmation` is open: the recap is on their screen, unanswered.

        `intake_sessions.state` has three values (0008) and only 'confirmed' is
        an ending. Narrowing to 'interviewing' makes the most common real stall
        invisible — the organizer who was shown the recap and never replied,
        which is how run 7 ended. Nothing else here would report it.
        """
        for statement in self.all_statements():
            self.assertNotIn(
                "state = 'interviewing'", statement,
                "a query calls only 'interviewing' live, so an interview sitting at "
                "the recap is missing from it:\n" + statement,
            )

    def test_a_session_closed_at_the_recap_is_reported_closed_not_awaiting(self):
        """claimExpiredSessions claims on `state <> 'confirmed'`, recap included."""
        self.tool("trip_detail", {"trip": "japan-2025"})
        labels = [s for s in self.statements() if "closed (idle)" in s]
        self.assertEqual(len(labels), 1, "the closed-for-idleness label moved")
        self.assertIn(
            "s.state <> 'confirmed' AND s.expired_at IS NOT NULL", labels[0],
            "an expired session at the recap would still be shown as awaiting_confirmation:\n" + labels[0],
        )

    def test_stuck_jobs_are_named_by_state_not_by_excluding_a_state_that_never_existed(self):
        self.tool("failures")
        joined = "\n".join(self.statements())
        self.assertNotIn("'completed'", joined)
        self.assertIn("j.state IN ('failed','cancelled')", joined)

    # ------------------------------------------------------- what it may read --
    def test_no_query_ever_selects_a_document_s_text(self):
        """Provenance is allowed; contents are not. char_length is the exception."""
        for statement in self.all_statements():
            for match in re.finditer(r"(?:\w+\.)?source_document->>'text'", statement):
                prefix = statement[: match.start()]
                self.assertTrue(
                    prefix.rstrip().endswith("char_length("),
                    "a query reads the text of an uploaded document:\n" + statement,
                )

    def test_no_query_reads_the_column_that_holds_the_site_password(self):
        """trips.companion_intro carries login_password in plain text."""
        for statement in self.all_statements():
            self.assertNotIn("companion_intro", statement)

    def test_the_site_url_comes_from_the_job_result(self):
        self.tool("trip_detail", {"trip": "japan-2026"})
        self.assertIn("result->>'private_url'", "\n".join(self.statements()))

    def test_people_are_never_selected_by_name(self):
        for statement in self.all_statements():
            for column in ("display_name", "participant_username", "telegram_user_id", "s.answers"):
                self.assertNotIn(column, statement, f"a query selects {column}:\n" + statement)

    # ------------------------------------------------------------- alerts ----
    def test_alerts_print_nothing_when_nothing_is_wrong(self):
        text, is_error = self.tool("alerts")
        self.assertFalse(is_error, text)
        self.assertEqual(text, "")

    def test_alerts_never_select_a_value_derived_from_now(self):
        """Hermes hashes these bytes: an elapsed time re-wakes the model hourly."""
        self.tool("alerts")
        for statement in self.statements():
            select_list = statement.split("FROM")[0]
            self.assertNotIn("now()", select_list, "alerts would print a moving value:\n" + statement)
            # A SELECT with no FROM returns exactly one row — alerts probes for
            # companion_bug_reports that way, so a stack behind migration 0054
            # degrades instead of breaking. Row order is not a property one row
            # can have, let alone lose; everything that reads a table needs it.
            if "FROM" not in statement:
                continue
            self.assertIn("ORDER BY", statement, "an alerts query has no stable row order:\n" + statement)

    # ---------------------------------------------- verification / approval --
    def test_a_trip_s_latest_verification_failure_appears_in_alerts(self):
        text, is_error = self.tool("alerts", {}, env=self.fixtures_env([
            ("to_regclass", [["t"]]),
            ("ve.outcome = 'failed'", [["trip-v", "runtime_health", "2026-10-06 09:00 UTC"]]),
        ]))
        self.assertFalse(is_error, text)
        self.assertIn("VERIFICATION FAILED", text)
        self.assertIn("trip-v — runtime_health failed as of 2026-10-06 09:00 UTC", text)

    def test_verification_failure_is_not_checked_on_a_stack_without_the_table(self):
        """to_regclass absent/false (no fixture match) must degrade, not error."""
        text, is_error = self.tool("alerts", {}, env=self.fixtures_env([]))
        self.assertFalse(is_error, text)
        self.assertNotIn("VERIFICATION FAILED", text)

    def test_a_job_waiting_too_long_for_organizer_approval_appears_in_alerts(self):
        text, is_error = self.tool("alerts", {}, env=self.fixtures_env([
            ("j.state = 'waiting_for_user_action'", [["trip-w", "provision", "2026-10-06 06:00 UTC"]]),
        ]))
        self.assertFalse(is_error, text)
        self.assertIn("AWAITING ORGANIZER APPROVAL", text)
        self.assertIn("trip-w — provision, waiting since 2026-10-06 06:00 UTC", text)

    # ------------------------------------------------------- suspended trips --
    # The fake psql returns exactly the rows a fixture names — it never
    # evaluates the SQL sent to it — so what these two can actually prove is
    # the query TEXT: whether it references t.suspended_at at all, which is
    # the real safety property (a stack behind migration 20261003060350 has
    # no such column, and referencing it would fail the whole query the way
    # `tableExists`'s own docstring describes for a missing relation).
    def test_a_suspended_trip_s_job_is_annotated_not_hidden_in_failures(self):
        self.tool("failures", {}, env=self.fixtures_env([("information_schema.columns", [["t"]])]))
        joined = "\n".join(self.statements())
        self.assertIn("t.suspended_at IS NOT NULL", joined)
        self.assertIn("SUSPENDED", joined)

    def test_failures_degrades_when_the_suspended_at_column_does_not_exist(self):
        """No fixture match for information_schema.columns == the column
        isn't there. The query must then never reference t.suspended_at at
        all, rather than fail outright the way a bare missing-column
        reference would."""
        self.tool("failures", {}, env=self.fixtures_env([]))
        joined = "\n".join(self.statements())
        self.assertNotIn("t.suspended_at", joined)
        self.assertIn("WHEN false THEN", joined)

    # --------------------------------------------------------- failed reads --
    def test_a_failed_query_is_reported_as_a_failure_not_as_no_rows(self):
        text, is_error = self.tool("fleet_overview", env={"FLEET_TEST_FAIL": "1"})
        self.assertTrue(is_error)
        self.assertIn("Tool failed", text)
        self.assertNotIn("(none)", text)

    def test_the_cli_stays_silent_when_alerts_are_empty(self):
        proc = subprocess.run(
            [NODE, str(SERVER), "--tool", "alerts"],
            capture_output=True, text=True, timeout=60,
            env={**os.environ, "KINERARY_FLEET_CONFIG": str(self.config),
                 "FLEET_TEST_SQL_LOG": str(self.log)},
        )
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertEqual(proc.stdout, "", "a watchdog would treat this as a change")

    # ------------------------------------------------------------- the digest --
    #
    # `format: "digest"` is the compact rendering the daily digest sends to
    # Telegram with no model in between. What is pinned: the agent's own text is
    # byte for byte what it was; the digest form carries every number the text
    # does; and it contains nothing Telegram would draw as a box, a block quote
    # or an italic title (measured against Hermes's own converter, 2026-09-28).

    def fixtures_env(self, fixtures: list | None = None) -> dict:
        path = self.tmp / "fixtures.json"
        path.write_text(json.dumps(FIXTURES if fixtures is None else fixtures))
        return {"FLEET_TEST_FIXTURES": str(path)}

    def rendered(self, tool: str, arguments: dict | None = None, fixtures: list | None = None) -> str:
        text, is_error = self.tool(tool, arguments or {}, self.fixtures_env(fixtures))
        self.assertFalse(is_error, text)
        return text

    def assert_telegram_safe(self, text: str) -> None:
        self.assertNotIn("```", text, "a code fence is drawn as a box")
        self.assertNotIn("|", text, "a pipe table needs a code fence to keep its columns")
        for line in text.splitlines():
            self.assertFalse(line.startswith(">"), f"a line starting with '>' is a block quote: {line!r}")
        # Every asterisk belongs to a **bold** pair: a single *x* is italic.
        self.assertNotIn("*", re.sub(r"\*\*[^*\n]+\*\*", "", text), "a lone asterisk renders as italic")
        self.assertLess(len(text.encode("utf-16-le")) // 2, 3500, "too long to arrive as one message")

    def test_the_default_output_of_the_digest_tools_is_unchanged(self):
        """The agent reads this text, and Hermes hashes the alerts bytes."""
        self.assertEqual(self.rendered("fleet_overview"), TEXT_OVERVIEW)
        self.assertEqual(self.rendered("statistics", {"days": 7}), TEXT_STATISTICS)
        self.assertEqual(self.rendered("alerts"), TEXT_ALERTS)
        # An explicit "text" is the default, not a third format.
        self.assertEqual(self.rendered("alerts", {"format": "text"}), TEXT_ALERTS)

    def test_the_overview_digest_carries_every_fact_without_boxes(self):
        text = self.rendered("fleet_overview", {"format": "digest"})
        self.assertEqual(text, DIGEST_OVERVIEW)
        self.assert_telegram_safe(text)
        self.assertIn("**Trips**", text)

    def test_the_stack_line_is_the_label_and_only_a_non_production_stack_is_flagged(self):
        production = self.rendered("fleet_overview", {"format": "digest"})
        self.assertEqual(production.splitlines()[0], "a control plane", "a production stack needs no suffix")
        stacks = json.loads(self.config.read_text())
        stacks["stacks"]["prod"]["production"] = False
        self.config.write_text(json.dumps(stacks))
        staging = self.rendered("fleet_overview", {"format": "digest"})
        self.assertEqual(staging.splitlines()[0], "a control plane · NOT PRODUCTION")

    def test_the_statistics_digest_carries_every_number(self):
        text = self.rendered("statistics", {"days": 7, "format": "digest"})
        self.assertEqual(text, DIGEST_STATISTICS)
        self.assert_telegram_safe(text)

    def test_the_alerts_digest_lists_every_incident(self):
        text = self.rendered("alerts", {"format": "digest"})
        self.assertEqual(text, DIGEST_ALERTS)
        self.assert_telegram_safe(text)
        # Every trip the text form names is in the digest form: the two are
        # renderings of the same incidents.
        for slug in re.findall(r"• (\S+) ", TEXT_ALERTS):
            self.assertIn(slug, text)

    def test_a_healthy_fleet_is_still_empty_in_the_digest_form(self):
        """Empty is the contract; the digest script words it, and only on success."""
        self.assertEqual(self.rendered("alerts", {"format": "digest"}, fixtures=[]), "")

    def test_the_digest_form_asks_the_database_nothing_new(self):
        for tool, arguments in (("fleet_overview", {}), ("statistics", {"days": 7}), ("alerts", {})):
            self.log.unlink(missing_ok=True)
            self.rendered(tool, arguments)
            text_sql = sorted(self.statements())
            self.log.unlink(missing_ok=True)
            self.rendered(tool, {**arguments, "format": "digest"})
            self.assertEqual(sorted(self.statements()), text_sql, f"{tool}: the digest form runs different SQL")

    def test_an_unknown_format_is_refused(self):
        text, is_error = self.tool("alerts", {"format": "html"}, self.fixtures_env())
        self.assertTrue(is_error)
        self.assertIn("format must be", text)

    def test_the_digest_format_is_not_offered_to_the_agent(self):
        """A rendering for the cron job, not a tool surface the agent learns."""
        for tool in self.call([{"jsonrpc": "2.0", "id": 1, "method": "tools/list"}])[0]["result"]["tools"]:
            self.assertNotIn("format", tool["inputSchema"].get("properties", {}), tool["name"])

    def test_a_stage_or_class_the_digest_has_never_heard_of_is_still_shown(self):
        fixtures = [
            ["FROM control_plane.trips t GROUP BY 1,2", [["live", "sealed", "1"], ["weird", "haunted", "2"]]],
            ["SELECT j.job_type, j.state", [["provision", "haunted", "3"], ["cleanup", "succeeded", "4"]]],
        ]
        text = self.rendered("fleet_overview", {"format": "digest"}, fixtures)
        self.assertIn("• live: 1 sealed — 1 in flight", text)
        self.assertIn("• weird: 2 haunted", text)
        self.assertIn("• provision: 3 haunted", text)
        self.assertIn("• cleanup: 4 succeeded", text)
        self.assert_telegram_safe(text)

    def test_a_traveller_s_words_cannot_make_markup_in_the_digest(self):
        """A companion's bug summary is free text: no fence, no link, no bold, one line."""
        hostile = "```\x1e> **all fine** [click](http://e.example) `x`"
        fixtures = [["companion_bug_reports r\n", [["trip-d", "bug", hostile, "rep_1", "2026-09-27 08:00 UTC"]]]]
        # A fixture list stops matching earlier markers, so give the guard its answer too.
        text = self.rendered("alerts", {"format": "digest"}, [["to_regclass", [["t"]]], *fixtures])
        self.assertEqual(len(text.splitlines()), 2, text)
        self.assertNotIn("[", text)
        self.assertNotIn("](", text)
        self.assertNotIn("**all fine**", text)
        self.assertIn("trip-d", text)
        self.assert_telegram_safe(text)

    def test_a_long_run_of_incidents_is_capped_and_says_so(self):
        rows = [[f"trip-{i:02d}", "provision", "TIMED_OUT", "3/3"] for i in range(13)]
        text = self.rendered("alerts", {"format": "digest"}, [["j.state = 'failed' AND", rows]])
        self.assertEqual(text.count("• failed job: trip-"), 10)
        self.assertIn("• failed job: …and 3 more", text)
        # ... while the agent's own text lists all of them.
        self.assertEqual(self.rendered("alerts", fixtures=[["j.state = 'failed' AND", rows]]).count("trip-"), 13)

    # ------------------------------------------------------ companion usage --
    #
    # `statistics` reads control_plane.assistant_events (metadata-only relay
    # facts). That table does not exist before Release A and is empty wherever
    # the relay does not write it, so "nothing to report" has several causes that
    # must never look alike, and never look like a row of zeros.

    def usage(self, fixtures: list, arguments: dict | None = None) -> str:
        """The statistics digest with every funnel fixture, plus these usage ones."""
        return self.rendered("statistics", {"days": 7, "format": "digest", **(arguments or {})},
                             [*fixtures, *FIXTURES])

    def usage_text(self, fixtures: list) -> str:
        return self.rendered("statistics", {"days": 7}, [*fixtures, *FIXTURES])

    NO_TABLE = "companion usage: not available — this database has no assistant_events table yet"

    def test_no_table_yet_is_said_in_words_and_the_rest_of_the_digest_survives(self):
        for render in (self.usage, self.usage_text):
            self.log.unlink(missing_ok=True)
            text = render([["to_regclass", [["f"]]]])
            self.assertIn(self.NO_TABLE, text)
            self.assertNotIn("0 requests", text)
            # The relation is named in a query only after the guard said it exists.
            self.assertFalse([s for s in self.statements() if "FROM control_plane.assistant_events" in s],
                             "queried a table the guard said is not there")
        digest = self.usage([["to_regclass", [["f"]]]])
        self.assertIn("• trips created: 3", digest)
        self.assertIn("• median duration: build 2 min", digest)

    def test_a_missing_table_reported_by_postgres_itself_is_the_same_state(self):
        """The guard can pass and the table be gone a moment later: 42P01 is state (a), not an error."""
        err = 'psql:<stdin>:3: ERROR:  relation "control_plane.assistant_events" does not exist'
        text = self.usage([["max(e.occurred_at)", err]])
        self.assertIn(self.NO_TABLE, text)
        self.assertNotIn("could not be read", text)

    def test_a_table_that_never_held_a_row_is_not_collected_not_zero(self):
        for render in (self.usage, self.usage_text):
            text = render([["max(e.occurred_at)", [["0", ""]]]])
            self.assertIn(
                "companion usage: not collected — assistant events are switched off on this stack "
                "(relay ASSISTANT_EVENTS_ENABLED); these would be zeros, not measurements", text)
            self.assertNotIn(" requests", text)
            self.assertNotIn("(0%)", text)
            self.assertNotIn("(n/a)", text)

    def test_no_answer_at_all_from_the_count_is_not_a_zero_either(self):
        """A count query that returns no row is a failed read, not an empty table."""
        text = self.usage([["max(e.occurred_at)", []]])
        self.assertIn("companion usage: could not be read", text)
        self.assertNotIn("not collected", text)

    def test_rows_that_exist_but_none_in_the_window_say_when_the_last_one_was(self):
        for render in (self.usage, self.usage_text):
            text = render([["max(e.occurred_at)", [["41", "2026-09-20"]]], ["x.response_latency_ms", []]])
            self.assertIn("no companion activity in the last 7 days (last event 2026-09-20)", text)
            self.assertNotIn("companion usage: not collected", text)
            self.assertNotIn(" requests", text)

    def test_any_other_database_error_is_named_and_the_rest_of_the_digest_still_renders(self):
        for error in ("ERROR:  permission denied for table assistant_events",
                      "ERROR:  canceling statement due to statement timeout"):
            reason = error.split("ERROR:  ")[1]
            digest = self.usage([["max(e.occurred_at)", error]])
            self.assertIn(f"companion usage: could not be read ({reason})", digest)
            self.assertNotIn("not available", digest)
            self.assertNotIn("not collected", digest)
            # the funnel, provisioning and durations sections are all still there
            self.assertIn("**Last 7 days**", digest)
            self.assertIn("• trips created: 3 (live 1 · prospect 2)", digest)
            self.assertIn("• provisioning: 1 succeeded", digest)
            self.assertIn("• median duration: build 2 min · interview 22 min", digest)
            text = self.usage_text([["max(e.occurred_at)", error]])
            self.assertIn(f"companion usage: could not be read ({reason})", text)
            self.assertIn("FUNNEL", text)
            self.assertIn("DURATIONS", text)

    def test_the_window_query_failing_is_also_could_not_be_read(self):
        digest = self.usage([["max(e.occurred_at)", [["50", "2026-09-27"]]],
                             ["x.response_latency_ms", "ERROR:  column reference is ambiguous"]])
        self.assertIn("companion usage: could not be read (column reference is ambiguous)", digest)
        self.assertIn("• trips created: 3", digest)

    def test_an_error_reason_never_carries_connection_details(self):
        """A failure that is not a database ERROR line (ssh, docker, psql itself) prints nothing of its text."""
        digest = self.usage([["max(e.occurred_at)", "ssh: connect to host 10.9.8.7 port 22: Connection refused"]])
        self.assertIn("companion usage: could not be read (the query failed)", digest)
        self.assertNotIn("10.9.8.7", digest)

    def test_an_answer_that_is_not_numbers_is_an_error_not_zeros(self):
        digest = self.usage([["max(e.occurred_at)", [["3", "2026-09-27"]]],
                             ["x.response_latency_ms", [["japan-2026", "live", "lots"] + ["0"] * 12]]])
        self.assertIn("companion usage: could not be read", digest)
        self.assertNotIn("lots", digest)

    #: slug, class, requests, delivered, failed, suppressed, lost (gateway), lost (companion),
    #: chatter, median ms, with media, group, dm, organizer, participant
    USAGE_ROWS = [
        ["japan-2026", "live", "12", "12", "0", "0", "0", "0", "9", "15000", "2", "8", "4", "5", "7"],
        ["orlando-2026", "live", "10", "7", "1", "1", "1", "1", "0", "2300", "0", "0", "10", "10", "0"],
        ["quiet-2026", "live", "0", "0", "0", "0", "0", "0", "4", "", "0", "0", "0", "0", "0"],
        ["retired-a-20260901", "retired", "3", "3", "0", "0", "0", "0", "1", "1000", "0", "3", "0", "1", "2"],
        ["retired-b-20260902", "retired", "2", "1", "0", "0", "1", "0", "0", "800", "1", "0", "2", "2", "0"],
    ]

    def usage_fixtures(self, rows: list | None = None) -> list:
        return [["max(e.occurred_at)", [["77", "2026-09-28"]]],
                ["x.response_latency_ms", self.USAGE_ROWS if rows is None else rows]]

    def test_the_digest_has_one_bullet_per_trip_with_counts_rate_and_median(self):
        text = self.usage(self.usage_fixtures())
        self.assertIn("**Companion usage**", text)
        self.assertIn(
            "• japan-2026: 12 requests · 12 replies (100%) · 0 failed · 0 lost · 9 chatter ignored · median 15s"
            " · group 8 / DM 4 · organizer 5 / participants 7 · 2 with media", text)
        # An under-100% reply rate says so, and every loss is itemised where it happened.
        self.assertIn(
            "• ⚠️ orlando-2026: 10 requests · 7 replies (70%, under 100%) · 1 failed · 1 suppressed"
            " · 2 lost (1 gateway unavailable · 1 companion unreachable) · 0 chatter ignored · median 2.3s"
            " · group 0 / DM 10 · organizer 10 / participants 0", text)
        # Chatter with no request is not a reply rate of 0%.
        self.assertIn("• quiet-2026: 0 requests · 0 replies (n/a) · 0 failed · 0 lost · 4 chatter ignored · median n/a", text)
        self.assert_telegram_safe(text)
        self.assertNotIn("╔", text)

    def test_test_run_trips_are_one_line_per_class_marked_as_such(self):
        """Exactly as `trips created` treats retired and scaffolding: counted, labelled, never per-trip."""
        text = self.usage(self.usage_fixtures())
        self.assertIn("• retired: 5 requests · 4 replies · 1 lost · 1 chatter ignored (test runs, ignore)", text)
        self.assertNotIn("retired-a-20260901", text)
        self.assertNotIn("retired-b-20260902", text)
        # and never flagged with a warning, whatever their rate
        self.assertNotIn("⚠️ retired", text)

    def test_usage_comes_after_the_funnel_and_nothing_before_it_moved(self):
        text = self.usage(self.usage_fixtures())
        self.assertEqual(text.splitlines()[0], "**Last 7 days**")
        self.assertLess(text.index("• median duration"), text.index("**Companion usage**"))

    def test_the_text_rendering_carries_the_same_counts_as_a_table_and_the_tool_usage_line(self):
        text = self.usage_text(self.usage_fixtures())
        self.assertIn("COMPANION USAGE", text)
        section = text.split("COMPANION USAGE", 1)[1]
        self.assertIn("trip | class | requests | replies | reply rate | failed | suppressed | lost (gateway)"
                      " | lost (companion) | chatter ignored | median reply | with media | group | dm"
                      " | organizer | participant", section)
        self.assertIn("japan-2026 | live | 12 | 12 | 100% | 0 | 0 | 0 | 0 | 9 | 15s | 2 | 8 | 4 | 5 | 7", section)
        self.assertIn("orlando-2026 | live | 10 | 7 | 70% | 1 | 1 | 1 | 1 | 0 | 2.3s | 0 | 0 | 10 | 10 | 0", section)
        self.assertIn("quiet-2026 | live | 0 | 0 | n/a", section)
        self.assertIn("retired-a-20260901 | retired | 3 | 3 | 100%", section)
        self.assertIn("tool usage: not collected on this stack (no hermes_logs_dir configured)", section)

    def test_tool_usage_is_in_the_text_only_and_in_every_state(self):
        self.assertNotIn("tool usage", self.usage(self.usage_fixtures()))
        self.assertNotIn("tool usage", self.usage([["to_regclass", [["f"]]]]))
        # None of these fixture combinations configure hermes_logs_dir, so every
        # one of them is the not_configured state regardless of what companion
        # usage is doing — the two sections are independent.
        for fixtures in ([["to_regclass", [["f"]]]], [["max(e.occurred_at)", [["0", ""]]]],
                         [["max(e.occurred_at)", [["4", "2026-09-01"]]]],
                         [["max(e.occurred_at)", "ERROR:  boom"]], self.usage_fixtures()):
            self.assertIn(
                "tool usage: not collected on this stack (no hermes_logs_dir configured)",
                self.usage_text(fixtures),
            )

    def test_the_usage_query_reads_only_counts_and_named_columns(self):
        """Metadata only: never event_id, turn_id or metadata — and the role is not granted them."""
        self.usage(self.usage_fixtures())
        sent = [s for s in self.statements() if "control_plane.assistant_events" in s and "to_regclass" not in s]
        self.assertGreaterEqual(len(sent), 2)
        for statement in sent:
            for column in ("event_id", "turn_id", "metadata", "trigger_type", "message_length_bucket", "SELECT *", "e.*"):
                self.assertNotIn(column, statement)
        window = [s for s in sent if "response_latency_ms" in s]
        self.assertEqual(len(window), 1)
        self.assertIn("interval '7 days'", window[0])
        for word in ("reply_delivered", "failed_delivery", "reply_suppressed", "lost_gateway_unavailable",
                     "lost_companion_unreachable", "ignored_not_addressed", "request_forwarded",
                     "request_to_relay"):
            self.assertIn(word, window[0])
        # test-run classification is the stack's own, not a copy of it
        self.assertIn("WHEN t.slug LIKE 'retired-%' THEN 'retired'", window[0])

    def test_a_stack_s_own_trip_class_override_is_used_for_usage_too(self):
        stacks = json.loads(self.config.read_text())
        stacks["stacks"]["prod"]["trip_class_sql"] = "'weird'"
        self.config.write_text(json.dumps(stacks))
        self.usage(self.usage_fixtures())
        window = [s for s in self.statements() if "response_latency_ms" in s][0]
        self.assertIn("'weird'", window)
        self.assertNotIn("LIKE 'retired-%'", window)

    def test_a_slug_with_markup_cannot_make_markup_in_the_usage_bullets(self):
        rows = [["**bold** [x](http://e.example) `c`", "live", "1", "1", "0", "0", "0", "0", "0", "1000", "0", "1", "0", "1", "0"]]
        text = self.usage(self.usage_fixtures(rows))
        self.assertIn("• bold (x)(http://e.example) c: 1 request · 1 reply (100%)", text)
        self.assertNotIn("[", text)
        self.assertNotIn("](", text)
        self.assert_telegram_safe(text)

    def test_a_class_the_deployment_invented_is_shown_by_name(self):
        rows = [["sandbox-1", "weird", "2", "2", "0", "0", "0", "0", "0", "1000", "0", "0", "2", "2", "0"]]
        self.assertIn("• sandbox-1: 2 requests · 2 replies (100%)", self.usage(self.usage_fixtures(rows)))

    def test_many_active_trips_stay_within_one_message(self):
        rows = [[f"trip-{i:03d}", "live", "5", "5", "0", "0", "0", "0", "1", "1000", "0", "2", "3", "2", "3"]
                for i in range(60)]
        text = self.usage(self.usage_fixtures(rows))
        self.assertEqual(text.count("• trip-"), 15)
        self.assertIn("• …and 45 more trips with companion activity (the statistics tool lists them all)", text)
        self.assert_telegram_safe(text)
        self.assertEqual(self.usage_text(self.usage_fixtures(rows)).count("trip-0"), 60)

    # ------------------------------------------------------------ tool usage --
    #
    # Interim source approved 2026-09-28: real counts read straight from the
    # Hermes relay's own `agent.log` files, not the database — dropped once a
    # proper Hermes-hook pipeline exists. Unlike every other tool in this file
    # this is not psql at all, so these tests point `hermes_logs_dir` at a real
    # local temp directory with real fixture log files, and the server's own
    # find/awk pipeline runs for real against them — no fake binary needed
    # (there is no `argv`-style escape hatch to stub here; the local, ssh-less
    # branch this function builds is the thing under test).

    NOT_CONFIGURED = "tool usage: not collected on this stack (no hermes_logs_dir configured)"

    @staticmethod
    def tool_log_line(day: str, time: str, tool: str, session: str = "20260923_180308_9b7827a0",
                       duration: str = "0.07s", size: str = "594 chars") -> str:
        """One real-shape Hermes tool-completion log line.

        Matches the verbatim lines pulled off the VM's `agent.log` on
        2026-09-29 — a bracketed run id between the level and the marker, and
        trailing `(<duration>, <size>)` after the word "completed". The old
        fixture shape (`... agent.tool_executor: tool <name> completed`, with
        nothing after "completed") is not what production ever wrote; the
        parser must accept this shape, not that one.
        """
        return (f"{day} {time} INFO [{session}] agent.tool_executor: "
                f"tool {tool} completed ({duration}, {size})")

    def configure_hermes_logs_dir(self, path: Path) -> None:
        stacks = json.loads(self.config.read_text())
        stacks["stacks"]["prod"]["hermes_logs_dir"] = str(path)
        self.config.write_text(json.dumps(stacks))

    def write_hermes_log(self, profile: str, filename: str, lines: list[str]) -> None:
        path = self.tmp / "hermes-logs" / profile / "logs" / filename
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text("\n".join(lines) + "\n")

    def tool_usage_text(self, days: int = 7) -> str:
        return self.rendered("statistics", {"days": days}, FIXTURES)

    def test_tool_usage_not_configured_when_hermes_logs_dir_is_absent(self):
        """The default stack in setUp never sets hermes_logs_dir."""
        text = self.tool_usage_text()
        self.assertIn(self.NOT_CONFIGURED, text)

    def test_tool_usage_unreadable_and_the_rest_of_statistics_still_renders(self):
        """A command that exits nonzero with a stderr line — here, a directory that isn't there."""
        self.configure_hermes_logs_dir(self.tmp / "does-not-exist")
        text = self.tool_usage_text()
        self.assertIn("tool usage: could not be read (", text)
        self.assertNotIn(self.NOT_CONFIGURED, text)
        self.assertNotIn("no tool calls", text)
        # This section failing must never take the rest of `statistics` with it.
        self.assertIn("FUNNEL", text)
        self.assertIn("DURATIONS", text)
        self.assertIn("COMPANION USAGE", text)

    def test_tool_usage_no_activity_when_files_exist_but_nothing_matches_the_window(self):
        old = (date.today() - timedelta(days=30)).isoformat()
        self.write_hermes_log("japan-2026", "agent.log", [
            self.tool_log_line(old, "09:00:00,000", "old_tool"),
            "this line does not match the log shape at all",
        ])
        self.configure_hermes_logs_dir(self.tmp / "hermes-logs")
        text = self.tool_usage_text()
        self.assertIn("tool usage: no tool calls in the last 7 days", text)
        self.assertNotIn(self.NOT_CONFIGURED, text)
        self.assertNotIn("could not be read", text)

    def test_tool_usage_activity_counts_across_profiles_and_rotated_logs(self):
        today = date.today()
        recent = today.isoformat()
        recent2 = (today - timedelta(days=1)).isoformat()
        just_inside = (today - timedelta(days=5)).isoformat()
        outside = (today - timedelta(days=20)).isoformat()
        secret = "sk-FAKESECRET1234567890"

        self.write_hermes_log("japan-2026", "agent.log", [
            self.tool_log_line(recent, "10:00:00,000", "get_config"),
            self.tool_log_line(recent, "10:00:05,000", "get_config"),
            self.tool_log_line(outside, "09:00:00,000", "old_tool"),
            # A fake-secret-looking value in an unrelated column, on a line that
            # does not match the fixed log shape: must never reach the output.
            f"{recent} 10:01:00,000 DEBUG chat_id=-1009999999999 secret={secret}",
        ])
        # A rotated log file: its lines count exactly like the live one.
        self.write_hermes_log("japan-2026", "agent.log.1", [
            self.tool_log_line(just_inside, "08:00:00,000", "send_message"),
        ])
        self.write_hermes_log("orlando-2026", "agent.log", [
            self.tool_log_line(recent2, "12:00:00,000", "get_config"),
            self.tool_log_line(recent2, "12:00:01,000", "web_search"),
            self.tool_log_line(outside, "00:00:00,000", "ancient_tool"),
            "not a log line at all just noise",
        ])
        self.configure_hermes_logs_dir(self.tmp / "hermes-logs")
        text = self.tool_usage_text()

        self.assertNotIn(secret, text, "a raw log line (or any of its columns) leaked into the output")
        self.assertNotIn("chat_id", text)
        self.assertNotIn(self.NOT_CONFIGURED, text)
        self.assertNotIn("could not be read", text)
        self.assertNotIn("no tool calls", text)
        self.assertIn("TOOL USAGE", text)
        self.assertIn("get_config: 3", text)
        self.assertIn("send_message: 1", text)
        self.assertIn("web_search: 1", text)
        self.assertNotIn("old_tool", text, "a line outside the window was counted")
        self.assertNotIn("ancient_tool", text, "a line outside the window was counted")
        self.assertIn("active profiles: japan-2026, orlando-2026", text)

    def test_tool_usage_caps_the_list_and_says_so(self):
        today = date.today().isoformat()
        lines = [self.tool_log_line(today, f"09:{i:02d}:00,000", f"tool_{i:02d}") for i in range(20)]
        self.write_hermes_log("japan-2026", "agent.log", lines)
        self.configure_hermes_logs_dir(self.tmp / "hermes-logs")
        text = self.tool_usage_text()
        shown = re.findall(r"tool_\d\d: 1", text)
        self.assertEqual(len(shown), 15, text)
        self.assertIn("…and 5 more", text)

    def test_tool_usage_counts_verbatim_production_lines(self):
        """The exact lines pulled off the VM's agent.log on 2026-09-29 that the
        merged #312 parser silently failed to count (reported `no_activity`
        against 374 and 41 real matching lines). If this regresses, the fix
        this brief exists for has regressed with it."""
        today = date.today().isoformat()
        self.write_hermes_log("japan-2026", "agent.log", [
            f"{today} 18:03:17,352 INFO [20260923_180308_9b7827a0] agent.tool_executor: "
            "tool mcp__trip_mcp__get_today completed (0.07s, 594 chars)",
            f"{today} 18:30:35,472 INFO [20260923_180308_9b7827a0] agent.tool_executor: "
            "tool tool_search completed (0.01s, 480 chars)",
            f"{today} 20:30:09,882 INFO [20260915_203000_54e258] agent.tool_executor: "
            "tool skill_view completed (0.03s, 3979 chars)",
            f"{today} 20:30:09,898 INFO [20260915_203000_54e258] agent.tool_executor: "
            "tool tool_describe completed (0.01s, 605 chars)",
            f"{today} 20:30:12,647 INFO [20260915_203000_54e258] agent.tool_executor: "
            "tool mcp__trip_mcp__get_agent_brief completed (0.03s, 2297 chars)",
        ])
        self.configure_hermes_logs_dir(self.tmp / "hermes-logs")
        text = self.tool_usage_text()

        self.assertNotIn(self.NOT_CONFIGURED, text)
        self.assertNotIn("could not be read", text)
        self.assertNotIn("no tool calls", text, "the real production shape must not be reported as no activity")
        self.assertIn("TOOL USAGE", text)
        self.assertIn("mcp__trip_mcp__get_today: 1", text)
        self.assertIn("tool_search: 1", text)
        self.assertIn("skill_view: 1", text)
        self.assertIn("tool_describe: 1", text)
        self.assertIn("mcp__trip_mcp__get_agent_brief: 1", text)

    def test_tool_usage_still_excludes_completed_lookalikes(self):
        """A word that merely starts with "completed" (or has it glued to more
        text with no space) must stay excluded, real trailing text or not."""
        today = date.today().isoformat()
        self.write_hermes_log("japan-2026", "agent.log", [
            self.tool_log_line(today, "09:00:00,000", "get_config").replace(
                "completed (0.07s", "completedish (0.07s"),
            f"{today} 09:01:00,000 INFO agent.tool_executor: tool get_config completedwithnospace",
            f"{today} 09:02:00,000 INFO agent.tool_executor: tool get_config failed (0.02s, 10 chars)",
        ])
        self.configure_hermes_logs_dir(self.tmp / "hermes-logs")
        text = self.tool_usage_text()
        self.assertIn("tool usage: no tool calls in the last 7 days", text)


if __name__ == "__main__":
    unittest.main()
