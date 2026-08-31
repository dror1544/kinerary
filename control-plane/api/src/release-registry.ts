// The release catalog + promotion state machine.
//
// registerCandidateRelease() records a built manifest as a 'candidate' row
// (idempotent on the artifact digest). promoteRelease() walks it
//
//     candidate -> verified -> available
//                     \-> deprecated        available -> deprecated
//     (any) -> retired
//
// A candidate cannot skip straight to 'available': it becomes 'verified' only
// after verifyManifest() re-derives the seal and the sanitation scan is clean,
// and only a 'verified' release can be promoted to 'available' — the pool
// generatePlan() selects from. Every promotion writes an append-only audit row.

import { randomBytes } from "node:crypto";
import type pg from "pg";
import { verifyManifest, type ReleaseManifest } from "./release-artifact.js";

function generateId(prefix: string): string {
  return `${prefix}_${randomBytes(16).toString("hex")}`;
}

export type ReleaseStatus = "candidate" | "verified" | "available" | "deprecated" | "retired";

const PROMOTED_BY_RE = /^[A-Za-z0-9:_.-]{1,128}$/;

// Mirrors the CHECK on control_plane.releases.status plus the intent of
// releases_scanned_before_verified: a candidate may only move forward through
// 'verified', and 'retired' is reachable from anywhere as a terminal exit.
const ALLOWED_TRANSITIONS: Record<ReleaseStatus, readonly ReleaseStatus[]> = {
  candidate: ["verified", "retired"],
  verified: ["available", "deprecated", "retired"],
  available: ["deprecated", "retired"],
  deprecated: ["retired"],
  retired: [],
};

export interface ReleaseSummary {
  id: string;
  sourceRevision: string;
  artifactDigest: string;
  applicationSchema: number;
  dataSchemaMin: number;
  dataSchemaMax: number;
  status: ReleaseStatus;
  sanitationPassed: boolean | null;
  promotedToAvailableAt: string | null;
  promotedBy: string | null;
}

interface ReleaseRegisterRow {
  status: ReleaseStatus;
  sanitation_passed: boolean | null;
  manifest: ReleaseManifest | { kind?: string } | null;
  artifact_digest: string;
}

export async function registerCandidateRelease(
  db: pg.Pool,
  manifest: ReleaseManifest,
): Promise<{ releaseId: string; created: boolean; status: ReleaseStatus }> {
  if (manifest.schema !== 1) throw new Error("unsupported manifest schema");
  if (!/^sha256:[a-f0-9]{64}$/.test(manifest.artifactDigest)) throw new Error("manifest.artifactDigest is not a sha256 ref");
  if (!/^[a-f0-9]{40}$/.test(manifest.sourceRevision)) throw new Error("manifest.sourceRevision is not a commit id");

  // Idempotent on the digest. The existing row may already be verified /
  // available / deprecated — return its real status so a re-run of `release
  // build` on the same tree reports what actually persisted, not a stale
  // "candidate" that would mislead the next promote.
  const found = await db.query<{ id: string; status: ReleaseStatus }>(
    "SELECT id, status FROM control_plane.releases WHERE artifact_digest = $1",
    [manifest.artifactDigest],
  );
  if (found.rows[0]) return { releaseId: found.rows[0].id, created: false, status: found.rows[0].status };

  const id = generateId("release");
  try {
    await db.query(
      `INSERT INTO control_plane.releases
         (id, source_revision, artifact_digest, application_schema,
          data_schema_min, data_schema_max, status, sanitation_passed, manifest)
       VALUES ($1, $2, $3, $4, $5, $6, 'candidate', $7, $8::jsonb)`,
      [
        id, manifest.sourceRevision, manifest.artifactDigest, manifest.applicationSchema,
        manifest.dataSchemaMin, manifest.dataSchemaMax, manifest.sanitation.passed,
        JSON.stringify(manifest),
      ],
    );
  } catch (error) {
    // Lost a race to another builder on the same digest.
    if ((error as { code?: string }).code === "23505") {
      const raced = await db.query<{ id: string; status: ReleaseStatus }>(
        "SELECT id, status FROM control_plane.releases WHERE artifact_digest = $1",
        [manifest.artifactDigest],
      );
      if (raced.rows[0]) return { releaseId: raced.rows[0].id, created: false, status: raced.rows[0].status };
    }
    throw error;
  }
  return { releaseId: id, created: true, status: "candidate" };
}

export type PromoteResult =
  | { ok: true; releaseId: string; from: ReleaseStatus; to: ReleaseStatus }
  | {
      ok: false;
      reason:
        | "RELEASE_NOT_FOUND"
        | "ILLEGAL_TRANSITION"
        | "INVALID_ACTOR"
        | "MANIFEST_UNVERIFIED"
        | "SANITATION_NOT_PASSED";
    };

