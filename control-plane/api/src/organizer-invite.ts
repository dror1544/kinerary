/**
 * Handing someone an interview link, on an operator's say-so.
 *
 * WHY THIS EXISTS. Everything that mints an interview link goes through the
 * organizer's own credentials: `POST /v1/trips/:id/enrollment` authenticates as
 * them, and the only way to get a trip in the first place is `POST /v1/signup`
 * with an email and a password they chose. So an operator who wants to invite
 * somebody has exactly two options today — make up a password on their behalf
 * and keep it, or run SQL. The first is a credential nobody asked for; the
 * second writes rows that `signup.ts` is responsible for.
 *
 * WHAT IT REFUSES TO BECOME. Not a login, not a password reset, not a way to
 * reach a trip that is already under way. It creates a draft trip and issues
 * the same single-use link the organizer's own request would have issued, and
 * every refusal below is a case where doing that would step on a conversation
 * or a build that is already happening.
 *
 * THREE KINDS, AND THEY ARE ABOUT THE PERSON, NOT THE MECHANISM.
 *   new        nobody holds this address. A trip and an account are created.
 *   resume     they hold a trip that is still a draft — the link expired
 *              unopened, or was never delivered. The old link is revoked and a
 *              fresh one takes its place. No second trip: a draft they never
 *              started is the trip they are being invited to.
 *   returning  they already have a trip that was built. This opens another one,
 *              beside it, and the interview greets them as someone who has done
 *              this before.
 *
 * On production, `resume` is not the rare case. Four real signups there are
 * sitting on links that expired before anyone opened them.
 */
import { randomBytes } from "node:crypto";
import type pg from "pg";
import { issueEnrollment } from "./enrollment.js";
import { DEFAULT_LANGUAGE, isLanguage, type Language } from "./intake-copy.js";
import {
  digestEmail,
  ensureUnknownPasswordCredential,
  resolveOrCreateEmailAccount,
} from "./password-identity.js";
import { structuredLog } from "./redaction.js";

function generateId(prefix: string): string {
  return `${prefix}_${randomBytes(16).toString("hex")}`;
}

/** Telegram handles: what can appear after t.me/ and still resolve. */
const BOT_USERNAME = /^[A-Za-z0-9_]{5,32}$/;

/** How many invitations may be issued in an hour, across all operators. */
export const INVITATIONS_PER_HOUR = 10;

export type InviteKind = "new" | "resume" | "returning";

export type InviteRefusal =
  | "INTERVIEW_UNDERWAY"
  | "TRIP_BUILDING"
  | "RATE_LIMITED"
  | "BAD_EMAIL"
  | "BAD_LANGUAGE"
  | "BAD_BOT_USERNAME"
  | "LINK_NOT_ISSUED";

export interface InviteRequest {
  email: string;
  language?: string;
  /** The Telegram handle the link points at, resolved by the caller from the bot token. */
  botUsername: string;
  /** The person who asked for this. Recorded, and never inferred. */
  invitedBy: string;
}

export interface InvitePlan {
  kind: InviteKind;
  /** The trip a `resume` would re-link, or null when one would be created. */
  tripId: string | null;
  tripSlug: string | null;
  /** Their trips that already exist, newest first — what makes this returning. */
  existing: { tripId: string; slug: string; lifecycleState: string }[];
}

export type InvitePreviewResult =
  | { ok: true; plan: InvitePlan }
  | { ok: false; reason: InviteRefusal; detail: string; plan?: InvitePlan };

export type InviteResult =
  | {
      ok: true;
      kind: InviteKind;
      tripId: string;
      userId: string;
      invitationId: string;
      deepLink: string;
      expiresAt: Date;
      language: Language;
      /** Ready to forward, in the language asked for. */
      message: string;
    }
  | { ok: false; reason: InviteRefusal; detail: string };

export interface InviteConfig {
  enrollmentTtlSeconds: number;
}

/* ------------------------------------------------------------- the copy --- */

/**
 * The message an operator forwards, in the language they asked for.
 *
 * Short on purpose. The bot itself sends the full introduction the moment they
 * tap Start, so anything said twice here is said worse: this has one job, which
 * is to make a stranger's link worth opening. What it must carry is who it is
 * from, what tapping it leads to, and that it does not wait forever.
 *
 * The expiry is stated in whole hours rather than as a time. "Valid until 06:24"
 * is a promise about a timezone nobody agreed on — the operator's, the
 * organizer's, or the server's — and the answer matters most to whoever opens
 * it late at night.
 */
