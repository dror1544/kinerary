import assert from "node:assert/strict";
import { test, describe, before, after } from "node:test";
import { execFile } from "node:child_process";
import { rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import pg from "pg";
import { applyMigrations } from "../src/migrations.js";

const run = promisify(execFile);
const DB_URL = process.env.CONTROL_PLANE_TEST_DATABASE_URL;
const SKIP = !DB_URL;
const apiDir = fileURLToPath(new URL("../", import.meta.url));
const cliEntry = fileURLToPath(new URL("../src/release-cli.ts", import.meta.url));
const migrationsDir = fileURLToPath(new URL("../../db/migrations/", import.meta.url));

async function cli(args: string[]): Promise<{ code: number; out: string; err: string }> {
  try {
    const { stdout, stderr } = await run(
      "node", ["--import", "tsx", cliEntry, ...args],
      { cwd: apiDir, env: { ...process.env, CONTROL_PLANE_TEST_DATABASE_URL: DB_URL } },
    );
    return { code: 0, out: stdout, err: stderr };
  } catch (error) {
    const e = error as { code?: number; stdout?: string; stderr?: string };
    return { code: e.code ?? 1, out: e.stdout ?? "", err: e.stderr ?? "" };
  }
}

// End-to-end through the operator entrypoint: git -> build -> register -> promote,
// the CLI analog of api/test/server-boot.test.ts. Uses the real repo tree, so it
// also proves PAYLOAD_ROOTS resolve and the shipped source passes its own scan.
describe("release CLI", () => {
  let pool: pg.Pool;
  const builtIds: string[] = [];

  before(async () => {
    if (SKIP) return;
    pool = new pg.Pool({ connectionString: DB_URL, max: 3 });
    const client = await pool.connect();
    try { await applyMigrations(client, migrationsDir); } finally { client.release(); }
  });

  after(async () => {
    if (SKIP) return;
    for (const id of builtIds) {
      await pool.query("DELETE FROM control_plane.releases WHERE id = $1 AND id <> 'release_localdev0001'", [id]);
      await rm(new URL(`../releases/${id}.json`, import.meta.url), { force: true });
    }
    await pool.end();
  });

  test("build produces a candidate row and a sealed manifest file", { skip: SKIP }, async () => {
    const res = await cli(["build"]);
    assert.equal(res.code, 0, res.err);
    const report = JSON.parse(res.out);
    assert.equal(report.command, "build");
    assert.match(report.releaseId, /^release_/);
    assert.equal(report.status, "candidate");
    assert.match(report.artifactDigest, /^sha256:[a-f0-9]{64}$/);
    assert.ok(report.files > 5, "the real payload should have more than a handful of files");
    assert.equal(report.sanitation.passed, true, "shipped source must pass its own scan");
    builtIds.push(report.releaseId);

    const row = await pool.query<{ status: string; sanitation_passed: boolean }>(
      "SELECT status, sanitation_passed FROM control_plane.releases WHERE id = $1", [report.releaseId],
    );
    assert.equal(row.rows[0]?.status, "candidate");
    assert.equal(row.rows[0]?.sanitation_passed, true);

    // Re-running build on the same tree is idempotent on the digest.
    const again = JSON.parse((await cli(["build"])).out);
    assert.equal(again.releaseId, report.releaseId);
    assert.equal(again.created, false);
  });

  test("promote walks candidate -> verified -> available and refuses the skip", { skip: SKIP }, async () => {
    const built = JSON.parse((await cli(["build"])).out);
    builtIds.push(built.releaseId);

    const skip = await cli(["promote", built.releaseId, "--to", "available", "--actor", "operator:clitest"]);
    assert.equal(skip.code, 1);
    assert.equal(JSON.parse(skip.out).reason, "ILLEGAL_TRANSITION");

    const verify = await cli(["promote", built.releaseId, "--to", "verified", "--actor", "operator:clitest"]);
    assert.equal(verify.code, 0, verify.err);
    assert.equal(JSON.parse(verify.out).to, "verified");

    const avail = await cli(["promote", built.releaseId, "--to", "available", "--actor", "operator:clitest"]);
    assert.equal(avail.code, 0, avail.err);
    assert.equal(JSON.parse(avail.out).to, "available");

    const show = JSON.parse((await cli(["show", built.releaseId])).out);
    assert.equal(show.status, "available");
    assert.equal(show.promotedBy, "operator:clitest");

    // Re-building the same tree now that it is promoted must report the real
    // persisted status, not a stale "candidate" that would invite an invalid
    // re-promotion.
    const rebuilt = JSON.parse((await cli(["build"])).out);
    assert.equal(rebuilt.releaseId, built.releaseId);
    assert.equal(rebuilt.created, false);
    assert.equal(rebuilt.status, "available");
  });
});
