/**
 * `/invite` reaching the LIVE relay (x-member-sign-in S2b follow-on): the relay server builds `siteInvites` from the architecture
 * profile's `web` block, the poller carries it to `dispatchUpdate`, and an organizer's `/invite` then produces the sends.
 *
 *   1. `siteInviteDepsFromProfile`: configured -> deps built from the profile's own values (a real `HttpRuntimeAccountAdapter` aimed at
 *      a loopback stand-in for the runtime gateway, so the key header, the path and the origin are read off a request, not a type);
 *      no `web` block, a secret that cannot be resolved (a fake resolver THROWS, nothing is read from the environment) and a blank
 *      secret -> undefined, with `relay.site_invites_unconfigured` logged and no secret material in it.
 *   2. The poller path, not just `dispatchUpdate`: `startTripBotPoller` with a recording Telegram client, one queued update, and the
 *      deps from (1). Configured -> the organizer's chat gets the link; unconfigured -> the organizer's chat gets the "not available"
 *      text, nothing is written, and a stranger's chat is unchanged.
 *   3. `relay/server.ts` runs `main()` on import (assistant-events-boot.test.ts's technique), so that it builds the deps and hands them to
 *      the poller is read from the source.
 */
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import http from "node:http";
import { after, before, describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import type pg from "pg";
import { digestTelegramId } from "../src/identity.js";
import { applyMigrations } from "../src/migrations.js";
import { siteInviteDepsFromProfile } from "../src/relay/invite-command.js";
import { startTripBotPoller } from "../src/relay/poller.js";
import type { SendResult, TelegramClient } from "../src/relay/telegram-api.js";
import { testDatabaseUrl, testPool } from "./support/test-database.js";

const migrationsDir = fileURLToPath(new URL("../../db/migrations/", import.meta.url));
const SECRET = "exchange-key-for-tests-only-9f3c";

// ── A loopback stand-in for the runtime gateway's participants route ──────────
const seen: { url: string; key: string | undefined }[] = [];
let runtime: http.Server;
let runtimeOrigin = "";
before(async () => {
  runtime = http.createServer((req, res) => {
    seen.push({ url: req.url ?? "", key: req.headers["x-api-key"] as string | undefined });
    if (req.headers["x-api-key"] !== SECRET) { res.writeHead(401).end(); return; }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ participants: [{ username: "dl17", displayName: "Dana Levi", role: "member" }, { username: "og01", displayName: "Olga Organizer", role: "organizer" }] }));
  });
  await new Promise<void>((resolve) => runtime.listen(0, "127.0.0.1", resolve));
  runtimeOrigin = `http://127.0.0.1:${(runtime.address() as { port: number }).port}`;
});
after(async () => { await new Promise((resolve) => runtime.close(resolve)); });

const web = () => ({ public_origin: "https://portal.example.test", runtime_origin: runtimeOrigin, runtime_exchange_key_secret_ref: "env://A_REF_THE_FAKE_RESOLVER_KNOWS" });

describe("siteInviteDepsFromProfile: what the relay server builds", () => {
  test("configured: deps from the profile's own values; the adapter asks the profile's runtime origin with the resolved key", async () => {
    const logs: string[] = [];
    const resolved: string[] = [];
    const deps = await siteInviteDepsFromProfile(web(), async (ref) => { resolved.push(ref); return `${SECRET}\n`; }, (line) => logs.push(line));
    assert.ok(deps);
    assert.deepEqual(resolved, ["env://A_REF_THE_FAKE_RESOLVER_KNOWS"], "the ref comes from the profile");
    assert.equal(deps.publicOrigin, "https://portal.example.test");
    const people = await deps.runtimeAccounts.listParticipants("trip_abcdefgh12");
    assert.deepEqual(people.map((p) => p.username), ["dl17", "og01"]);
    const last = seen[seen.length - 1]!;
    assert.equal(last.url, "/internal/t/trip_abcdefgh12/participants");
    assert.equal(last.key, SECRET, "the key is trimmed and sent as the gateway expects");
    assert.ok(logs.every((l) => !l.includes(SECRET)), "no secret in the log");
    assert.ok(logs.some((l) => /relay\.site_invites_ready/.test(l)));
  });

  for (const [label, profileWeb, resolver, reason] of [
    ["no web block", undefined, async () => SECRET, "NO_WEB_BLOCK"],
    ["a secret that cannot be resolved", web(), async () => { throw new Error(`boom ${SECRET}`); }, "SECRET_UNRESOLVED"],
    ["a blank secret", web(), async () => "  \n", "SECRET_EMPTY"],
  ] as const) {
    test(`${label}: unset, the relay stays up, and it is said once in the log without any secret material`, async () => {
      const logs: string[] = [];
      const deps = await siteInviteDepsFromProfile(profileWeb, resolver, (line) => logs.push(line));
      assert.equal(deps, undefined);
      const line = logs.find((l) => /relay\.site_invites_unconfigured/.test(l));
      assert.ok(line, `logged: ${logs.join("|")}`);
      assert.equal(JSON.parse(line).reason, reason);
      assert.ok(!logs.join("\n").includes(SECRET), "the resolver's message (which here carries a secret) is never logged");
      assert.ok(!logs.join("\n").includes("A_REF_THE_FAKE_RESOLVER_KNOWS"), "nor the name of the reference");
    });
  }
});