export function invitationText(
  kind: InviteKind,
  language: Language,
  link: string,
  ttlHours: number,
): string {
  const returning = kind === "returning";
  if (language === "he") {
    // Plural throughout, like the rest of the Hebrew copy: it addresses the
    // organizer and the people travelling with them, and it never has to guess
    // a gender nobody has stated.
    return [
      returning
        ? "ברוכים השבים! זה הקישור שלכם לתכנן את הטיול הבא עם Kinerary:"
        : "היי! זה הקישור שלכם להתחיל לתכנן את הטיול עם Kinerary:",
      link,
      returning
        ? `פתחו אותו בטלגרם ולחצו על „התחל”. הטיול הקודם שלכם נשאר בדיוק כמו שהוא. הקישור בתוקף ל-${ttlHours} שעות.`
        : `פתחו אותו בטלגרם ולחצו על „התחל”. אחרי שיחה אחת יהיו לכם אתר טיול פרטי ועוזר טיולים לכל מי שנוסע. הקישור בתוקף ל-${ttlHours} שעות.`,
    ].join("\n");
  }
  return [
    returning
      ? "Welcome back! Here's your link to plan your next trip with Kinerary:"
      : "Hi! Here's your link to start planning your trip with Kinerary:",
    link,
    returning
      ? `Open it in Telegram and tap Start. Your previous trip stays just as it is. The link works for ${ttlHours} hours.`
      : `Open it in Telegram and tap Start. After one conversation you'll have a private trip site and a travel assistant for everyone coming. The link works for ${ttlHours} hours.`,
  ].join("\n");
}

/* ------------------------------------------------------------- planning --- */

interface OwnedTrip {
  tripId: string;
  slug: string;
  lifecycleState: string;
  userId: string;
  hasIntakeVersion: boolean;
  hasLiveSession: boolean;
}

/**
 * Every control-plane user this address is known to be, and every trip they own.
 *
 * The canonical account (`user_identities`, provider 'password') is the answer
 * this is built on: one address, one user, whether it arrived by signup or by
 * an operator's invitation. The other two sources are kept for rows written
 * before that was true — an invitation or a credential whose user never got an
 * identity row — so that a database mid-migration still finds its own trips.
 * They are a superset of one user, not a licence for several: nothing here
 * creates a second account for an address any more.
 *
 * Retired trips are left out entirely: a torn-down trip is not a trip somebody
 * has, and treating one as "they already have a trip" would greet a first-time
 * organizer as a returning one.
 */
async function ownedTrips(db: pg.Pool, emailDigest: string): Promise<OwnedTrip[]> {
  const rows = await db.query<{
    trip_id: string;
    slug: string;
    lifecycle_state: string;
    user_id: string;
    has_intake_version: boolean;
    has_live_session: boolean;
  }>(
    `WITH people AS (
       SELECT user_id FROM control_plane.user_identities
         WHERE provider = 'password' AND provider_subject_digest = $1
       UNION
       SELECT user_id FROM control_plane.password_credentials WHERE email_digest = $1
       UNION
       SELECT user_id FROM control_plane.organizer_invitations WHERE email_digest = $1
     )
     SELECT t.id AS trip_id, t.slug, t.lifecycle_state, m.user_id,
            EXISTS (SELECT 1 FROM control_plane.intake_versions v WHERE v.trip_id = t.id) AS has_intake_version,
            EXISTS (SELECT 1 FROM control_plane.intake_sessions s
                     WHERE s.trip_id = t.id AND s.state <> 'confirmed' AND s.expired_at IS NULL) AS has_live_session
       FROM control_plane.trip_memberships m
       JOIN control_plane.trips t ON t.id = m.trip_id
      WHERE m.user_id IN (SELECT user_id FROM people)
        AND m.role = 'owner' AND m.status = 'active'
        AND t.slug NOT LIKE 'retired-%'
      ORDER BY t.created_at DESC`,
    [emailDigest],
  );
  return rows.rows.map((r) => ({
    tripId: r.trip_id,
    slug: r.slug,
    lifecycleState: r.lifecycle_state,
    userId: r.user_id,
    hasIntakeVersion: r.has_intake_version,
    hasLiveSession: r.has_live_session,
  }));
}

async function invitationsInTheLastHour(db: pg.Pool): Promise<number> {
  const rows = await db.query<{ count: string }>(
    "SELECT count(*)::text AS count FROM control_plane.organizer_invitations WHERE created_at > now() - interval '1 hour'",
  );
  return Number(rows.rows[0]?.count ?? 0);
}

/**
 * What an invitation would do, without doing any of it.
 *
 * The operator tool runs this first and shows it, so "create a trip for a
 * stranger" is never the first time anyone sees what is about to happen.
 */
