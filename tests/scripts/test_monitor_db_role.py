"""The fleet monitor's read-only database role.

control-plane/deployment/monitor-db-role.sql and scripts/create-monitor-db-role.sh
give the fleet monitor a login that reads what fleet-mcp.mjs reads and nothing
else. The monitor's database URL sits in a Hermes profile, and a Hermes host can
run every profile — traveller-facing companions included — in one container as
one uid, so whoever can be talked into reading that file holds the credential.
What is pinned here:

- the grant list names exactly the relations fleet-mcp.mjs queries (no database
  needed: a new query on a new table fails here, saying to update the role);
- against a real PostgreSQL carrying every migration: every fleet tool answers
  as the role with the same rows the database owner gets, and every granted
  column is one some query needs (least privilege, measured, not asserted);
- writes are refused by the privileges themselves, not by the read-only session
  default a client can switch off; nothing outside the list can be read;
- the script is idempotent, `--check` changes nothing and fails loudly on
  drift, `--rotate` replaces the password atomically, and the password never
  reaches its output, any child's argument list, or the server.

    python3 -B -m unittest tests.scripts.test_monitor_db_role

The database half needs docker and a local postgres:16-alpine image (the one the
VM runs); without them it is skipped, never failed. Failure messages here never
include a password or a URL: assertions on secret-bearing text use assertTrue
with a fixed message, because assertIn/assertEqual print their operands.
"""
from __future__ import annotations

import json
import os
import re
import secrets
import shutil
import stat
import subprocess
import sys
import tempfile
import time
import unittest
import uuid
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SQL_FILE = ROOT / "control-plane" / "deployment" / "monitor-db-role.sql"
SCRIPT = ROOT / "scripts" / "create-monitor-db-role.sh"
SERVER = ROOT / ".agents" / "skills" / "trip-fleet-monitor" / "fleet-mcp.mjs"
MIGRATIONS = ROOT / "control-plane" / "db" / "migrations"
IMAGE = "postgres:16-alpine"
BASH5_IMAGE = "node:20"  # Debian: bash 5, python3 and openssl, like the VM
DOCKER = shutil.which("docker")
NODE = shutil.which("node")
BASH = "/bin/bash" if Path("/bin/bash").exists() else shutil.which("bash")
ADMIN = "kinerary_control_plane"
ROLE = "kinerary_fleet_ro"
REQUIRED_ENV = ("PSQL_CMD", "MONITOR_DB_URL_FILE", "MONITOR_DB_URL_OWNER",
                "MONITOR_DB_HOST", "MONITOR_DB_PORT", "MONITOR_DB_NAME")


def image_present(image: str) -> bool:
    if not DOCKER:
        return False
    return subprocess.run([DOCKER, "image", "inspect", image], capture_output=True).returncode == 0


def grant_list() -> dict[str, set[str]]:
    """The relations and columns monitor-db-role.sql grants, read from the file."""
    text = SQL_FILE.read_text()
    match = re.search(r"\$grants\$\n(.*?)\$grants\$", text, re.S)
    assert match, "monitor-db-role.sql has no $grants$ block"
    grants: dict[str, set[str]] = {}
    for line in match.group(1).splitlines():
        if not line.strip():
            continue
        relation, _, columns = line.partition(":")
        grants.setdefault(relation.strip(), set()).update(columns.split())
    return grants


def fleet_relations() -> set[str]:
    """Every relation fleet-mcp.mjs names. Its SQL qualifies every table."""
    source = SERVER.read_text()
    return set(re.findall(r"\b((?:control_plane|public)\.[a-z_][a-z0-9_]*)", source))


def secret_free(text: str) -> str:
    """For failure messages about text that might hold a URL: never print it."""
    return re.sub(r"postgres(?:ql)?://\S+", "postgresql://<redacted>", text)


# ─────────────────────────────────────────────── no database needed ─────────
class GrantListMatchesTheCatalogue(unittest.TestCase):
    """The drift guard that runs everywhere: relations, statically."""

    def test_the_grant_list_names_exactly_the_relations_fleet_mcp_reads(self):
        granted = set(grant_list())
        read = fleet_relations()
        self.assertTrue(read, "found no relation in fleet-mcp.mjs — has the query style changed?")
        missing = sorted(read - granted)
        extra = sorted(granted - read)
        self.assertEqual(
            missing, [],
            f"fleet-mcp.mjs reads {missing}, which the monitor's database role cannot. Add each, with the "
            "columns its queries use, to the grant list in control-plane/deployment/monitor-db-role.sql, "
            "then re-apply the role on every deployment (scripts/create-monitor-db-role.sh) — until then "
            "the monitor's tool fails with 'permission denied'.")
        self.assertEqual(
            extra, [],
            f"monitor-db-role.sql grants {extra}, which fleet-mcp.mjs no longer reads. Remove it from the "
            "grant list: the role reads what the monitor reads and nothing else.")

    def test_every_table_fleet_mcp_queries_is_schema_qualified(self):
        """Otherwise the relation list above could miss one."""
        source = SERVER.read_text()
        unqualified = [m.group(0) for m in re.finditer(r"\b(?:FROM|JOIN)\s+[A-Za-z_][A-Za-z0-9_.]*", source)
                       if not re.search(r"\s(?:control_plane|public)\.", m.group(0))]
        self.assertEqual(unqualified, [],
                         "a fleet-mcp.mjs query names a table without its schema; qualify it so the "
                         "monitor role's drift guard can see it")

    def test_the_grants_are_column_level_and_the_site_password_is_not_among_them(self):
        grants = grant_list()
        self.assertNotIn("companion_intro", grants["control_plane.trips"],
                         "trips.companion_intro holds each site's login password in plain text")
        self.assertNotIn("answers", grants["control_plane.intake_sessions"])
        self.assertNotIn("display_name", grants["control_plane.trip_person_links"])
        self.assertNotIn("token_digest", grants["control_plane.interview_enrollments"])
        for relation, columns in grants.items():
            self.assertTrue(columns, f"{relation} is listed with no columns")
            for column in columns:
                self.assertRegex(column, r"^[a-z_][a-z0-9_]*$")

    def test_companion_usage_is_granted_by_column_and_never_the_ids_or_metadata(self):
        """assistant_events is metadata-only by construction; the role reads only what the usage query counts."""
        columns = grant_list().get("control_plane.assistant_events")
        self.assertIsNotNone(columns, "fleet-mcp.mjs reads assistant_events but the role is not granted it")
        self.assertEqual(
            columns,
            {"trip_id", "occurred_at", "event_type", "channel_type", "requester_role", "outcome",
             "response_latency_ms", "media_kind"})
        for withheld in ("event_id", "turn_id", "metadata", "trigger_type", "message_length_bucket", "source_service"):
            self.assertNotIn(withheld, columns, f"assistant_events.{withheld} is not read by any monitor query")

    def test_the_runbook_states_the_number_of_relations_and_columns_the_role_grants(self):
        """The runbook once said 79 columns of 12 relations; a count in prose goes stale with the list."""
        grants = grant_list()
        relations, columns = len(grants), sum(len(c) for c in grants.values())
        runbook = re.sub(r"\s+", " ", (ROOT / "docs" / "control-plane-vm-deployment.md").read_text())
        self.assertIn(f"exactly the {columns} columns of the {relations} relations the fleet MCP reads", runbook,
                      f"the runbook's count of granted columns/relations is stale: the list grants {columns} "
                      f"columns of {relations} relations")

    def test_the_repository_holds_no_password_for_the_role(self):
        for path in (SQL_FILE, SCRIPT):
            text = path.read_text() if path.exists() else ""
            # A printf placeholder (%s) or a variable ($...) is not a password.
            self.assertIsNone(re.search(r"(?i)PASSWORD\s+'", text), f"{path.name} carries a password literal")
            self.assertIsNone(re.search(r"postgres(?:ql)?://[^\s:@/]+:[^\s@$%]+@", text),
                              f"{path.name} carries a URL with a password")


