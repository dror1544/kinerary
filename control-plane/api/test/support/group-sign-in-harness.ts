/**
 * Shared fixtures for the group sign-in suites (docs/specs/sprint-9/x-member-sign-in.md, slice S1):
 * telegram-member-group-sign-in.test.ts (AC-1 to AC-6, AC-8, AC-9) and member-claims-routes.test.ts (AC-7).
 *
 * What is real and what is not:
 *   - Postgres, the migrations, the Fastify app and every route are real.
 *   - Telegram is `tools/fake-telegram.ts` run as a process, reached over HTTP through the same `getChatMember`
 *     URL the production checker builds. Which person is in which group is set through its control API.
 *   - The trip site is NOT here: the runtime adapter is a map the test fills (`site`), because the claim list is
 *     "the site's participants minus ...", and the test decides who the site says they are.
 *
 * Nothing in this file is a test. It opens a connection only when `startHarness()` is called, so a suite that is
 * skipped for want of a database never reaches it.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createServer } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { buildApp } from "../../src/app.js";
import { validateArchitectureProfile } from "../../src/config.js";
import { digestTelegramId } from "../../src/identity.js";
import { applyMigrations } from "../../src/migrations.js";
import { sha256, type PortalDependencies } from "../../src/portal.js";
import { groupMembershipChecker } from "../../src/telegram-group-membership.js";
import { TEST_BOT_TOKEN, launchFields, signedInitData, userField } from "./mini-app-init-data.js";
import { fakeAdopt, fakeProvision, fakeRelease, newFakeSiteState } from "./fake-site.js";
import { testPool } from "./test-database.js";

export const ORIGIN = "http://portal.example.test";
export const GROUP_BOT_TOKEN = "555555555:AAGroupBotTokenForTestsOnly_2222";
const apiDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const migrationsDir = fileURLToPath(new URL("../../../db/migrations/", import.meta.url));

export const profile = validateArchitectureProfile({
  version: 1, environment: "test", public_api: { bind_host: "127.0.0.1", port: 4310 },
  worker: { queue: "postgres", health_bind_host: "127.0.0.1", health_port: 4311 },
  database: { connection_secret_ref: "env://CONTROL_PLANE_DATABASE_URL" },
  adapters: { compute: "fake", ingress: "fake", agent_runtime: "fake", messaging: "fake", secrets: "fake" },
  test_resources: { enabled: false },
});

export interface SitePerson { username: string; displayName: string; role?: string | undefined }

const suffix = `${Date.now().toString(36)}${randomBytes(3).toString("hex")}`;
const hex = () => randomBytes(8).toString("hex");
export const id = (prefix: string) => `${prefix}_${suffix}${hex()}`;
let nextTg = 6_000_000_000 + Math.floor(Math.random() * 1_000_000_000);
/** A Telegram id unique to this run, in the range real ids use. */
export const tg = () => ++nextTg;
let nextGroup = 1_000_000_000_000 + Math.floor(Math.random() * 1_000_000_000);
/** A group chat id (negative) unique to this run. */
export const newGroupChat = () => String(-(++nextGroup));

async function freePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as { port: number };
      server.close(() => resolve(port));
    });
  });
}

