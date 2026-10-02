/**
 * Prints the daily control-plan report (analytics/report.ts) for one trip's
 * one local day, read straight from `control_plane.assistant_events` — issue
 * #326. Read-only: it opens one pool, runs `rollupAssistantEvents` and
 * `renderDailyReport`, and prints. It never writes a row.
 *
 *   node --import tsx tools/assistant-report.ts --trip <trip_id> --day YYYY-MM-DD [--tz Asia/Tokyo]
 *
 * DB URL: CONTROL_PLANE_DATABASE_URL, else CONTROL_PLANE_DATABASE_URL_FILE,
 * else CONTROL_PLANE_TEST_DATABASE_URL — the same order `release-cli.ts` uses,
 * so it works unmodified against the local compose stack or a test database.
 */
import { readFile } from "node:fs/promises";
import pg from "pg";
import { renderDailyReport } from "../src/analytics/report.js";
import { emptyDayRollup } from "../src/analytics/rates.js";
import { rollupAssistantEvents } from "../src/analytics/store.js";

function parseFlags(argv: string[]): Map<string, string> {
  const flags = new Map<string, string>();
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === undefined || !arg.startsWith("--")) continue;
    const eq = arg.indexOf("=");
    if (eq >= 0) flags.set(arg.slice(2, eq), arg.slice(eq + 1));
    else { flags.set(arg.slice(2), argv[i + 1] ?? ""); i += 1; }
  }
  return flags;
}

async function resolveDatabaseUrl(): Promise<string> {
  const direct = process.env.CONTROL_PLANE_DATABASE_URL;
  if (direct) return direct;
  const file = process.env.CONTROL_PLANE_DATABASE_URL_FILE;
  if (file) return (await readFile(file, "utf8")).trim();
  const test = process.env.CONTROL_PLANE_TEST_DATABASE_URL;
  if (test) return test;
  throw new Error("no database url (set CONTROL_PLANE_DATABASE_URL, CONTROL_PLANE_DATABASE_URL_FILE, or CONTROL_PLANE_TEST_DATABASE_URL)");
}

const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

async function main(): Promise<void> {
  const flags = parseFlags(process.argv.slice(2));
  const tripId = flags.get("trip");
  const day = flags.get("day");
  const timeZone = flags.get("tz") ?? "UTC";
  if (!tripId || !day) {
    console.error("usage: assistant-report.ts --trip <trip_id> --day YYYY-MM-DD [--tz <IANA zone>]");
    process.exitCode = 2;
    return;
  }
  if (!DAY_PATTERN.test(day)) {
    console.error(`--day must be YYYY-MM-DD, got ${JSON.stringify(day)}`);
    process.exitCode = 2;
    return;
  }

  const databaseUrl = await resolveDatabaseUrl();
  const pool = new pg.Pool({ connectionString: databaseUrl });
  try {
    const days = await rollupAssistantEvents(pool, { tripId, timeZone });
    const rollup = days.find((d) => d.local_day === day) ?? emptyDayRollup(tripId, day);
    const { markdown } = renderDailyReport(rollup);
    console.log(markdown);
  } finally {
    await pool.end();
  }
}

await main();