@unittest.skipUnless(BASH, "no bash")
class ScriptRefusesWithoutItsConfiguration(unittest.TestCase):
    """Generic: it names no deployment, so every value is required, and absent means refuse."""

    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="fleetro-refuse-"))
        self.addCleanup(shutil.rmtree, self.tmp, True)
        self.url_file = self.tmp / "url"
        self.env = {
            "PATH": os.environ.get("PATH", "/usr/bin:/bin"),
            "HOME": str(self.tmp),
            "PSQL_CMD": str(self.tmp / "never-run-psql"),
            "MONITOR_DB_URL_FILE": str(self.url_file),
            "MONITOR_DB_URL_OWNER": f"{os.getuid()}:{os.getgid()}",
            "MONITOR_DB_HOST": "db.invalid",
            "MONITOR_DB_PORT": "5432",
            "MONITOR_DB_NAME": "somedb",
        }
        marker = self.tmp / "psql-ran"
        psql = self.tmp / "never-run-psql"
        psql.write_text(f"#!/bin/sh\ntouch {marker}\nexit 1\n")
        psql.chmod(0o755)
        self.marker = marker

    def run_script(self, env: dict, *args: str) -> subprocess.CompletedProcess:
        return subprocess.run([BASH, str(SCRIPT), *args], capture_output=True, text=True, env=env, timeout=60)

    def test_each_required_variable_is_refused_when_unset(self):
        for name in REQUIRED_ENV:
            with self.subTest(variable=name):
                env = {k: v for k, v in self.env.items() if k != name}
                for mode in ((), ("--check",)):
                    proc = self.run_script(env, *mode)
                    self.assertNotEqual(proc.returncode, 0, f"ran without {name}")
                    self.assertIn(name, proc.stderr)
                    self.assertFalse(self.url_file.exists(), "wrote a URL file while refusing")
                    self.assertFalse(self.marker.exists(), "reached the database while refusing")

    def test_values_that_would_break_the_url_are_refused(self):
        for name, value in (("MONITOR_DB_PORT", "54x"), ("MONITOR_DB_HOST", "h@st/x"),
                            ("MONITOR_DB_NAME", "db?x=1"), ("MONITOR_DB_ROLE", "Robert'); DROP"),
                            ("MONITOR_DB_URL_OWNER", "")):
            with self.subTest(variable=name):
                proc = self.run_script({**self.env, name: value})
                self.assertNotEqual(proc.returncode, 0)
                self.assertIn(name, proc.stderr)
                self.assertFalse(self.marker.exists())

    def test_a_missing_directory_is_refused_not_created(self):
        proc = self.run_script({**self.env, "MONITOR_DB_URL_FILE": str(self.tmp / "no" / "such" / "url")})
        self.assertNotEqual(proc.returncode, 0)
        self.assertIn("MONITOR_DB_URL_FILE", proc.stderr)
        self.assertFalse((self.tmp / "no").exists())

    def test_an_unknown_flag_is_a_usage_error(self):
        proc = self.run_script(self.env, "--force")
        self.assertEqual(proc.returncode, 2)
        self.assertIn("usage", proc.stderr)

    @unittest.skipUnless(image_present(BASH5_IMAGE), f"docker with {BASH5_IMAGE} is not available (bash 5)")
    def test_bash_5_parses_it_and_refuses_the_same_way(self):
        # Checked first: a bind mount of a missing file makes docker create a
        # DIRECTORY at that path in the checkout.
        self.assertTrue(SCRIPT.is_file(), f"{SCRIPT} does not exist")
        mount =["-v", f"{SCRIPT}:/work/create-monitor-db-role.sh:ro"]
        parse = subprocess.run([DOCKER, "run", "--rm", *mount, BASH5_IMAGE, "bash", "-n",
                                "/work/create-monitor-db-role.sh"], capture_output=True, text=True, timeout=120)
        self.assertEqual(parse.returncode, 0, parse.stderr)
        refuse = subprocess.run([DOCKER, "run", "--rm", *mount, BASH5_IMAGE, "bash",
                                 "/work/create-monitor-db-role.sh", "--check"],
                                capture_output=True, text=True, timeout=120)
        self.assertNotEqual(refuse.returncode, 0)
        self.assertIn("PSQL_CMD", refuse.stderr)