export interface Harness {
  pool: pg.Pool;
  /** Every log line the Mini App routes and the membership checker wrote. */
  logs: string[];
  telegram: {
    root: string;
    /** Sets what getChatMember answers for one person in one group. */
    member(chatId: string, userId: number | string, status?: string, extra?: { isMember?: boolean; mode?: "error" | "timeout" }): Promise<void>;
    /** How many times the Bot API method was called since the stand-in started. */
    calls(method: string): Promise<number>;
  };
  /** The trip site's participants, per trip: what the runtime adapter answers. */
  site: Map<string, SitePerson[] | "unreachable">;
  /**
   * The trip site's identity bindings, as the site's own adopt/release routes keep them (server/control-plane-auth.js;
   * tests/control-plane-claim-binding.test.js runs those for real): key trip:username -> the control-plane user bound.
   * `siteFail` makes the next call of that kind misbehave: "unavailable" throws before anything happens, "bind_then_fail"
   * binds and THEN throws (the site did it, the answer never came back), "refused"/"conflict" answer as the site does.
   * `siteHeld` names (trip:username) are bound by an invite: never displaced.
   */
  siteBindings: Map<string, string>;
  siteFail: { adopt?: "unavailable" | "bind_then_fail" | "refused" | "conflict"; release?: "unavailable"; provision?: "unavailable" };
  siteHeld: Set<string>;
  siteCalls: { adopt: { tripId: string; userId: string; runtimeUsername: string }[]; release: { tripId: string; userId: string; runtimeUsername: string }[]; provision: { tripId: string; userId: string; runtimeUsername: string; inviteId: string }[] };
  newApp(overrides?: Partial<PortalDependencies>): ReturnType<typeof buildApp>;
  /** The dependencies `newApp` builds the portal from, for a caller of an exported portal function (createSiteInvite). */
  deps(overrides?: Partial<PortalDependencies>): PortalDependencies;
  stop(): Promise<void>;
  // fixtures
  mkUser(name: string): Promise<string>;
  mkTrip(title: string, options?: { retired?: boolean }): Promise<string>;
  mkMember(tripId: string, userId: string, role?: string, opts?: { dashboard?: boolean; runtime?: boolean }): Promise<void>;
  /** Binds a group chat to the trip (open). Returns the chat id. */
  bindGroup(tripId: string, chatId?: string, opts?: { closed?: boolean }): Promise<string>;
  /** Binds an organizer's own private chat to the trip (open). */
  bindPrivate(tripId: string, chatId: number | string): Promise<void>;
  switchOn(tripId: string, on?: boolean): Promise<void>;
  setLanguage(tripId: string, language: string): Promise<void>;
  webSession(userId: string, label: string): Promise<{ cookie: string; csrf: string; raw: string }>;
  /** Counts of every table a sign-in can write, for "nothing was written". */
  snapshot(): Promise<Record<string, number>>;
}