export async function promoteRelease(
  db: pg.Pool,
  options: { releaseId: string; to: ReleaseStatus; actorRef: string; correlationId?: string },
): Promise<PromoteResult> {
  if (!PROMOTED_BY_RE.test(options.actorRef)) return { ok: false, reason: "INVALID_ACTOR" };

  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const row = await client.query<ReleaseRegisterRow>(
      `SELECT status, sanitation_passed, manifest, artifact_digest
         FROM control_plane.releases WHERE id = $1 FOR UPDATE`,
      [options.releaseId],
    );
    const release = row.rows[0];
    if (!release) {
      await client.query("ROLLBACK");
      return { ok: false, reason: "RELEASE_NOT_FOUND" };
    }

    const from = release.status;
    if (!ALLOWED_TRANSITIONS[from]?.includes(options.to)) {
      await client.query("ROLLBACK");
      return { ok: false, reason: "ILLEGAL_TRANSITION" };
    }

    if (options.to === "verified") {
      if (release.sanitation_passed !== true) {
        await client.query("ROLLBACK");
        return { ok: false, reason: "SANITATION_NOT_PASSED" };
      }
      const manifest = release.manifest;
      const looksLikeFullManifest =
        manifest != null && typeof manifest === "object" && Array.isArray((manifest as ReleaseManifest).files);
      const verification = looksLikeFullManifest
        ? verifyManifest(manifest as ReleaseManifest)
        : ({ ok: false } as const);
      if (!verification.ok) {
        await client.query("ROLLBACK");
        return { ok: false, reason: "MANIFEST_UNVERIFIED" };
      }
    }

    if (options.to === "available") {
      await client.query(
        "UPDATE control_plane.releases SET status = 'available', promoted_to_available_at = now(), promoted_by = $2 WHERE id = $1",
        [options.releaseId, options.actorRef],
      );
    } else {
      await client.query(
        "UPDATE control_plane.releases SET status = $2 WHERE id = $1",
        [options.releaseId, options.to],
      );
    }

    await client.query(
      `INSERT INTO control_plane.audit_events
         (id, actor_ref, action, target_ref, correlation_id, evidence, occurred_at)
       VALUES ($1, $2, 'release.promote', $3, $4, $5::jsonb, now())`,
      [
        generateId("audit"),
        options.actorRef,
        options.releaseId,
        options.correlationId ?? `corr_${randomBytes(8).toString("hex")}`,
        JSON.stringify({ from, to: options.to, artifactDigest: release.artifact_digest }),
      ],
    );

    await client.query("COMMIT");
    return { ok: true, releaseId: options.releaseId, from, to: options.to };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function getRelease(db: pg.Pool, releaseId: string): Promise<ReleaseSummary | null> {
  const rows = await db.query<{
    id: string; source_revision: string; artifact_digest: string;
    application_schema: number; data_schema_min: number; data_schema_max: number;
    status: ReleaseStatus; sanitation_passed: boolean | null;
    promoted_to_available_at: Date | null; promoted_by: string | null;
  }>(
    `SELECT id, source_revision, artifact_digest, application_schema,
            data_schema_min, data_schema_max, status, sanitation_passed,
            promoted_to_available_at, promoted_by
       FROM control_plane.releases WHERE id = $1`,
    [releaseId],
  );
  const r = rows.rows[0];
  if (!r) return null;
  return {
    id: r.id,
    sourceRevision: r.source_revision,
    artifactDigest: r.artifact_digest,
    applicationSchema: r.application_schema,
    dataSchemaMin: r.data_schema_min,
    dataSchemaMax: r.data_schema_max,
    status: r.status,
    sanitationPassed: r.sanitation_passed,
    promotedToAvailableAt: r.promoted_to_available_at ? r.promoted_to_available_at.toISOString() : null,
    promotedBy: r.promoted_by,
  };
}

export async function listReleases(db: pg.Pool): Promise<ReleaseSummary[]> {
  const rows = await db.query<{
    id: string; source_revision: string; artifact_digest: string;
    application_schema: number; data_schema_min: number; data_schema_max: number;
    status: ReleaseStatus; sanitation_passed: boolean | null;
    promoted_to_available_at: Date | null; promoted_by: string | null;
  }>(
    `SELECT id, source_revision, artifact_digest, application_schema,
            data_schema_min, data_schema_max, status, sanitation_passed,
            promoted_to_available_at, promoted_by
       FROM control_plane.releases ORDER BY created_at DESC`,
  );
  return rows.rows.map((r) => ({
    id: r.id,
    sourceRevision: r.source_revision,
    artifactDigest: r.artifact_digest,
    applicationSchema: r.application_schema,
    dataSchemaMin: r.data_schema_min,
    dataSchemaMax: r.data_schema_max,
    status: r.status,
    sanitationPassed: r.sanitation_passed,
    promotedToAvailableAt: r.promoted_to_available_at ? r.promoted_to_available_at.toISOString() : null,
    promotedBy: r.promoted_by,
  }));
}
