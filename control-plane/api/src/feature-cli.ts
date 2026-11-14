// Operator command for per-trip feature switches (#567, slice S1).
// Not a served route's client: it talks to the database directly, like
// release-cli.ts, so it needs the same database URL.
//
//   npm run feature -- list
//   npm run feature -- show --trip <slug|id>
//   npm run feature -- set <switch> on|off (--trip <slug|id> | --all | --new-trips) [--live] [--by <name>]
//
//   --trip       this trip only
//   --all        every trip, present and future
//   --new-trips  trips created after this moment
//   --live       "I know this reaches trips in use". Required for --all and
//                --new-trips, and for any --trip at ready_private or later (only a trip
//                before ready_private is free of it). It is a
//                deploy under CLAUDE.md hard rule 2, and the Claude Code hook
//                asks before running a command that carries it.
//   --by         who is changing it (stored as a sha256 digest). Default:
//                $CONTROL_PLANE_FEATURE_OPERATOR, else "operator:cli".
//
// A switch must be declared in shared/feature-switches.js; anything else is
// refused before the database is opened.
//
// DB URL: --database-url, else CONTROL_PLANE_DATABASE_URL, else
// CONTROL_PLANE_DATABASE_URL_FILE, else CONTROL_PLANE_TEST_DATABASE_URL.

import { readFile } from "node:fs/promises";
import { findSwitch } from "../../../shared/feature-switches.js";
import { createDatabasePool } from "./database.js";
import {
  REGISTRY_FILE,
  describeFeatureSwitches,
  findTrip,
  listFeatureSwitches,
  setFeatureSwitch,
  type SwitchScope,
} from "./feature-switches.js";

const BOOLEAN_FLAGS = new Set(["all", "new-trips", "live"]);

function parseFlags(argv: string[]): { positional: string[]; flags: Map<string, string> } {
  const positional: string[] = [];
  const flags = new Map<string, string>();
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === undefined) continue;
    if (arg.startsWith("--")) {
      const eq = arg.indexOf("=");
      const name = eq >= 0 ? arg.slice(2, eq) : arg.slice(2);
      if (eq >= 0) flags.set(name, arg.slice(eq + 1));
      else if (BOOLEAN_FLAGS.has(name)) flags.set(name, "true");
      else { flags.set(name, argv[i + 1] ?? ""); i += 1; }
    } else {
      positional.push(arg);
    }
  }
  return { positional, flags };
}

async function resolveDatabaseUrl(flags: Map<string, string>): Promise<string> {
  const direct = flags.get("database-url") ?? process.env.CONTROL_PLANE_DATABASE_URL;
  if (direct) return direct;
  const file = process.env.CONTROL_PLANE_DATABASE_URL_FILE;
  if (file) return (await readFile(file, "utf8")).trim();
  const test = process.env.CONTROL_PLANE_TEST_DATABASE_URL;
  if (test) return test;
  throw new Error("no database url (set CONTROL_PLANE_DATABASE_URL or pass --database-url)");
}

const USAGE = [
  "usage: feature list",
  "       feature show --trip <slug|id>",
  "       feature set <switch> on|off (--trip <slug|id> | --all | --new-trips) [--live] [--by <name>]",
].join("\n");

function pad(text: string, width: number): string {
  return text.length >= width ? text : text + " ".repeat(width - text.length);
}

function cmdList(): number {
  const rows = listFeatureSwitches();
  const width = Math.max(...rows.map((row) => row.name.length), 6);
  for (const row of rows) {
    process.stdout.write(`${pad(row.name, width)}  ${row.surfaces.join(",")}${row.memberVisible ? " (members see it)" : ""}  ${row.summary}\n`);
  }
  process.stdout.write(`\nDeclared in ${REGISTRY_FILE}.\n`);
  return 0;
}

async function cmdShow(flags: Map<string, string>): Promise<number> {
  const ref = flags.get("trip");
  if (!ref) { process.stderr.write(`${USAGE}\n`); return 2; }
  const pool = createDatabasePool(await resolveDatabaseUrl(flags));
  try {
    const trip = await findTrip(pool, ref);
    if (!trip) { process.stderr.write(`no trip "${ref}"\n`); return 1; }
    const view = await describeFeatureSwitches(pool, trip.id);
    const width = Math.max(...view.map((row) => row.name.length), 6);
    process.stdout.write(`${trip.slug} (${trip.lifecycleState})\n`);
    for (const row of view) {
      const where = row.source === "default" ? "default" : row.source === "trip" ? "this trip" : row.source === "all_trips" ? "every trip" : "future trips";
      process.stdout.write(`${pad(row.name, width)}  ${pad(row.enabled ? "on" : "off", 3)}  ${pad(where, 12)}  ${row.summary}\n`);
    }
    return 0;
  } finally {
    await pool.end();
  }
}

async function cmdSet(positional: string[], flags: Map<string, string>): Promise<number> {
  const [name, value] = positional;
  if (!name || (value !== "on" && value !== "off")) { process.stderr.write(`${USAGE}\n`); return 2; }
  const scopes: SwitchScope[] = [];
  if (flags.has("trip")) scopes.push("trip");
  if (flags.has("all")) scopes.push("all_trips");
  if (flags.has("new-trips")) scopes.push("new_trips");
  if (scopes.length !== 1) {
    process.stderr.write(`say where: exactly one of --trip <slug|id>, --all, --new-trips\n${USAGE}\n`);
    return 2;
  }
  // Before the database is opened: an unregistered name is a registry question.
  if (!findSwitch(name)) {
    process.stderr.write(`"${name}" is not a registered switch. Switches are declared in ${REGISTRY_FILE}; nothing was changed.\n`);
    return 1;
  }
  const scope = scopes[0]!;
  const by = flags.get("by") || process.env.CONTROL_PLANE_FEATURE_OPERATOR || "operator:cli";
  const pool = createDatabasePool(await resolveDatabaseUrl(flags));
  try {
    const result = await setFeatureSwitch(pool, {
      switch: name,
      enabled: value === "on",
      scope,
      trip: scope === "trip" ? flags.get("trip") : undefined,
      live: flags.get("live") === "true",
      by,
    });
    if (!result.ok) {
      process.stderr.write(`refused (${result.reason}): ${result.message}\n`);
      return 1;
    }
    const where = scope === "trip" ? `trip ${flags.get("trip")}` : scope === "all_trips" ? "every trip" : "trips created from now on";
    const was = result.previous === null ? "unset" : result.previous ? "on" : "off";
    process.stdout.write(`${name} is ${value} for ${where} (was ${was}). Recorded in the history.\n`);
    process.stdout.write("Relay-side features read it on their next check.\n");
    return 0;
  } finally {
    await pool.end();
  }
}

async function main(): Promise<number> {
  const [command, ...rest] = process.argv.slice(2);
  const { positional, flags } = parseFlags(rest);
  switch (command) {
    case "list": return cmdList();
    case "show": return cmdShow(flags);
    case "set": return cmdSet(positional, flags);
    default:
      process.stderr.write(`${USAGE}\n`);
      return 2;
  }
}

main().then(
  (code) => { process.exitCode = code; },
  (error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  },
);
