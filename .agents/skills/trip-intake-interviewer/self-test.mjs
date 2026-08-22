#!/usr/bin/env node
/**
 * self-test.mjs — drives a real scripted conversation through the real
 * trip-intake Hermes profile, for iterating on SOUL.md/skill changes
 * without needing a live human every time.
 *
 * This is NOT a substitute for a real-person interview: it proves the
 * mechanics work (the agent calls the right tools, reaches confirmation,
 * the resulting intake data is well-formed, no technical terms leak) but
 * it cannot judge whether the conversation actually *felt* good to a real
 * organizer — only a human can tell you that.
 *
 * Requires: hermes CLI on PATH, the interview-mcp.ts server running
 * (control-plane/deployment's local stack + `node --import tsx
 * src/interview-mcp.ts`), and CONTROL_PLANE_DATABASE_URL pointed at the
 * same Postgres the running control-plane API uses.
 *
 * Must be run with tsx so the import from ../../../control-plane/api/src
 * (a .ts file) resolves:
 *   node --import tsx self-test.mjs
 *
 * Exit codes: 0 = confirmed intake reached with no leaked technical terms;
 * 1 = usage/setup error; 2 = the conversation never reached confirmation
 * within the turn budget; 3 = a forbidden technical term leaked into a
 * response.
 */
import { spawnSync } from "node:child_process";
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const controlPlaneApiDir = join(__dirname, "..", "..", "..", "control-plane", "api");
// Node's ESM resolution is scoped to each importing file's own directory
// ancestry — this script lives under .agents/skills/, nowhere near
// control-plane/api/node_modules, so a plain `import pg from "pg"` cannot
// find it. createRequire, resolved against a file *inside* control-plane/api,
// looks up node_modules from there instead.
const requireFromApi = createRequire(pathToFileURL(join(controlPlaneApiDir, "package.json")));
const pg = requireFromApi("pg");

const DB_URL = process.env.CONTROL_PLANE_DATABASE_URL;
if (!DB_URL) {
  console.error("[self-test] set CONTROL_PLANE_DATABASE_URL (the same one interview-mcp.ts and the control-plane API use)");
  process.exit(1);
}
const PROFILE = process.env.HERMES_PROFILE || "trip-intake";
const MAX_TURNS = Number(process.env.SELF_TEST_MAX_TURNS || "15");

const FORBIDDEN_TERMS = [/\bMCP\b/i, /\bJSON\b/i, /session token/i, /sessionToken/, /control[- ]plane/i, /\bAPI\b/, /\bendpoint\b/i];

function log(...args) { console.error("[self-test]", ...args); }

const transcriptDir = mkdtempSync(join(tmpdir(), "interview-self-test-"));
const transcriptPath = join(transcriptDir, "transcript.txt");
let transcript = "";

const pool = new pg.Pool({ connectionString: DB_URL });

async function cleanup(tripId, userId) {
  if (tripId) {
    await pool.query("DELETE FROM control_plane.intake_versions WHERE trip_id = $1", [tripId]);
    await pool.query("DELETE FROM control_plane.intake_sessions WHERE trip_id = $1", [tripId]);
    await pool.query("DELETE FROM control_plane.interview_enrollments WHERE trip_id = $1", [tripId]);
    await pool.query("DELETE FROM control_plane.trip_memberships WHERE trip_id = $1", [tripId]);
    await pool.query("DELETE FROM control_plane.trips WHERE id = $1", [tripId]);
  }
  if (userId) {
    await pool.query("DELETE FROM control_plane.users WHERE id = $1", [userId]);
  }
  await pool.end();
  writeFileSync(transcriptPath, transcript);
  log(`fixture cleaned up; transcript kept at ${transcriptPath}`);
}

function checkLeakage(text) {
  for (const pattern of FORBIDDEN_TERMS) {
    if (pattern.test(text)) {
      console.error(`[self-test] FORBIDDEN TERM LEAKED (${pattern}) in response:\n${text}`);
      return pattern;
    }
  }
  return null;
}