// ── The poller path ───────────────────────────────────────────────────────────
class RecordingTelegram implements TelegramClient {
  readonly sent: { chatId: string; text: string; parseMode?: string }[] = [];
  queued: unknown[][] = [];
  async sendMessage(p: { chatId: string; text: string; parseMode?: string }): Promise<SendResult> {
    this.sent.push({ chatId: p.chatId, text: p.text, parseMode: p.parseMode });
    return { ok: true, messageId: String(this.sent.length) };
  }
  async editMessageText(): Promise<SendResult> { return { ok: true }; }
  async sendChatAction(): Promise<void> { /* no-op */ }
  async answerCallbackQuery(): Promise<void> { /* no-op */ }
  async getChatInfo() { return null; }
  async getMe() { return { id: "7000000001", username: "KineraryTestBot" }; }
  async getUpdates(): Promise<unknown[]> { return this.queued.shift() ?? []; }
  async deleteWebhookIfPresent(): Promise<void> { /* no-op */ }
}
const connector = { pushInbound: () => true };

const SKIP = !testDatabaseUrl();
let pool: pg.Pool;
before(async () => {
  if (SKIP) return;
  pool = testPool({ max: 6 });
  const client = await pool.connect();
  try {
    await client.query("DROP SCHEMA IF EXISTS control_plane CASCADE");
    await client.query("DROP TABLE IF EXISTS public.control_plane_schema_migrations");
    await applyMigrations(client, migrationsDir);
  } finally { client.release(); }
});
after(async () => { if (!SKIP) await pool.end(); });

const hex = () => randomBytes(8).toString("hex");
let nextTg = 8_300_000_000;

async function organizersTrip() {
  const tripId = `trip_${hex()}`;
  const userId = `user_${hex()}`;
  const telegramId = ++nextTg;
  await pool.query("INSERT INTO control_plane.users(id, status, display_name) VALUES ($1, 'active', 'Owner')", [userId]);
  await pool.query("INSERT INTO control_plane.trips(id, slug, lifecycle_state, title) VALUES ($1, $2, 'draft', 'Alsace in December')", [tripId, `w-${tripId.replace(/_/g, "-")}`]);
  await pool.query("INSERT INTO control_plane.trip_memberships(id, trip_id, user_id, role, status, dashboard_access, runtime_access) VALUES ($1, $2, $3, 'owner', 'active', true, true)", [`memb_${hex()}`, tripId, userId]);
  await pool.query("INSERT INTO control_plane.telegram_organizer_trip_links(id, user_id, trip_id, telegram_subject_digest, verified_via) VALUES ($1, $2, $3, $4, 'enrollment_redemption')", [`tol_${hex()}`, userId, tripId, digestTelegramId(String(telegramId))]);
  await pool.query("INSERT INTO control_plane.telegram_chat_bindings(id, chat_id, trip_id, hermes_profile) VALUES ($1, $2, $3, 'companion-test')", [`tcb_${hex()}`, String(telegramId), tripId]);
  return { tripId, userId, telegramId };
}

const update = (telegramId: number, text: string) => ({ update_id: 1, message: { message_id: 7, from: { id: telegramId, first_name: "Someone" }, chat: { id: String(telegramId), type: "private" }, text } });

