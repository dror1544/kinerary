#!/usr/bin/env node
/**
 * Kinerary fleet MCP — the read-only window a monitoring agent gets onto a
 * control plane.
 *
 * WHY THIS EXISTS, AND WHY IT IS NOT A DATABASE CONNECTION. An agent that
 * monitors trips needs to answer "what stage is everything at, what failed,
 * and how are we doing" — questions that are a handful of fixed queries, not
 * arbitrary SQL. So this server exposes a QUERY CATALOG: every statement is
 * written here, and no tool takes SQL. An agent cannot phrase a query this
 * file does not already contain, which is the point. Defence in depth: every
 * connection is opened read-only, so even a mistake in this file cannot write.
 *
 * DEPLOYMENT IS CONFIGURATION, NOT CODE. Nothing here knows a hostname, a
 * container name, a database user or an SSH key. Those live in a
 * `fleet-stacks.json` (see `fleet-stacks.example.json`), so the same server
 * monitors a laptop stack, a VM reached over SSH, or a managed Postgres, and
 * moving a deployment is an edit to one JSON file rather than a patch here.
 * What stays in code is the part that is about Kinerary rather than about
 * where it runs: the lifecycle stages, the trip classes, and what counts as
 * broken.
 *
 * ONE STACK IS PRODUCTION AND IT SAYS SO. Every answer names the stack it came
 * from, and a stack marked `"production": true` is labelled as such, because a
 * statistic that silently mixes a test stack with real families is worse than
 * no statistic.
 *
 * ZERO DEPENDENCIES ON PURPOSE. This runs from a Hermes profile, which has no
 * node_modules and outlives any one git worktree. So the MCP protocol is
 * spoken directly (newline-delimited JSON-RPC on stdio) and Postgres is
 * reached through psql. Nothing here breaks when a branch is deleted or a
 * package is bumped.
 */
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SERVER_NAME = "kinerary-fleet";
const SERVER_VERSION = "2.0.0";

/** psql field separator: unit separator, which cannot occur in these columns. */
const SEP = "\x1f";

/**
 * Read-only and time-bounded, set on the CONNECTION rather than as SQL.
 *
 * psql prints a command tag ("SET") for every SET statement, and under -At those
 * tags land on stdout ahead of the real rows, indistinguishable from data — the
 * first smoke test of this server duly reported "SET trips". PGOPTIONS applies
 * the same settings at connect time and prints nothing.
 */
const PGOPTIONS = "-c default_transaction_read_only=on -c statement_timeout=20s";

const HERE = dirname(fileURLToPath(import.meta.url));

/* ----------------------------------------------------------- deployment --- */

const expandHome = (value) =>
  typeof value === "string" && value.startsWith("~/") ? join(homedir(), value.slice(2)) : value;

/**
 * Find an executable without trusting PATH to be populated.
 *
 * Hermes launches stdio MCP servers with a filtered environment, so PATH may be
 * missing or minimal. Each binary can also be pinned explicitly by env var,
 * which is the escape hatch for an unusual install.
 */
function findBinary(name, envVar, fallbacks) {
  const pinned = process.env[envVar];
  if (pinned) return pinned;
  const dirs = [
    ...(process.env.PATH ?? "").split(":").filter(Boolean),
    "/usr/local/bin",
    "/opt/homebrew/bin",
    "/usr/bin",
    "/bin",
    join(homedir(), ".local/bin"),
  ];
  for (const dir of dirs) {
    const candidate = join(dir, name);
    if (existsSync(candidate)) return candidate;
  }
  return fallbacks.find((path) => existsSync(path)) ?? name;
}

