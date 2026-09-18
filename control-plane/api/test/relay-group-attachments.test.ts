/**
 * A document sent to a family group, and the instruction that follows it.
 *
 * 2026-09-17, live: an organizer sent the trip's itinerary PDF to the family
 * group with no caption, then — 4 min 32 s later — asked the assistant by name
 * to put it on the trip site. The relevance gate saw two unrelated messages:
 * a file that addressed nobody (dropped as NOT_ADDRESSED) and an instruction
 * with no file. The assistant truthfully answered that nothing had been
 * uploaded. The file had in fact been DOWNLOADED by the relay before the gate
 * dropped it, so every photo a family shared was being fetched for nothing.
 *
 * What these tests hold the relay to:
 *   - a group message still reaches the assistant only when it addresses it;
 *   - a dropped document is remembered as a reference, never as bytes;
 *   - only its own sender's next addressed message, in the same chat, within
 *     the window, brings it along — and only once;
 *   - replying to your own document while addressing the assistant brings it;
 *   - nothing is downloaded unless it is actually going to the assistant.
 */
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { applyMigrations } from "../src/migrations.js";
import { dispatchUpdate, DEFAULT_STRINGS } from "../src/relay/dispatch.js";
import { MediaStore } from "../src/relay/media-store.js";
import type { MediaDeps, TelegramMessage, TelegramUpdate } from "../src/relay/normalize.js";
import {
  PENDING_ATTACHMENT_TTL_MS,
  PENDING_ATTACHMENTS_PER_SENDER,
  PendingAttachments,
} from "../src/relay/pending-attachments.js";
import { testDatabaseUrl } from "./support/test-database.js";

const databaseUrl = testDatabaseUrl();
const SKIP = !databaseUrl;
const migrationsDir = fileURLToPath(new URL("../../db/migrations/", import.meta.url));

const GROUP = "-1003000111";
const NIR = 5001;
const SARAH = 5002;
const ITINERARY = { file_id: "BQAC-itinerary", file_name: "japan-itinerary.pdf", mime_type: "application/pdf", file_size: 760998 };
const HOTELS = { file_id: "BQAC-hotels", file_name: "hotels.pdf", mime_type: "application/pdf", file_size: 120000 };

function doc(fileId: string, filename = "file.pdf") {
  return { fileId, kind: "document" as const, mime: "application/pdf", filename };
}

// ── The holding area on its own ─────────────────────────────────────────────

