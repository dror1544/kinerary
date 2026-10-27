/**
 * "Remove member": an organizer ends someone's place on a trip.
 *
 * Until this existed the only way to take a person off a trip was SQL, and the
 * dashboard could revoke an invite only while it was UNUSED — the moment it was
 * redeemed the organizer had no lever at all. This is the lever, and it has to
 * actually end access rather than flag it, so one transaction does all of:
 *
 *   - the membership goes to `revoked`. That status change is what fires the
 *     database trigger which revokes the person's Telegram member link for this
 *     trip and the web sessions that link minted (migration 20261020120000);
 *   - their trip-password credential is deleted, so the password stops working;
 *   - the invite they redeemed is marked `revoked` (frees the username too);
 *   - any launch grant they hold for the trip and have not used is spent;
 *   - if this was their last active membership anywhere, every portal session
 *     of theirs ends. If they still belong to other trips their sessions stay —
 *     a portal session is per person, not per trip, and every trip route checks
 *     membership on every request, so they cannot reach this one anyway.
 *
 * NOT covered here: the trip SITE's own session for them (its cookie lives in
 * the runtime gateway, and the control plane has no call to end it). Their
 * portal membership is gone, so they cannot mint a new launch; an existing
 * runtime session runs out on its own clock.
 *
 * Refusals: a caller who is not an owner/organizer of the trip with dashboard
 * access gets the SAME 404 as a trip that does not exist; the owner/organizer
 * can be told why they cannot (409): not yourself, not the last owner, not an
 * owner unless you are one.
 */
import type pg from "pg";

export type RemoveMemberOutcome =
  | { ok: true }
  | { ok: false; status: 404 | 409; error: "NOT_FOUND" | "CANNOT_REMOVE_SELF" | "LAST_OWNER" | "LAST_ORGANIZER" | "OWNER_ONLY" };

const NOT_FOUND: RemoveMemberOutcome = { ok: false, status: 404, error: "NOT_FOUND" };

export async function removeMember(
  db: pg.Pool,
  input: { tripId: string; actorUserId: string; targetUserId: string },
): Promise<RemoveMemberOutcome> {
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const actor = await client.query<{ role: string }>(
      `SELECT role FROM control_plane.trip_memberships
        WHERE trip_id = $1 AND user_id = $2 AND status = 'active' AND dashboard_access = true
          AND role IN ('owner', 'organizer')`,
      [input.tripId, input.actorUserId],
    );
    if (!actor.rows[0]) { await client.query("ROLLBACK"); return NOT_FOUND; }
    // Lock the trip's memberships in one statement, in a stable order, so two
    // organizers removing each other (or the last two owners) serialise here.
    const members = await client.query<{ user_id: string; role: string }>(
      `SELECT user_id, role FROM control_plane.trip_memberships
        WHERE trip_id = $1 AND status = 'active' ORDER BY id FOR UPDATE`,
      [input.tripId],
    );
    const target = members.rows.find((row) => row.user_id === input.targetUserId);
    if (!target) { await client.query("ROLLBACK"); return NOT_FOUND; }
    if (input.targetUserId === input.actorUserId) { await client.query("ROLLBACK"); return { ok: false, status: 409, error: "CANNOT_REMOVE_SELF" }; }
    if (target.role === "owner" && actor.rows[0].role !== "owner") { await client.query("ROLLBACK"); return { ok: false, status: 409, error: "OWNER_ONLY" }; }
    const others = members.rows.filter((row) => row.user_id !== input.targetUserId);
    if (target.role === "owner" && !others.some((row) => row.role === "owner")) { await client.query("ROLLBACK"); return { ok: false, status: 409, error: "LAST_OWNER" }; }
    if (["owner", "organizer"].includes(target.role) && !others.some((row) => ["owner", "organizer"].includes(row.role))) {
      await client.query("ROLLBACK");
      return { ok: false, status: 409, error: "LAST_ORGANIZER" };
    }

    await client.query(
      "UPDATE control_plane.trip_memberships SET status = 'revoked' WHERE trip_id = $1 AND user_id = $2",
      [input.tripId, input.targetUserId],
    );
    await client.query(
      "DELETE FROM control_plane.web_password_credentials WHERE trip_id = $1 AND user_id = $2",
      [input.tripId, input.targetUserId],
    );
    await client.query(
      `UPDATE control_plane.site_invites SET state = 'revoked', updated_at = now()
        WHERE trip_id = $1 AND redeemed_by = $2 AND state = 'redeemed'`,
      [input.tripId, input.targetUserId],
    );
    await client.query(
      `UPDATE control_plane.runtime_launch_grants SET consumed_at = now()
        WHERE trip_id = $1 AND user_id = $2 AND consumed_at IS NULL`,
      [input.tripId, input.targetUserId],
    );
    await client.query(
      `UPDATE control_plane.web_sessions SET revoked_at = now()
        WHERE user_id = $1 AND revoked_at IS NULL
          AND NOT EXISTS (SELECT 1 FROM control_plane.trip_memberships m WHERE m.user_id = $1 AND m.status = 'active')`,
      [input.targetUserId],
    );
    await client.query("COMMIT");
    return { ok: true };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
