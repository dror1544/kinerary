/**
 * An itinerary PDF sent to a trip's family group, all the way to the plan the
 * family sees on the site.
 *
 * The relay fix (relay-group-attachments.test.ts) proves the document reaches
 * the companion's turn. This proves what happens after is possible with the
 * pieces a companion actually has: the file served back over the connector's
 * media plane, its text readable, and the trip updated through trip-mcp's own
 * tools against a real trip server — read back through the site API a family
 * member uses.
 *
 * The second test takes the file itself the rest of the way: saved where
 * Hermes saves it, uploaded by trip-mcp onto a booking, and downloaded by a
 * family member byte for byte.
 *
 * Every link is production code except ONE: deciding which lines of the PDF
 * are plan items is the companion's model's job, and a test cannot run a
 * model. `planFromItineraryText` below stands in for it, and it is kept
 * deliberately dumb so it is obvious that it is the stand-in. What the
 * companion's model does with the same text is verified live, not here.
 *
 * Needs the control-plane test database (the router resolves the group from
 * it) and installed `server/` and `mcp/` dependencies.
 */
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { documentText } from "../src/document-text.js";
import { applyMigrations } from "../src/migrations.js";
import { RelayConnector } from "../src/relay/connector.js";
import { dispatchUpdate, DEFAULT_STRINGS } from "../src/relay/dispatch.js";
import { MediaStore } from "../src/relay/media-store.js";
import type { TelegramMessage } from "../src/relay/normalize.js";
import { PendingAttachments } from "../src/relay/pending-attachments.js";
import { makeUpgradeToken } from "../src/relay/protocol.js";
import { minimalPdf } from "./support/minimal-pdf.js";
import { testDatabaseUrl } from "./support/test-database.js";
// The trip-site suite's own harness: a real server.js on a throwaway copy of
// tests/fixtures, and a real mcp.js pointed at it.
// @ts-expect-error — plain JS helpers, no type declarations
import { api, startTestServer, stopTestServer } from "../../../tests/helpers/server.js";
// @ts-expect-error — plain JS helpers, no type declarations
import { mcpCallTool, startTestMcp, stopTestMcp } from "../../../tests/helpers/mcp.js";
// @ts-expect-error — plain JS helpers, no type declarations
import { PORTS } from "../../../tests/helpers/ports.js";

const databaseUrl = testDatabaseUrl();
const SKIP = !databaseUrl;
const migrationsDir = fileURLToPath(new URL("../../db/migrations/", import.meta.url));

const GROUP = "-1003000999";
const ORGANIZER = 6001;
const GATEWAY_SECRET = "group-document-test-secret";
const AGENT_KEY = "test-hermes-key";
// tests/fixtures/trip.config.json: phase `colorado`, 2027-03-17 → 2027-03-23,
// with no days of its own — so everything on its plan afterwards came from
// the document.
const PHASE = "colorado";

const ITINERARY_LINES = [
  "Colorado family ski week - itinerary",
  "2027-03-18 Day plan: Breckenridge first day",
  "2027-03-18 09:00 Ski school drop-off at Peak 9",
  "2027-03-18 13:00 Lunch at Ten Mile Station",
  "2027-03-19 Day plan: Keystone and the gondola",
  "2027-03-19 10:30 River Run Gondola to the summit",
  "2027-03-19 18:00 Dinner at Alpenglow Stube",
];

/**
 * THE STAND-IN FOR THE COMPANION'S MODEL. Reads the itinerary's two line
 * shapes out of extracted text. A real companion reads prose; this only needs
 * to be good enough to hand real values to the real tools.
 */
function planFromItineraryText(text: string): {
  items: Array<{ date: string; time: string; text: string }>;
  labels: Array<{ date: string; label: string }>;
} {
  const items = [...text.matchAll(/(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}) ([^\n]+?)(?=\s*(?:\d{4}-\d{2}-\d{2}|$))/g)]
    .map((m) => ({ date: m[1]!, time: m[2]!, text: m[3]!.trim() }));
  const labels = [...text.matchAll(/(\d{4}-\d{2}-\d{2}) Day plan: ([^\n]+?)(?=\s*(?:\d{4}-\d{2}-\d{2}|$))/g)]
    .map((m) => ({ date: m[1]!, label: m[2]!.trim() }));
  return { items, labels };
}

