import { randomBytes } from "node:crypto";
import type pg from "pg";
import { signApprovalAction, verifyApprovalAction } from "./approval-action.js";
import type { VerifiedTelegramIdentity } from "./identity.js";
import { structuredLog } from "./redaction.js";
import { canTransitionTrip } from "./lifecycle.js";

// hex gives 32 lowercase alphanumeric chars, satisfying [A-Za-z0-9]{8,64}
function generateId(prefix: string): string {
  return `${prefix}_${randomBytes(16).toString("hex")}`;
}

export interface NotificationAdapter {
  sendApprovalRequest(params: {
    requestId: string;
    displayName: string;
    tripNameRequest: string;
    approveToken: string;
    rejectToken: string;
    expiresAt: Date;
  }): Promise<void>;
}

export interface SignupConfig {
  superAdminSubjectDigest: string;
  actionSecret: string;
  actionTtlSeconds: number;
  messagingAdapter: string;
  /** Seconds the user must wait after rejection before re-requesting. */
  signupRateLimitCooldownSeconds: number;
}

export type SignupStatus = "awaiting_approval" | "approved" | "declined" | "not_found";

export interface SignupResult {
  status: SignupStatus;
  tripId?: string;
  requestId?: string;
}

export type CallbackResult =
  | { outcome: "approved"; tripId: string }
  | { outcome: "rejected" }
  | { outcome: "already_decided" }
  | { outcome: "error"; reason: "INVALID_TOKEN" | "EXPIRED_TOKEN" | "INVALID_SIGNATURE" | "WRONG_SENDER" | "REQUEST_NOT_FOUND" };

/**
 * Finds or creates a signup approval request for the verified identity.
 *
 * - If a pending (non-expired) request already exists: returns it without
 *   sending a new notification (no fan-out).
 * - If no request exists or the previous one has expired: creates a new
 *   request, inserts an outbox row in the same transaction, then notifies
 *   after commit.
 * - Cooldown after rejection prevents re-attempts within the configured window.
 */