describe("PendingAttachments", () => {
  test("holds a document for its sender and hands it over exactly once", () => {
    let now = 1_000_000;
    const pending = new PendingAttachments({ now: () => now });
    pending.hold(GROUP, "5001", doc("A"));
    now += 1000;
    assert.deepEqual(pending.take(GROUP, "5001").map((d) => d.fileId), ["A"]);
    assert.deepEqual(pending.take(GROUP, "5001"), [], "taken means gone");
  });

  test("never hands one sender's document to another sender", () => {
    const pending = new PendingAttachments({ now: () => 1_000_000 });
    pending.hold(GROUP, "5001", doc("nirs"));
    assert.deepEqual(pending.take(GROUP, "5002"), [], "Sarah's request gets nothing of Nir's");
    assert.deepEqual(
      pending.take(GROUP, "5001").map((d) => d.fileId),
      ["nirs"],
      "and asking on Sarah's behalf did not consume it",
    );
  });

  test("never crosses chats, even for the same person", () => {
    const pending = new PendingAttachments({ now: () => 1_000_000 });
    pending.hold("-1003000111", "5001", doc("family-group"));
    assert.deepEqual(pending.take("-1003000222", "5001"), []);
    assert.deepEqual(pending.take("5001", "5001"), [], "not in their DM either");
    assert.equal(pending.take("-1003000111", "5001").length, 1);
  });

  test("expires at the window's end, not a moment later", () => {
    let now = 1_000_000;
    const pending = new PendingAttachments({ ttlMs: 60_000, now: () => now });
    pending.hold(GROUP, "5001", doc("early"));
    now += 59_999;
    assert.equal(pending.take(GROUP, "5001").length, 1, "one millisecond inside the window");

    pending.hold(GROUP, "5001", doc("late"));
    now += 60_000;
    assert.deepEqual(pending.take(GROUP, "5001"), [], "exactly at the window's end it is gone");
  });

  test("an expired document is not revived by a newer one", () => {
    let now = 1_000_000;
    const pending = new PendingAttachments({ ttlMs: 60_000, now: () => now });
    pending.hold(GROUP, "5001", doc("stale"));
    now += 90_000;
    pending.hold(GROUP, "5001", doc("fresh"));
    assert.deepEqual(pending.take(GROUP, "5001").map((d) => d.fileId), ["fresh"]);
  });

  test("the default window covers the gap that lost a real itinerary", () => {
    // 14:32:38 the PDF, 14:37:10 the instruction: 272 seconds.
    assert.ok(PENDING_ATTACHMENT_TTL_MS >= 272_000, "must include the live case");
    assert.ok(PENDING_ATTACHMENT_TTL_MS <= 5 * 60_000, "and stay short — minutes, not a conversation");
  });

  test("keeps only the newest few per sender, oldest first when handed over", () => {
    let now = 1_000_000;
    const pending = new PendingAttachments({ now: () => now });
    const sent = Array.from({ length: PENDING_ATTACHMENTS_PER_SENDER + 2 }, (_, i) => `doc-${i}`);
    for (const id of sent) {
      pending.hold(GROUP, "5001", doc(id));
      now += 1;
    }
    assert.deepEqual(
      pending.take(GROUP, "5001").map((d) => d.fileId),
      sent.slice(-PENDING_ATTACHMENTS_PER_SENDER),
    );
  });

  test("a sender who holds the same document twice gets it once", () => {
    const pending = new PendingAttachments({ now: () => 1_000_000 });
    pending.hold(GROUP, "5001", doc("same"));
    pending.hold(GROUP, "5001", doc("same"));
    assert.equal(pending.take(GROUP, "5001").length, 1);
  });

  test("is bounded across senders, dropping the longest-held first", () => {
    let now = 1_000_000;
    const pending = new PendingAttachments({ maxSenders: 2, now: () => now });
    pending.hold(GROUP, "1", doc("one"));
    now += 1;
    pending.hold(GROUP, "2", doc("two"));
    now += 1;
    pending.hold(GROUP, "3", doc("three"));
    assert.equal(pending.size, 2);
    assert.deepEqual(pending.take(GROUP, "1"), [], "the longest-held sender made room");
    assert.equal(pending.take(GROUP, "3").length, 1);
  });

  test("holds a reference, never bytes", () => {
    const pending = new PendingAttachments({ now: () => 1_000_000 });
    pending.hold(GROUP, "5001", doc("ref"), { caption: "flights" });
    const [held] = pending.take(GROUP, "5001");
    assert.deepEqual(Object.keys(held!).sort(), ["caption", "fileId", "filename", "kind", "mime"]);
  });
});

// ── Through the router ──────────────────────────────────────────────────────

interface Fixture {
  pool: pg.Pool;
  tripId: string;
}

async function withGroupTrip(fn: (fix: Fixture) => Promise<void>): Promise<void> {
  const pool = new pg.Pool({ connectionString: databaseUrl });
  const client = await pool.connect();
  try {
    await client.query("DROP SCHEMA IF EXISTS control_plane CASCADE");
    await client.query("DROP TABLE IF EXISTS public.control_plane_schema_migrations");
    await applyMigrations(client, migrationsDir);
  } finally {
    client.release();
  }
  try {
    const tripId = `trip_${randomBytes(16).toString("hex")}`;
    await pool.query(
      "INSERT INTO control_plane.trips(id, slug, lifecycle_state, assistant_names) VALUES ($1, $2, 'draft', $3)",
      [tripId, tripId.replace(/_/g, "-"), ["ליב", "Liv"]],
    );
    await pool.query(
      "INSERT INTO control_plane.telegram_chat_bindings(id, chat_id, trip_id, hermes_profile) VALUES ('tcb_' || md5(random()::text), $1, $2, 'companion-japan')",
      [GROUP, tripId],
    );
    await fn({ pool, tripId });
  } finally {
    await pool.end();
  }
}