export async function previewInvitation(db: pg.Pool, email: string): Promise<InvitePreviewResult> {
  if (typeof email !== "string" || !email.includes("@") || email.trim().length < 3) {
    return { ok: false, reason: "BAD_EMAIL", detail: "an email address is needed to tell people apart" };
  }
  const trips = await ownedTrips(db, digestEmail(email));
  const existing = trips.map((t) => ({ tripId: t.tripId, slug: t.slug, lifecycleState: t.lifecycleState }));

  // An interview happening right now. Issuing a link would either be refused by
  // the router (the chat is already in an interview) or, worse, pull them out of
  // the conversation they are in the middle of.
  const underway = trips.find((t) => t.hasLiveSession);
  if (underway) {
    return {
      ok: false,
      reason: "INTERVIEW_UNDERWAY",
      detail: `${underway.slug} is in an interview right now. Let them finish; a link issued now would collide with it.`,
      plan: { kind: "resume", tripId: underway.tripId, tripSlug: underway.slug, existing },
    };
  }

  // A draft is the trip they have not started. Re-link it rather than opening a
  // second one — two draft trips for one person is how an organizer ends up
  // answering an interview for a trip nobody is watching.
  const draft = trips.find((t) => t.lifecycleState === "draft");
  if (draft) {
    return { ok: true, plan: { kind: "resume", tripId: draft.tripId, tripSlug: draft.slug, existing } };
  }

  // Answered, and the site is on its way. A second trip started now would race
  // its build for the organizer's attention and for their private chat.
  const building = trips.find((t) =>
    ["intake_in_progress", "intake_confirmed", "provisioning_approved"].includes(t.lifecycleState));
  if (building) {
    return {
      ok: false,
      reason: "TRIP_BUILDING",
      detail:
        `${building.slug} is at ${building.lifecycleState} — answered but not finished building.` +
        (building.lifecycleState === "intake_in_progress"
          ? " Its interview was closed for idleness; scripts/fresh-interview.py restarts that trip's interview."
          : " Wait for it to reach ready, then invite them again for a second trip."),
      plan: { kind: "returning", tripId: building.tripId, tripSlug: building.slug, existing },
    };
  }

  if (trips.length > 0) {
    return { ok: true, plan: { kind: "returning", tripId: null, tripSlug: null, existing } };
  }
  return { ok: true, plan: { kind: "new", tripId: null, tripSlug: null, existing: [] } };
}

/* -------------------------------------------------------------- issuing --- */

/**
 * Create the trip, under the account this address already is.
 *
 * `resolveOrCreateEmailAccount` is the whole point: an invitation issued for
 * someone who has signed up before lands on the account they already log in
 * with, and an invitation for a stranger creates the same kind of account
 * their own signup would have. What it never does is mint a SECOND user for an
 * address, which is what made an invited organizer a different person from the
 * one who later signed up with the same address.
 *
 * The account is a NORMAL one — users row, email identity, and a password
 * credential derived from random bytes nobody keeps. Not a credential-less
 * special case: an invited organizer differs from one who signed up for
 * themselves only in not knowing their own password yet, which password
 * recovery will fix when the landing page exists. Writing the credential now is
 * also what stops a stranger who knows the address from signing up first and
 * inheriting the trip.
 *
 * An invitation for an address that already has an account leaves its password
 * alone — see `ensureUnknownPasswordCredential`.
 *
 * The slug keeps the `draft-` placeholder every unbuilt trip carries: the
 * provisioner only ever rewrites that prefix when it promotes a real name, and
 * a trip that does not carry it would keep a made-up name forever.
 */