# ──────────────────────────────────────────────── a real PostgreSQL ─────────
SEED = """
INSERT INTO control_plane.users (id, status, display_name) VALUES ('user_seed0001', 'active', 'Seed Organizer');
INSERT INTO control_plane.trips (id, slug, lifecycle_state, title, destination_label, start_date, end_date,
                                 reachability, unreachable_reason, companion_intro)
VALUES ('trip_seed0001', 'seed-live-2026', 'ready_private', 'Seed trip', 'Nowhere', '2026-10-01', '2026-10-09',
        'unreachable', 'TRIP_MCP_BRIDGE_FAILED', '{"login_password": "CANARY-SITE-PASSWORD"}'),
       ('trip_seed0002', 'draft-sreq-seed0002', 'intake_confirmed', NULL, NULL, NULL, NULL, 'unknown', NULL, NULL),
       ('trip_seed0003', 'retired-old-20260901', 'ready_private', NULL, NULL, NULL, NULL, 'unknown', NULL, NULL);
INSERT INTO control_plane.interview_enrollments (id, trip_id, user_id, token_digest, state, expires_at, consumed_at)
VALUES ('enr_seed00001', 'trip_seed0001', 'user_seed0001', 'sha256:' || repeat('a', 64), 'consumed',
        now() + interval '1 day', now() - interval '2 hours'),
       ('enr_seed00002', 'trip_seed0002', 'user_seed0001', 'sha256:' || repeat('b', 64), 'issued',
        now() - interval '1 day', NULL);
INSERT INTO control_plane.intake_sessions (id, trip_id, user_id, enrollment_id, state, answers, source_document,
                                           language, phase, awaiting, awaiting_since, updated_at, interpret_path)
VALUES ('sess_seed00001', 'trip_seed0001', 'user_seed0001', 'enr_seed00001', 'interviewing',
        '{"secret": "CANARY-ANSWER"}',
        '{"filename": "booking.pdf", "text": "CANARY-DOCUMENT-TEXT", "savedAt": "2026-09-27T10:00:00Z"}',
        'en', 'essentials', 'machine', now() - interval '3 hours', now() - interval '8 hours', true);
INSERT INTO control_plane.interview_interpretations (id, session_id, telegram_chat_id, burst_key, source_text, failure_reason)
VALUES ('interp_seed0001', 'sess_seed00001', '1001', 'b1', 'CANARY-TYPED-TEXT', 'TIMED_OUT');
INSERT INTO control_plane.plans (id, trip_id, kind, status, digest, desired)
VALUES ('plan_seed00001', 'trip_seed0001', 'provision', 'executed', 'sha256:' || repeat('c', 64), '{}');
INSERT INTO control_plane.jobs (id, trip_id, plan_id, job_type, idempotency_key, correlation_id, state, attempt,
                                safe_error_code, result, created_at, updated_at)
VALUES ('job_seed00001', 'trip_seed0001', 'plan_seed00001', 'provision', 'idem-1', 'corr_seed00001', 'succeeded', 1,
        NULL, '{"private_url": "https://seed.example.test/"}', now() - interval '2 days', now() - interval '2 days'),
       ('job_seed00002', 'trip_seed0001', 'plan_seed00001', 'upgrade', 'idem-2', 'corr_seed00002', 'failed', 3,
        'UPSTREAM_DOWN', NULL, now() - interval '1 day', now() - interval '1 day');
INSERT INTO control_plane.job_steps (id, job_id, step_key, state, idempotency_key, safe_error_code)
VALUES ('step_seed00001', 'job_seed00002', 'deploy_site', 'failed', 'idem-s1', 'UPSTREAM_DOWN');
INSERT INTO control_plane.notification_outbox (id, notification_type, adapter, state, attempt, max_attempts, trip_id,
                                               kind, recipient, payload)
VALUES ('ntf_seed00001', 'trip_ready', 'telegram', 'failed', 3, 3, 'trip_seed0001', 'ready', 'CANARY-RECIPIENT',
        '{"text": "CANARY-PAYLOAD"}');
INSERT INTO control_plane.telegram_chat_bindings (id, chat_id, trip_id, hermes_profile)
VALUES ('tcb_seed00001', '-1009', 'trip_seed0001', 'seedprofile');
INSERT INTO control_plane.trip_person_links (id, trip_id, telegram_user_id, participant_username, display_name, role,
                                             verified_via)
VALUES ('tpl_seed00001', 'trip_seed0001', '1001', 'CANARY-USERNAME', 'CANARY-NAME', 'organizer', 'interview_chat');
INSERT INTO control_plane.intake_versions (id, trip_id, version, artifact_ref, digest, confirmed_at, data)
VALUES ('iv_seed000001', 'trip_seed0002', 1, 'artifact-1', 'sha256:' || repeat('d', 64), now() - interval '5 days', '{}');
INSERT INTO control_plane.companion_bug_reports (id, trip_id, hermes_profile, kind, summary, detail, quote, surface)
VALUES ('bug_seed00001', 'trip_seed0001', 'seedprofile', 'user-reported', 'The map link opens the wrong city',
        E'line one\\nline two', 'a quote', 'site');
-- Companion usage: a known mix for trip_seed0001 (4 requests: 2 group / 2 DM, 3 organizer / 1 participant,
-- 2 with media; 2 delivered, 1 failed, 1 suppressed; 1 turn lost of each kind; 3 chatter ignored; reply
-- latencies 10s, 10s, 3s, 5s -> median 7.5s), one delivered request for a retired trip, one request whose
-- trip was deleted (trip_id NULL), and one request older than any window the tests ask for.
INSERT INTO control_plane.assistant_events (event_id, trip_id, occurred_at, source_service, event_type, turn_id,
    channel_type, trigger_type, requester_role, outcome, response_latency_ms, message_length_bucket, media_kind)
VALUES
 (gen_random_uuid(), 'trip_seed0001', now() - interval '5 hours', 'relay', 'request_forwarded', gen_random_uuid(), 'group', 'mention', 'participant', 'dispatched', NULL, '1_40', 'none'),
 (gen_random_uuid(), 'trip_seed0001', now() - interval '5 hours', 'relay', 'request_forwarded', gen_random_uuid(), 'group', 'name', 'organizer', 'dispatched', NULL, '41_160', 'photo'),
 (gen_random_uuid(), 'trip_seed0001', now() - interval '4 hours', 'relay', 'request_forwarded', gen_random_uuid(), 'organizer_dm', 'dm', 'organizer', 'dispatched', NULL, '1_40', 'none'),
 (gen_random_uuid(), 'trip_seed0001', now() - interval '4 hours', 'relay', 'request_to_relay', gen_random_uuid(), 'organizer_dm', 'dm', 'organizer', 'dispatched', NULL, 'none', 'document'),
 (gen_random_uuid(), 'trip_seed0001', now() - interval '5 hours', 'relay', 'reply_sent', NULL, NULL, NULL, NULL, 'reply_delivered', 10000, '41_160', NULL),
 (gen_random_uuid(), 'trip_seed0001', now() - interval '5 hours', 'relay', 'reply_sent', NULL, NULL, NULL, NULL, 'reply_delivered', 10000, '41_160', NULL),
 (gen_random_uuid(), 'trip_seed0001', now() - interval '4 hours', 'relay', 'reply_sent', NULL, NULL, NULL, NULL, 'failed_delivery', 3000, '1_40', NULL),
 (gen_random_uuid(), 'trip_seed0001', now() - interval '4 hours', 'relay', 'reply_sent', NULL, NULL, NULL, NULL, 'reply_suppressed', 5000, 'none', NULL),
 (gen_random_uuid(), 'trip_seed0001', now() - interval '3 hours', 'relay', 'turn_lost', NULL, 'group', 'mention', 'participant', 'lost_gateway_unavailable', NULL, '1_40', 'none'),
 (gen_random_uuid(), 'trip_seed0001', now() - interval '3 hours', 'relay', 'turn_lost', NULL, 'organizer_dm', 'dm', 'organizer', 'lost_companion_unreachable', NULL, '1_40', 'none'),
 (gen_random_uuid(), 'trip_seed0001', now() - interval '2 hours', 'relay', 'ignored_not_addressed', NULL, 'group', 'not_addressed', 'participant', 'ignored_not_addressed', NULL, '1_40', 'none'),
 (gen_random_uuid(), 'trip_seed0001', now() - interval '2 hours', 'relay', 'ignored_not_addressed', NULL, 'group', 'not_addressed', 'organizer', 'ignored_not_addressed', NULL, '41_160', 'none'),
 (gen_random_uuid(), 'trip_seed0001', now() - interval '2 hours', 'relay', 'ignored_not_addressed', NULL, 'group', 'not_addressed', 'participant', 'ignored_not_addressed', NULL, '1_40', 'photo'),
 (gen_random_uuid(), 'trip_seed0001', now() - interval '100 days', 'relay', 'request_forwarded', gen_random_uuid(), 'group', 'mention', 'participant', 'dispatched', NULL, '1_40', 'none'),
 (gen_random_uuid(), 'trip_seed0003', now() - interval '1 day', 'relay', 'request_forwarded', gen_random_uuid(), 'group', 'mention', 'organizer', 'dispatched', NULL, '1_40', 'none'),
 (gen_random_uuid(), 'trip_seed0003', now() - interval '1 day', 'relay', 'reply_sent', NULL, NULL, NULL, NULL, 'reply_delivered', 1000, '1_40', NULL),
 (gen_random_uuid(), NULL, now() - interval '1 day', 'relay', 'request_forwarded', gen_random_uuid(), 'group', 'mention', 'participant', 'dispatched', NULL, '1_40', 'none');
"""