/** Single-quote a value for a remote shell. */
const shq = (value) => `'${String(value).replace(/'/g, `'\\''`)}'`;

/**
 * Where a deployment describes itself. First hit wins.
 *
 * The profile root is the intended home when this runs as a Hermes skill: it
 * sits beside the skill rather than inside it, so a real deployment's config
 * never shows up as drift against the repo copy of the skill.
 */
const CONFIG_SEARCH = [
  resolve(HERE, "../../..", "fleet-stacks.json"),
  join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "kinerary", "fleet-stacks.json"),
  join(HERE, "fleet-stacks.json"),
];

/**
 * An explicitly named config is a demand, not a suggestion.
 *
 * If KINERARY_FLEET_CONFIG is set and the file is missing, this REFUSES rather
 * than searching on. A typo in that variable would otherwise make the monitor
 * quietly read a different deployment and announce it as production — for a
 * tool whose whole job is pointing at one control plane among several, reading
 * the wrong one silently is worse than not starting.
 */
const PINNED_CONFIG = process.env.KINERARY_FLEET_CONFIG || null;

function loadConfig() {
  if (PINNED_CONFIG && !existsSync(PINNED_CONFIG)) {
    return {
      stacks: {},
      defaultStack: null,
      path: PINNED_CONFIG,
      error:
        `KINERARY_FLEET_CONFIG points at ${PINNED_CONFIG}, which does not exist.\n` +
        "Refusing to fall back to another deployment's configuration.",
    };
  }
  const path = PINNED_CONFIG ?? CONFIG_SEARCH.find((candidate) => existsSync(candidate));
  if (!path) {
    return {
      stacks: {},
      defaultStack: null,
      path: null,
      error:
        "No fleet-stacks.json found. Copy fleet-stacks.example.json to one of:\n" +
        CONFIG_SEARCH.map((candidate) => `  ${candidate}`).join("\n") +
        "\nor point KINERARY_FLEET_CONFIG at it.",
    };
  }
  try {
    const raw = JSON.parse(readFileSync(path, "utf8"));
    const stacks = raw.stacks ?? {};
    const names = Object.keys(stacks);
    if (names.length === 0) throw new Error("no stacks defined");
    const defaultStack = raw.default_stack ?? names.find((n) => stacks[n].production) ?? names[0];
    if (!stacks[defaultStack]) throw new Error(`default_stack '${defaultStack}' is not defined`);
    return { stacks, defaultStack, path, error: null };
  } catch (error) {
    return { stacks: {}, defaultStack: null, path, error: `${path}: ${error.message}` };
  }
}

const CONFIG = loadConfig();

const stackLabel = (name) => CONFIG.stacks[name]?.label ?? name;
const isProduction = (name) => CONFIG.stacks[name]?.production === true;

/**
 * Turn one stack's description into the argv that runs psql against it.
 *
 * Three shapes cover every deployment seen so far, and `argv` is the escape
 * hatch for the one that is not:
 *   url       psql connects directly (managed Postgres, or a published port)
 *   container the database is inside a container on this host
 *   ssh       ... and that host is reached over SSH first
 */
function buildArgv(name) {
  const stack = CONFIG.stacks[name];
  if (!stack) {
    const known = Object.keys(CONFIG.stacks).join(", ") || "none configured";
    throw new Error(`unknown stack '${name}' (configured: ${known})`);
  }
  if (Array.isArray(stack.argv) && stack.argv.length > 0) {
    return stack.argv.map((part) => String(part).replace("{sep}", SEP).replace("{pgoptions}", PGOPTIONS));
  }

  const db = stack.database ?? {};
  // ON_ERROR_STOP makes a failing statement exit non-zero. Without it psql exits
  // 0 with empty stdout, and runSql turned a CRASHED query into "no rows" — which
  // is how trip_detail told an operator a live customer trip had no Telegram
  // bindings at all, when its query had never run.
  const psqlArgs = ["-v", "ON_ERROR_STOP=1", "-At", "-F", SEP, "-f", "-"];
  if (stack.url) {
    psqlArgs.unshift(stack.url);
  } else {
    if (db.user) psqlArgs.unshift("-U", db.user);
    if (db.name) psqlArgs.unshift("-d", db.name);
    if (db.host) psqlArgs.unshift("-h", db.host);
    if (db.port) psqlArgs.unshift("-p", String(db.port));
  }

  // No container and no SSH: psql runs right here.
  if (!stack.container && !stack.ssh) {
    return [findBinary("psql", "FLEET_PSQL_BIN", ["/usr/local/bin/psql", "/opt/homebrew/bin/psql"]), ...psqlArgs];
  }

  const dockerBin = stack.docker_bin ?? "docker";
  const containerArgs = stack.container
    ? [dockerBin, "exec", "-i", "-e", `PGOPTIONS=${PGOPTIONS}`, stack.container, "psql", ...psqlArgs]
    : ["psql", ...psqlArgs];

  if (!stack.ssh) {
    const local = [...containerArgs];
    local[0] = findBinary("docker", "FLEET_DOCKER_BIN", ["/usr/local/bin/docker", "/opt/homebrew/bin/docker"]);
    return local;
  }

  // Over SSH the whole thing is ONE argument, interpreted by the remote shell.
  // SEP is interpolated as a real control byte inside quotes: a literal "\x1f"
  // would reach psql as four characters and every row would come back unsplit.
  const ssh = stack.ssh;
  const remote = [
    ...(ssh.sudo === false ? [] : ["sudo"]),
    ...containerArgs.map((part) => (part === SEP ? shq(SEP) : shq(part))),
  ].join(" ");

  const sshArgs = ["-o", "BatchMode=yes", "-o", `ConnectTimeout=${ssh.connect_timeout ?? 10}`];
  if (ssh.key) sshArgs.push("-i", expandHome(ssh.key));
  if (ssh.port) sshArgs.push("-p", String(ssh.port));
  for (const option of ssh.options ?? []) sshArgs.push("-o", option);

  return [
    findBinary("ssh", "FLEET_SSH_BIN", ["/usr/bin/ssh"]),
    ...sshArgs,
    ssh.target,
    remote,
  ];
}

/**
 * A trip's class, derived from its slug.
 *
 * This is the distinction that makes monitoring usable rather than noisy. On
 * 2026-09-16 production held 48 trips of which 38 were `retired-*` teardowns
 * from automated e2e runs, and every failed notification in the whole table
 * belonged to a throwaway trip. An agent that reported those as failures would
 * page a human forever about test runs that were torn down on purpose.
 *
 *   live        a real trip, built, with a promoted slug
 *   prospect    a real person whose trip has NOT been built yet, so its slug is
 *               still the signup id. Anywhere from "signed up an hour ago" to
 *               "confirmed their interview five days ago and nothing happened".
 *               Never noise — the stage says which, and one of those states is
 *               a genuine fault.
 *   retired     torn down deliberately; failures here are expected
 *   scaffolding created by a test harness
 *
 * The slug is promoted at provisioning, so `draft-sreq-…` means only "never
 * built". An earlier version of this file called that class `unnamed_draft` and
 * described it as "never reached an interview", which was wrong: on 2026-09-16
 * two of them sat at `intake_confirmed`, five days after a person finished
 * answering. That is the opposite of noise, and the wording would have taught
 * the agent to dismiss it.
 *
 * The prefixes themselves are product conventions, not deployment settings, so
 * they live here; a deployment that renames them can override the expression
 * with `trip_class_sql` on THAT stack in its config.
 *
 * Per stack, never global. This used to take the first `trip_class_sql` found in
 * any stack and apply it everywhere, so a development override that called every
 * trip scaffolding also classified production — and `alerts` only looks at live
 * and prospect trips, so real problems vanished from the watchdog.
 */
const DEFAULT_TRIP_CLASS_SQL = `
  CASE
    WHEN t.slug LIKE 'retired-%' THEN 'retired'
    WHEN t.slug LIKE 'cpvm-%' OR t.slug LIKE 'zzcpvm%' THEN 'scaffolding'
    WHEN t.slug LIKE 'draft-sreq-%' THEN 'prospect'
    ELSE 'live'
  END`;

const tripClassSql = (stack) => CONFIG.stacks[stack]?.trip_class_sql ?? DEFAULT_TRIP_CLASS_SQL;

/** Run one read-only script against a stack and return rows as string arrays. */
function runSql(stackName, sql) {
  if (CONFIG.error) return Promise.reject(new Error(CONFIG.error));
  const argv = buildArgv(stackName);
  return new Promise((resolve_, reject) => {
    const child = spawn(argv[0], argv.slice(1), {
      stdio: ["pipe", "pipe", "pipe"],
      // Hermes launches stdio MCP servers with a FILTERED environment, so
      // nothing here may assume the shell's. ssh needs HOME to find its
      // known_hosts, and docker needs a PATH. Both are supplied explicitly so
      // the server behaves identically from a terminal and from a gateway.
      env: {
        ...process.env,
        HOME: process.env.HOME || homedir(),
        PATH: process.env.PATH || "/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin",
        PGOPTIONS: process.env.PGOPTIONS || PGOPTIONS,
      },
    });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => { out += d; });
    child.stderr.on("data", (d) => { err += d; });
    child.on("error", (e) => reject(new Error(`${stackName}: ${e.message}`)));
    child.on("close", (code) => {
      if (code !== 0) return reject(new Error(`${stackName}: psql exited ${code}: ${err.trim() || out.trim()}`));
      // Belt and braces for a stack that brings its own `argv` without
      // ON_ERROR_STOP: an ERROR on stderr is a failed query whatever the exit
      // code says. An empty result must only ever mean "the query found nothing".
      if (/\bERROR:/.test(err)) return reject(new Error(`${stackName}: ${err.trim().split("\n")[0]}`));
      const rows = out.split("\n").filter((l) => l.length > 0).map((l) => l.split(SEP));
      resolve_(rows);
    });
    // Pure query text: read-only and the statement timeout ride on the
    // connection, so psql emits no command tags that would look like data.
    child.stdin.end(`${sql}\n`);
  });
}

/** A trip id or slug, and nothing else — the only free text that reaches SQL. */
function safeRef(value) {
  const ref = String(value ?? "").trim();
  if (!/^[A-Za-z0-9_-]{1,120}$/.test(ref)) {
    throw new Error("trip must be a trip id or slug (letters, digits, _ and - only)");
  }
  return ref;
}

function clamp(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(n)));
}

const asTable = (rows, headers) =>
  rows.length === 0 ? "  (none)" : [headers.join(" | "), ...rows.map((r) => r.join(" | "))].map((l) => `  ${l}`).join("\n");

const header = (stack) => `Stack: ${stackLabel(stack)}${isProduction(stack) ? "  [PRODUCTION]" : ""}`;

/* ---------------------------------------------------------------- tools --- */

async function fleetOverview({ stack = CONFIG.defaultStack }) {
  const [stages, jobs, notifications, stalled, unreachable, stuck] = await Promise.all([
    runSql(stack, `SELECT ${tripClassSql(stack)}, t.lifecycle_state, count(*)
                     FROM control_plane.trips t GROUP BY 1,2 ORDER BY 1,2;`),
    runSql(stack, `SELECT j.job_type, j.state, count(*) FROM control_plane.jobs j GROUP BY 1,2 ORDER BY 1,2;`),
    runSql(stack, `SELECT ${tripClassSql(stack)}, n.kind, n.state, count(*)
                     FROM control_plane.notification_outbox n
                     JOIN control_plane.trips t ON t.id = n.trip_id
                    WHERE n.state = 'failed' GROUP BY 1,2,3 ORDER BY 4 DESC;`),
    runSql(stack, `SELECT ${tripClassSql(stack)}, count(*),
                          round(max(extract(epoch from (now() - s.updated_at)) / 3600))
                     FROM control_plane.intake_sessions s
                     JOIN control_plane.trips t ON t.id = s.trip_id
                    WHERE s.state = 'interviewing' GROUP BY 1 ORDER BY 1;`),
    runSql(stack, `SELECT t.slug, coalesce(t.unreachable_reason, '-')
                     FROM control_plane.trips t
                    WHERE t.reachability = 'unreachable' AND t.slug NOT LIKE 'retired-%'
                    ORDER BY t.created_at DESC;`),
    // Confirmed (or approved) with no job row at all. Nothing else here would
    // report it: such a trip is not failed and not unreachable — it simply
    // never started, so it appears healthy in every other view.
    runSql(stack, `SELECT t.slug, ${tripClassSql(stack)}, t.lifecycle_state,
                          round(extract(epoch from (now() - t.updated_at)) / 86400) || 'd'
                     FROM control_plane.trips t
                    WHERE t.lifecycle_state IN ('intake_confirmed','provisioning_approved')
                      AND t.slug NOT LIKE 'retired-%'
                      AND NOT EXISTS (SELECT 1 FROM control_plane.jobs j WHERE j.trip_id = t.id)
                    ORDER BY t.updated_at;`),
  ]);

  const liveStages = stages.filter((r) => r[0] === "live");
  const byStage = (cls) => stages.filter((r) => r[0] === cls).map((r) => `${r[1]}=${r[2]}`).join(", ") || "none";

  return [
    header(stack),
    "",
    "TRIPS BY CLASS AND STAGE",
    `  live:          ${byStage("live")}`,
    `  prospect:      ${byStage("prospect")}   (real signups, not built yet — check the stage)`,
    `  retired:       ${byStage("retired")}   (torn down on purpose — not a problem)`,
    `  scaffolding:   ${byStage("scaffolding")}`,
    "",
    `LIVE TRIPS IN FLIGHT: ${liveStages.filter((r) => !r[1].startsWith("ready_")).reduce((n, r) => n + Number(r[2]), 0)}` +
      `, live and ready: ${liveStages.filter((r) => r[1].startsWith("ready_")).reduce((n, r) => n + Number(r[2]), 0)}`,
    "",
    "PROVISIONING JOBS",
    asTable(jobs, ["job_type", "state", "count"]),
    "",
    "FAILED NOTIFICATIONS (by trip class — only 'live' deserves attention)",
    asTable(notifications, ["class", "kind", "state", "count"]),
    "",
    "UNFINISHED INTERVIEWS (by trip class, with the longest idle time in hours)",
    asTable(stalled, ["class", "count", "max_idle_hours"]),
    "",
    "UNREACHABLE TRIPS (excluding retired)",
    asTable(unreachable, ["slug", "reason"]),
    "",
    "CONFIRMED BUT NEVER BUILT — someone finished answering and no job exists",
    asTable(stuck, ["slug", "class", "stage", "waiting"]),
  ].join("\n");
}

async function listTrips({ stack = CONFIG.defaultStack, filter = "live", limit = 40 }) {
  const n = clamp(limit, 1, 200, 40);
  const where = {
    live: `${tripClassSql(stack)} = 'live'`,
    all: "true",
    active: `${tripClassSql(stack)} IN ('live','prospect') AND t.lifecycle_state NOT IN ('ready_private','ready_public')`,
    unreachable: "t.reachability = 'unreachable'",
    ready: "t.lifecycle_state IN ('ready_private','ready_public')",
  }[filter];
  if (!where) throw new Error(`filter must be one of: live, all, active, unreachable, ready`);

  const rows = await runSql(stack, `
    SELECT t.id, t.slug, ${tripClassSql(stack)}, t.lifecycle_state,
           coalesce(t.reachability, '-'), coalesce(t.unreachable_reason, ''),
           to_char(t.created_at, 'YYYY-MM-DD HH24:MI'),
           round(extract(epoch from (now() - t.updated_at)) / 3600) || 'h'
      FROM control_plane.trips t
     WHERE ${where}
     ORDER BY t.created_at DESC LIMIT ${n};`);

  return `${header(stack)}  filter: ${filter}\n\n` +
    asTable(rows, ["trip_id", "slug", "class", "stage", "reach", "reason", "created", "idle"]);
}

async function tripDetail({ stack = CONFIG.defaultStack, trip }) {
  const ref = safeRef(trip);
  const match = `(t.id = '${ref}' OR t.slug = '${ref}')`;

  const [head, session, jobs, steps, notifications, bindings, people] = await Promise.all([
    runSql(stack, `SELECT t.id, t.slug, ${tripClassSql(stack)}, t.lifecycle_state, coalesce(t.reachability,'-'),
                          coalesce(t.unreachable_reason,'-'), coalesce(t.title,'-'), coalesce(t.destination_label,'-'),
                          coalesce(to_char(t.start_date,'YYYY-MM-DD'),'-'), coalesce(to_char(t.end_date,'YYYY-MM-DD'),'-'),
                          to_char(t.created_at,'YYYY-MM-DD HH24:MI')
                     FROM control_plane.trips t WHERE ${match};`),
    // `awaiting` means something only while a session is interviewing. A
    // confirmed session keeps its last value — all 33 confirmed sessions in
    // production read recap/machine — and the first real report took that for
    // "a summary the system owes the organizer, 16 hours late". Finished
    // sessions say finished.
    runSql(stack, `SELECT s.id, s.state, coalesce(s.phase,'-'),
                          CASE WHEN s.state = 'interviewing' THEN coalesce(s.awaiting,'-') ELSE 'finished' END,
                          coalesce(s.language,'-'), s.interpret_path, to_char(s.updated_at,'MM-DD HH24:MI'),
                          CASE WHEN s.state = 'interviewing'
                               THEN round(extract(epoch from (now() - s.updated_at))/3600) || 'h idle'
                               ELSE '-' END
                     FROM control_plane.intake_sessions s JOIN control_plane.trips t ON t.id = s.trip_id
                    WHERE ${match} ORDER BY s.created_at DESC;`),
    runSql(stack, `SELECT j.id, j.job_type, j.state, j.attempt || '/' || j.max_attempts, coalesce(j.safe_error_code,'-'),
                          to_char(j.created_at,'MM-DD HH24:MI'),
                          round(extract(epoch from (coalesce(j.last_heartbeat_at, j.updated_at) - j.created_at))/60) || 'm'
                     FROM control_plane.jobs j JOIN control_plane.trips t ON t.id = j.trip_id
                    WHERE ${match} ORDER BY j.created_at DESC;`),
    runSql(stack, `SELECT st.step_key, st.state, coalesce(st.safe_error_code,'-'), to_char(st.updated_at,'MM-DD HH24:MI')
                     FROM control_plane.job_steps st
                     JOIN control_plane.jobs j ON j.id = st.job_id
                     JOIN control_plane.trips t ON t.id = j.trip_id
                    WHERE ${match} AND st.state <> 'succeeded' ORDER BY st.updated_at DESC LIMIT 20;`),
    runSql(stack, `SELECT coalesce(n.kind, n.notification_type), n.state, n.attempt || '/' || n.max_attempts,
                          coalesce(to_char(n.sent_at,'MM-DD HH24:MI'),'-')
                     FROM control_plane.notification_outbox n JOIN control_plane.trips t ON t.id = n.trip_id
                    WHERE ${match} ORDER BY n.created_at DESC LIMIT 20;`),
    // chat_id is TEXT, so the sign is read from the string (Telegram groups are
    // negative). `b.chat_id < 0` is a type error, and before ON_ERROR_STOP that
    // error surfaced here as "(none)". The raw id is not returned: the agent
    // needs to know a chat exists, not which one.
    runSql(stack, `SELECT CASE WHEN b.chat_id LIKE '-%' THEN 'group' ELSE 'private' END,
                          coalesce(b.hermes_profile,'-'),
                          CASE WHEN b.closed_at IS NULL THEN 'open' ELSE 'closed: ' || coalesce(b.closed_reason,'?') END,
                          to_char(b.created_at,'MM-DD HH24:MI')
                     FROM control_plane.telegram_chat_bindings b JOIN control_plane.trips t ON t.id = b.trip_id
                    WHERE ${match} ORDER BY b.created_at DESC;`),
    // Roles and counts, never display names. The SOUL forbids repeating names,
    // but a rule in a prompt is not a boundary: the first real report named an
    // organizer — misspelled, and with the wrong gender — because this query
    // handed the name over. What the tool never returns, the agent cannot leak.
    runSql(stack, `SELECT coalesce(l.role,'-'), coalesce(l.verified_via,'-'), count(*)::text
                     FROM control_plane.trip_person_links l JOIN control_plane.trips t ON t.id = l.trip_id
                    WHERE ${match} GROUP BY 1,2 ORDER BY 1;`),
  ]);

  if (head.length === 0) return `No trip matching '${ref}' on ${stack}.`;
  const h = head[0];
  return [
    header(stack),
    "",
    `TRIP ${h[0]}`,
    `  slug ${h[1]}   class ${h[2]}   stage ${h[3]}`,
    `  reachability ${h[4]}${h[5] === "-" ? "" : ` (${h[5]})`}`,
    `  ${h[6]} — ${h[7]}   ${h[8]} → ${h[9]}   created ${h[10]}`,
    "",
    "INTERVIEW SESSIONS",
    asTable(session, ["session", "state", "phase", "awaiting", "lang", "interpret", "updated", "idle"]),
    "",
    "JOBS",
    asTable(jobs, ["job", "type", "state", "attempt", "error", "created", "took"]),
    "",
    "UNFINISHED JOB STEPS",
    asTable(steps, ["step", "state", "error", "updated"]),
    "",
    "NOTIFICATIONS",
    asTable(notifications, ["kind", "state", "attempt", "sent"]),
    "",
    "TELEGRAM BINDINGS  (a live trip needs an open private chat; a group binding means the family is connected)",
    asTable(bindings, ["kind", "companion_profile", "status", "since"]),
    "",
    "PEOPLE LINKED  (roles only — names are deliberately not available to this tool)",
    asTable(people, ["role", "verified_via", "count"]),
  ].join("\n");
}

async function failures({ stack = CONFIG.defaultStack, days = 7 }) {
  const d = clamp(days, 1, 180, 7);
  const [jobs, notifications, unreachable] = await Promise.all([
    runSql(stack, `SELECT t.slug, ${tripClassSql(stack)}, j.job_type, j.state, coalesce(j.safe_error_code,'-'),
                          j.attempt || '/' || j.max_attempts, to_char(j.updated_at,'MM-DD HH24:MI')
                     FROM control_plane.jobs j JOIN control_plane.trips t ON t.id = j.trip_id
                    WHERE j.state NOT IN ('succeeded','completed')
                      AND j.updated_at > now() - interval '${d} days'
                    ORDER BY j.updated_at DESC;`),
    runSql(stack, `SELECT t.slug, ${tripClassSql(stack)}, coalesce(n.kind, n.notification_type), n.state,
                          n.attempt || '/' || n.max_attempts, to_char(n.updated_at,'MM-DD HH24:MI')
                     FROM control_plane.notification_outbox n JOIN control_plane.trips t ON t.id = n.trip_id
                    WHERE n.state = 'failed' AND n.updated_at > now() - interval '${d} days'
                    ORDER BY n.updated_at DESC LIMIT 40;`),
    runSql(stack, `SELECT t.slug, ${tripClassSql(stack)}, coalesce(t.unreachable_reason,'-'),
                          coalesce(to_char(t.reachability_checked_at,'MM-DD HH24:MI'),'-')
                     FROM control_plane.trips t WHERE t.reachability = 'unreachable' ORDER BY t.updated_at DESC;`),
  ]);

  const liveCount = [...jobs, ...notifications, ...unreachable].filter((r) => r[1] === "live").length;
  return [
    `${header(stack)}   window: last ${d} days`,
    `Rows affecting LIVE trips: ${liveCount}. Anything marked retired or scaffolding was torn down on purpose.`,
    "",
    "FAILED / STUCK JOBS",
    asTable(jobs, ["slug", "class", "type", "state", "error", "attempt", "updated"]),
    "",
    "FAILED NOTIFICATIONS",
    asTable(notifications, ["slug", "class", "kind", "state", "attempt", "updated"]),
    "",
    "UNREACHABLE TRIPS",
    asTable(unreachable, ["slug", "class", "reason", "checked"]),
  ].join("\n");
}

async function stalledInterviews({ stack = CONFIG.defaultStack, hours = 6 }) {
  const h = clamp(hours, 1, 2000, 6);
  const rows = await runSql(stack, `
    SELECT t.slug, ${tripClassSql(stack)}, coalesce(s.phase,'-'), coalesce(s.awaiting,'-'), coalesce(s.language,'-'),
           round(extract(epoch from (now() - s.updated_at))/3600) || 'h',
           CASE WHEN s.expires_at IS NULL THEN '-'
                WHEN s.expires_at < now() THEN 'EXPIRED'
                ELSE 'expires ' || to_char(s.expires_at,'MM-DD HH24:MI') END
      FROM control_plane.intake_sessions s JOIN control_plane.trips t ON t.id = s.trip_id
     WHERE s.state = 'interviewing' AND s.updated_at < now() - interval '${h} hours'
     ORDER BY s.updated_at;`);

  return [
    `${header(stack)}   idle for more than ${h}h`,
    "",
    "An interview 'awaiting person' is waiting on the organizer — normal for a while, abandoned eventually.",
    "'awaiting machine' for hours is the interesting one: the interview is waiting on US.",
    "",
    asTable(rows, ["slug", "class", "phase", "awaiting", "lang", "idle", "expiry"]),
  ].join("\n");
}

async function statistics({ stack = CONFIG.defaultStack, days = 30 }) {
  const d = clamp(days, 1, 365, 30);
  const since = `now() - interval '${d} days'`;

  const [funnel, builds, durations, classes] = await Promise.all([
    runSql(stack, `
      SELECT 'trips created', count(*)::text FROM control_plane.trips WHERE created_at > ${since}
      UNION ALL SELECT 'interviews started', count(*)::text FROM control_plane.intake_sessions WHERE created_at > ${since}
      UNION ALL SELECT 'interviews confirmed', count(*)::text FROM control_plane.intake_sessions
                WHERE state = 'confirmed' AND updated_at > ${since}
      UNION ALL SELECT 'still interviewing', count(*)::text FROM control_plane.intake_sessions WHERE state = 'interviewing'
      UNION ALL SELECT 'trips reaching ready', count(*)::text FROM control_plane.trips
                WHERE lifecycle_state IN ('ready_private','ready_public') AND updated_at > ${since};`),
    runSql(stack, `SELECT j.state, count(*)::text FROM control_plane.jobs j
                    WHERE j.created_at > ${since} GROUP BY 1 ORDER BY 1;`),
    runSql(stack, `
      -- To the last worker heartbeat, NOT to updated_at. A succeeded job's
      -- updated_at lands 2-8 seconds after creation because it marks the claim
      -- rather than the finish, which reported every build as 0 minutes.
      SELECT 'build minutes (median, to last heartbeat)',
             coalesce(round(percentile_cont(0.5) WITHIN GROUP (
               ORDER BY extract(epoch from (coalesce(j.last_heartbeat_at, j.updated_at) - j.created_at))/60))::text, 'n/a')
        FROM control_plane.jobs j WHERE j.state = 'succeeded' AND j.created_at > ${since}
      UNION ALL
      SELECT 'interview minutes (median)',
             coalesce(round(percentile_cont(0.5) WITHIN GROUP (
               ORDER BY extract(epoch from (s.updated_at - s.created_at))/60))::text, 'n/a')
        FROM control_plane.intake_sessions s WHERE s.state = 'confirmed' AND s.created_at > ${since};`),
    runSql(stack, `SELECT ${tripClassSql(stack)}, count(*)::text FROM control_plane.trips t
                    WHERE t.created_at > ${since} GROUP BY 1 ORDER BY 1;`),
  ]);

  const value = (rows, key) => rows.find((r) => r[0] === key)?.[1] ?? "0";
  const started = Number(value(funnel, "interviews started"));
  const confirmed = Number(value(funnel, "interviews confirmed"));
  const ok = Number(builds.find((r) => r[0] === "succeeded")?.[1] ?? 0);
  const bad = builds.filter((r) => r[0] !== "succeeded").reduce((n, r) => n + Number(r[1]), 0);
  const pct = (a, b) => (b > 0 ? `${Math.round((a / b) * 100)}%` : "n/a");

  return [
    `${header(stack)}   window: last ${d} days`,
    "",
    "FUNNEL",
    asTable(funnel, ["step", "count"]),
    `  interview completion rate: ${pct(confirmed, started)}`,
    "",
    "TRIPS CREATED, BY CLASS  (retired/scaffolding are test runs, not customers)",
    asTable(classes, ["class", "count"]),
    "",
    "PROVISIONING",
    asTable(builds, ["job state", "count"]),
    `  build success rate: ${pct(ok, ok + bad)}`,
    "",
    "DURATIONS",
    asTable(durations, ["measure", "value"]),
  ].join("\n");
}

/**
 * Everything wrong right now, and NOTHING AT ALL when the fleet is healthy.
 *
 * The empty string is the contract. A scheduled watchdog runs this and stays
 * silent on empty output, so "quiet" is a structural property rather than
 * something a shell script greps for. Only `live` and `prospect` trips are
 * considered — a retired trip's failures are the expected debris of a teardown,
 * and alerting on them would train the reader to ignore the channel.
 *
 * THE SAME INCIDENTS PRODUCE THE SAME BYTES. Hermes runs this as a monitor
 * script and hashes its exact output: unchanged output suppresses the model run,
 * any change wakes it. This used to print elapsed time ("idle 7h", "waiting
 * 5d"), so one unchanged stalled interview re-ran the model every hour and a
 * stuck trip every day. So: no value computed from now() is ever printed — each
 * incident says when it STARTED, in UTC — and every query has an ORDER BY, so row
 * order cannot change the hash either. How long something has been going on
 * is `stalled_interviews` and `trip_detail`, which nothing hashes.
 */
async function alerts({ stack = CONFIG.defaultStack, hours = 1 }) {
  const h = clamp(hours, 1, 240, 1);
  const real = `${tripClassSql(stack)} IN ('live','prospect')`;

  const [unreachable, jobs, notifications, stuck, awaiting, companionless] = await Promise.all([
    runSql(stack, `SELECT t.slug, coalesce(t.unreachable_reason,'-')
                     FROM control_plane.trips t
                    WHERE t.reachability = 'unreachable' AND ${real}
                    ORDER BY t.slug;`),
    runSql(stack, `SELECT t.slug, j.job_type, coalesce(j.safe_error_code,'-'), j.attempt || '/' || j.max_attempts
                     FROM control_plane.jobs j JOIN control_plane.trips t ON t.id = j.trip_id
                    WHERE j.state = 'failed' AND ${real}
                    ORDER BY t.slug, j.id;`),
    runSql(stack, `SELECT t.slug, coalesce(n.kind, n.notification_type), n.attempt || '/' || n.max_attempts
                     FROM control_plane.notification_outbox n JOIN control_plane.trips t ON t.id = n.trip_id
                    WHERE n.state = 'failed' AND ${real}
                    ORDER BY t.slug, n.id;`),
    // When the organizer confirmed — a fixed moment — not how long ago that was.
    runSql(stack, `SELECT t.slug, t.lifecycle_state,
                          coalesce(to_char((SELECT max(v.confirmed_at) FROM control_plane.intake_versions v
                                             WHERE v.trip_id = t.id) AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI') || ' UTC',
                                   'at an unrecorded time')
                     FROM control_plane.trips t
                    WHERE t.lifecycle_state IN ('intake_confirmed','provisioning_approved')
                      AND ${real}
                      AND NOT EXISTS (SELECT 1 FROM control_plane.jobs j WHERE j.trip_id = t.id)
                    ORDER BY t.slug;`),
    // Since when the interview has been waiting on us (awaiting_since is set
    // whenever the turn passes to the machine), not for how many hours.
    runSql(stack, `SELECT t.slug, coalesce(s.phase,'-'),
                          to_char(s.awaiting_since AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI') || ' UTC'
                     FROM control_plane.intake_sessions s JOIN control_plane.trips t ON t.id = s.trip_id
                    WHERE s.state = 'interviewing' AND s.awaiting = 'machine'
                      AND s.awaiting_since < now() - interval '${h} hours' AND ${real}
                    ORDER BY t.slug, s.id;`),
    // Built, but the organizer has no open private chat — a site with no
    // assistant behind it. This is exactly how the 2026-09-15 trip failed.
    // chat_id is TEXT: this check was written as `b.chat_id > 0`, a type error
    // that — before ON_ERROR_STOP — returned no rows, so it could never fire.
    runSql(stack, `SELECT t.slug
                     FROM control_plane.trips t
                    WHERE t.lifecycle_state = 'ready_private' AND ${tripClassSql(stack)} = 'live'
                      AND NOT EXISTS (SELECT 1 FROM control_plane.telegram_chat_bindings b
                                       WHERE b.trip_id = t.id AND b.closed_at IS NULL
                                         AND b.chat_id NOT LIKE '-%')
                    ORDER BY t.slug;`),
  ]);

  const sections = [];
  const add = (title, rows, render) => {
    if (rows.length > 0) sections.push(`${title}\n${rows.map((r) => `  • ${render(r)}`).join("\n")}`);
  };
  add("UNREACHABLE", unreachable, (r) => `${r[0]} — ${r[1]}`);
  add("BUILT WITHOUT AN ORGANIZER CHAT", companionless, (r) => `${r[0]} — site is up, no private chat bound`);
  add("FAILED JOBS", jobs, (r) => `${r[0]} — ${r[1]} ${r[2]} (attempt ${r[3]})`);
  add("CONFIRMED BUT NEVER BUILT", stuck, (r) => `${r[0]} — ${r[1]}, confirmed ${r[2]}`);
  add("INTERVIEW WAITING ON US", awaiting, (r) => `${r[0]} — phase ${r[1]}, waiting on us since ${r[2]}`);
  add("UNDELIVERED NOTIFICATIONS", notifications, (r) => `${r[0]} — ${r[1]} (attempt ${r[2]})`);

  if (sections.length === 0) return "";
  return [`⚠️ Kinerary fleet — ${stackLabel(stack)}`, ...sections].join("\n\n");
}

async function stacksTool() {
  if (CONFIG.error) return `No usable deployment configuration.\n\n${CONFIG.error}`;

  const lines = [
    `Configured by: ${CONFIG.path}`,
    `Default stack: ${CONFIG.defaultStack}`,
    "",
    "Which stack is which, and whether this agent can reach it right now.",
    "",
  ];
  for (const name of Object.keys(CONFIG.stacks)) {
    let reachable;
    try {
      const rows = await runSql(name, "SELECT count(*)::text FROM control_plane.trips;");
      reachable = `reachable — ${rows[0]?.[0] ?? "?"} trips`;
    } catch (error) {
      reachable = `UNREACHABLE — ${error.message.split("\n")[0]}`;
    }
    lines.push(`  ${name}${isProduction(name) ? "  [PRODUCTION]" : "  [not production]"}`);
    lines.push(`    ${stackLabel(name)}`);
    lines.push(`    ${reachable}`);
  }
  lines.push("", "Only a stack marked [PRODUCTION] describes real travellers. Never merge the numbers.");
  return lines.join("\n");
}

const STACK_ARG = {
  type: "string",
  ...(Object.keys(CONFIG.stacks).length > 0 ? { enum: Object.keys(CONFIG.stacks) } : {}),
  description:
    `Which control plane to read. Default '${CONFIG.defaultStack ?? "(unconfigured)"}'` +
    `. Configured: ${Object.keys(CONFIG.stacks).join(", ") || "none"}.`,
};

const TOOLS = [
  {
    name: "fleet_overview",
    description:
      "The whole fleet at a glance: trips by stage split into live / prospect / retired / scaffolding, provisioning jobs, failed notifications, unfinished interviews, unreachable trips and trips confirmed but never built. Start here.",
    inputSchema: { type: "object", properties: { stack: STACK_ARG } },
    handler: fleetOverview,
  },
  {
    name: "list_trips",
    description: "List trips with stage, reachability and idle time. filter: live (default), active (in flight), all, unreachable, ready.",
    inputSchema: {
      type: "object",
      properties: {
        stack: STACK_ARG,
        filter: { type: "string", enum: ["live", "active", "all", "unreachable", "ready"] },
        limit: { type: "number", description: "Max rows, 1-200 (default 40)" },
      },
    },
    handler: listTrips,
  },
  {
    name: "trip_detail",
    description:
      "Everything about one trip by id or slug: stage, reachability and reason, interview sessions with phase/awaiting/idle, jobs and failed steps with error codes, notifications, Telegram bindings (private chat and family group) and linked people.",
    inputSchema: {
      type: "object",
      properties: { stack: STACK_ARG, trip: { type: "string", description: "Trip id (trip_…) or slug" } },
      required: ["trip"],
    },
    handler: tripDetail,
  },
  {
    name: "failures",
    description: "Failed or stuck jobs, failed notifications and unreachable trips in a window, each tagged with the trip's class so test-run noise is separable from real problems.",
    inputSchema: { type: "object", properties: { stack: STACK_ARG, days: { type: "number", description: "Look-back window in days (default 7)" } } },
    handler: failures,
  },
  {
    name: "stalled_interviews",
    description: "Interviews that have not moved for a while, with what they are waiting on. 'awaiting machine' for hours means the system is stuck, not the person.",
    inputSchema: { type: "object", properties: { stack: STACK_ARG, hours: { type: "number", description: "Idle threshold in hours (default 6)" } } },
    handler: stalledInterviews,
  },
  {
    name: "statistics",
    description: "Funnel and health numbers over a window: trips created by class, interview completion rate, provisioning success rate, median interview and build durations.",
    inputSchema: { type: "object", properties: { stack: STACK_ARG, days: { type: "number", description: "Window in days (default 30)" } } },
    handler: statistics,
  },
  {
    name: "alerts",
    description:
      "Only what is actionable right now for real (live/prospect) trips: unreachable trips, trips built with no organizer chat, failed jobs, confirmed-but-never-built, interviews waiting on us, undelivered notifications. Returns NOTHING when the fleet is healthy — use it to answer 'is anything wrong?'.",
    inputSchema: {
      type: "object",
      properties: { stack: STACK_ARG, hours: { type: "number", description: "How long an interview may wait on us before it counts (default 1h)" } },
    },
    handler: alerts,
  },
  {
    name: "stacks",
    description: "Which stacks are configured, which one is production, where the configuration came from, and a live connectivity check for each. Use when a read fails or when unsure which control plane a number came from.",
    inputSchema: { type: "object", properties: {} },
    handler: stacksTool,
  },
];

/* ------------------------------------------------------- MCP over stdio --- */

const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
const reply = (id, result) => send({ jsonrpc: "2.0", id, result });
const fail = (id, code, message) => send({ jsonrpc: "2.0", id, error: { code, message } });

async function handle(request) {
  const { id, method, params } = request;
  // Notifications carry no id and take no response.
  if (id === undefined || id === null) return;

  switch (method) {
    case "initialize":
      // Echo the client's protocol version back: this server is version-neutral,
      // so it stays compatible as an MCP client moves.
      return reply(id, {
        protocolVersion: params?.protocolVersion ?? "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
      });
    case "ping":
      return reply(id, {});
    case "tools/list":
      return reply(id, {
        tools: TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })),
      });
    case "tools/call": {
      const tool = TOOLS.find((t) => t.name === params?.name);
      if (!tool) return fail(id, -32602, `unknown tool '${params?.name}'`);
      try {
        const text = await tool.handler(params?.arguments ?? {});
        return reply(id, { content: [{ type: "text", text }] });
      } catch (error) {
        // Reported as tool output, not a protocol error: the agent should see
        // "that stack was unreachable" as an answer it can relay, not a crash.
        return reply(id, { content: [{ type: "text", text: `Tool failed: ${error.message}` }], isError: true });
      }
    }
    default:
      return fail(id, -32601, `method not found: ${method}`);
  }
}

/* ------------------------------------------------------------------ CLI --- */

/**
 * Run one tool straight from a shell: `fleet-mcp.mjs --tool fleet_overview`.
 *
 * This is the same handler the agent calls, deliberately: a scheduled digest
 * and the agent's own answer cannot drift apart, because there is one
 * implementation. It exists because a cron job can run a script with NO model
 * at all — which is how a monitor stays cheap enough to run often, and how an
 * alert still goes out on a day when no model provider is reachable.
 */
async function runCli(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 2) {
    const key = String(argv[i] ?? "").replace(/^--/, "");
    const value = argv[i + 1];
    if (key) args[key] = /^\d+$/.test(value ?? "") ? Number(value) : value;
  }
  const tool = TOOLS.find((t) => t.name === args.tool);
  if (!tool) {
    process.stderr.write(
      `usage: fleet-mcp.mjs --tool <${TOOLS.map((t) => t.name).join("|")}>` +
        ` [--stack <name>] [--days N] [--hours N] [--filter live] [--trip REF]\n`,
    );
    process.exit(2);
  }
  delete args.tool;
  try {
    const text = await tool.handler(args);
    // Nothing to say prints nothing at all, not a blank line: a watchdog treats
    // empty stdout as "stay silent", and a lone newline is not empty.
    if (text.trim().length > 0) process.stdout.write(`${text}\n`);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exit(1);
  }
}

if (process.argv.includes("--tool")) {
  await runCli(process.argv.slice(2));
} else {
  createInterface({ input: process.stdin }).on("line", (line) => {
    const text = line.trim();
    if (!text) return;
    let request;
    try {
      request = JSON.parse(text);
    } catch {
      return fail(null, -32700, "parse error");
    }
    handle(request).catch((error) => fail(request?.id ?? null, -32603, error.message));
  });
}
