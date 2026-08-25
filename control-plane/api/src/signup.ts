import { randomBytes } from "node:crypto";
import type pg from "pg";
import { signApprovalAction, verifyApprovalAction } from "./approval-action.js";
import type { VerifiedTelegramIdentity } from "./identity.js";
import { structuredLog } from "./redaction.js";

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
  /** A plain, unstructured DM to an arbitrary chat id — e.g. the outbox dispatcher's trip notifications. */
  sendMessage(params: { chatId: string; text: string }): Promise<void>;
}

export interface SignupConfig {
  superAdminSubjectDigest: string;
  actionSecret: string;
  actionTtlSeconds: number;
  messagingAdapter: string;
  /** Seconds the user must wait after the most recent rejection before re-requesting. */
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
 * State precedence:
 *  1. Already approved → return approved (idempotent)
 *  2. Pending + not expired → reuse without re-notifying (idempotent)
 *  3. Pending + expired → expire the old row, fall through to create a new one
 *  4. Recently rejected (within cooldown) → return declined
 *  5. No active request / cooldown elapsed → create new request + outbox row
 *
 * Old rows (rejected/expired) are NEVER deleted — notification_outbox holds a
 * plain FK to them.  Partial unique indexes on the table enforce "at most one
 * pending" and "at most one approved" per user without touching history rows.
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

    // 1. Resolve or create the system user for this Telegram identity
    const identityRow = await client.query<{ user_id: string }>(
      "SELECT user_id FROM control_plane.user_identities WHERE provider = $1 AND provider_subject_digest = $2",
      ["telegram", identity.providerSubjectDigest],
    );
    let userId: string;
    const [existingIdentity] = identityRow.rows;
    if (existingIdentity) {
      userId = existingIdentity.user_id;
    } else {
      userId = generateId("user");
      await client.query(
        "INSERT INTO control_plane.users(id, status, display_name) VALUES ($1, 'active', $2)",
        [userId, identity.displayName],
      );
      await client.query(
        "INSERT INTO control_plane.user_identities(id, user_id, provider, provider_subject_digest, provider_subject_id, verified_at) VALUES ($1, $2, 'telegram', $3, $4, now())",
        [generateId("idnt"), userId, identity.providerSubjectDigest, identity.providerSubjectId],
      );
    }

    // 2a. Already approved? (partial unique index guarantees at most one)
    const approvedRow = await client.query<{ id: string; trip_id: string | null }>(
      "SELECT id, trip_id FROM control_plane.signup_approval_requests WHERE user_id = $1 AND state = 'approved'",
      [userId],
    );
    const [approvedByUser] = approvedRow.rows;
    if (approvedByUser) {
      await client.query("ROLLBACK");
      return { status: "approved", tripId: approvedByUser.trip_id ?? undefined, requestId: approvedByUser.id };
    }

    // 2b. Active pending request? (partial unique index guarantees at most one)
    const pendingRow = await client.query<{ id: string; action_expires_at: Date | null }>(
      "SELECT id, action_expires_at FROM control_plane.signup_approval_requests WHERE user_id = $1 AND state = 'pending'",
      [userId],
    );
    const [pr] = pendingRow.rows;
    if (pr) {
      const tokenExpired = pr.action_expires_at !== null && pr.action_expires_at.getTime() < Date.now();
      if (!tokenExpired) {
        // Reuse — do not send a second notification
        await client.query("ROLLBACK");
        log(structuredLog("info", "signup.reused_pending", { request_id: pr.id }));
        return { status: "awaiting_approval", requestId: pr.id };
      }
      // Transition to 'expired' so the partial unique index frees the 'pending'
      // slot for the new request.  The row and its outbox child are preserved.
      await client.query(
        "UPDATE control_plane.signup_approval_requests SET state = 'expired', decided_at = now(), updated_at = now() WHERE id = $1",
        [pr.id],
      );
      await client.query(
        "UPDATE control_plane.notification_outbox SET state = 'skipped', updated_at = now() WHERE signup_request_id = $1 AND state IN ('pending', 'failed')",
        [pr.id],
      );
      // Fall through to create a new pending request
    }

