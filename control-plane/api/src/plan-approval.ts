import { createHash, randomBytes } from "node:crypto";
import type pg from "pg";

function generateId(prefix: string): string {
  return `${prefix}_${randomBytes(16).toString("hex")}`;
}

function tokenDigest(raw: string): string {
  return `sha256:${createHash("sha256").update(raw).digest("hex")}`;
}

export type IssueApprovalResult =
  | { ok: true; approvalId: string; token: string; expiresAt: Date }
  | { ok: false; reason: "PLAN_NOT_FOUND" | "PLAN_NOT_PENDING" | "ALREADY_APPROVED" };

/**
 * Issues an expiring approval for a pending plan.
 * Atomically: marks the plan as approved, moves its job from
 * waiting_for_user_action to queued, and records the one-time token digest.
 * The raw token is returned to the organizer for audit; it is never stored.
 */
export async function issueApproval(
  db: pg.Pool,
  planId: string,
  actorRef: string,
  ttlSeconds: number,
): Promise<IssueApprovalResult> {
  const planRow = await db.query<{ id: string; trip_id: string; digest: string; status: string }>(
    "SELECT id, trip_id, digest, status FROM control_plane.plans WHERE id = $1",
    [planId],
  );
  const plan = planRow.rows[0];
  if (!plan) return { ok: false, reason: "PLAN_NOT_FOUND" };
  if (plan.status === "approved") return { ok: false, reason: "ALREADY_APPROVED" };
  if (plan.status !== "pending_approval") return { ok: false, reason: "PLAN_NOT_PENDING" };

  const rawToken = randomBytes(32).toString("base64url");
  const digest = tokenDigest(rawToken);
  const approvalId = generateId("appr");
  const expiresAt = new Date(Date.now() + ttlSeconds * 1000);

  const client = await db.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `INSERT INTO control_plane.plan_approvals(id, plan_id, plan_digest, token_digest, issued_by, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [approvalId, planId, plan.digest, digest, actorRef, expiresAt],
    );
    await client.query(
      "UPDATE control_plane.plans SET status = 'approved', updated_at = now() WHERE id = $1",
      [planId],
    );
    // Unlock the job so the worker can claim it.
    await client.query(
      "UPDATE control_plane.jobs SET state = 'queued', updated_at = now() WHERE plan_id = $1 AND state = 'waiting_for_user_action'",
      [planId],
    );
    await client.query(
      "UPDATE control_plane.trips SET lifecycle_state = 'provisioning_approved', updated_at = now() WHERE id = $1",
      [plan.trip_id],
    );
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }

  return { ok: true, approvalId, token: rawToken, expiresAt };
}
