/**
 * WhatsApp S2, new code on the OLD schema with the switch on (spec 625, AC-5 and the "two clocks" rule): the three WhatsApp routes
 * answer the same indistinguishable `404 {"error":"NOT_FOUND"}` as "feature not present", never a 500 that echoes the database
 * error, with one warn log line that names the event and carries no SQL text. Only these three routes: no global error handler.
 */
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { after, before, describe, test } from "node:test";
import pg from "pg";
import { buildApp } from "../src/app.js";
import { validateArchitectureProfile } from "../src/config.js";
import { sha256, type PortalDependencies } from "../src/portal.js";
import { testDatabaseUrl } from "./support/test-database.js";
import { freshDatabase, mkWhatsappTrip, uid } from "./support/whatsapp-fixture.js";

const SKIP = !testDatabaseUrl();
const ORIGIN = "http://portal.oldschema.test";
const profile = validateArchitectureProfile({
  version: 1, environment: "test", public_api: { bind_host: "127.0.0.1", port: 4310 },
  worker: { queue: "postgres", health_bind_host: "127.0.0.1", health_port: 4311 },
  database: { connection_secret_ref: "env://CONTROL_PLANE_DATABASE_URL" },
  adapters: { compute: "fake", ingress: "fake", agent_runtime: "fake", messaging: "fake", secrets: "fake" },
  test_resources: { enabled: false },
});

describe("whatsapp portal routes on a database from before the WhatsApp migration", { skip: SKIP }, () => {
  let pool: pg.Pool;
  const logs: string[] = [];
  let app: ReturnType<typeof buildApp>;
  let tripId: string, cookie: string, csrf: string;
  before(async () => {
    pool = await freshDatabase({ oldSchema: true });
    const trip = await mkWhatsappTrip(pool);   // the switch is on; the S2 schema is absent
    tripId = trip.tripId;
    const raw = `sess-${randomBytes(8).toString("hex")}`;
    csrf = `csrf-${randomBytes(8).toString("hex")}`;
    await pool.query(
      "INSERT INTO control_plane.web_sessions(id,user_id,token_digest,csrf_digest,expires_at) VALUES ($1,$2,$3,$4,now() + interval '1 hour')",
      [uid("wsess"), trip.ownerId, sha256(raw), sha256(csrf)]);
    cookie = `kit_session=${raw}; kit_csrf=${csrf}`;
    app = buildApp(profile, {
      portal: {
        db: pool, runtimeAccounts: { participantExists: async () => true, provisionParticipant: async () => {} },
        publicOrigin: ORIGIN, runtimeOrigin: "http://runtime.oldschema.test", runtimeExchangeKey: "exchange-key",
        runtimeUpstreamHostSuffixes: ["internal"], telegramBotUsername: "kinerary_bot", sessionTtlSeconds: 3600,
        enrollmentTtlSeconds: 3600, approvalTtlSeconds: 3600, emailAuthLog: (line: string) => logs.push(line),
        whatsapp: { number: "15550100123", codeTtlSeconds: 900 },
      } as PortalDependencies,
    });
  });
  after(async () => { await app.close(); await pool.end(); });

  const call = (method: string, url: string, payload?: unknown) => app.inject({
    method: method as "GET", url,
    headers: { cookie, "x-csrf-token": csrf, origin: ORIGIN, ...(payload !== undefined ? { "content-type": "application/json" } : {}) },
    ...(payload !== undefined ? { payload: JSON.stringify(payload) } : {}),
  });

  test("AC-5: POST whatsapp-codes, GET and DELETE whatsapp-connections answer 404 NOT_FOUND with no database error in the body, and one warn line each", async () => {
    for (const [label, request] of [
      ["POST whatsapp-codes", () => call("POST", `/v1/trips/${tripId}/whatsapp-codes`, { kind: "me" })],
      ["GET whatsapp-connections", () => call("GET", `/v1/trips/${tripId}/whatsapp-connections`)],
      ["DELETE whatsapp-connections", () => call("DELETE", `/v1/trips/${tripId}/whatsapp-connections/tcb_${randomBytes(16).toString("hex")}`)],
    ] as const) {
      logs.length = 0;
      const response = await request();
      console.log(`EVIDENCE old schema, switch on: ${label} -> HTTP ${response.statusCode} ${response.body} | log: ${logs.join(" ")}`);
      assert.equal(response.statusCode, 404, label);
      assert.deepEqual(JSON.parse(response.body), { error: "NOT_FOUND" }, label);
      assert.ok(!/relation|does not exist|chat_binding_codes|telegram_chat_bindings|SELECT|42P01|42703/i.test(response.body), "the response never carries the database's words");
      const warn = logs.filter((l) => l.includes("whatsapp.schema_missing"));
      assert.equal(warn.length, 1, `${label}: one warn line naming the event`);
      assert.ok(!/SELECT|FROM|control_plane\./i.test(warn[0]!), "no SQL text in the log line");
      assert.match(warn[0]!, /42P01|42703/);
    }
  });

  test("AC-5: the guard is only on the three WhatsApp routes: the trip list and the trip page still answer normally on the old schema", async () => {
    // a different, healthy route still answers normally on the old schema
    assert.equal((await call("GET", "/v1/trips")).statusCode, 200);
    assert.equal((await call("GET", `/v1/trips/${tripId}`)).statusCode, 200);
  });
});
