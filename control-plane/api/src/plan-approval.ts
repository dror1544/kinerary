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

export interface IssueApprovalOptions {
  /**
   * Raw Telegram chat id the operator notification is addressed to. Absent
   * (a `fake`-adapter dev profile, or a deployment that configures no
   * super-admin chat id) means no row is enqueued at all — an approval must
   * never depend on there being somewhere to send a DM.
   */
  operatorChatId?: string;
}

/**
 * Issues an expiring approval for a pending plan.
 * Atomically: marks the plan as approved, moves its job from
 * waiting_for_user_action to queued, records the one-time token digest, and
 * enqueues the operator notification.
 * The raw token is returned to the organizer for audit; it is never stored.
 *
 * The notification is enqueued INSIDE this transaction on purpose. Writing it
 * here rather than in the route makes two things structurally true rather than
 * remembered: an approval cannot happen without the operator being told, and
 * telling the operator cannot fail the approval — the row is handed to the
 * outbox dispatcher (outbox-dispatcher.ts), which sends it on its own 10s loop
 * and retries to max_attempts. Observability, never a gate.
 */
export async function issueApproval(
  db: pg.Pool,
  planId: string,
  actorRef: string,
  ttlSeconds: number,
  options: IssueApprovalOptions = {},
): Promise<IssueApprovalResult> {
  const rawToken = randomBytes(32).toString("base64url");
  const digest = tokenDigest(rawToken);
  const approvalId = generateId("appr");
  const expiresAt = new Date(Date.now() + ttlSeconds * 1000);

  const client = await db.connect();
  try {
    await client.query("BEGIN");
    // Lock the plan row so concurrent approval calls cannot both pass the
    // status check before either has committed its INSERT into plan_approvals.
    const planRow = await client.query<{ id: string; trip_id: string; digest: string; status: string; release_id: string | null }>(
      "SELECT id, trip_id, digest, status, release_id FROM control_plane.plans WHERE id = $1 FOR UPDATE",
      [planId],
    );
    const plan = planRow.rows[0];
    if (!plan) {
      await client.query("ROLLBACK");
      return { ok: false, reason: "PLAN_NOT_FOUND" };
    }
    if (plan.status === "approved") {
      await client.query("ROLLBACK");
      return { ok: false, reason: "ALREADY_APPROVED" };
    }
    if (plan.status !== "pending_approval") {
      await client.query("ROLLBACK");
      return { ok: false, reason: "PLAN_NOT_PENDING" };
    }

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

    if (options.operatorChatId) {
      // The organizer is the approver under the converged flow, but the two are
      // recorded separately so the row stays honest if that ever stops being
      // true: `organizer` is the trip's owner, `approved_by` is whoever placed
      // this call.
      const contextRow = await client.query<{ title: string | null; destination_label: string | null; slug: string; organizer_name: string | null }>(
        `SELECT t.title, t.destination_label, t.slug, u.display_name AS organizer_name
         FROM control_plane.trips t
         LEFT JOIN control_plane.trip_memberships m
           ON m.trip_id = t.id AND m.role = 'owner' AND m.status = 'active'
         LEFT JOIN control_plane.users u ON u.id = m.user_id
         WHERE t.id = $1`,
        [plan.trip_id],
      );
      const context = contextRow.rows[0];
      await client.query(
        `INSERT INTO control_plane.notification_outbox
           (id, trip_id, kind, recipient, payload, signup_request_id, notification_type, adapter, state)
         VALUES ($1, $2, 'operator_provisioning_approved', $3, $4::jsonb,
                 NULL, 'operator_provisioning_approved', 'control-plane', 'pending')`,
        [
          generateId("notif"),
          plan.trip_id,
          options.operatorChatId,
          JSON.stringify({
            trip_id: plan.trip_id,
            trip_title: context?.title ?? context?.destination_label ?? null,
            trip_slug: context?.slug ?? null,
            organizer: context?.organizer_name ?? null,
            approved_by: actorRef,
            plan_id: planId,
            plan_digest: plan.digest,
            release_id: plan.release_id,
          }),
        ],
      );
    }

    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }

  return { ok: true, approvalId, token: rawToken, expiresAt };
}
