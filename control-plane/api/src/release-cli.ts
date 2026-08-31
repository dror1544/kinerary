// Operator CLI for the release catalog. Not a served route — releases write to
// the filesystem-truth (the manifest) and change what the planner can select,
// so promotion is a deliberate local command, in the same spirit as
// mcp/provision.js being LAN-only.
//
//   npm run release -- build [--ref HEAD] [--app-schema 1] [--data-min 1] [--data-max 2]
//   npm run release -- promote <releaseId> --to verified|available|deprecated|retired [--actor operator:you]
//   npm run release -- list
//   npm run release -- show <releaseId>
//
// DB URL: --database-url, else CONTROL_PLANE_DATABASE_URL, else
// CONTROL_PLANE_DATABASE_URL_FILE, else CONTROL_PLANE_TEST_DATABASE_URL.

import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { createDatabasePool } from "./database.js";
import { INTAKE_SCHEMA_VERSION } from "./interview.js";
import { buildReleaseManifest } from "./release-artifact.js";
import { createGitPayloadSource } from "./release-git.js";
import {
  getRelease,
  listReleases,
  promoteRelease,
  registerCandidateRelease,
  type ReleaseStatus,
} from "./release-registry.js";

const run = promisify(execFile);

function parseFlags(argv: string[]): { positional: string[]; flags: Map<string, string> } {
  const positional: string[] = [];
  const flags = new Map<string, string>();
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === undefined) continue;
    if (arg.startsWith("--")) {
      const eq = arg.indexOf("=");
      if (eq >= 0) flags.set(arg.slice(2, eq), arg.slice(eq + 1));
      else { flags.set(arg.slice(2), argv[i + 1] ?? ""); i += 1; }
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

async function resolveRepoRoot(flags: Map<string, string>): Promise<string> {
  const explicit = flags.get("repo");
  if (explicit) return resolve(explicit);
  try {
    const { stdout } = await run("git", ["rev-parse", "--show-toplevel"]);
    return stdout.trim();
  } catch {
    // src/ -> api -> control-plane -> repo root
    return resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
  }
}

function toInt(value: string | undefined, fallback: number): number {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

async function cmdBuild(flags: Map<string, string>): Promise<number> {
  const repoRoot = await resolveRepoRoot(flags);
  const source = createGitPayloadSource(repoRoot);
  const manifest = await buildReleaseManifest(source, {
    ref: flags.get("ref") ?? "HEAD",
    applicationSchema: toInt(flags.get("app-schema"), 1),
    dataSchemaMin: toInt(flags.get("data-min"), 1),
    dataSchemaMax: toInt(flags.get("data-max"), INTAKE_SCHEMA_VERSION),
  });

  const pool = createDatabasePool(await resolveDatabaseUrl(flags));
  try {
    const { releaseId, created, status } = await registerCandidateRelease(pool, manifest);
    const manifestPath = resolve(repoRoot, "control-plane/api/releases", `${releaseId}.json`);
    await mkdir(dirname(manifestPath), { recursive: true });
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    process.stdout.write(`${JSON.stringify({
      command: "build",
      releaseId,
      created,
      // The persisted status, not an assumed "candidate": a re-build of an
      // already-promoted tree must not imply it is still promotable.
      status,
      sourceRevision: manifest.sourceRevision,
      artifactDigest: manifest.artifactDigest,
      files: manifest.files.length,
      sanitation: { passed: manifest.sanitation.passed, findings: manifest.sanitation.findings.length },
      manifestPath,
    }, null, 2)}\n`);
    if (manifest.sanitation.findings.length > 0) {
      for (const f of manifest.sanitation.findings) {
        process.stderr.write(`sanitation: ${f.rule} at ${f.path}:${f.line}\n`);
      }
    }
    return manifest.sanitation.passed ? 0 : 1;
  } finally {
    await pool.end();
  }
}

const PROMOTE_TARGETS: readonly ReleaseStatus[] = ["verified", "available", "deprecated", "retired"];

async function cmdPromote(positional: string[], flags: Map<string, string>): Promise<number> {
  const releaseId = positional[0];
  const to = flags.get("to") as ReleaseStatus | undefined;
  if (!releaseId || !to || !PROMOTE_TARGETS.includes(to)) {
    process.stderr.write(`usage: promote <releaseId> --to ${PROMOTE_TARGETS.join("|")}\n`);
    return 2;
  }
  const actorRef = flags.get("actor") ?? process.env.CONTROL_PLANE_RELEASE_OPERATOR ?? "operator:cli";
  const pool = createDatabasePool(await resolveDatabaseUrl(flags));
  try {
    const result = await promoteRelease(pool, { releaseId, to, actorRef });
    process.stdout.write(`${JSON.stringify({ command: "promote", ...result }, null, 2)}\n`);
    return result.ok ? 0 : 1;
  } finally {
    await pool.end();
  }
}

async function cmdList(flags: Map<string, string>): Promise<number> {
  const pool = createDatabasePool(await resolveDatabaseUrl(flags));
  try {
    process.stdout.write(`${JSON.stringify(await listReleases(pool), null, 2)}\n`);
    return 0;
  } finally {
    await pool.end();
  }
}

async function cmdShow(positional: string[], flags: Map<string, string>): Promise<number> {
  const releaseId = positional[0];
  if (!releaseId) { process.stderr.write("usage: show <releaseId>\n"); return 2; }
  const pool = createDatabasePool(await resolveDatabaseUrl(flags));
  try {
    const release = await getRelease(pool, releaseId);
    if (!release) { process.stderr.write("not found\n"); return 1; }
    process.stdout.write(`${JSON.stringify(release, null, 2)}\n`);
    return 0;
  } finally {
    await pool.end();
  }
}

async function main(): Promise<number> {
  const [command, ...rest] = process.argv.slice(2);
  const { positional, flags } = parseFlags(rest);
  switch (command) {
    case "build": return cmdBuild(flags);
    case "promote": return cmdPromote(positional, flags);
    case "list": return cmdList(flags);
    case "show": return cmdShow(positional, flags);
    default:
      process.stderr.write("usage: release <build|promote|list|show> [...]\n");
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
