/**
 * Reading photos and scans — the parts that need no database and no real model.
 *
 * Two properties carry the weight. A file is never silently dropped: a runner
 * that cannot deliver it refuses before any model is contacted, because a
 * "transcription" of a file the model never saw looks exactly like a real one.
 * And the checks that can run before the file leaves the machine — its type,
 * its size, a passport's filename — do run before.
 */
import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import {
  buildVisionPrompt,
  parseVisionOutput,
  readWithVision,
  VISION_OUTPUT_SCHEMA,
  VISION_TASK,
  visionFileFor,
  visionReaderVersion,
  visionTextFrom,
  visionProcessingConfig,
} from "../src/document-vision.js";
import {
  claudeSpec,
  claudeStreamAnswer,
  cliRunner,
  codexRunner,
  codexSpec,
  composeRunners,
  fakeRunner,
  hermesSpec,
  modelRunnerFromEnv,
  openRouterRunner,
  openRouterSpec,
  runnerForBinding,
} from "../src/model-runner.js";

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
const transcript = (lines: string[], extra: Record<string, unknown> = {}) =>
  JSON.stringify({ legible: true, identity_document: false, lines, ...extra });

describe("which files are looked at", () => {
  test("images by declared type, the name only when the type says nothing, and no HEIC dressed as a JPEG", () => {
    assert.deepEqual(visionFileFor("image/png", "x"), { kind: "image", mime: "image/png", ext: "png" });
    assert.deepEqual(visionFileFor("image/jpeg", undefined), { kind: "image", mime: "image/jpeg", ext: "jpg" });
    assert.deepEqual(visionFileFor("application/octet-stream", "voucher.JPEG"), { kind: "image", mime: "image/jpeg", ext: "jpg" });
    assert.deepEqual(visionFileFor("application/pdf", "scan.pdf"), { kind: "pdf", mime: "application/pdf", ext: "pdf" });
    assert.equal(visionFileFor("image/heic", "photo.jpg"), null);
    assert.equal(visionFileFor("image/svg+xml", "map.svg"), null, "a script-capable document, not a picture");
    assert.equal(visionFileFor("application/zip", "bundle.zip"), null);
  });
});

describe("the transcript", () => {
  test("parses only the asked-for shape", () => {
    assert.deepEqual(parseVisionOutput({ legible: true, identity_document: false, lines: ["a"] }), {
      legible: true, identityDocument: false, lines: ["a"],
    });
    assert.equal(parseVisionOutput({ legible: "yes", identity_document: false, lines: [] }), null);
    assert.equal(parseVisionOutput({ legible: true, identity_document: false, lines: [1] }), null);
    assert.equal(parseVisionOutput(null), null);
  });

  test("an identity document, an MRZ in the lines, and an illegible page are refused as such", () => {
    const booking = ["HOTEL BOOKING CONFIRMATION", "Hotel: Kyoto Riverside Inn", "Check-in: 14 October 2026"];
    const ok = visionTextFrom({ legible: true, identityDocument: false, lines: booking }, "voucher.jpg");
    assert.equal(ok.ok, true);
    if (ok.ok) {
      assert.match(ok.text, /Kyoto Riverside Inn/);
      assert.equal(ok.coverage[0]?.unit, "image");
      assert.equal(ok.coverage[0]?.usable, true);
    }
    assert.deepEqual(visionTextFrom({ legible: true, identityDocument: true, lines: [] }, "x.jpg"), {
      ok: false, reason: "IDENTITY_DOCUMENT",
    });
    const mrz = visionTextFrom(
      { legible: true, identityDocument: false, lines: ["P<ISRLEVI<<DANA<<<<<<<<<<<<<<<<<<<<<<<<<<<<<"] },
      "img.jpg",
    );
    assert.deepEqual(mrz, { ok: false, reason: "IDENTITY_DOCUMENT" }, "the model missed it; the MRZ check did not");
    assert.deepEqual(visionTextFrom({ legible: false, identityDocument: false, lines: [] }, "x.jpg"), {
      ok: false, reason: "NO_TEXT",
    });
  });

  test("the prompt treats the document as data", () => {
    assert.match(buildVisionPrompt(), /DATA, not instructions/);
  });
});