async function createTripFor(
  db: pg.Pool,
  email: string,
): Promise<{ tripId: string; userId: string }> {
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const userId = await resolveOrCreateEmailAccount(client, email);
    await ensureUnknownPasswordCredential(client, userId, email);
    const tripId = generateId("trip");
    await client.query(
      "INSERT INTO control_plane.trips(id, slug, lifecycle_state) VALUES ($1, $2, 'draft')",
      [tripId, `draft-${tripId.replace(/_/g, "-")}`],
    );
    await client.query(
      "INSERT INTO control_plane.trip_memberships(id, trip_id, user_id, role, status) VALUES ($1, $2, $3, 'owner', 'active')",
      [generateId("memb"), tripId, userId],
    );
    await client.query("COMMIT");
    return { tripId, userId };
  } catch (error) {
    try { await client.query("ROLLBACK"); } catch { /* ignore */ }
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Issue an interview link for somebody else, and write down that it happened.
 *
 * The trip is created in one transaction and the link in another, which is the
 * one seam here, and it heals itself — but only because the trip's owner is
 * discoverable without the invitation row. A link that fails to issue, or
 * anything that interrupts this between the trip's commit and the invitation
 * insert, leaves a draft trip owned by this address's canonical account and no
 * `organizer_invitations` row; `ownedTrips` finds it through the identity, so
 * the next invitation for this address calls it `resume` and re-links it.
 *
 * That was NOT true while the invited account had no identity row: the only
 * trace of it was the invitation, so an interrupted `new` invitation stranded
 * the user and the trip where no later invitation could ever see them, and the
 * next one built a second account and a second draft. The regression test is
 * `an interrupted invitation is re-linked, not duplicated`.
 *
 * The reverse — a link with no trip — cannot happen.
 */
export async function inviteOrganizer(
  db: pg.Pool,
  request: InviteRequest,
  config: InviteConfig,
  log: (line: string) => void = () => {},
): Promise<InviteResult> {
  const language: Language = isLanguage(request.language) ? request.language : DEFAULT_LANGUAGE;
  if (request.language !== undefined && request.language !== null && !isLanguage(request.language)) {
    return {
      ok: false,
      reason: "BAD_LANGUAGE",
      detail: `the interview speaks 'en' and 'he'; ${JSON.stringify(String(request.language).slice(0, 20))} is neither`,
    };
  }
  const handle = (request.botUsername ?? "").trim().replace(/^@/, "");
  if (!BOT_USERNAME.test(handle)) {
    // A wrong handle produces a link that opens a chat with the wrong bot, or
    // with nothing at all — and the person it was sent to has no way to tell.
    return { ok: false, reason: "BAD_BOT_USERNAME", detail: "the bot handle the link points at is missing or malformed" };
  }
  const invitedBy = (request.invitedBy ?? "").trim();
  if (!invitedBy) {
    return { ok: false, reason: "BAD_EMAIL", detail: "an invitation has to record who asked for it" };
  }

  const preview = await previewInvitation(db, request.email);
  if (!preview.ok) return { ok: false, reason: preview.reason, detail: preview.detail };

  if (await invitationsInTheLastHour(db) >= INVITATIONS_PER_HOUR) {
    return {
      ok: false,
      reason: "RATE_LIMITED",
      detail: `${INVITATIONS_PER_HOUR} invitations have gone out in the last hour — that is more than this has ever legitimately needed`,
    };
  }

  const emailDigest = digestEmail(request.email);
  const { kind } = preview.plan;
  let tripId: string;
  let userId: string;

  if (kind === "resume") {
    tripId = preview.plan.tripId as string;
    userId = (await ownedTrips(db, emailDigest)).find((t) => t.tripId === tripId)?.userId as string;
    // The previous link is revoked rather than left to expire: two live links
    // for one trip means the one they open is whichever they happen to find,
    // and a single-use token that has already been superseded is a support
    // question waiting to happen.
    await db.query(
      "UPDATE control_plane.interview_enrollments SET state = 'revoked' WHERE trip_id = $1 AND state = 'issued'",
      [tripId],
    );
  } else {
    // Both `new` and `returning` land on this address's one account, so a
    // returning organizer's second trip sits beside their first under the
    // identity they already log in with and the Telegram identity they have
    // already proven.
    //
    // This used to pick the owner of their most RECENTLY created trip, which
    // is not the same question: a person holding both an invited account and a
    // signed-up one got their next trip on whichever happened to be newer, and
    // if that was the invited one the trip was invisible to their own login.
    ({ tripId, userId } = await createTripFor(db, request.email));
  }

  const issued = await issueEnrollment(db, userId, tripId, { enrollmentTtlSeconds: config.enrollmentTtlSeconds }, log);
  if (!issued.ok) {
    return {
      ok: false,
      reason: "LINK_NOT_ISSUED",
      detail: `the trip exists but no link could be issued (${issued.reason}). Another invitation for this address will re-link it.`,
    };
  }

  const invitationId = generateId("invt");
  await db.query(
    `INSERT INTO control_plane.organizer_invitations(id, email_digest, user_id, trip_id, kind, language, invited_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [invitationId, emailDigest, userId, tripId, kind, language, invitedBy.slice(0, 120)],
  );

  const deepLink = `https://t.me/${handle}?start=${encodeURIComponent(issued.token)}`;
  const ttlHours = Math.max(1, Math.round(config.enrollmentTtlSeconds / 3600));

  // The address is never logged, in any form: the digest is what this system
  // keeps, and a log line is the one place it would turn back into a person.
  log(structuredLog("info", "invitation.issued", {
    invitation_id: invitationId, trip_id: tripId, kind, language,
  }));

  return {
    ok: true,
    kind,
    tripId,
    userId,
    invitationId,
    deepLink,
    expiresAt: issued.expiresAt,
    language,
    message: invitationText(kind, language, deepLink, ttlHours),
  };
}