#: Every call the monitor can make, each filter included: one query per branch.
FLEET_CALLS = [
    ["--tool", "fleet_overview"],
    ["--tool", "trip_detail", "--trip", "seed-live-2026"],
    ["--tool", "trip_detail", "--trip", "trip_seed0002"],
    ["--tool", "failures", "--days", "30"],
    ["--tool", "stalled_interviews", "--hours", "1"],
    ["--tool", "statistics", "--days", "90"],
    ["--tool", "alerts", "--hours", "1"],
    ["--tool", "bug_reports", "--days", "30"],
    ["--tool", "stacks"],
] + [["--tool", "list_trips", "--filter", f] for f in ("live", "all", "active", "unreachable", "ready")]

#: Argument-logging stand-ins for every external command the script might run.
LOGGED_COMMANDS = ("python3", "mktemp", "chmod", "chown", "mv", "rm", "stat", "cat", "tr", "dirname",
                   "basename", "head", "grep", "sed", "id", "awk", "cut", "ls", "cp", "ln", "touch", "tee", "env")

FAKE_OPENSSL = """#!/bin/sh
printf '%s\\n' "openssl $*" >> "{log}"
if [ "$1" = rand ] && [ "$2" = -hex ] && [ "$3" = 32 ]; then
  n=$(( $(cat "{counter}" 2>/dev/null || echo 0) + 1 ))
  echo "$n" > "{counter}"
  canary=$(printf 'c0ffee%058x' "$n")
  printf '%s\\n' "$canary" >> "{canaries}"
  printf '%s\\n' "$canary"
  exit 0
fi
exec "{real}" "$@"
"""