export async function startHarness(): Promise<Harness> {
  const pool = testPool({ max: 10 });
  const client = await pool.connect();
  try { await applyMigrations(client, migrationsDir); } finally { client.release(); }

  const port = await freePort();
  const root = `http://127.0.0.1:${port}`;
  const child: ChildProcess = spawn(process.execPath, ["--import", "tsx", "tools/fake-telegram.ts", "--port", String(port)], { cwd: apiDir, stdio: ["ignore", "pipe", "inherit"] });
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("the Telegram stand-in did not start within 20s")), 20_000);
    child.once("exit", (code) => { clearTimeout(timer); reject(new Error(`the Telegram stand-in exited with ${code} before it was ready`)); });
    child.stdout!.on("data", (chunk: Buffer) => {
      if (chunk.toString().includes("fake_telegram.listening")) { clearTimeout(timer); resolve(); }
    });
  });
  const control = async (path: string, body?: unknown) => {
    const response = await fetch(`${root}${path}`, body === undefined ? undefined : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    return (await response.json()) as { ok: boolean; result?: unknown; description?: string };
  };

  const logs: string[] = [];
  const site = new Map<string, SitePerson[] | "unreachable">();
  const siteState = newFakeSiteState();
  const siteBindings = siteState.bindings;
  const siteFail: Harness["siteFail"] = {};
  const siteHeld = siteState.invited;
  const siteCalls: Harness["siteCalls"] = { adopt: [], release: [], provision: [] };
  const portalDeps = (db: pg.Pool, overrides: Partial<PortalDependencies>): PortalDependencies => ({
    db,
    runtimeAccounts: {
      // A trip the test never described answers as it always did (everyone exists, any invite binds); a described trip answers as the
      // trip site does (fakeProvision, held to tests/fixtures/site-binding-cases.json): a refusal is the adapter's REFUSED, a lost answer its FAILED.
      participantExists: async ({ tripId, runtimeUsername }: { tripId: string; runtimeUsername: string }) => {
        const people = site.get(tripId);
        if (people === "unreachable") throw new Error("RUNTIME_PARTICIPANT_LOOKUP_FAILED");
        return people === undefined ? true : people.some((p) => p.username === runtimeUsername);
      },
      provisionParticipant: async (input: { tripId: string; inviteId: string; userId: string; runtimeUsername: string; displayName: string }) => {
        siteCalls.provision.push({ tripId: input.tripId, userId: input.userId, runtimeUsername: input.runtimeUsername, inviteId: input.inviteId });
        const fail = siteFail.provision; delete siteFail.provision;
        if (fail === "unavailable") throw new Error("RUNTIME_PARTICIPANT_PROVISION_FAILED");
        const people = site.get(input.tripId);
        if (people === undefined) return;
        if (people === "unreachable") throw new Error("RUNTIME_PARTICIPANT_PROVISION_FAILED");
        if (fakeProvision(siteState, people, input) !== "ok") throw new Error("RUNTIME_PARTICIPANT_REFUSED");
      },
      adoptParticipant: async (input: { tripId: string; userId: string; runtimeUsername: string }) => {
        siteCalls.adopt.push(input);
        const fail = siteFail.adopt; delete siteFail.adopt;
        if (fail === "unavailable") throw new Error("RUNTIME_PARTICIPANT_ADOPT_FAILED");
        if (fail === "refused" || fail === "conflict") return fail;
        const people = site.get(input.tripId);
        const answer = fakeAdopt(siteState, people === "unreachable" ? [] : people, input);
        if (fail === "bind_then_fail") throw new Error("RUNTIME_PARTICIPANT_ADOPT_FAILED");
        return answer;
      },
      releaseParticipant: async (input: { tripId: string; userId: string; runtimeUsername: string }) => {
        siteCalls.release.push(input);
        const fail = siteFail.release; delete siteFail.release;
        if (fail === "unavailable") throw new Error("RUNTIME_PARTICIPANT_RELEASE_FAILED");
        fakeRelease(siteState, input);
      },
      listParticipants: async (tripId: string) => {
        const people = site.get(tripId);
        if (people === "unreachable") throw new Error("RUNTIME_PARTICIPANT_LIST_FAILED");
        return (people ?? []) as Awaited<ReturnType<PortalDependencies["runtimeAccounts"]["listParticipants"]>>;
      },
    },
    publicOrigin: ORIGIN, runtimeOrigin: "http://runtime.example.test", runtimeExchangeKey: "exchange-key",
    runtimeUpstreamHostSuffixes: ["internal"], telegramBotUsername: "kinerary_bot", sessionTtlSeconds: 3600,
    enrollmentTtlSeconds: 3600, approvalTtlSeconds: 3600,
    telegramMiniApp: { botToken: TEST_BOT_TOKEN, maxAgeSeconds: 300, enabled: () => true, log: (line) => logs.push(line) },
    memberGroupSignIn: { isActiveMember: groupMembershipChecker({ botToken: GROUP_BOT_TOKEN, apiRoot: root, timeoutMs: 400, log: (line) => logs.push(line) }) },
    ...overrides,
  });

  return {
    pool, logs, site, siteBindings, siteFail, siteHeld, siteCalls,
    telegram: {
      root,
      member: async (chatId, userId, status = "member", extra = {}) => {
        const answer = await control("/_control/member", { chatId, userId: String(userId), status, ...extra });
        if (!answer.ok) throw new Error(`the Telegram stand-in refused the member: ${answer.description}`);
      },
      calls: async (method) => Number(((await control("/_control/calls")).result as Record<string, number>)[method] ?? 0),
    },
    newApp: (overrides = {}) => buildApp(profile, { portal: portalDeps(pool, overrides) }),
    deps: (overrides = {}) => portalDeps(pool, overrides),
    stop: async () => {
      child.kill("SIGTERM");
      await pool.end();
    },
    mkUser: async (name) => {
      const userId = id("user");
      await pool.query("INSERT INTO control_plane.users(id,status,display_name) VALUES ($1,'active',$2)", [userId, name]);
      return userId;
    },
    mkTrip: async (title, options = {}) => {
      const tripId = id("trip");
      const slug = `${options.retired ? "retired-" : ""}grp-${tripId.replace(/_/g, "-").toLowerCase()}`;
      await pool.query("INSERT INTO control_plane.trips(id,slug,lifecycle_state,title) VALUES ($1,$2,'draft',$3)", [tripId, slug, title]);
      return tripId;
    },
    mkMember: async (tripId, userId, role = "owner", opts = {}) => {
      await pool.query(
        "INSERT INTO control_plane.trip_memberships(id,trip_id,user_id,role,status,dashboard_access,runtime_access) VALUES ($1,$2,$3,$4,'active',$5,$6)",
        [id("memb"), tripId, userId, role, opts.dashboard ?? role !== "member", opts.runtime ?? true]);
    },
    bindGroup: async (tripId, chatId = newGroupChat(), opts = {}) => {
      await pool.query(
        `INSERT INTO control_plane.telegram_chat_bindings(id, chat_id, trip_id, hermes_profile, closed_at, closed_reason)
         VALUES ($1, $2, $3, 'companion-test', ${opts.closed ? "now()" : "NULL"}, ${opts.closed ? "'test_closed'" : "NULL"})`,
        [id("tcb"), chatId, tripId]);
      return chatId;
    },
    bindPrivate: async (tripId, chatId) => {
      await pool.query("INSERT INTO control_plane.telegram_chat_bindings(id, chat_id, trip_id, hermes_profile) VALUES ($1, $2, $3, 'companion-test')", [id("tcb"), String(chatId), tripId]);
    },
    switchOn: async (tripId, on = true) => {
      await pool.query("DELETE FROM control_plane.feature_switch_settings WHERE switch = 'member_group_sign_in' AND trip_id = $1", [tripId]);
      await pool.query(
        "INSERT INTO control_plane.feature_switch_settings(switch, scope, trip_id, enabled, changed_by) VALUES ('member_group_sign_in','trip',$1,$2,$3)",
        [tripId, on, `sha256:${"0".repeat(64)}`]);
    },
    setLanguage: async (tripId, language) => {
      // The trip's language is the one fact of `trips.companion_intro` the control plane reads for it (chat-router.ts tripLanguage).
      await pool.query("UPDATE control_plane.trips SET companion_intro = jsonb_build_object('language', $2::text) WHERE id = $1", [tripId, language]);
    },
    webSession: async (userId, label) => {
      const raw = `sess-${label}-${suffix}${hex()}`, csrf = `csrf-${label}-${suffix}${hex()}`;
      await pool.query(
        "INSERT INTO control_plane.web_sessions(id,user_id,token_digest,csrf_digest,expires_at) VALUES ($1,$2,$3,$4,now() + interval '1 hour')",
        [id("wsess"), userId, sha256(raw), sha256(csrf)]);
      return { cookie: `kit_session=${raw}; kit_csrf=${csrf}`, csrf, raw };
    },
    snapshot: async () => {
      const tables = ["users", "trip_memberships", "telegram_member_links", "trip_participant_claims", "notification_outbox", "web_sessions", "telegram_mini_app_launches"];
      const out: Record<string, number> = {};
      for (const table of tables) {
        out[table] = Number((await pool.query(`SELECT count(*)::int AS n FROM control_plane.${table}`)).rows[0].n);
      }
      return out;
    },
  };
}

