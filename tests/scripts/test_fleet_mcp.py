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
  interview minutes (median) | 22"""

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
• median duration: build 2 min · interview 22 min"""

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


if __name__ == "__main__":
    unittest.main()
