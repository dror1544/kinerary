/**
 * Inviting an organizer: what an operator's link does, and what it refuses.
 *
 * The refusals are the substance here. Issuing a link is easy; the cases worth
 * pinning are the ones where issuing it would be wrong — a conversation already
 * under way, a build in flight, a draft that should be re-linked rather than
 * duplicated — because each of those, done wrong, is an organizer answering an
 * interview for a trip nobody is watching.
 */
import assert from "node:assert/strict";
import { test, describe, before, after, beforeEach } from "node:test";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { buildApp } from "../src/app.js";
import { validateArchitectureProfile } from "../src/config.js";
import { digestEmail } from "../src/password-identity.js";
import { startSession } from "../src/interview.js";
import { applyMigrations } from "../src/migrations.js";
import {
  INVITATIONS_PER_HOUR,
  invitationText,
  inviteOrganizer,
  previewInvitation,
} from "../src/organizer-invite.js";
import { testDatabaseUrl } from "./support/test-database.js";

const DB_URL = testDatabaseUrl();
const SKIP = !DB_URL;
const migrationsDir = fileURLToPath(new URL("../../db/migrations/", import.meta.url));

const CONFIG = { enrollmentTtlSeconds: 86400 };
const BOT = "Kinerary_bot";

function address(): string {
  return `invitee-${Math.random().toString(36).slice(2, 10)}@example.test`;
}

async function invite(pool: pg.Pool, email: string, language = "en") {
  return inviteOrganizer(pool, { email, language, botUsername: BOT, invitedBy: "an operator" }, CONFIG);
}

/** A trip that already exists for this address, at whatever stage is being tested. */
async function giveThemATrip(
  pool: pg.Pool,
  email: string,
  lifecycleState: string,
  options: { slug?: string; liveSession?: boolean } = {},
): Promise<{ tripId: string; userId: string }> {
  const first = await invite(pool, email);
  assert.equal(first.ok, true);
  if (!first.ok) throw new Error("unreachable");
  if (options.slug) {
    await pool.query("UPDATE control_plane.trips SET slug = $2 WHERE id = $1", [first.tripId, options.slug]);
  }
  if (options.liveSession) {
    // Started through the real path — the token out of the link, redeemed from
    // a chat — rather than an INSERT, so this fixture is a session the router
    // would recognise rather than one shaped like the test's assumptions. It
    // has to happen while the trip is still a draft, because that is the only
    // state an interview can start from.
    const token = new URL(first.deepLink).searchParams.get("start") as string;
    const chatId = String(100000000 + Math.floor(Math.random() * 1e8));
    const started = await startSession(pool, token, () => {}, undefined, chatId);
    assert.equal(started.ok, true, "the fixture's own interview failed to start");
  }
  await pool.query("UPDATE control_plane.trips SET lifecycle_state = $2 WHERE id = $1",
    [first.tripId, lifecycleState]);
  return { tripId: first.tripId, userId: first.userId };
}