function toolJson(result: { isError?: boolean; content?: Array<{ text?: string }> }): unknown {
  assert.notEqual(result.isError, true, `tool failed: ${result.content?.[0]?.text ?? ""}`);
  return JSON.parse(result.content?.[0]?.text ?? "null");
}

describe("an itinerary PDF sent to the family group reaches the trip's plan", { skip: SKIP }, () => {
  let pool: pg.Pool;
  let connector: RelayConnector;
  const mediaStore = new MediaStore();

  before(async () => {
    pool = new pg.Pool({ connectionString: databaseUrl });
    const client = await pool.connect();
    try {
      await client.query("DROP SCHEMA IF EXISTS control_plane CASCADE");
      await client.query("DROP TABLE IF EXISTS public.control_plane_schema_migrations");
      await applyMigrations(client, migrationsDir);
    } finally {
      client.release();
    }
    const tripId = `trip_${randomBytes(16).toString("hex")}`;
    await pool.query(
      "INSERT INTO control_plane.trips(id, slug, lifecycle_state, assistant_names) VALUES ($1, $2, 'draft', $3)",
      [tripId, tripId.replace(/_/g, "-"), ["ליב", "Liv"]],
    );
    await pool.query(
      "INSERT INTO control_plane.telegram_chat_bindings(id, chat_id, trip_id, hermes_profile) VALUES ('tcb_' || md5(random()::text), $1, $2, 'companion-colorado')",
      [GROUP, tripId],
    );

    connector = new RelayConnector({
      gatewaySecrets: [GATEWAY_SECRET],
      telegram: { async sendMessage() { return { ok: true }; } } as never,
      port: 0,
      mediaStore,
    });
    await connector.listen();

    await startTestServer({ PORT: String(PORTS.groupDocumentServer) });
    await startTestMcp({
      MCP_PORT: String(PORTS.groupDocumentMcp),
      API_BASE_URL: `http://127.0.0.1:${PORTS.groupDocumentServer}`,
      TRIP_API_KEY: AGENT_KEY,
    });
  });

  after(async () => {
    stopTestMcp();
    stopTestServer();
    await connector?.close();
    await pool?.end();
  });

  test("document, then instruction → re-hosted → read → written through trip-mcp → seen on the site", async () => {
    const pdf = minimalPdf(ITINERARY_LINES);

    // 1. The family group, as it happened live: the file with no caption, then
    //    the instruction by name. Telegram hands the file over only when the
    //    relay asks for it.
    const fetched: string[] = [];
    const media = {
      telegram: {
        async fetchFile(fileId: string) {
          fetched.push(fileId);
          return { bytes: pdf, mime: "application/pdf" };
        },
      },
      store: mediaStore,
      baseUrl: `http://127.0.0.1:${connector.address}`,
    };
    const pending = new PendingAttachments();
    const send = (message: TelegramMessage) =>
      dispatchUpdate(pool, { update_id: message.message_id ?? 1, message }, DEFAULT_STRINGS, () => {}, {
        username: "Kinerary_bot",
        id: "9000",
      }, { media, pendingAttachments: pending });
    const inGroup = (fields: Partial<TelegramMessage>, id: number): TelegramMessage => ({
      message_id: id,
      from: { id: ORGANIZER, first_name: "Organizer" },
      chat: { id: GROUP, type: "supergroup" },
      ...fields,
    });

    const fileTurn = await send(inGroup({
      document: { file_id: "BQAC-colorado", file_name: "colorado-itinerary.pdf", mime_type: "application/pdf", file_size: pdf.length },
    }, 1));
    assert.deepEqual(fileTurn, { kind: "ignore", reason: "NOT_ADDRESSED" });
    assert.deepEqual(fetched, [], "the file alone is not for the assistant — nothing downloaded");

    const instruction = await send(inGroup({ text: "Liv, please add this itinerary to the site" }, 2));
    assert.equal(instruction.kind, "to_gateway");
    if (instruction.kind !== "to_gateway") return;
    assert.equal(instruction.event.source.profile, "companion-colorado");
    assert.equal(instruction.event.message_type, "document");
    const mediaUrl = instruction.event.media_urls?.[0];
    assert.ok(mediaUrl, "the instruction carries the document");

    // 2. The companion's gateway fetches it the way Hermes does: a GET on the
    //    connector with its bearer. Without one, nothing.
    const anonymous = await fetch(mediaUrl);
    assert.equal(anonymous.status, 401);
    const served = await fetch(mediaUrl, {
      headers: { authorization: `Bearer ${makeUpgradeToken("gw_companion_colorado", GATEWAY_SECRET, 300)}` },
    });
    assert.equal(served.status, 200);
    assert.match(served.headers.get("content-disposition") ?? "", /colorado-itinerary\.pdf/);
    const bytes = Buffer.from(await served.arrayBuffer());
    assert.ok(bytes.equals(pdf), "the companion receives exactly the bytes that were sent");

    // 3. The PDF is a real, text-bearing PDF. (pdf.js refuses a Node Buffer,
    //    as the relay's own document path knows — poller.ts converts too.)
    const read = await documentText(
      new Uint8Array(bytes),
      served.headers.get("content-type") ?? undefined,
      "colorado-itinerary.pdf",
    );
    assert.equal(read.ok, true, `unreadable: ${read.ok ? "" : read.reason}`);
    if (!read.ok) return;
    assert.match(read.text, /River Run Gondola/);

    // 4. The model's step — see planFromItineraryText.
    const plan = planFromItineraryText(read.text);
    assert.equal(plan.items.length, 4, `stand-in parse: ${JSON.stringify(plan)}`);
    assert.equal(plan.labels.length, 2);

    // 5. trip-mcp, exactly the tools the companion is told to use: look first,
    //    then write the active plan, then read back.
    const before = toolJson(await mcpCallTool("get_phase_plan", { phase_id: PHASE })) as { items: unknown[] };
    assert.deepEqual(before.items, [], "the phase starts with an empty active plan");
    for (const item of plan.items) {
      toolJson(await mcpCallTool("add_plan_item", {
        phase_id: PHASE,
        date: item.date,
        time: item.time,
        text_en: item.text,
        text_he: item.text,
        // The companion writes after the organizer approves the draft it
        // showed them (SOUL: approval first), so what lands is confirmed.
        status: "confirmed",
      }));
    }
    for (const day of plan.labels) {
      toolJson(await mcpCallTool("set_plan_day_label", { phase_id: PHASE, date: day.date, label_en: day.label }));
    }

    // 6. What a family member sees on the site.
    const login = await api("/api/auth/login", { method: "POST", body: { username: "bob", password: "1234" } });
    const { token } = await login.json();
    const itemsRes = await api(`/api/phases/${PHASE}/plan`, { token });
    assert.equal(itemsRes.status, 200);
    const items = (await itemsRes.json()) as Array<{ date: string; time: string; text_en: string }>;
    assert.deepEqual(
      items.map((i) => `${i.date} ${i.time} ${i.text_en}`).sort(),
      [
        "2027-03-18 09:00 Ski school drop-off at Peak 9",
        "2027-03-18 13:00 Lunch at Ten Mile Station",
        "2027-03-19 10:30 River Run Gondola to the summit",
        "2027-03-19 18:00 Dinner at Alpenglow Stube",
      ],
    );
    const daysRes = await api(`/api/phases/${PHASE}/plan/days`, { token });
    assert.equal(daysRes.status, 200);
    const days = (await daysRes.json()) as Array<{ date: string; label_en?: string | null }>;
    assert.equal(days.find((d) => d.date === "2027-03-19")?.label_en, "Keystone and the gondola");
    assert.deepEqual(fetched, ["BQAC-colorado"], "downloaded once, for the turn that used it");
  });

  test("the booking PDF itself: saved to the hand-off folder → uploaded by trip-mcp → downloadable on the site", async () => {
    const confirmation = minimalPdf([
      "Alpenglow Stube - reservation confirmed",
      "Confirmation number KEY-48213 for 5 guests on 2027-03-19 at 18:00",
    ]);
    const media = {
      telegram: { async fetchFile() { return { bytes: confirmation, mime: "application/pdf" }; } },
      store: mediaStore,
      baseUrl: `http://127.0.0.1:${connector.address}`,
    };
    const pending = new PendingAttachments();
    const send = (message: TelegramMessage) =>
      dispatchUpdate(pool, { update_id: message.message_id ?? 1, message }, DEFAULT_STRINGS, () => {}, {
        username: "Kinerary_bot",
        id: "9000",
      }, { media, pendingAttachments: pending });

    await send({
      message_id: 11,
      from: { id: ORGANIZER, first_name: "Organizer" },
      chat: { id: GROUP, type: "supergroup" },
      document: { file_id: "BQAC-alpenglow", file_name: "alpenglow.pdf", mime_type: "application/pdf" },
    });
    const turn = await send({
      message_id: 12,
      from: { id: ORGANIZER, first_name: "Organizer" },
      chat: { id: GROUP, type: "supergroup" },
      text: "Liv, attach this to the dinner booking",
    });
    assert.equal(turn.kind, "to_gateway");
    const mediaUrl = turn.kind === "to_gateway" ? turn.event.media_urls?.[0] : undefined;
    assert.ok(mediaUrl);

    // What Hermes does with it (gateway/relay/media.py): fetch with its bearer,
    // then `tempfile.mkstemp(prefix="relay_media_")` — under TMPDIR, which on
    // the VM is the hand-off folder mounted at the same path on the host, where
    // trip-mcp runs. Here both sides share one filesystem, so a temp directory
    // plays that folder; tests/scripts/test_inbound_handoff.py holds the VM
    // compose to the same-path rule.
    const handoff = mkdtempSync(join(tmpdir(), "kinerary-inbound-"));
    try {
      const served = await fetch(mediaUrl, {
        headers: { authorization: `Bearer ${makeUpgradeToken("gw_companion_colorado", GATEWAY_SECRET, 300)}` },
      });
      assert.equal(served.status, 200);
      const savedPath = join(handoff, `relay_media_${randomBytes(4).toString("hex")}.pdf`);
      writeFileSync(savedPath, Buffer.from(await served.arrayBuffer()), { mode: 0o600 });

      // The companion's tools: record the booking, then attach the file it was sent.
      const created = toolJson(await mcpCallTool("add_booking", {
        phase: PHASE,
        type: "other",
        name: "Dinner at Alpenglow Stube",
        date_from: "2027-03-19",
        confirmation: "KEY-48213",
      })) as { id: number };
      assert.ok(Number.isInteger(created.id));
      const uploaded = toolJson(await mcpCallTool("upload_booking_confirmation", {
        id: created.id,
        filePath: savedPath,
      })) as { conf_file: string };
      assert.ok(uploaded.conf_file, "the site stored the file and named it on the booking");

      // A family member opens it on the site.
      const login = await api("/api/auth/login", { method: "POST", body: { username: "bob", password: "1234" } });
      const { token } = await login.json();
      const bookings = (await (await api("/api/bookings", { token })).json()) as Array<{ id: number; conf_file?: string }>;
      assert.equal(bookings.find((b) => b.id === created.id)?.conf_file, uploaded.conf_file);
      const download = await api(`/api/bookings/confirmation/${encodeURIComponent(uploaded.conf_file)}`, { token });
      assert.equal(download.status, 200);
      assert.ok(
        Buffer.from(await download.arrayBuffer()).equals(confirmation),
        "the family downloads exactly the PDF that was sent to the group",
      );
    } finally {
      rmSync(handoff, { recursive: true, force: true });
    }
  });
});
