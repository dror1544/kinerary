import assert from "node:assert/strict";
import { test, describe, before, after } from "node:test";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { applyMigrations } from "../src/migrations.js";
import {
  buildReleaseManifest,
  type PayloadSource,
  type ReleaseManifest,
} from "../src/release-artifact.js";
import {
  getRelease,
  listReleases,
  promoteRelease,
  registerCandidateRelease,
} from "../src/release-registry.js";

const DB_URL = process.env.CONTROL_PLANE_TEST_DATABASE_URL;
const SKIP = !DB_URL;
const migrationsDir = fileURLToPath(new URL("../../db/migrations/", import.meta.url));

function randomHex(n: number): string {
  return [...Array(n)].map(() => Math.floor(Math.random() * 16).toString(16)).join("");
}

// Fake payload whose content (and so the derived digest) is unique per call,
// so parallel runs / leftover rows never collide on artifact_digest.
function uniqueSource(poison?: string): PayloadSource {
  const revision = randomHex(40);
  const salt = randomHex(8);
  const files: Record<string, string> = {
    "site/app.js": `// build ${salt}\nconst h = { Authorization: \`Bearer \${t}\` };\n`,
    "server/server.js": poison
      ? `line one\n${poison}\nline three\n`
      : `// ${salt}\nconst u = process.env.DB_URL;\n`,
    "shared/schema.js": `export const V = 1; // ${salt}\n`,
  };
  const sha = (s: string) => {
    let h = 0n;
    for (const ch of s) h = (h * 131n + BigInt(ch.charCodeAt(0))) % (1n << 160n);
    return h.toString(16).padStart(40, "0").slice(0, 40);
  };
  return {
    async resolveRevision() { return revision; },
    async listPayload() {
      return Object.entries(files).map(([path, content]) => ({ path, blobSha: sha(content) }));
    },
    async readTextFile(_rev, path) { return files[path] ?? ""; },
  };
}

async function freshManifest(poison?: string): Promise<ReleaseManifest> {
  return buildReleaseManifest(uniqueSource(poison), {
    applicationSchema: 1,
    dataSchemaMin: 1,
    dataSchemaMax: 2,
    now: () => new Date("2026-08-30T00:00:00.000Z"),
  });
}