describe("organizer invitations", { skip: SKIP ? "no CONTROL_PLANE_TEST_DATABASE_URL" : false }, () => {
  let pool: pg.Pool;

  before(async () => {
    pool = new pg.Pool({ connectionString: DB_URL });
    const client = await pool.connect();
    try { await applyMigrations(client, migrationsDir); } finally { client.release(); }
  });

  after(async () => { await pool.end(); });

  beforeEach(async () => {
    // The rate limit counts every invitation in the last hour, so each test
    // starts from a clean count rather than inheriting the previous one's.
    await pool.query("DELETE FROM control_plane.organizer_invitations");
  });

  test("an address nobody knows gets an account, a draft trip and a link", async () => {
    const email = address();
    const preview = await previewInvitation(pool, email);
    assert.equal(preview.ok && preview.plan.kind, "new");

    const result = await invite(pool, email);
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.kind, "new");
    assert.match(result.deepLink, new RegExp(`^https://t\\.me/${BOT}\\?start=[A-Za-z0-9_-]+$`));
    assert.ok(result.message.includes(result.deepLink));

    const trip = await pool.query("SELECT slug, lifecycle_state FROM control_plane.trips WHERE id = $1", [result.tripId]);
    assert.equal(trip.rows[0].lifecycle_state, "draft");
    // The placeholder the provisioner rewrites when it promotes a real name. A
    // slug without it would keep an invented name for the life of the trip.
    assert.ok(trip.rows[0].slug.startsWith("draft-"), trip.rows[0].slug);

    const enrollment = await pool.query(
      "SELECT state FROM control_plane.interview_enrollments WHERE trip_id = $1", [result.tripId]);
    assert.deepEqual(enrollment.rows.map((r) => r.state), ["issued"]);
  });

  test("an invited address is never given a credential it did not ask for", async () => {
    const email = address();
    const result = await invite(pool, email);
    assert.equal(result.ok, true);
    if (!result.ok) return;

    // No password credential, and no identity row either: writing one with no
    // credential behind it would leave this address unable to ever sign up for
    // itself, and nothing in this system can reset that.
    const credentials = await pool.query(
      "SELECT 1 FROM control_plane.password_credentials WHERE user_id = $1", [result.userId]);
    assert.equal(credentials.rowCount, 0);
    const identities = await pool.query(
      "SELECT 1 FROM control_plane.user_identities WHERE user_id = $1", [result.userId]);
    assert.equal(identities.rowCount, 0);
  });

  test("the address is recorded only as a digest, and the invitation says who asked", async () => {
    const email = address();
    const result = await invite(pool, email);
    assert.equal(result.ok, true);
    if (!result.ok) return;

    const row = await pool.query(
      "SELECT email_digest, kind, language, invited_by FROM control_plane.organizer_invitations WHERE id = $1",
      [result.invitationId]);
    assert.match(row.rows[0].email_digest, /^sha256:[a-f0-9]{64}$/);
    assert.ok(!row.rows[0].email_digest.includes(email.split("@")[0]));
    assert.equal(row.rows[0].invited_by, "an operator");
  });

  test("the same address is recognised however it is capitalised or spaced", async () => {
    const email = address();
    const first = await invite(pool, email);
    assert.equal(first.ok, true);
    if (!first.ok) return;

    const preview = await previewInvitation(pool, `  ${email.toUpperCase()} `);
    assert.equal(preview.ok, true);
    if (!preview.ok) return;
    assert.equal(preview.plan.kind, "resume");
    assert.equal(preview.plan.tripId, first.tripId);
  });

  test("a draft they never started is re-linked, not duplicated", async () => {
    const email = address();
    const first = await invite(pool, email);
    assert.equal(first.ok, true);
    if (!first.ok) return;

    const second = await invite(pool, email);
    assert.equal(second.ok, true);
    if (!second.ok) return;
    assert.equal(second.kind, "resume");
    assert.equal(second.tripId, first.tripId, "a second trip was created for a draft they had not started");
    assert.notEqual(second.deepLink, first.deepLink);

    // One usable link, not two: the superseded one is revoked rather than left
    // to expire, so whichever they find is the one that works.
    const states = await pool.query(
      "SELECT state FROM control_plane.interview_enrollments WHERE trip_id = $1 ORDER BY created_at", [first.tripId]);
    assert.deepEqual(states.rows.map((r) => r.state), ["revoked", "issued"]);
  });

  test("an interview happening right now is not interrupted", async () => {
    const email = address();
    await giveThemATrip(pool, email, "intake_in_progress", { liveSession: true });

    const preview = await previewInvitation(pool, email);
    assert.equal(preview.ok, false);
    if (preview.ok) return;
    assert.equal(preview.reason, "INTERVIEW_UNDERWAY");

    const result = await invite(pool, email);
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.reason, "INTERVIEW_UNDERWAY");
  });

  test("a trip that is still building refuses, and names what to do instead", async () => {
    const email = address();
    await giveThemATrip(pool, email, "intake_confirmed");

    const result = await invite(pool, email);
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.reason, "TRIP_BUILDING");
    assert.match(result.detail, /ready/);
  });

  test("someone whose trip was built gets a second trip and the returning message", async () => {
    const email = address();
    const first = await giveThemATrip(pool, email, "ready_private", { slug: `japan-${Math.random().toString(36).slice(2, 8)}` });

    const preview = await previewInvitation(pool, email);
    assert.equal(preview.ok && preview.plan.kind, "returning");

    const second = await invite(pool, email, "he");
    assert.equal(second.ok, true);
    if (!second.ok) return;
    assert.equal(second.kind, "returning");
    assert.notEqual(second.tripId, first.tripId);
    // The same user owns both, which is what makes /trips list them together
    // and what lets their own chat move to the new one.
    assert.equal(second.userId, first.userId);
    assert.ok(second.message.includes("ברוכים השבים"), second.message);
  });

  test("a torn-down trip is not a trip they have", async () => {
    const email = address();
    const first = await giveThemATrip(pool, email, "ready_private", { slug: `retired-gone-${Math.random().toString(36).slice(2, 8)}` });

    const preview = await previewInvitation(pool, email);
    assert.equal(preview.ok, true);
    if (!preview.ok) return;
    // Their only trip was torn down, so this is a first trip again — not a
    // "welcome back" about a site that no longer exists.
    assert.equal(preview.plan.kind, "new");
    assert.equal(preview.plan.existing.length, 0);
    assert.ok(first.tripId);
  });

  test("a language the interview cannot speak is refused, not silently translated", async () => {
    const result = await inviteOrganizer(
      pool, { email: address(), language: "fr", botUsername: BOT, invitedBy: "an operator" }, CONFIG);
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.reason, "BAD_LANGUAGE");
  });

  test("a malformed bot handle is refused rather than made into a broken link", async () => {
    for (const botUsername of ["", "no", "not a handle", "https://t.me/x"]) {
      const result = await inviteOrganizer(
        pool, { email: address(), language: "en", botUsername, invitedBy: "an operator" }, CONFIG);
      assert.equal(result.ok, false, `accepted ${JSON.stringify(botUsername)}`);
      if (!result.ok) assert.equal(result.reason, "BAD_BOT_USERNAME");
    }
  });

  test("an invitation always records who asked for it", async () => {
    const result = await inviteOrganizer(
      pool, { email: address(), language: "en", botUsername: BOT, invitedBy: "   " }, CONFIG);
    assert.equal(result.ok, false);
  });

  test("more invitations in an hour than anyone legitimately needs are refused", async () => {
    for (let i = 0; i < INVITATIONS_PER_HOUR; i += 1) {
      const result = await invite(pool, address());
      assert.equal(result.ok, true, `invitation ${i} was refused early`);
    }
    const overflow = await invite(pool, address());
    assert.equal(overflow.ok, false);
    if (overflow.ok) return;
    assert.equal(overflow.reason, "RATE_LIMITED");
  });

  test("the message carries the link, the expiry and nothing in the wrong language", () => {
    const link = "https://t.me/Kinerary_bot?start=tok";
    const en = invitationText("new", "en", link, 24);
    assert.ok(en.includes(link));
    assert.ok(en.includes("24 hours"));
    assert.ok(!/[֐-׿]/.test(en), "Hebrew leaked into the English message");

    const he = invitationText("returning", "he", link, 24);
    assert.ok(he.includes(link));
    assert.ok(he.includes("24"));
    // The one thing a returning organizer needs promised: the trip they
    // already have is not being replaced.
    assert.ok(he.includes("נשאר בדיוק כמו שהוא"), he);
  });
});