let nextMessageId = 100;

function groupMessage(fromId: number, fields: Partial<TelegramMessage>): TelegramMessage {
  nextMessageId += 1;
  return {
    message_id: nextMessageId,
    from: { id: fromId, first_name: fromId === NIR ? "Nir" : "Sarah" },
    chat: { id: GROUP, type: "supergroup", title: "Japan 2026" },
    ...fields,
  };
}

function update(message: TelegramMessage): TelegramUpdate {
  return { update_id: message.message_id ?? 1, message };
}

/** A Telegram stand-in that records every file it was asked to download. */
function recordingMedia(): { deps: MediaDeps; fetched: string[]; store: MediaStore } {
  const fetched: string[] = [];
  const store = new MediaStore();
  return {
    fetched,
    store,
    deps: {
      telegram: {
        async fetchFile(fileId: string) {
          fetched.push(fileId);
          return { bytes: Buffer.from(`%PDF-1.4 ${fileId}`), mime: "application/pdf" };
        },
      },
      store,
      baseUrl: "http://127.0.0.1:4312",
    },
  };
}

function router(fix: Fixture, media: MediaDeps, pending: PendingAttachments) {
  return (message: TelegramMessage) =>
    dispatchUpdate(fix.pool, update(message), DEFAULT_STRINGS, () => {}, { username: "Kinerary_bot", id: "9000" }, {
      media,
      pendingAttachments: pending,
    });
}