// ── The Mini App's own calls ────────────────────────────────────────────────

type App = ReturnType<typeof buildApp>;

/** Signed initData for Telegram user `telegramId`, fresh unless `nowMs` says otherwise. */
export function initDataFor(telegramId: number, opts: { tripId?: string; nowMs?: number; firstName?: string; username?: string } = {}): string {
  return signedInitData(launchFields(telegramId, opts.nowMs ?? Date.now(), {
    query_id: `AA${hex()}`,
    user: userField(telegramId, { ...(opts.firstName ? { first_name: opts.firstName } : {}), ...(opts.username ? { username: opts.username } : {}) }),
    ...(opts.tripId ? { start_param: opts.tripId } : {}),
  }));
}

export async function launch(app: App, initData: string, tripId?: string, cookie?: string) {
  return app.inject({
    method: "POST", url: "/v1/auth/telegram-mini-app",
    headers: { origin: ORIGIN, "content-type": "application/json", ...(cookie ? { cookie } : {}) },
    payload: JSON.stringify({ initData, ...(tripId ? { tripId } : {}) }),
  });
}

export async function claim(app: App, initData: string, tripId: string, claimId: string, extra: Record<string, unknown> = {}) {
  return app.inject({
    method: "POST", url: "/v1/mini-app/claim",
    headers: { origin: ORIGIN, "content-type": "application/json" },
    payload: JSON.stringify({ initData, tripId, claimId, ...extra }),
  });
}

export function cookieOf(response: { headers: Record<string, unknown> }, name: string): string | null {
  const raw = response.headers["set-cookie"];
  const list = Array.isArray(raw) ? raw : raw ? [String(raw)] : [];
  const found = list.find((c) => c.startsWith(`${name}=`));
  return found ? decodeURIComponent(found.split(";")[0]!.slice(name.length + 1)) : null;
}
export const asCookie = (response: { headers: Record<string, unknown> }) => `kit_session=${cookieOf(response, "kit_session")}; kit_csrf=${cookieOf(response, "kit_csrf")}`;

/** The outcome AC-1 pins: what someone with no link is told, with or without the switch. */
export const notLinkedBody = (tripId: string) => JSON.stringify({ error: "TELEGRAM_NOT_LINKED", fallback: "trip_password", tripId });

export { digestTelegramId, sha256 };