/**
 * The routes themselves: who may call them, and what a refusal looks like over
 * HTTP.
 *
 * The auth assertions are the point. These two routes create trips for
 * addresses nobody here has heard from, so the states worth pinning are the
 * ones where they must NOT answer: no key configured, wrong key, no key at all.
 */
describe("the operator's invitation routes", { skip: SKIP ? "no CONTROL_PLANE_TEST_DATABASE_URL" : false }, () => {
  const KEY = "operator-key-for-tests";
  const profile = validateArchitectureProfile({
    version: 1,
    environment: "test",
    public_api: { bind_host: "127.0.0.1", port: 4310 },
    worker: { queue: "postgres", health_bind_host: "127.0.0.1", health_port: 4311 },
    database: { connection_secret_ref: "env://CONTROL_PLANE_DATABASE_URL" },
    adapters: { compute: "fake", ingress: "fake", agent_runtime: "fake", messaging: "fake", secrets: "fake" },
    test_resources: { enabled: true, label_key: "kinerary.test_run_id", allowed_name_prefix: "kinerary-test-local" },
  });

  let pool: pg.Pool;

  before(async () => {
    pool = new pg.Pool({ connectionString: DB_URL });
    const client = await pool.connect();
    try { await applyMigrations(client, migrationsDir); } finally { client.release(); }
  });

  after(async () => { await pool.end(); });

  function appWithOperator() {
    return buildApp(profile, {
      operator: { db: pool, apiKey: KEY, enrollmentTtlSeconds: 86400, botUsername: "Kinerary_bot" },
    });
  }

  test("without the key in the environment the routes are not there at all", async () => {
    const app = buildApp(profile, {});
    try {
      for (const url of ["/internal/operator/invitations", "/internal/operator/invitations/preview"]) {
        const response = await app.inject({ method: "POST", url, payload: { email: address() } });
        assert.equal(response.statusCode, 503);
        assert.equal(JSON.parse(response.body).error, "OPERATOR_NOT_CONFIGURED");
      }
    } finally {
      await app.close();
    }
  });

  test("a wrong key, an empty key and no key are all just refused", async () => {
    const app = appWithOperator();
    try {
      for (const headers of [{}, { "x-api-key": "" }, { "x-api-key": "nearly-the-key" }]) {
        const response = await app.inject({
          method: "POST", url: "/internal/operator/invitations", headers,
          payload: { email: address(), language: "en", invitedBy: "an operator" },
        });
        assert.equal(response.statusCode, 401, JSON.stringify(headers));
      }
      // And nothing was created on the way to those refusals.
      const trips = await pool.query(
        "SELECT count(*)::int AS n FROM control_plane.organizer_invitations WHERE created_at > now() - interval '1 minute'");
      assert.equal(trips.rows[0].n, 0);
    } finally {
      await app.close();
    }
  });

  test("the interview agent's key does not open this door", async () => {
    // Different powers, different credentials: the sidecar that answers
    // interview questions must not also be able to mint invitations.
    const app = buildApp(profile, {
      operator: { db: pool, apiKey: KEY, enrollmentTtlSeconds: 86400, botUsername: "Kinerary_bot" },
      interviewAgent: { db: pool, apiKey: "interview-agent-key" },
    });
    try {
      const response = await app.inject({
        method: "POST", url: "/internal/operator/invitations",
        headers: { "x-api-key": "interview-agent-key" },
        payload: { email: address(), language: "en", invitedBy: "an operator" },
      });
      assert.equal(response.statusCode, 401);
    } finally {
      await app.close();
    }
  });

  test("a preview with the key answers what would happen, and creates nothing", async () => {
    const app = appWithOperator();
    try {
      const email = address();
      const response = await app.inject({
        method: "POST", url: "/internal/operator/invitations/preview",
        headers: { "x-api-key": KEY }, payload: { email },
      });
      assert.equal(response.statusCode, 200);
      assert.deepEqual(JSON.parse(response.body).plan.kind, "new");
      const trips = await pool.query(
        `SELECT count(*)::int AS n FROM control_plane.organizer_invitations
          WHERE email_digest = $1`, [digestEmail(email)]);
      assert.equal(trips.rows[0].n, 0);
    } finally {
      await app.close();
    }
  });

  test("creating returns the link, the message and the expiry", async () => {
    await pool.query("DELETE FROM control_plane.organizer_invitations");
    const app = appWithOperator();
    try {
      const response = await app.inject({
        method: "POST", url: "/internal/operator/invitations",
        headers: { "x-api-key": KEY },
        payload: { email: address(), language: "he", invitedBy: "dror" },
      });
      assert.equal(response.statusCode, 201);
      const body = JSON.parse(response.body);
      assert.equal(body.kind, "new");
      assert.equal(body.language, "he");
      assert.match(body.deepLink, /^https:\/\/t\.me\/Kinerary_bot\?start=/);
      assert.ok(body.message.includes(body.deepLink));
      assert.ok(Date.parse(body.expiresAt) > Date.now());
      // The token is only ever part of a link. It appears twice — in
      // `deepLink` and inside the message that embeds it — and never as a
      // field of its own: a bare token in a response is a single-use
      // credential sitting somewhere that can be logged as data.
      const token = new URL(body.deepLink).searchParams.get("start") as string;
      assert.equal(body.token, undefined);
      for (const [key, value] of Object.entries(body)) {
        if (typeof value === "string" && value.includes(token)) {
          assert.ok(value.includes(`?start=${token}`), `${key} carries a bare token`);
        }
      }
    } finally {
      await app.close();
    }
  });

  test("a refusal comes back as a status a caller can act on", async () => {
    const email = address();
    const app = appWithOperator();
    try {
      // Mid-build: 409, because this is "not now" rather than "never".
      await giveThemATrip(pool, email, "intake_confirmed");
      const conflict = await app.inject({
        method: "POST", url: "/internal/operator/invitations",
        headers: { "x-api-key": KEY }, payload: { email, language: "en", invitedBy: "dror" },
      });
      assert.equal(conflict.statusCode, 409);
      assert.equal(JSON.parse(conflict.body).error, "TRIP_BUILDING");

      // A language the interview cannot speak is a request that was never
      // going to work: 400.
      const bad = await app.inject({
        method: "POST", url: "/internal/operator/invitations",
        headers: { "x-api-key": KEY }, payload: { email: address(), language: "fr", invitedBy: "dror" },
      });
      assert.equal(bad.statusCode, 400);
      assert.equal(JSON.parse(bad.body).error, "BAD_LANGUAGE");
    } finally {
      await app.close();
    }
  });
});