describe("a document and the instruction that follows it", () => {
  test("a caption-less document in the group is neither forwarded nor downloaded", { skip: SKIP }, async () => {
    await withGroupTrip(async (fix) => {
      const media = recordingMedia();
      const pending = new PendingAttachments();
      const send = router(fix, media.deps, pending);

      const decision = await send(groupMessage(NIR, { document: ITINERARY }));
      assert.deepEqual(decision, { kind: "ignore", reason: "NOT_ADDRESSED" });
      assert.deepEqual(media.fetched, [], "not for the assistant, so not fetched");
      assert.equal(media.store.size, 0);
    });
  });

  test("the sender naming the assistant within the window brings the document along", { skip: SKIP }, async () => {
    await withGroupTrip(async (fix) => {
      let now = 1_000_000;
      const media = recordingMedia();
      const send = router(fix, media.deps, new PendingAttachments({ now: () => now }));

      await send(groupMessage(NIR, { document: ITINERARY }));
      now += 272_000; // the live gap: 4 min 32 s
      const decision = await send(groupMessage(NIR, { text: "ליב, שלבי את המסלול באתר" }));

      assert.equal(decision.kind, "to_gateway");
      if (decision.kind !== "to_gateway") return;
      assert.equal(decision.event.text, "ליב, שלבי את המסלול באתר", "the instruction is the turn's text");
      assert.equal(decision.event.message_type, "document");
      assert.equal(decision.event.media_urls?.length, 1);
      assert.equal(decision.event.media?.[0]?.filename, "japan-itinerary.pdf");
      assert.deepEqual(media.fetched, [ITINERARY.file_id], "downloaded once, only now that it is going somewhere");
    });
  });

  test("another member's request never carries it — and does not use it up", { skip: SKIP }, async () => {
    await withGroupTrip(async (fix) => {
      const media = recordingMedia();
      const send = router(fix, media.deps, new PendingAttachments());

      await send(groupMessage(NIR, { document: ITINERARY }));
      const sarahs = await send(groupMessage(SARAH, { text: "Liv, what's the weather in Kyoto?" }));
      assert.equal(sarahs.kind, "to_gateway");
      if (sarahs.kind !== "to_gateway") return;
      assert.equal(sarahs.event.media_urls, undefined, "Nir's file is not attached to Sarah's question");
      assert.equal(sarahs.event.message_type, "text");
      assert.deepEqual(media.fetched, []);

      const nirs = await send(groupMessage(NIR, { text: "Liv, add this to the site" }));
      assert.equal(nirs.kind === "to_gateway" ? nirs.event.media_urls?.length : 0, 1, "still Nir's to use");
    });
  });

  test("after the window the document is gone", { skip: SKIP }, async () => {
    await withGroupTrip(async (fix) => {
      let now = 1_000_000;
      const media = recordingMedia();
      const send = router(fix, media.deps, new PendingAttachments({ now: () => now }));

      await send(groupMessage(NIR, { document: ITINERARY }));
      now += PENDING_ATTACHMENT_TTL_MS;
      const decision = await send(groupMessage(NIR, { text: "Liv, add the itinerary" }));
      assert.equal(decision.kind, "to_gateway");
      assert.equal(decision.kind === "to_gateway" ? decision.event.media_urls : "x", undefined);
      assert.deepEqual(media.fetched, []);
    });
  });

  test("a held document is handed over once, not to every later question", { skip: SKIP }, async () => {
    await withGroupTrip(async (fix) => {
      const media = recordingMedia();
      const send = router(fix, media.deps, new PendingAttachments());

      await send(groupMessage(NIR, { document: ITINERARY }));
      const first = await send(groupMessage(NIR, { text: "Liv, add this" }));
      const second = await send(groupMessage(NIR, { text: "Liv, and what time is dinner?" }));
      assert.equal(first.kind === "to_gateway" ? first.event.media_urls?.length : 0, 1);
      assert.equal(second.kind === "to_gateway" ? second.event.media_urls : "x", undefined);
      assert.deepEqual(media.fetched, [ITINERARY.file_id]);
    });
  });

  test("several documents sent before the instruction all come along, in order", { skip: SKIP }, async () => {
    await withGroupTrip(async (fix) => {
      const media = recordingMedia();
      const send = router(fix, media.deps, new PendingAttachments());

      await send(groupMessage(NIR, { document: ITINERARY }));
      await send(groupMessage(NIR, { document: HOTELS }));
      const decision = await send(groupMessage(NIR, { text: "Liv, both of these are for the site" }));
      assert.equal(decision.kind, "to_gateway");
      if (decision.kind !== "to_gateway") return;
      assert.deepEqual(decision.event.media?.map((m) => m.filename), ["japan-itinerary.pdf", "hotels.pdf"]);
      assert.equal(decision.event.media_urls?.length, 2);
    });
  });

  test("a reply to the assistant counts as addressing it, and brings the held document", { skip: SKIP }, async () => {
    await withGroupTrip(async (fix) => {
      const media = recordingMedia();
      const send = router(fix, media.deps, new PendingAttachments());

      await send(groupMessage(NIR, { document: ITINERARY }));
      const decision = await send(groupMessage(NIR, {
        text: "here it is",
        reply_to_message: { message_id: 50, from: { id: 9000, is_bot: true } },
      }));
      assert.equal(decision.kind === "to_gateway" ? decision.event.media_urls?.length : 0, 1);
    });
  });

  test("replying to your own document while naming the assistant attaches it — even past the window", { skip: SKIP }, async () => {
    await withGroupTrip(async (fix) => {
      let now = 1_000_000;
      const media = recordingMedia();
      const send = router(fix, media.deps, new PendingAttachments({ now: () => now }));

      const original = groupMessage(NIR, { document: ITINERARY });
      await send(original);
      now += PENDING_ATTACHMENT_TTL_MS * 10;
      const decision = await send(groupMessage(NIR, {
        text: "Liv, add this one to the site",
        reply_to_message: original,
      }));
      assert.equal(decision.kind, "to_gateway");
      if (decision.kind !== "to_gateway") return;
      assert.equal(decision.event.media?.[0]?.filename, "japan-itinerary.pdf");
      assert.deepEqual(media.fetched, [ITINERARY.file_id]);
    });
  });

  test("replying to a document is not attached twice when it is also held", { skip: SKIP }, async () => {
    await withGroupTrip(async (fix) => {
      const media = recordingMedia();
      const send = router(fix, media.deps, new PendingAttachments());

      const original = groupMessage(NIR, { document: ITINERARY });
      await send(original);
      const decision = await send(groupMessage(NIR, { text: "Liv, this one", reply_to_message: original }));
      assert.equal(decision.kind === "to_gateway" ? decision.event.media_urls?.length : 0, 1);
      assert.deepEqual(media.fetched, [ITINERARY.file_id]);
    });
  });

  test("replying to someone else's document does not hand it to your request", { skip: SKIP }, async () => {
    await withGroupTrip(async (fix) => {
      const media = recordingMedia();
      const send = router(fix, media.deps, new PendingAttachments());

      const nirsDocument = groupMessage(NIR, { document: ITINERARY });
      await send(nirsDocument);
      const decision = await send(groupMessage(SARAH, {
        text: "Liv, what does this say?",
        reply_to_message: nirsDocument,
      }));
      assert.equal(decision.kind, "to_gateway");
      assert.equal(decision.kind === "to_gateway" ? decision.event.media_urls : "x", undefined);
      assert.deepEqual(media.fetched, []);
    });
  });

  test("a photo that is not for the assistant is neither downloaded nor held", { skip: SKIP }, async () => {
    await withGroupTrip(async (fix) => {
      const media = recordingMedia();
      const pending = new PendingAttachments();
      const send = router(fix, media.deps, pending);

      const decision = await send(groupMessage(NIR, { photo: [{ file_id: "thumb" }, { file_id: "sushi-dinner" }] }));
      assert.deepEqual(decision, { kind: "ignore", reason: "NOT_ADDRESSED" });
      assert.equal(pending.size, 0, "family photos are not documents for the assistant");

      const next = await send(groupMessage(NIR, { text: "Liv, what time is checkout?" }));
      assert.equal(next.kind === "to_gateway" ? next.event.media_urls : "x", undefined);
      assert.deepEqual(media.fetched, []);
    });
  });

  test("family talk still does not reach the assistant", { skip: SKIP }, async () => {
    await withGroupTrip(async (fix) => {
      const media = recordingMedia();
      const send = router(fix, media.deps, new PendingAttachments());

      await send(groupMessage(NIR, { document: ITINERARY }));
      const chatter = await send(groupMessage(NIR, { text: "sent you all the plan, have a look" }));
      assert.deepEqual(chatter, { kind: "ignore", reason: "NOT_ADDRESSED" });
      assert.deepEqual(media.fetched, [], "an unaddressed follow-up does not release the document");

      const addressed = await send(groupMessage(NIR, { text: "Liv, put the plan on the site" }));
      assert.equal(addressed.kind === "to_gateway" ? addressed.event.media_urls?.length : 0, 1);
    });
  });

  test("a document whose caption names the assistant goes straight through, as before", { skip: SKIP }, async () => {
    await withGroupTrip(async (fix) => {
      const media = recordingMedia();
      const send = router(fix, media.deps, new PendingAttachments());

      const decision = await send(groupMessage(NIR, { document: ITINERARY, caption: "Liv, add this" }));
      assert.equal(decision.kind, "to_gateway");
      if (decision.kind !== "to_gateway") return;
      assert.equal(decision.event.text, "Liv, add this");
      assert.equal(decision.event.media?.[0]?.caption, "Liv, add this");
      assert.deepEqual(media.fetched, [ITINERARY.file_id]);
    });
  });

  test("a direct message with a document is forwarded as before", { skip: SKIP }, async () => {
    await withGroupTrip(async (fix) => {
      await fix.pool.query(
        "INSERT INTO control_plane.telegram_chat_bindings(id, chat_id, trip_id, hermes_profile) VALUES ('tcb_' || md5(random()::text), $1, $2, 'companion-japan')",
        [String(NIR), fix.tripId],
      );
      const media = recordingMedia();
      const send = router(fix, media.deps, new PendingAttachments());

      const decision = await send({
        message_id: 900,
        from: { id: NIR, first_name: "Nir" },
        chat: { id: String(NIR), type: "private" },
        document: ITINERARY,
      });
      assert.equal(decision.kind === "to_gateway" ? decision.event.media_urls?.length : 0, 1);
    });
  });
});
