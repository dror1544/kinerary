import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildAlbum, thumbnailOf } from "../tools/fake-telegram-media.js";

const api = join(dirname(fileURLToPath(import.meta.url)), "..");

// Two stand-in "photos": a JPEG's start and end markers around different bytes.
const jpeg = (fill: string) => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from(fill), Buffer.from([0xff, 0xd9])]);

describe("buildAlbum: what Telegram hands the relay when someone sends pictures together", () => {
  const ids = (() => { let n = 0; return () => `F${++n}`; })();
  const album = buildAlbum({
    photos: [{ bytes: jpeg("one") }, { bytes: jpeg("two") }],
    base: { chat: { id: 7, type: "private" }, from: { id: 7 }, date: 1 },
    firstMessageId: 100, mediaGroupId: "G1", caption: "our tickets", newFileId: ids,
  });

  test("it is one message per photo, with consecutive ids", () => {
    assert.deepEqual(album.messages.map((m) => m.message_id), [100, 101]);
  });

  test("every message names the same media_group_id; that is the only thing joining them", () => {
    assert.deepEqual(album.messages.map((m) => m.media_group_id), ["G1", "G1"]);
  });

  test("the caption rides on the first message only, as Telegram sends it", () => {
    assert.equal(album.messages[0]!.caption, "our tickets");
    assert.equal("caption" in album.messages[1]!, false);
  });

  test("each photo lists a thumbnail first and the full size LAST, which is the one the relay takes", () => {
    for (const message of album.messages) {
      const sizes = message.photo as { file_id: string; file_size: number; width: number }[];
      assert.equal(sizes.length, 2);
      assert.ok(sizes[0]!.width < sizes[1]!.width);
    }
    const last = (album.messages[1]!.photo as { file_id: string }[]).at(-1)!.file_id;
    assert.deepEqual(album.files.find((f) => f.id === last)!.bytes, jpeg("two"));
  });

  test("the thumbnail's bytes differ from the photo's, so storing the wrong size is detectable", () => {
    const first = album.messages[0]!.photo as { file_id: string }[];
    const small = album.files.find((f) => f.id === first[0]!.file_id)!;
    const large = album.files.find((f) => f.id === first[1]!.file_id)!;
    assert.notDeepEqual(small.bytes, large.bytes);
    assert.deepEqual(small.bytes, thumbnailOf(large.bytes));
    // …and is still a JPEG to anything that decodes it: it starts the same and ends with the marker, not the picture.
    assert.deepEqual(small.bytes.subarray(0, large.bytes.length), large.bytes);
  });

  test("a single photo is a message with no media_group_id and its caption", () => {
    const one = buildAlbum({
      photos: [{ bytes: jpeg("solo") }], base: {}, firstMessageId: 5, caption: "c", newFileId: ids,
    });
    assert.equal(one.messages.length, 1);
    assert.equal("media_group_id" in one.messages[0]!, false);
    assert.equal(one.messages[0]!.caption, "c");
  });
});

// ── The running stand-in, asked the way the relay asks ───────────────────────

async function freePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const probe = createServer();
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address() as { port: number };
      probe.close(() => resolve(port));
    });
    probe.on("error", reject);
  });
}

describe("the stand-in serves an album through the Bot API, as the relay reads it", () => {
  let child: ChildProcess;
  let root = "";

  before(async () => {
    const port = await freePort();
    root = `http://127.0.0.1:${port}`;
    child = spawn("node", ["--import", "tsx", "tools/fake-telegram.ts", "--port", String(port)],
      { cwd: api, stdio: ["ignore", "pipe", "inherit"] });
    await new Promise<void>((resolve, reject) => {
      child.on("error", reject);
      child.stdout!.on("data", (chunk: Buffer) => { if (chunk.toString().includes("listening")) resolve(); });
    });
  });
  after(() => { child.kill(); });

  const control = async (path: string, body?: unknown) => {
    const res = await fetch(`${root}/_control/${path}`, body === undefined ? {} : {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
    });
    return (await res.json()) as { ok: boolean; result?: Record<string, unknown>; description?: string };
  };
  const bot = async (method: string, params: Record<string, unknown> = {}) => {
    const res = await fetch(`${root}/bot123:fake/${method}`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(params),
    });
    return (await res.json()) as { ok: boolean; result?: any; description?: string };
  };

  test("getUpdates returns both messages of the album at once, in order, sharing a media_group_id", async () => {
    const one = jpeg("ticket-one"), two = jpeg("ticket-two");
    const sent = await control("album", {
      chatId: "9000000000042",
      photos: [{ base64: one.toString("base64") }, { base64: two.toString("base64") }],
    });
    assert.equal(sent.ok, true, sent.description);
    assert.equal((sent.result!.messageIds as number[]).length, 2);

    const polled = await bot("getUpdates", { offset: 0, timeout: 0 });
    const messages = (polled.result as { message: Record<string, any> }[]).map((u) => u.message);
    assert.equal(messages.length, 2, "both photos in one poll, not one per poll");
    assert.equal(messages[0]!.media_group_id, messages[1]!.media_group_id);
    assert.ok(messages[0]!.media_group_id);

    // The relay's path: take the last size, getFile it, download file_path.
    const received: Buffer[] = [];
    for (const message of messages) {
      const largest = message.photo[message.photo.length - 1];
      const file = await bot("getFile", { file_id: largest.file_id });
      assert.equal(file.ok, true);
      const download = await fetch(`${root}/file/bot123:fake/${file.result.file_path}`);
      assert.equal(download.headers.get("content-type"), "image/jpeg");
      received.push(Buffer.from(await download.arrayBuffer()));
    }
    assert.deepEqual(received, [one, two]);
  });

  test("a lone photo is one message with no media_group_id", async () => {
    await control("photo", { chatId: "9000000000043", base64: jpeg("solo").toString("base64") });
    const polled = await bot("getUpdates", { offset: 0, timeout: 0 });
    const mine = (polled.result as { message: Record<string, any> }[]).map((u) => u.message)
      .filter((m) => m.chat.id === 9000000000043);
    assert.equal(mine.length, 1);
    assert.equal("media_group_id" in mine[0]!, false);
  });

  test("an album with no photos, or one with no bytes, is refused rather than queued empty", async () => {
    assert.equal((await control("album", { chatId: "9000000000044", photos: [] })).ok, false);
    assert.equal((await control("album", { chatId: "9000000000044", photos: [{ base64: "" }] })).ok, false);
  });

  test("an unknown file id is still refused, as Telegram does", async () => {
    assert.equal((await bot("getFile", { file_id: "nope" })).ok, false);
  });
});