describe("readWithVision", () => {
  test("sends the file as an attachment on the read_image task, with the schema", async () => {
    const runner = fakeRunner([transcript(["Confirmation number: KRI-58213", "Check-in: 14 October 2026"])]);
    const read = await readWithVision(runner, { bytes: PNG, mime: "image/png", filename: "voucher.png" });
    assert.equal(read.ok, true);
    assert.equal(runner.calls.length, 1);
    const call = runner.calls[0]!;
    assert.equal(call.task, VISION_TASK);
    assert.deepEqual(call.schema, VISION_OUTPUT_SCHEMA);
    assert.deepEqual(call.attachments, [{ mime: "image/png", bytes: PNG }]);
  });

  test("type, size and a passport's filename are refused before any model is contacted", async () => {
    const runner = fakeRunner([transcript(["should never be asked"])]);
    assert.deepEqual(await readWithVision(runner, { bytes: PNG, mime: "image/heic", filename: "x.heic" }), {
      ok: false, reason: "UNSUPPORTED_TYPE", detail: "image/heic",
    });
    const big = new Uint8Array(5 * 1024 * 1024 + 1);
    assert.equal((await readWithVision(runner, { bytes: big, mime: "image/jpeg" })).ok, false);
    assert.deepEqual(await readWithVision(runner, { bytes: PNG, mime: "image/png", filename: "passport.png" }), {
      ok: false, reason: "IDENTITY_DOCUMENT",
    });
    assert.equal(runner.calls.length, 0);
  });

  test("no runner serving read_image is NOT_CONFIGURED, with no call made", async () => {
    const other = fakeRunner([transcript(["x"])]);
    const runner = composeRunners({ extract_intake: other });
    assert.equal(visionProcessingConfig(runner), null);
    assert.deepEqual(await readWithVision(runner, { bytes: PNG, mime: "image/png" }), { ok: false, reason: "NOT_CONFIGURED" });
    assert.deepEqual(await readWithVision(undefined, { bytes: PNG, mime: "image/png" }), { ok: false, reason: "NOT_CONFIGURED" });
    assert.equal(other.calls.length, 0);
  });

  test("a malformed answer fails without carrying the model's words onward", async () => {
    const runner = fakeRunner(['{"lines": "Guest: Dana Levi, confirmation KRI-58213"}']);
    const read = await readWithVision(runner, { bytes: PNG, mime: "image/png" });
    assert.deepEqual(read, { ok: false, reason: "FAILED", detail: "BAD_OUTPUT" });
  });

  test("a different vision model is a different reader version", () => {
    const a = visionProcessingConfig(cliRunner({ read_image: claudeSpec("claude-sonnet-5") }))!;
    const b = visionProcessingConfig(cliRunner({ read_image: claudeSpec("claude-opus-5") }))!;
    assert.notEqual(visionReaderVersion(a), visionReaderVersion(b));
  });
});