@unittest.skipUnless(image_present(IMAGE), f"docker with {IMAGE} is not available — the database half is skipped")
@unittest.skipUnless(BASH, "no bash")
class AgainstPostgres(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.container = f"fleetro-test-{uuid.uuid4().hex[:10]}"
        cls.admin_password = secrets.token_hex(16)
        subprocess.run([DOCKER, "run", "-d", "--rm", "--name", cls.container, "-e", f"POSTGRES_USER={ADMIN}",
                        "-e", f"POSTGRES_DB={ADMIN}", "-e", f"POSTGRES_PASSWORD={cls.admin_password}", IMAGE],
                       check=True, capture_output=True)
        try:
            cls._start()
        except BaseException:
            subprocess.run([DOCKER, "rm", "-f", cls.container], capture_output=True)
            raise

    @classmethod
    def _start(cls):
        for _ in range(90):
            probe = subprocess.run([DOCKER, "exec", cls.container, "psql", "-X", "-U", ADMIN, "-d", ADMIN,
                                    "-h", "127.0.0.1", "-c", "SELECT 1"], capture_output=True)
            if probe.returncode == 0:
                break
            time.sleep(1)
        else:
            raise RuntimeError("the throwaway PostgreSQL never became ready")
        # pg_isready and the first query can both answer during the image's
        # init restart; one more real query after a pause settles it.
        time.sleep(1)
        cls.admin_sql("SELECT 1")
        cls.apply_migrations()
        cls.admin_sql(SEED)
        cls.ip = subprocess.run(
            [DOCKER, "inspect", "-f", "{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}", cls.container],
            check=True, capture_output=True, text=True).stdout.strip()
        assert cls.ip, "the throwaway container has no IP address"

        cls.tmp = Path(tempfile.mkdtemp(prefix="fleetro-"))
        cls.bin = cls.tmp / "bin"
        cls.bin.mkdir()
        cls.logs = cls.tmp / "logs"
        cls.logs.mkdir()
        (cls.tmp / "secrets").mkdir(mode=0o700)
        cls.url_file = cls.tmp / "secrets" / "fleet_monitor_database_url"
        cls.argv_log = cls.logs / "argv.log"
        cls.stdin_log = cls.logs / "psql-stdin.log"
        cls.canaries = cls.logs / "canaries.txt"

        # PSQL_CMD: the deployment's admin psql, here `docker exec` as the owner.
        # It records its arguments and everything it is fed.
        admin_psql = cls.bin / "admin-psql"
        admin_psql.write_text(
            f"#!{sys.executable}\n"
            "import subprocess, sys\n"
            f"open({str(cls.argv_log)!r}, 'a').write('admin-psql ' + ' '.join(sys.argv[1:]) + '\\n')\n"
            "data = sys.stdin.buffer.read()\n"
            f"open({str(cls.stdin_log)!r}, 'ab').write(data + b'\\n\\x00\\n')\n"
            f"p = subprocess.run([{DOCKER!r}, 'exec', '-i', {cls.container!r}, 'psql', '-X', '-U', {ADMIN!r}, "
            f"'-d', {ADMIN!r}] + sys.argv[1:], input=data)\n"
            "sys.exit(p.returncode)\n")
        admin_psql.chmod(0o755)

        # Every other command the script runs, behind an argument logger; and
        # openssl replaced, so each password it hands out is a known canary.
        shims = cls.tmp / "shims"
        shims.mkdir()
        for name in LOGGED_COMMANDS:
            real = shutil.which(name)
            if not real:
                continue
            shim = shims / name
            shim.write_text(f"#!/bin/sh\nprintf '%s\\n' \"{name} $*\" >> \"{cls.argv_log}\"\nexec \"{real}\" \"$@\"\n")
            shim.chmod(0o755)
        fake = shims / "openssl"
        fake.write_text(FAKE_OPENSSL.format(log=cls.argv_log, counter=cls.logs / "counter",
                                            canaries=cls.canaries, real=shutil.which("openssl") or "/usr/bin/openssl"))
        fake.chmod(0o755)

        cls.env = {
            "PATH": f"{shims}:{os.environ.get('PATH', '/usr/bin:/bin')}",
            "HOME": str(cls.tmp),
            "PSQL_CMD": str(admin_psql),
            "MONITOR_DB_URL_FILE": str(cls.url_file),
            "MONITOR_DB_URL_OWNER": f"{os.getuid()}:{os.getgid()}",
            "MONITOR_DB_HOST": cls.ip,
            "MONITOR_DB_PORT": "5432",
            "MONITOR_DB_NAME": ADMIN,
        }
        cls.runs: list[subprocess.CompletedProcess] = []
        cls.first = cls.run_script()

    @classmethod
    def tearDownClass(cls):
        subprocess.run([DOCKER, "rm", "-f", cls.container], capture_output=True)
        shutil.rmtree(getattr(cls, "tmp", ""), ignore_errors=True)

    def setUp(self):
        # Every test here stands on the first run having created the role.
        if self.first.returncode != 0 and self._testMethodName != "test_the_first_run_creates_the_role_and_a_private_url_file":
            self.fail("the script's first run failed, so there is no role to test:\n"
                      + secret_free(self.first.stdout + self.first.stderr))

    # ------------------------------------------------------------ helpers --
    @classmethod
    def admin_sql(cls, text: str, check: bool = True) -> str:
        proc = subprocess.run([DOCKER, "exec", "-i", cls.container, "psql", "-X", "-U", ADMIN, "-d", ADMIN,
                               "-At", "-v", "ON_ERROR_STOP=1"], input=text.encode(), capture_output=True)
        if check and proc.returncode != 0:
            raise AssertionError(secret_free(proc.stderr.decode()))
        return proc.stdout.decode().strip()

    @classmethod
    def apply_migrations(cls):
        """The repo's real migrations, in name order, as applyMigrations runs them."""
        cls.admin_sql("CREATE TABLE IF NOT EXISTS public.control_plane_schema_migrations "
                      "(version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now());")
        files = sorted(p.name for p in MIGRATIONS.iterdir() if re.match(r"^\d+_.+\.sql$", p.name))
        assert len(files) > 50, "found almost no migrations"
        for name in files:
            body = (MIGRATIONS / name).read_text()
            cls.admin_sql(f"BEGIN;\n{body}\n;\nINSERT INTO public.control_plane_schema_migrations(version) "
                          f"VALUES ('{name}');\nCOMMIT;\n")

    @classmethod
    def run_script(cls, *args: str, env: dict | None = None) -> subprocess.CompletedProcess:
        proc = subprocess.run([BASH, str(SCRIPT), *args], capture_output=True, text=True,
                              env={**cls.env, **(env or {})}, timeout=180)
        cls.runs.append(proc)
        return proc

    def ok(self, proc: subprocess.CompletedProcess, what: str):
        self.assertEqual(proc.returncode, 0, f"{what} failed:\n{secret_free(proc.stdout)}\n{secret_free(proc.stderr)}")

    def url(self) -> str:
        return self.url_file.read_text().strip()

    def as_url(self, url: str, text: str, pgoptions: str | None = None) -> subprocess.CompletedProcess:
        """psql INSIDE the container, over its own network address — not
        loopback, which the image trusts without a password."""
        env_args = ["-e", f"PGOPTIONS={pgoptions}"] if pgoptions is not None else []
        return subprocess.run([DOCKER, "exec", "-i", *env_args, self.container, "psql", "-X", url, "-At",
                               "-v", "ON_ERROR_STOP=1"], input=text.encode(), capture_output=True)

    def as_role(self, text: str, pgoptions: str | None = None) -> subprocess.CompletedProcess:
        return self.as_url(self.url(), text, pgoptions)

    def snapshot(self) -> str:
        """Everything the script may change, in a form safe to compare and print."""
        return self.admin_sql(f"""
          SELECT 'role ' || md5(coalesce(rolpassword, '')) || ' ' || rolcanlogin || rolsuper || rolinherit
                 || rolcreatedb || rolcreaterole || rolreplication || rolbypassrls || ' ' || rolconnlimit
            FROM pg_authid WHERE rolname = '{ROLE}'
          UNION ALL
          SELECT 'settings ' || coalesce((SELECT array_to_string(array_agg(s ORDER BY s), ',')
                                            FROM pg_db_role_setting d, unnest(d.setconfig) s
                                           WHERE d.setrole = '{ROLE}'::regrole), '')
          UNION ALL
          SELECT 'members ' || count(*) FROM pg_auth_members WHERE member = '{ROLE}'::regrole
          UNION ALL
          SELECT 'database ' || coalesce(datacl::text, '') FROM pg_database WHERE datname = current_database()
          UNION ALL
          SELECT 'schema ' || nspname || ' ' || coalesce(nspacl::text, '') FROM pg_namespace
           WHERE nspname IN ('public', 'control_plane')
          UNION ALL
          SELECT 'table ' || c.oid::regclass || ' ' || a.privilege_type
            FROM pg_class c, aclexplode(c.relacl) a WHERE a.grantee = '{ROLE}'::regrole
          UNION ALL
          SELECT 'column ' || c.oid::regclass || '.' || att.attname || ' ' || a.privilege_type
            FROM pg_class c JOIN pg_attribute att ON att.attrelid = c.oid, aclexplode(att.attacl) a
           WHERE a.grantee = '{ROLE}'::regrole
          ORDER BY 1;""")

    def url_file_state(self) -> tuple:
        st = self.url_file.stat()
        return (st.st_ino, st.st_mtime_ns, stat.S_IMODE(st.st_mode), st.st_uid, st.st_gid,
                __import__("hashlib").sha256(self.url_file.read_bytes()).hexdigest())

    def fleet(self, url: str, call: list[str], sql_log: Path | None = None) -> tuple[int, str, str]:
        """One fleet-mcp tool, over a URL, as the monitor runs it (url mode + psql)."""
        work = Path(tempfile.mkdtemp(dir=self.tmp))
        psql = work / "psql"
        log_line = (f"import sys; open({str(sql_log)!r}, 'a').write(data + '\\n\\x00\\n')\n" if sql_log else "")
        psql.write_text(
            f"#!{sys.executable}\n"
            "import os, subprocess, sys\n"
            "data = sys.stdin.read()\n"
            f"{log_line}"
            f"p = subprocess.run([{DOCKER!r}, 'exec', '-i', '-e', 'PGOPTIONS', {self.container!r}, 'psql', '-X'] "
            "+ sys.argv[1:], input=data.encode())\n"
            "sys.exit(p.returncode)\n")
        psql.chmod(0o755)
        config = work / "fleet-stacks.json"
        config.write_text(json.dumps({"default_stack": "prod", "stacks": {"prod": {"label": "throwaway", "url": url}}}))
        config.chmod(0o600)
        proc = subprocess.run([NODE, str(SERVER), *call], capture_output=True, text=True, timeout=120,
                              env={**os.environ, "KINERARY_FLEET_CONFIG": str(config), "FLEET_PSQL_BIN": str(psql)})
        shutil.rmtree(work, ignore_errors=True)
        return proc.returncode, proc.stdout.replace(str(config), "<config>"), secret_free(proc.stderr)

    def admin_url(self) -> str:
        return f"postgresql://{ADMIN}:{self.admin_password}@{self.ip}:5432/{ADMIN}"

    # -------------------------------------------------------------- tests --
    def test_the_first_run_creates_the_role_and_a_private_url_file(self):
        self.ok(self.first, "the first run")
        self.assertIn(ROLE, self.first.stdout)
        self.assertIn(str(self.url_file), self.first.stdout)
        st = self.url_file.stat()
        self.assertEqual(stat.S_IMODE(st.st_mode), 0o600)
        self.assertEqual((st.st_uid, st.st_gid), (os.getuid(), os.getgid()))
        self.assertTrue(self.url().startswith(f"postgresql://{ROLE}:"), "the URL file does not name the role")
        self.assertTrue(self.url().endswith(f"@{self.ip}:5432/{ADMIN}"), "the URL file does not name the database")
        leftovers = [p.name for p in self.url_file.parent.iterdir() if p != self.url_file]
        self.assertEqual(leftovers, [], "a temporary file was left beside the URL file")

    def test_the_url_logs_in_as_the_role_by_password(self):
        proc = self.as_role("SELECT current_user, current_setting('default_transaction_read_only'), "
                            "current_setting('statement_timeout');")
        self.assertEqual(proc.returncode, 0, secret_free(proc.stderr.decode()))
        self.assertEqual(proc.stdout.decode().strip(), f"{ROLE}|on|20s")
        wrong = re.sub(r"^(postgresql://[^:]+:)[0-9a-f]+@", r"\g<1>0000@", self.url())
        refused = self.as_url(wrong, "SELECT 1;")
        self.assertNotEqual(refused.returncode, 0, "a wrong password was accepted — is the test on a trusted path?")
        self.assertIn("password authentication failed", refused.stderr.decode())

    @unittest.skipUnless(NODE, "node is not installed")
    def test_every_fleet_tool_answers_as_the_role_with_the_rows_the_owner_sees(self):
        for call in FLEET_CALLS:
            with self.subTest(call=" ".join(call)):
                code_admin, out_admin, err_admin = self.fleet(self.admin_url(), call)
                code_role, out_role, err_role = self.fleet(self.url(), call)
                self.assertEqual(code_admin, 0, err_admin)
                self.assertEqual(code_role, 0, f"as {ROLE}: {err_role}")
                self.assertNotIn("Tool failed", out_role)
                self.assertEqual(out_role, out_admin, "the role sees different rows from the owner")
        # And the comparison was not two empty answers.
        _, listing, _ = self.fleet(self.url(), ["--tool", "list_trips", "--filter", "all"])
        self.assertIn("seed-live-2026", listing)
        _, alerts, _ = self.fleet(self.url(), ["--tool", "alerts"])
        for section in ("UNREACHABLE", "FAILED JOBS", "CONFIRMED BUT NEVER BUILT", "INTERVIEW WAITING ON US",
                        "MODEL FAILING MID-INTERVIEW", "UNDELIVERED NOTIFICATIONS", "REPORTED BY A COMPANION"):
            self.assertIn(section, alerts, "the seed no longer exercises every alert query")

    @unittest.skipUnless(NODE, "node is not installed")
    def test_companion_usage_is_counted_correctly_by_the_real_query_as_the_role(self):
        """The stand-in psql cannot tell whether the SQL is right; this can. A wrong query would not fail the
        tool (a usage failure is reported in words, the digest carries on), so the text is asserted, not the exit."""
        code, digest, err = self.fleet(self.url(), ["--tool", "statistics", "--days", "30", "--format", "digest"])
        self.assertEqual(code, 0, err)
        self.assertNotIn("could not be read", digest)
        self.assertNotIn("not available", digest)
        self.assertNotIn("not collected", digest)
        usage = digest.split("**Companion usage**", 1)[1].strip().splitlines()
        self.assertEqual(usage, [
            "• ⚠️ seed-live-2026: 4 requests · 2 replies (50%, under 100%) · 1 failed · 1 suppressed"
            " · 2 lost (1 gateway unavailable · 1 companion unreachable) · 3 chatter ignored · median 7.5s"
            " · group 2 / DM 2 · organizer 3 / participants 1 · 2 with media",
            "• ⚠️ (removed trip): 1 request · 0 replies (0%, under 100%) · 0 failed · 0 lost · 0 chatter ignored"
            " · median n/a · group 1 / DM 0 · organizer 0 / participants 1",
            "• retired: 1 request · 1 reply · 0 chatter ignored (test runs, ignore)",
        ])
        # A wider window brings the old request in; the text form carries the same counts as a table.
        _, wide, _ = self.fleet(self.url(), ["--tool", "statistics", "--days", "365"])
        self.assertIn("seed-live-2026 | live | 5 | 2 | 40% | 1 | 1 | 1 | 1 | 3 | 7.5s | 2 | 3 | 2 | 3 | 2", wide)
        self.assertIn("tool usage: not collected yet", wide)

    @unittest.skipUnless(NODE, "node is not installed")
    def test_companion_usage_says_no_table_and_not_collected_against_the_real_catalog(self):
        """The two no-data states on a real database: no zeros, and no error. The table is put aside for the
        duration (as the owner, so the role's grants stay with it) and restored whatever happens."""
        digest_call = ["--tool", "statistics", "--days", "30", "--format", "digest"]
        self.admin_sql("ALTER TABLE control_plane.assistant_events RENAME TO assistant_events_held;")
        try:
            _, gone, _ = self.fleet(self.url(), digest_call)
            self.assertIn("companion usage: not available — this database has no assistant_events table yet", gone)
            self.assertNotIn("could not be read", gone)
            self.assertIn("**Last 30 days**", gone)
            # The runbook's ordering rule: the grant list names the table, so applying the role to a
            # database that lacks it fails (inside its own transaction, changing nothing).
            probe = f"fleetro_probe_{uuid.uuid4().hex[:8]}"
            refused = subprocess.run([self.env["PSQL_CMD"]], input=f"\\set role {probe}\n".encode() + SQL_FILE.read_bytes(),
                                     capture_output=True)
            self.assertNotEqual(refused.returncode, 0, "the role applied to a database with no assistant_events")
            self.assertIn("assistant_events", refused.stderr.decode())
            self.assertEqual(self.admin_sql(f"SELECT count(*) FROM pg_roles WHERE rolname = '{probe}'"), "0")
            self.admin_sql("CREATE TABLE control_plane.assistant_events "
                           "(LIKE control_plane.assistant_events_held);")
            try:
                _, empty, _ = self.fleet(self.admin_url(), digest_call)
                self.assertIn("companion usage: not collected — assistant events are switched off on this stack", empty)
                self.assertNotIn(" requests", empty)
                self.assertNotIn("could not be read", empty)
            finally:
                self.admin_sql("DROP TABLE control_plane.assistant_events;")
        finally:
            self.admin_sql("ALTER TABLE control_plane.assistant_events_held RENAME TO assistant_events;")

    def test_writes_fail_under_the_role_s_session_default(self):
        before = self.admin_sql("SELECT count(*) FROM control_plane.trips")
        for statement in ("INSERT INTO control_plane.trips (id, slug, lifecycle_state) "
                          "VALUES ('trip_evil0001', 'evil', 'draft')",
                          "UPDATE control_plane.trips SET title = 'x'",
                          "DELETE FROM control_plane.trips",
                          "TRUNCATE control_plane.companion_bug_reports",
                          "CREATE TABLE control_plane.evil (x int)",
                          "DROP TABLE control_plane.trips"):
            with self.subTest(statement=statement):
                proc = self.as_role(statement + ";")
                self.assertNotEqual(proc.returncode, 0)
                self.assertRegex(proc.stderr.decode(), r"permission denied|read-only transaction|must be owner")
        self.assertEqual(self.admin_sql("SELECT count(*) FROM control_plane.trips"), before)

    def test_writes_fail_with_permission_denied_when_the_session_is_read_write(self):
        """The session default is the caller's to change; the privileges are not."""
        writes = ("INSERT INTO control_plane.trips (id, slug, lifecycle_state) VALUES ('trip_evil0001', 'evil', 'draft')",
                  "UPDATE control_plane.trips SET title = 'x'",
                  "DELETE FROM control_plane.trips",
                  "TRUNCATE control_plane.companion_bug_reports",
                  "CREATE TABLE control_plane.evil (x int)",
                  "CREATE TEMPORARY TABLE evil (x int)",
                  "ALTER TABLE control_plane.trips ADD COLUMN evil int",
                  "DROP TABLE control_plane.trips",
                  "CREATE SCHEMA evil",
                  "GRANT SELECT ON control_plane.trips TO PUBLIC")
        unlocks = ("SET default_transaction_read_only = off;",
                   "SET SESSION CHARACTERISTICS AS TRANSACTION READ WRITE; BEGIN READ WRITE;")
        before = self.admin_sql("SELECT count(*) FROM control_plane.trips")
        for unlock in unlocks:
            for statement in writes:
                with self.subTest(unlock=unlock, statement=statement):
                    proc = self.as_role(f"{unlock}\n{statement};")
                    self.assertNotEqual(proc.returncode, 0)
                    self.assertRegex(proc.stderr.decode(), r"permission denied|must be owner")
        for statement in writes[:3]:
            with self.subTest(pgoptions="-c default_transaction_read_only=off", statement=statement):
                proc = self.as_role(statement + ";", pgoptions="-c default_transaction_read_only=off")
                self.assertIn("permission denied", proc.stderr.decode())
        for escape in (f"SET ROLE {ADMIN};", "SET ROLE pg_write_all_data;", "SET ROLE pg_read_all_data;",
                       f"SET SESSION AUTHORIZATION {ADMIN};"):
            with self.subTest(escape=escape):
                proc = self.as_role(f"SET default_transaction_read_only = off;\n{escape}\n"
                                    "INSERT INTO control_plane.trips (id, slug, lifecycle_state) "
                                    "VALUES ('trip_evil0002', 'evil2', 'draft');")
                self.assertNotEqual(proc.returncode, 0)
                self.assertIn("permission denied", proc.stderr.decode())
        self.assertEqual(self.admin_sql("SELECT count(*) FROM control_plane.trips"), before)

    def test_the_role_cannot_read_what_it_was_not_granted(self):
        self.admin_sql("CREATE TABLE IF NOT EXISTS control_plane.zz_canary_after_role (secret text); "
                       "INSERT INTO control_plane.zz_canary_after_role VALUES ('CANARY');")
        self.addCleanup(self.admin_sql, "DROP TABLE IF EXISTS control_plane.zz_canary_after_role;")
        unreadable = [
            # password material, sessions, identities, audit
            "SELECT * FROM control_plane.password_credentials",
            "SELECT * FROM control_plane.web_password_credentials",
            "SELECT * FROM control_plane.web_sessions",
            "SELECT * FROM control_plane.users",
            "SELECT * FROM control_plane.user_identities",
            "SELECT * FROM control_plane.audit_events",
            "SELECT * FROM control_plane.organizer_invitations",
            "SELECT count(*) FROM control_plane.plans",
            "SELECT rolpassword FROM pg_authid",
            # a table created after the role: no default privileges reach it
            "SELECT * FROM control_plane.zz_canary_after_role",
            # the columns the monitor deliberately never reads
            "SELECT companion_intro FROM control_plane.trips",
            "SELECT * FROM control_plane.trips",
            "SELECT answers FROM control_plane.intake_sessions",
            "SELECT session_token_digest FROM control_plane.intake_sessions",
            "SELECT token_digest FROM control_plane.interview_enrollments",
            "SELECT display_name, participant_username, telegram_user_id FROM control_plane.trip_person_links",
            "SELECT source_text FROM control_plane.interview_interpretations",
            "SELECT recipient, payload FROM control_plane.notification_outbox",
            "SELECT data FROM control_plane.intake_versions",
            "SELECT applied_at FROM public.control_plane_schema_migrations",
        ]
        for statement in unreadable:
            with self.subTest(statement=statement):
                proc = self.as_role(statement + ";")
                self.assertNotEqual(proc.returncode, 0, "read something outside the grant list")
                self.assertIn("permission denied", proc.stderr.decode())
                self.assertNotIn("CANARY", proc.stdout.decode())

    @unittest.skipUnless(NODE, "node is not installed")
    def test_every_granted_column_is_one_a_fleet_query_needs(self):
        """The column half of the drift guard: least privilege, measured.

        Each tool runs once as the owner with its SQL captured. Then, for every
        granted column, a probe role with the same grants minus that column runs
        those statements: at least one must be refused, or the column is
        granted for nothing.
        """
        sql_log = self.tmp / "captured.sql"
        sql_log.unlink(missing_ok=True)
        for call in FLEET_CALLS:
            code, _, err = self.fleet(self.admin_url(), call, sql_log=sql_log)
            self.assertEqual(code, 0, err)
        statements = list(dict.fromkeys(
            s.strip().rstrip(";") for s in sql_log.read_text().split("\n\x00\n") if s.strip()))
        self.assertGreater(len(statements), 30, "captured almost no SQL — did the tools run?")

        probe = f"fleetro_probe_{uuid.uuid4().hex[:8]}"
        self.addCleanup(self.admin_sql, f"DROP OWNED BY {probe}; DROP ROLE IF EXISTS {probe};", False)
        applied = subprocess.run([self.env["PSQL_CMD"]], input=f"\\set role {probe}\n".encode() + SQL_FILE.read_bytes(),
                                 capture_output=True)
        self.assertEqual(applied.returncode, 0, applied.stderr.decode())

        def refused(relevant: list[str], revoke: str) -> list[str]:
            """The permission errors the probe role gets running these, in one rolled-back transaction."""
            body = f"BEGIN;\n{revoke}\nSET LOCAL ROLE {probe};\n"
            for statement in relevant:
                body += f"SAVEPOINT s;\n{statement};\nROLLBACK TO SAVEPOINT s;\n"
            body += "ROLLBACK;\n"
            proc = subprocess.run([DOCKER, "exec", "-i", self.container, "psql", "-X", "-q", "-U", ADMIN,
                                   "-d", ADMIN, "-At"], input=body.encode(), capture_output=True)
            errors = proc.stderr.decode()
            self.assertNotRegex(errors, r"ERROR:  (?!permission denied)", "a captured statement failed for "
                                "another reason, so this probe proves nothing:\n" + errors[:2000])
            return [line for line in errors.splitlines() if "permission denied" in line]

        needs = refused(statements, "")
        self.assertEqual(needs, [], "a fleet-mcp.mjs query needs a column the role cannot read — add it to "
                                    "monitor-db-role.sql and re-apply the role on every deployment")

        unneeded = []
        for relation, columns in sorted(grant_list().items()):
            short = relation.split(".")[1]
            relevant = [s for s in statements if short in s]
            for column in sorted(columns):
                if not refused(relevant, f"REVOKE SELECT ({column}) ON {relation} FROM {probe};"):
                    unneeded.append(f"{relation}.{column}")
        self.assertEqual(unneeded, [], "monitor-db-role.sql grants columns no fleet-mcp.mjs query reads — "
                                       "remove them from the grant list")

    def test_a_second_run_changes_nothing(self):
        self.ok(self.run_script(), "a settling run")
        catalog, url_file = self.snapshot(), self.url_file_state()
        again = self.run_script()
        self.ok(again, "the second run")
        self.assertEqual(self.snapshot(), catalog)
        self.assertEqual(self.url_file_state(), url_file, "the URL file was touched")
        self.assertIn("unchanged", again.stdout)

    def test_check_passes_and_changes_nothing(self):
        self.ok(self.run_script(), "a settling run")
        catalog, url_file = self.snapshot(), self.url_file_state()
        self.stdin_log.write_bytes(b"")
        check = self.run_script("--check")
        self.ok(check, "--check")
        self.assertIn("verified", check.stdout)
        self.assertIn("refused with permission denied", check.stdout)
        self.assertEqual(self.snapshot(), catalog)
        self.assertEqual(self.url_file_state(), url_file)
        fed = self.stdin_log.read_bytes().decode()
        self.assertIn("\\set check_only true", fed)
        self.assertNotIn("\\set verifier", fed, "--check sent a password")

    def test_check_fails_loudly_on_drift_and_a_rerun_repairs_it(self):
        self.ok(self.run_script(), "a settling run")
        self.admin_sql(f"GRANT INSERT ON control_plane.trips TO {ROLE}; "
                       f"GRANT SELECT (companion_intro) ON control_plane.trips TO {ROLE}; "
                       f"GRANT SELECT ON control_plane.web_sessions TO {ROLE}; "
                       f"ALTER ROLE {ROLE} INHERIT; GRANT pg_read_all_data TO {ROLE};")
        check = self.run_script("--check")
        self.assertNotEqual(check.returncode, 0, "--check passed a role that can write")
        report = check.stdout + check.stderr
        for problem in ("can write control_plane.trips", "control_plane.trips.companion_intro",
                        "control_plane.web_sessions", "has INHERIT", "member of pg_read_all_data"):
            self.assertIn(problem, report)
        self.ok(self.run_script(), "the repairing run")
        self.ok(self.run_script("--check"), "--check after the repair")

    def test_check_fails_when_the_url_file_is_not_private_or_not_the_role_s(self):
        self.ok(self.run_script(), "a settling run")
        self.url_file.chmod(0o644)
        try:
            check = self.run_script("--check")
            self.assertNotEqual(check.returncode, 0)
            self.assertIn("mode", check.stdout + check.stderr)
        finally:
            self.url_file.chmod(0o600)
        good = self.url_file.read_bytes()
        self.url_file.write_text(re.sub(r"^(postgresql://[^:]+:)[0-9a-f]+@", r"\g<1>1234abcd@", good.decode()))
        check = self.run_script("--check")
        self.assertNotEqual(check.returncode, 0, "--check accepted a URL whose password the role does not have")
        self.assertIn("password", check.stdout + check.stderr)
        # An apply heals it: a new password, and a file that matches it.
        healed = self.run_script()
        self.ok(healed, "the healing run")
        self.assertIn("rotated", healed.stdout)
        self.ok(self.run_script("--check"), "--check after healing")
        self.assertEqual(self.as_role("SELECT 1;").returncode, 0)

    def test_rotate_replaces_the_password_and_the_file_atomically(self):
        self.ok(self.run_script(), "a settling run")
        old_url, old_inode = self.url(), self.url_file.stat().st_ino
        self.assertEqual(self.as_url(old_url, "SELECT 1;").returncode, 0)
        rotated = self.run_script("--rotate")
        self.ok(rotated, "--rotate")
        self.assertIn("rotated", rotated.stdout)
        self.assertTrue(self.url() != old_url, "--rotate kept the password")
        self.assertNotEqual(self.url_file.stat().st_ino, old_inode, "the file was rewritten in place, not replaced")
        self.assertEqual(stat.S_IMODE(self.url_file.stat().st_mode), 0o600)
        self.assertIn("password authentication failed", self.as_url(old_url, "SELECT 1;").stderr.decode())
        self.assertEqual(self.as_url(self.url(), "SELECT 1;").returncode, 0)
        self.ok(self.run_script("--check"), "--check after rotating")

    def test_no_password_reaches_the_output_a_child_s_arguments_or_the_server(self):
        self.ok(self.run_script("--rotate"), "a rotation")
        self.ok(self.run_script("--check"), "a check")
        canaries = [c for c in self.canaries.read_text().split() if c]
        self.assertGreaterEqual(len(canaries), 2, "the planted openssl was never asked for a password")
        self.assertTrue(any(c in self.url() for c in canaries), "the URL file does not hold the planted password")
        argv = self.argv_log.read_text()
        fed = self.stdin_log.read_bytes().decode(errors="replace")
        self.assertIn("openssl rand -hex 32", argv, "the argument log did not capture the script's commands")
        for canary in canaries:
            for proc in self.runs:
                self.assertFalse(canary in proc.stdout or canary in proc.stderr, "a password was printed")
            self.assertFalse(canary in argv, "a password was on a command line")
            self.assertFalse(canary in fed, "the plaintext password was sent to the server")
        for proc in self.runs:
            for stream in (proc.stdout, proc.stderr):
                self.assertFalse(re.search(r"postgres(?:ql)?://", stream), "a connection URL was printed")
        self.assertIn("SCRAM-SHA-256$4096:", fed, "the password was not set as a client-side verifier")


if __name__ == "__main__":
    unittest.main()