    // 2c. Rate limit: check most recent rejection (there may be several historical rows)
    if (config.signupRateLimitCooldownSeconds > 0) {
      const recentRejection = await client.query<{ decided_at: Date }>(
        `SELECT decided_at FROM control_plane.signup_approval_requests
         WHERE user_id = $1 AND state = 'rejected'
         ORDER BY decided_at DESC NULLS LAST LIMIT 1`,
        [userId],
      );
      const [rejection] = recentRejection.rows;
      if (rejection) {
        const decidedMs = rejection.decided_at.getTime();
        if (Date.now() - decidedMs < config.signupRateLimitCooldownSeconds * 1000) {
          await client.query("ROLLBACK");
          return { status: "declined" };
        }
      }
    }

    // 3. Create a new pending request + outbox row in one transaction
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

    // 4. Send notification after commit (best-effort; failure preserved in outbox)
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
  if (senderSubjectDigest !== config.superAdminSubjectDigest) {
    return { outcome: "error", reason: "WRONG_SENDER" };
  }

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

    // Row-level lock prevents two concurrent callbacks from both seeing 'pending'
    const row = await client.query<{ id: string; user_id: string; state: string; trip_id: string | null }>(
      "SELECT id, user_id, state, trip_id FROM control_plane.signup_approval_requests WHERE id = $1 FOR UPDATE",
      [requestId],
    );

    const [req] = row.rows;
    if (!req) {
      await client.query("ROLLBACK");
      return { outcome: "error", reason: "REQUEST_NOT_FOUND" };
    }

    if (req.state !== "pending") {
      await client.query("ROLLBACK");
      return { outcome: "already_decided" };
    }

    if (action === "approve") {
      const tripId = generateId("trip");
      // slug must match ^[a-z0-9]+(-[a-z0-9]+)*$ — underscores → dashes
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
 * Returns the public-facing status for a user identified by their provider
 * subject digest.  With multiple historical rows per user, priority is:
 * approved > pending > most-recently-decided (rejected/expired).
 */
export async function getSignupStatus(
  db: pg.Pool,
  providerSubjectDigest: string,
): Promise<SignupResult> {
  const identity = await db.query<{ user_id: string }>(
    "SELECT user_id FROM control_plane.user_identities WHERE provider = 'telegram' AND provider_subject_digest = $1",
    [providerSubjectDigest],
  );
  const [userRow] = identity.rows;
  if (!userRow) return { status: "not_found" };
  const userId = userRow.user_id;

  // Approved row (at most one, enforced by partial unique index)
  const approved = await db.query<{ id: string; trip_id: string | null }>(
    "SELECT id, trip_id FROM control_plane.signup_approval_requests WHERE user_id = $1 AND state = 'approved'",
    [userId],
  );
  const [approvedRequest] = approved.rows;
  if (approvedRequest) {
    return { status: "approved", tripId: approvedRequest.trip_id ?? undefined, requestId: approvedRequest.id };
  }

  // Pending row (at most one, enforced by partial unique index)
  const pending = await db.query<{ id: string }>(
    "SELECT id FROM control_plane.signup_approval_requests WHERE user_id = $1 AND state = 'pending'",
    [userId],
  );
  const [pendingRequest] = pending.rows;
  if (pendingRequest) {
    return { status: "awaiting_approval", requestId: pendingRequest.id };
  }

  // Any historical row at all?
  const any = await db.query<{ id: string }>(
    "SELECT id FROM control_plane.signup_approval_requests WHERE user_id = $1 LIMIT 1",
    [userId],
  );
  if (any.rows.length === 0) return { status: "not_found" };

  return { status: "declined" };
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
  const [row] = result.rows;
  if (!row) return null;
  return { id: row.id, slug: row.slug, lifecycleState: row.lifecycle_state };
}