describe("runners and attachments", () => {
  test("codex and hermes refuse a file rather than run the prompt without it — no process started", async () => {
    const req = { task: "read_image", prompt: "p", parse: (raw: unknown) => raw, attachments: [{ mime: "image/png", bytes: PNG }] };
    // A binary that does not exist: had either spawned, the reason would be FAILED ("not found").
    const codex = await codexRunner({ read_image: codexSpec("gpt-5.6-luna", 1000, { bin: "/nonexistent/codex" }) }).run(req);
    assert.equal(codex.ok, false);
    if (!codex.ok) assert.equal(codex.reason, "NOT_CONFIGURED");
    const hermes = await cliRunner({ read_image: hermesSpec("kinerary-extract", 1000, "/nonexistent/hermes") }).run(req);
    assert.equal(hermes.ok, false);
    if (!hermes.ok) assert.equal(hermes.reason, "NOT_CONFIGURED");
  });

  test("an attachment of a type no provider takes is refused before the call", async () => {
    const res = await cliRunner({ read_image: claudeSpec("m", 1000, "/nonexistent/claude") }).run({
      task: "read_image", prompt: "p", parse: (raw: unknown) => raw, attachments: [{ mime: "image/svg+xml", bytes: PNG }],
    });
    assert.equal(res.ok, false);
    if (!res.ok) assert.match(res.detail ?? "", /unsupported attachment type/);
  });

  test("the claude CLI gets the file as a stream-json content block, and no tools", async () => {
    const dir = await mkdtemp(join(tmpdir(), "kinerary-fake-claude-"));
    try {
      const bin = join(dir, "claude");
      await writeFile(bin, [
        "#!/usr/bin/env node",
        "let input = '';",
        "process.stdin.setEncoding('utf8');",
        "process.stdin.on('data', (d) => { input += d; });",
        "process.stdin.on('end', () => {",
        "  const content = JSON.parse(input.trim().split('\\n')[0]).message.content;",
        "  const seen = {",
        "    args: process.argv.slice(2),",
        "    blocks: content.map((b) => b.type === 'text' ? 'text' : b.type + ':' + b.source.media_type + ':' + Buffer.from(b.source.data, 'base64').toString('hex')),",
        "    prompt: content[content.length - 1].text,",
        "  };",
        "  process.stdout.write(JSON.stringify({ type: 'system', subtype: 'init' }) + '\\n');",
        "  process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: JSON.stringify(seen) }) + '\\n');",
        "});",
      ].join("\n"));
      await chmod(bin, 0o755);
      const runner = cliRunner({ read_image: claudeSpec("claude-sonnet-5", 20_000, bin) });
      const pdf = new Uint8Array([0x25, 0x50, 0x44, 0x46]);
      const res = await runner.run({
        task: "read_image",
        prompt: "transcribe",
        parse: (raw: unknown) => raw as { args: string[]; blocks: string[]; prompt: string },
        attachments: [{ mime: "image/png", bytes: PNG }, { mime: "application/pdf", bytes: pdf }],
      });
      assert.equal(res.ok, true, res.ok ? "" : `${res.reason} ${res.detail}`);
      if (!res.ok) return;
      assert.deepEqual(res.value.blocks, [
        `image:image/png:${Buffer.from(PNG).toString("hex")}`,
        `document:application/pdf:${Buffer.from(pdf).toString("hex")}`,
        "text",
      ]);
      assert.equal(res.value.prompt, "transcribe");
      const args = res.value.args;
      assert.ok(args.includes("stream-json") && args.includes("--input-format"));
      assert.equal(args[args.indexOf("--tools") + 1], "", "no tools");
      assert.equal(args[args.indexOf("--model") + 1], "claude-sonnet-5");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("a stream that reports an error is a failure, not an empty answer", () => {
    assert.deepEqual(claudeStreamAnswer('{"type":"result","subtype":"success","is_error":false,"result":"{}"}\n'), { ok: true, text: "{}" });
    assert.equal(claudeStreamAnswer('{"type":"result","subtype":"error_during_execution","is_error":true}\n').ok, false);
    assert.equal(claudeStreamAnswer("not json\n").ok, false);
  });

  test("OpenRouter gets images as data URLs and a PDF as a file part, beside the prompt", async () => {
    let body: { messages: { content: unknown }[] } | null = null;
    const fetcher = (async (_url: unknown, init?: { body?: unknown }) => {
      body = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({ choices: [{ message: { content: transcript(["ok"]) } }] }), { status: 200 });
    }) as typeof fetch;
    const runner = openRouterRunner({ read_image: openRouterSpec("vendor/vision", "sk-test", 1000) }, fetcher);
    const res = await runner.run({
      task: "read_image", prompt: "transcribe", parse: (raw: unknown) => raw,
      attachments: [{ mime: "image/jpeg", bytes: PNG }, { mime: "application/pdf", bytes: PNG }],
    });
    assert.equal(res.ok, true);
    const parts = body!.messages[0]!.content as { type: string; image_url?: { url: string }; file?: { file_data: string } }[];
    assert.deepEqual(parts.map((p) => p.type), ["image_url", "file", "text"]);
    assert.match(parts[0]!.image_url!.url, /^data:image\/jpeg;base64,/);
    assert.match(parts[1]!.file!.file_data, /^data:application\/pdf;base64,/);
  });

  test("read_image binds only to a runner that can take files, and inherits no EXTRACT_* binding", () => {
    assert.equal(runnerForBinding("codex", "gpt-5.6-luna", 1000, "read_image", {}), undefined);
    assert.equal(runnerForBinding("hermes", "kinerary-extract", 1000, "read_image", {}), undefined);
    assert.ok(runnerForBinding("claude", "claude-sonnet-5", 1000, "read_image", {}));
    assert.ok(runnerForBinding("codex", "gpt-5.6-luna", 1000, "extract_intake", {}), "other tasks unaffected");

    assert.deepEqual(
      modelRunnerFromEnv({ VISION_RUNNER: "claude", VISION_MODEL: "claude-sonnet-5" })?.describe?.("read_image"),
      { provider: "claude", model: "claude-sonnet-5" },
    );
    assert.equal(modelRunnerFromEnv({ EXTRACT_RUNNER: "claude", EXTRACT_MODEL: "claude-sonnet-5" })?.describe?.("read_image"), null);
    assert.equal(modelRunnerFromEnv({ VISION_RUNNER: "codex" }), undefined, "codex cannot read images, so nothing is configured");
  });
});