async function throughThePoller(updates: unknown[], siteInvites: Awaited<ReturnType<typeof siteInviteDepsFromProfile>>, logs: string[]) {
  const telegram = new RecordingTelegram();
  telegram.queued = [updates];
  const stop = startTripBotPoller(
    { db: pool, telegram, connector, log: (line: string) => logs.push(line), ...(siteInvites ? { siteInvites } : {}) },
    { longPollSeconds: 0, maxBackoffMs: 10 },
  );
  await new Promise((resolve) => setTimeout(resolve, 400));
  stop();
  return telegram;
}
const invitesOf = async (tripId: string) => (await pool.query("SELECT created_by, runtime_username, state FROM control_plane.site_invites WHERE trip_id = $1", [tripId])).rows;

describe("the poller path", { skip: SKIP }, () => {
  test("configured: an organizer's /invite, polled from Telegram, is answered in their chat with the link; the invite is theirs", async () => {
    const trip = await organizersTrip();
    const logs: string[] = [];
    const deps = await siteInviteDepsFromProfile(web(), async () => SECRET, (l) => logs.push(l));
    const sent = (await throughThePoller([update(trip.telegramId, "/invite Dana Levi")], deps, logs)).sent;
    assert.ok(sent.length >= 2, JSON.stringify(sent));
    assert.ok(sent.every((s) => s.chatId === String(trip.telegramId)), "only the organizer's own chat");
    assert.ok(sent.every((s) => s.parseMode === undefined), "plain text");
    const link = /https:\/\/portal\.example\.test\/join#token=[A-Za-z0-9_-]+/.exec(sent.map((s) => s.text).join("\n"))?.[0];
    assert.ok(link, "the join link, built on the profile's public origin");
    assert.deepEqual(await invitesOf(trip.tripId), [{ created_by: trip.userId, runtime_username: "dl17", state: "unused" }]);
    const token = link.split("#token=")[1]!;
    assert.ok(!logs.join("\n").includes(token) && !logs.join("\n").includes(String(trip.telegramId)), "nothing the relay logged holds the token or the id");
    console.log("POLLER IN :", JSON.stringify(update(trip.telegramId, "/invite Dana Levi")));
    console.log("POLLER OUT:", JSON.stringify(sent));
  });

  test("not configured: the organizer is told it is not available, nothing is written, the relay logs it; a stranger's answer is the unknown-command one", async () => {
    const trip = await organizersTrip();
    const stranger = ++nextTg;
    await pool.query("INSERT INTO control_plane.telegram_chat_bindings(id, chat_id, trip_id, hermes_profile) VALUES ($1, $2, $3, 'companion-test')", [`tcb_${hex()}`, String(stranger), trip.tripId]);
    const logs: string[] = [];
    const telegram = await throughThePoller([update(trip.telegramId, "/invite Dana Levi"), update(stranger, "/invite Dana Levi")], undefined, logs);
    const organizer = telegram.sent.filter((s) => s.chatId === String(trip.telegramId));
    assert.equal(organizer.length, 1);
    assert.match(organizer[0]!.text, /not available/);
    assert.ok(logs.some((l) => /trip_bot\.invite_command_unconfigured/.test(l)));
    assert.deepEqual(await invitesOf(trip.tripId), []);
    const other = telegram.sent.filter((s) => s.chatId === String(stranger));
    assert.match(other[0]!.text, /isn't one of my commands/);
  });
});

describe("relay/server.ts carries it (read from source: the entrypoint runs main() on import)", () => {
  test("it builds the deps from the profile's web block with the relay's own secret resolver, and hands them to the poller", async () => {
    const source = await readFile(fileURLToPath(new URL("../src/relay/server.ts", import.meta.url)), "utf8");
    assert.match(source, /siteInviteDepsFromProfile\(\s*profile\.web\s*,\s*resolveSecretRef\s*,\s*log\s*\)/);
    assert.match(source, /\.\.\.\(runtime\.siteInvites \? \{ siteInvites: runtime\.siteInvites \} : \{\}\)/);
    const poller = await readFile(fileURLToPath(new URL("../src/relay/poller.ts", import.meta.url)), "utf8");
    assert.match(poller, /\.\.\.\(deps\.siteInvites \? \{ siteInvites: deps\.siteInvites \} : \{\}\)/);
  });
});