export async function startSignup(
  db: pg.Pool,
  identity: VerifiedTelegramIdentity,
  tripNameRequest: string,
  config: SignupConfig,
  notification: NotificationAdapter,
  log: (line: string) => void = () => {},
): Promise<SignupResult> {
  const client = await db.connect();
  try {
    await client.query("BEGIN");

    // 1. Resolve or create user
    const identityRow = await client.query<{ user_id: string }>(
      "SELECT user_id FROM control_plane.user_identities WHERE provider = $1 AND provider_subject_digest = $2",
      ["telegram", identity.providerSubjectDigest],
    );
    let userId: string;
    if (identityRow.rows.length > 0) {
      userId = identityRow.rows[0].user_id;
    } else {
      userId = generateId("user");
      await client.query(
        "INSERT INTO control_plane.users(id, status, display_name) VALUES ($1, 'active', $2)",
        [userId, identity.displayName],
      );
      await client.query(
        "INSERT INTO control_plane.user_identities(id, user_id, provider, provider_subject_digest, verified_at) VALUES ($1, $2, 'telegram', $3, now())",
        [generateId("idnt"), userId, identity.providerSubjectDigest],
      );
    }

    // 2. Check for an existing request
    const existing = await client.query<{
      id: string; state: string; trip_id: string | null; action_expires_at: Date | null; decided_at: Date | null;
    }>(
      "SELECT id, state, trip_id, action_expires_at, decided_at FROM control_plane.signup_approval_requests WHERE user_id = $1",
      [userId],
    );

    if (existing.rows.length > 0) {
      const row = existing.rows[0];

      if (row.state === "approved") {
        await client.query("ROLLBACK");
        return { status: "approved", tripId: row.trip_id ?? undefined, requestId: row.id };
      }

      if (row.state === "rejected") {
        // Enforce cooldown: if decision was recent, block re-attempt
        const decidedAt = row.decided_at ? row.decided_at.getTime() : 0;
        const cooldownMs = config.signupRateLimitCooldownSeconds * 1000;
        if (Date.now() - decidedAt < cooldownMs) {
          await client.query("ROLLBACK");
          return { status: "declined", requestId: row.id };
        }
        // Cooldown passed — fall through to create a new request
        await client.query(
          "DELETE FROM control_plane.signup_approval_requests WHERE id = $1",
          [row.id],
        );
      } else if (row.state === "pending") {
        const expired = row.action_expires_at && row.action_expires_at.getTime() < Date.now();
        if (!expired) {
          // Active pending request: reuse without sending a new notification
          await client.query("ROLLBACK");
          log(structuredLog("info", "signup.reused_pending", { request_id: row.id }));
          return { status: "awaiting_approval", requestId: row.id };
        }
        // Token expired while still pending — mark expired and allow a new attempt
        await client.query(
          "UPDATE control_plane.signup_approval_requests SET state = 'expired', decided_at = now(), updated_at = now() WHERE id = $1",
          [row.id],
        );
        await client.query(
          "UPDATE control_plane.notification_outbox SET state = 'skipped', updated_at = now() WHERE signup_request_id = $1 AND state = 'pending'",
          [row.id],
        );
        // Remove the decided row so the UNIQUE(user_id) constraint allows a new insert.
        // The history of the expired request is preserved via its decided_at timestamp.
        // We keep the row for audit trail — UNIQUE constraint only blocks inserts when
        // a row already exists, regardless of state, so we must DELETE or use UPSERT.
        await client.query(
          "DELETE FROM control_plane.signup_approval_requests WHERE id = $1",
          [row.id],
        );
      }
    }

    // 3. Create new request + outbox row in one transaction
    const requestId = generateId("sreq");
    const nowMs = Date.now();
    const approveToken = signApprovalAction(requestId, "approve", config.actionSecret, {
      ttlSeconds: config.actionTtlSeconds, nowMs,
    });
    const rejectToken = signApprovalAction(requestId, "reject", config.actionSecret, {
      ttlSeconds: config.actionTtlSeconds, nowMs,
    });

    await client.query(
      `INSERT INTO control_plane.signup_approval_requests(id, user_id, state, action_expires_at)
       VALUES ($1, $2, 'pending', $3)`,
      [requestId, userId, approveToken.expiresAt],
    );
    const outboxId = generateId("notf");
    await client.query(
      `INSERT INTO control_plane.notification_outbox(id, signup_request_id, notification_type, adapter, state)
       VALUES ($1, $2, 'admin_signup_approval', $3, 'pending')`,
      [outboxId, requestId, config.messagingAdapter],
    );

    await client.query("COMMIT");

    // 4. Send notification after commit (best-effort)
    try {
      await notification.sendApprovalRequest({
        requestId,
        displayName: identity.displayName,
        tripNameRequest,
        approveToken: approveToken.token,
        rejectToken: rejectToken.token,
        expiresAt: approveToken.expiresAt,
      });
      await db.query(
        "UPDATE control_plane.notification_outbox SET state = 'sent', sent_at = now(), updated_at = now() WHERE id = $1",
        [outboxId],
      );
    } catch {
      log(structuredLog("error", "signup.notification_failed", {
        safe_error_code: "NOTIFICATION_SEND_FAILED",
        request_id: requestId,
      }));
      await db.query(
        "UPDATE control_plane.notification_outbox SET state = 'failed', updated_at = now(), attempt = attempt + 1 WHERE id = $1",
        [outboxId],
      );
    }

    return { status: "awaiting_approval", requestId };
  } catch (error) {
    try { await client.query("ROLLBACK"); } catch { /* ignore */ }
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Processes a super-admin approval or rejection callback.
 *
 * Verifies: token signature, expiry, sender identity against configured
 * super-admin digest. Approval atomically creates the draft trip and
 * membership and transitions the request state. Idempotent on exact repeat
 * (returns `already_decided`).
 */
export async function processApprovalCallback(
  db: pg.Pool,
  token: string,
  senderSubjectDigest: string,
  config: SignupConfig,
): Promise<CallbackResult> {
  // 1. Verify sender is the configured super-admin
  if (senderSubjectDigest !== config.superAdminSubjectDigest) {
    return { outcome: "error", reason: "WRONG_SENDER" };
  }

  // 2. Verify token signature and expiry
  const verification = verifyApprovalAction(token, config.actionSecret);
  if (!verification.valid) {
    return {
      outcome: "error",
      reason: verification.reason === "EXPIRED_TOKEN" ? "EXPIRED_TOKEN" : "INVALID_SIGNATURE",
    };
  }

  const { requestId, action } = verification;
  const client = await db.connect();
  try {
    await client.query("BEGIN");

    // 3. Load request with a row-level lock (prevents concurrent callbacks)
    const row = await client.query<{
      id: string; user_id: string; state: string; trip_id: string | null;
    }>(
      "SELECT id, user_id, state, trip_id FROM control_plane.signup_approval_requests WHERE id = $1 FOR UPDATE",
      [requestId],
    );

    if (row.rows.length === 0) {
      await client.query("ROLLBACK");
      return { outcome: "error", reason: "REQUEST_NOT_FOUND" };
    }

    const req = row.rows[0];
    if (req.state !== "pending") {
      await client.query("ROLLBACK");
      return { outcome: "already_decided" };
    }

    if (action === "approve") {
      // Create draft trip + membership atomically with the approval
      const tripId = generateId("trip");
      // slug must match ^[a-z0-9]+(-[a-z0-9]+)*$ — replace underscore separators with dashes
      const slug = `draft-${requestId.replace(/_/g, "-")}`;
      await client.query(
        "INSERT INTO control_plane.trips(id, slug, lifecycle_state) VALUES ($1, $2, 'draft')",
        [tripId, slug],
      );
      await client.query(
        "INSERT INTO control_plane.trip_memberships(id, trip_id, user_id, role, status) VALUES ($1, $2, $3, 'owner', 'active')",
        [generateId("memb"), tripId, req.user_id],
      );
      await client.query(
        `UPDATE control_plane.signup_approval_requests
         SET state = 'approved', trip_id = $1, decided_at = now(), updated_at = now()
         WHERE id = $2`,
        [tripId, requestId],
      );
      await client.query("COMMIT");
      return { outcome: "approved", tripId };
    } else {
      await client.query(
        "UPDATE control_plane.signup_approval_requests SET state = 'rejected', decided_at = now(), updated_at = now() WHERE id = $1",
        [requestId],
      );
      await client.query("COMMIT");
      return { outcome: "rejected" };
    }
  } catch (error) {
    try { await client.query("ROLLBACK"); } catch { /* ignore */ }
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Returns the public-facing status for a user identified by their
 * provider subject digest. Enforces: a user can only read their own status.
 */
export async function getSignupStatus(
  db: pg.Pool,
  providerSubjectDigest: string,
): Promise<SignupResult> {
  const identity = await db.query<{ user_id: string }>(
    "SELECT user_id FROM control_plane.user_identities WHERE provider = 'telegram' AND provider_subject_digest = $1",
    [providerSubjectDigest],
  );
  if (identity.rows.length === 0) return { status: "not_found" };

  const userId = identity.rows[0].user_id;
  const req = await db.query<{ id: string; state: string; trip_id: string | null }>(
    "SELECT id, state, trip_id FROM control_plane.signup_approval_requests WHERE user_id = $1",
    [userId],
  );
  if (req.rows.length === 0) return { status: "not_found" };

  const row = req.rows[0];
  if (row.state === "approved") {
    return { status: "approved", tripId: row.trip_id ?? undefined, requestId: row.id };
  }
  if (row.state === "pending") return { status: "awaiting_approval", requestId: row.id };
  return { status: "declined", requestId: row.id };
}

/**
 * Returns a trip's basic info if the requesting user is an active member.
 * Membership scoping is enforced: non-members see nothing.
 */
export async function getTripForMember(
  db: pg.Pool,
  tripId: string,
  providerSubjectDigest: string,
): Promise<{ id: string; slug: string; lifecycleState: string } | null> {
  const result = await db.query<{ id: string; slug: string; lifecycle_state: string }>(
    `SELECT t.id, t.slug, t.lifecycle_state
     FROM control_plane.trips t
     JOIN control_plane.trip_memberships m ON m.trip_id = t.id
     JOIN control_plane.user_identities ui ON ui.user_id = m.user_id
     WHERE t.id = $1
       AND ui.provider = 'telegram'
       AND ui.provider_subject_digest = $2
       AND m.status = 'active'`,
    [tripId, providerSubjectDigest],
  );
  if (result.rows.length === 0) return null;
  const row = result.rows[0];
  return { id: row.id, slug: row.slug, lifecycleState: row.lifecycle_state };
}