describe("release registry + promotion", () => {
  let pool: pg.Pool;
  const created: string[] = [];

  before(async () => {
    if (SKIP) return;
    pool = new pg.Pool({ connectionString: DB_URL, max: 5 });
    const client = await pool.connect();
    try { await applyMigrations(client, migrationsDir); } finally { client.release(); }
  });

  after(async () => {
    if (SKIP) return;
    // audit_events is append-only (0002/0003 triggers) — leave those; delete
    // only the release rows this file made. release_localdev0001 is untouched.
    for (const id of created) {
      await pool.query("DELETE FROM control_plane.releases WHERE id = $1 AND id <> 'release_localdev0001'", [id]);
    }
    await pool.end();
  });

  const register = async (manifest: ReleaseManifest) => {
    const r = await registerCandidateRelease(pool, manifest);
    created.push(r.releaseId);
    return r;
  };

  test("registers a candidate and is idempotent on the artifact digest", { skip: SKIP }, async () => {
    const manifest = await freshManifest();
    const first = await register(manifest);
    assert.equal(first.created, true);
    assert.match(first.releaseId, /^release_/);

    const again = await registerCandidateRelease(pool, manifest);
    assert.equal(again.created, false);
    assert.equal(again.releaseId, first.releaseId);
    assert.equal(again.status, "candidate");

    const row = await getRelease(pool, first.releaseId);
    assert.equal(row?.status, "candidate");
    assert.equal(row?.sanitationPassed, true);
    assert.equal(row?.artifactDigest, manifest.artifactDigest);
  });

  test("candidate -> verified -> available, and an audit row per hop", { skip: SKIP }, async () => {
    const { releaseId } = await register(await freshManifest());

    const auditBefore = await pool.query<{ n: string }>(
      "SELECT count(*)::text AS n FROM control_plane.audit_events WHERE target_ref = $1", [releaseId],
    );

    const v = await promoteRelease(pool, { releaseId, to: "verified", actorRef: "operator:test" });
    assert.deepEqual(v, { ok: true, releaseId, from: "candidate", to: "verified" });

    const a = await promoteRelease(pool, { releaseId, to: "available", actorRef: "operator:test" });
    assert.deepEqual(a, { ok: true, releaseId, from: "verified", to: "available" });

    const row = await getRelease(pool, releaseId);
    assert.equal(row?.status, "available");
    assert.equal(row?.promotedBy, "operator:test");
    assert.ok(row?.promotedToAvailableAt);

    const auditAfter = await pool.query<{ n: string; action: string }>(
      "SELECT count(*)::int AS n FROM control_plane.audit_events WHERE target_ref = $1 AND action = 'release.promote'", [releaseId],
    );
    assert.equal(Number(auditAfter.rows[0]!.n) - Number(auditBefore.rows[0]!.n), 2);
  });

  test("a candidate cannot skip straight to available", { skip: SKIP }, async () => {
    const { releaseId } = await register(await freshManifest());
    const result = await promoteRelease(pool, { releaseId, to: "available", actorRef: "operator:test" });
    assert.deepEqual(result, { ok: false, reason: "ILLEGAL_TRANSITION" });
    assert.equal((await getRelease(pool, releaseId))?.status, "candidate");
  });

  test("a failed sanitation scan blocks promotion past candidate", { skip: SKIP }, async () => {
    const manifest = await freshManifest("const PROX = '10.0.0.5';");
    assert.equal(manifest.sanitation.passed, false);
    const { releaseId } = await register(manifest);
    assert.equal((await getRelease(pool, releaseId))?.sanitationPassed, false);

    const result = await promoteRelease(pool, { releaseId, to: "verified", actorRef: "operator:test" });
    assert.deepEqual(result, { ok: false, reason: "SANITATION_NOT_PASSED" });
  });

  test("a tampered manifest fails re-verification on the way to verified", { skip: SKIP }, async () => {
    const manifest = await freshManifest();
    // Slip in an extra file after the scan passed but leave the digest as-is:
    // the row's sanitation_passed is still true, so only verifyManifest catches it.
    manifest.files.push({ path: "server/backdoor.js", blobSha: "f".repeat(40) });
    const { releaseId } = await register(manifest);

    const result = await promoteRelease(pool, { releaseId, to: "verified", actorRef: "operator:test" });
    assert.deepEqual(result, { ok: false, reason: "MANIFEST_UNVERIFIED" });
  });

  test("rejects an unknown release and a malformed actor", { skip: SKIP }, async () => {
    const { releaseId } = await register(await freshManifest());
    assert.deepEqual(
      await promoteRelease(pool, { releaseId: "release_does_not_exist", to: "verified", actorRef: "operator:test" }),
      { ok: false, reason: "RELEASE_NOT_FOUND" },
    );
    assert.deepEqual(
      await promoteRelease(pool, { releaseId, to: "verified", actorRef: "has spaces & symbols!" }),
      { ok: false, reason: "INVALID_ACTOR" },
    );
  });

  test("available can be walked back to deprecated then retired", { skip: SKIP }, async () => {
    const { releaseId } = await register(await freshManifest());
    await promoteRelease(pool, { releaseId, to: "verified", actorRef: "operator:test" });
    await promoteRelease(pool, { releaseId, to: "available", actorRef: "operator:test" });

    assert.equal((await promoteRelease(pool, { releaseId, to: "deprecated", actorRef: "operator:test" })).ok, true);
    assert.equal((await promoteRelease(pool, { releaseId, to: "retired", actorRef: "operator:test" })).ok, true);
    assert.deepEqual(
      await promoteRelease(pool, { releaseId, to: "available", actorRef: "operator:test" }),
      { ok: false, reason: "ILLEGAL_TRANSITION" },
    );
  });

  test("the DB refuses a hand-flip to verified without a passed scan", { skip: SKIP }, async () => {
    const manifest = await freshManifest("const PROX = '10.0.0.5';");
    const { releaseId } = await register(manifest);
    // Bypassing promoteRelease entirely: migration 0027's CHECK is the backstop.
    await assert.rejects(
      pool.query("UPDATE control_plane.releases SET status = 'verified' WHERE id = $1", [releaseId]),
      /releases_scanned_before_verified/,
    );
  });

  test("the DB refuses a raw status skip candidate -> available", { skip: SKIP }, async () => {
    // A clean candidate this time — the only thing missing is the verify hop.
    // The transition trigger must reject it even with the promotion columns
    // filled, so a direct UPDATE can't land unverified code in the planner pool.
    const { releaseId } = await register(await freshManifest());
    await assert.rejects(
      pool.query(
        "UPDATE control_plane.releases SET status = 'available', promoted_to_available_at = now(), promoted_by = 'operator:hand' WHERE id = $1",
        [releaseId],
      ),
      /illegal release status transition/,
    );
    assert.equal((await getRelease(pool, releaseId))?.status, "candidate");
  });

  test("the DB refuses 'available' without promotion bookkeeping", { skip: SKIP }, async () => {
    const { releaseId } = await register(await freshManifest());
    await promoteRelease(pool, { releaseId, to: "verified", actorRef: "operator:test" });
    // Legal edge (verified -> available) but promoteRelease normally also stamps
    // promoted_by / promoted_to_available_at in the same statement.
    await assert.rejects(
      pool.query("UPDATE control_plane.releases SET status = 'available' WHERE id = $1", [releaseId]),
      /releases_available_requires_promotion/,
    );
  });

  test("the DB refuses reviving a retired release", { skip: SKIP }, async () => {
    const { releaseId } = await register(await freshManifest());
    await promoteRelease(pool, { releaseId, to: "retired", actorRef: "operator:test" });
    await assert.rejects(
      pool.query("UPDATE control_plane.releases SET status = 'verified' WHERE id = $1", [releaseId]),
      /illegal release status transition/,
    );
  });

  test("listReleases includes the permanent dev-seed and this file's rows", { skip: SKIP }, async () => {
    const { releaseId } = await register(await freshManifest());
    const all = await listReleases(pool);
    assert.ok(all.some((r) => r.id === "release_localdev0001"));
    assert.ok(all.some((r) => r.id === releaseId));
  });
});