let sessionId;
function send(message) {
  const args = ["-p", PROFILE, "chat", "-q", message, "-Q"];
  if (sessionId) args.push("--resume", sessionId);
  // hermes chat -Q prints "session_id: ..." to stderr, not stdout — capture
  // both explicitly rather than relying on execFileSync's stdout-only
  // return value, or every turn silently starts a fresh session instead of
  // resuming (confirmed the hard way: 15 turns, 15 different session ids).
  const result = spawnSync("hermes", args, { encoding: "utf8", timeout: 120_000 });
  if (result.error) throw result.error;
  const combined = `${result.stdout || ""}${result.stderr || ""}`;
  transcript += `--- organizer: ${message}\n--- agent (raw): ${combined}\n\n`;
  const match = combined.match(/session_id: (\S+)/);
  if (match) sessionId = match[1];
  const response = (result.stdout || "")
    .split("\n")
    .filter((line) => !line.startsWith("session_id:") && !line.startsWith("↻"))
    .join("\n")
    .trim();
  const leaked = checkLeakage(response);
  return { response, leaked };
}

async function main() {
  const suffix = `${Date.now()}${Math.floor(Math.random() * 1e6)}`;
  const userId = `user_selftest${suffix}`;
  const tripId = `trip_selftest${suffix}`;

  try {
    log(`setting up fixture trip ${tripId}`);
    await pool.query("INSERT INTO control_plane.users(id, status, display_name) VALUES ($1, 'active', 'Self-Test Organizer')", [userId]);
    await pool.query("INSERT INTO control_plane.trips(id, slug, lifecycle_state) VALUES ($1, $2, 'draft')", [tripId, `self-test-${suffix}`]);
    await pool.query(
      "INSERT INTO control_plane.trip_memberships(id, trip_id, user_id, role, status) VALUES ($1, $2, $3, 'owner', 'active')",
      [`memb_selftest${suffix}`, tripId, userId],
    );

    const { issueEnrollment } = await import(pathToFileURL(join(controlPlaneApiDir, "src", "enrollment.js")));
    const enrolled = await issueEnrollment(pool, userId, tripId, { enrollmentTtlSeconds: 3600 });
    if (!enrolled.ok) throw new Error(`issueEnrollment failed: ${enrolled.reason}`);
    log("enrollment token issued");

    log(`starting scripted conversation (max ${MAX_TURNS} turns)`);
    // A real deep link delivers "/start <payload>" as the literal first
    // message when tapped — plain conversational prose reads to the agent
    // as an unverified in-chat claim, not the actual authorization channel,
    // and it correctly refuses to start on that basis (confirmed by an
    // earlier run of this harness). Match the real delivery format.
    let result = send(`/start ${enrolled.token}`);
    if (result.leaked) { await cleanup(tripId, userId); process.exit(3); }

    let turn = 0;
    let state;
    while (turn < MAX_TURNS) {
      turn += 1;
      const row = await pool.query("SELECT state FROM control_plane.intake_sessions WHERE trip_id = $1", [tripId]);
      state = row.rows[0]?.state;
      log(`turn ${turn}: session state = ${state ?? "<not started>"}`);

      if (state === "awaiting_confirmation") {
        log("reached awaiting_confirmation, sending CONFIRM");
        result = send("CONFIRM");
        if (result.leaked) { await cleanup(tripId, userId); process.exit(3); }
        break;
      }

      const message = state
        ? "Family trip to Japan, 2 travelers: Alex (40) and Sam (12), both in the Test family. " +
          "Departing 2026-09-06, returning 2026-09-20. One stop: Tokyo, same dates. " +
          "Nothing booked yet, no special needs. If you need anything else, use TBD or skip it."
        : "Yes, let's begin — please start the interview using that token.";
      result = send(message);
      if (result.leaked) { await cleanup(tripId, userId); process.exit(3); }
    }

    if (state !== "awaiting_confirmation") {
      log(`never reached confirmation within ${MAX_TURNS} turns`);
      await cleanup(tripId, userId);
      process.exit(2);
    }

    log("verifying confirmed intake in the database");
    const versionRow = await pool.query(
      "SELECT id, data FROM control_plane.intake_versions WHERE trip_id = $1 ORDER BY version DESC LIMIT 1",
      [tripId],
    );
    if (!versionRow.rows[0]) {
      log("FAILED: no confirmed intake_versions row exists");
      await cleanup(tripId, userId);
      process.exit(2);
    }
    log("confirmed intake row:", JSON.stringify(versionRow.rows[0]).slice(0, 500));

    await cleanup(tripId, userId);
    log("PASS — real conversation reached confirmation, no forbidden terms leaked");
    process.exit(0);
  } catch (error) {
    log("ERROR:", error.message);
    await cleanup(tripId, userId).catch(() => {});
    process.exit(1);
  }
}

main();
