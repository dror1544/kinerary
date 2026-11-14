/**
 * The relay's Hermes-specific assumptions, asserted against ONE fixture
 * captured from a pinned Hermes revision (#380).
 *
 * `test/fixtures/hermes-mirror.json` is written by
 * `scripts/capture-hermes-mirror.py` from Hermes SOURCE (never by running
 * Hermes). Before this file the same knowledge was copied by hand into six
 * places and each copy said "if Hermes changes, change the mirror" - a promise
 * nothing enforced, so a Hermes upgrade could change companion behaviour with
 * every test green. Now a moved revision, or a recapture whose wording or
 * classifier changed, fails HERE and says which assumption broke.
 *
 * This is a tripwire, not an import: the relay's runtime code does not read the
 * fixture. Hermes stays a black box at runtime.
 *
 * One test per acceptance criterion of docs/specs/sprint-8/380-hermes-mirror-fixture.md.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";
import { WebSocket } from "ws";
import { GATEWAY_TIMEOUT_ERROR, RelayConnector } from "../src/relay/connector.js";
import { detectInternalLeak } from "../src/relay/internal-leak.js";
import {
  CONTRACT_VERSION,
  makeUpgradeToken,
  parseOutboundAction,
  TELEGRAM_DESCRIPTOR,
} from "../src/relay/protocol.js";
import { REQUEST_TIMEOUT_MS, RETRY_AFTER_CAP_SECONDS } from "../src/relay/telegram-api.js";
import type { ChatInfo, SendResult } from "../src/relay/telegram-api.js";
import {
  BASE_REV_FILE,
  CAPTURE_COMMAND,
  hermesIsRetryable,
  hermesIsTimeout,
  hermesMirror as mirror,
  renderTemplate,
  revisionMismatch,
  type HermesMirror,
} from "./support/hermes-mirror.js";

const SECRET = "mirror-test-secret";

/** Records what the connector asked Telegram to do. Same shape as relay-connector.test.ts' double. */
class FakeTelegram {
  readonly sent: { chatId: string; text: string; replyTo?: string }[] = [];
  async sendMessage(p: { chatId: string; text: string; replyTo?: string }): Promise<SendResult> {
    this.sent.push(p);
    return { ok: true, messageId: "555" };
  }
  async editMessageText(): Promise<SendResult> {
    return { ok: true };
  }
  async sendChatAction(): Promise<void> {}
  async answerCallbackQuery(): Promise<void> {}
  async getChatInfo(): Promise<ChatInfo | null> {
    return { name: "Japan Trip", type: "group" };
  }
  async getUpdates(): Promise<unknown[]> {
    return [];
  }
  async deleteWebhookIfPresent(): Promise<void> {}
}

/** One outbound frame, sent the way the gateway sends it (`json.dumps(frame) + "\n"`). */
async function outbound(frame: Record<string, unknown>): Promise<{ result: Record<string, unknown> | null; telegram: FakeTelegram }> {
  const telegram = new FakeTelegram();
  const connector = new RelayConnector({ gatewaySecrets: [SECRET], telegram: telegram as never, port: 0 });
  await connector.listen();
  const port = connector.address;
  assert.ok(port, "connector should have bound a port");
  const ws = new WebSocket(`ws://127.0.0.1:${port}/relay`, {
    headers: { authorization: `Bearer ${makeUpgradeToken("gw_1", SECRET, 300)}` },
  });
  const frames: Record<string, unknown>[] = [];
  ws.on("message", (raw) => {
    for (const line of String(raw).split("\n")) if (line.trim()) frames.push(JSON.parse(line));
  });
  try {
    await new Promise<void>((resolve, reject) => {
      ws.once("open", () => resolve());
      ws.once("error", reject);
    });
    ws.send(JSON.stringify({ type: "outbound", requestId: "req_1", ...frame }) + "\n");
    const deadline = Date.now() + 2000;
    for (;;) {
      const found = frames.find((f) => f.type === "outbound_result");
      if (found) return { result: found.result as Record<string, unknown>, telegram };
      if (Date.now() > deadline) return { result: null, telegram };
      await new Promise((r) => setTimeout(r, 10));
    }
  } finally {
    ws.close();
    await connector.close();
  }
}

describe("the Hermes mirror fixture (#380)", () => {
  test("AC-1: the phrase the relay answers a timed-out send with is a timeout to Hermes, and not retryable; NETWORK is retried", () => {
    // Hermes returns a timeout as-is (the send may have landed); a retryable error is retried with
    // backoff; anything else falls to the plain-text fallback, which RE-SENDS the reply prefixed
    // "(Response formatting failed, plain text:)" - the family would see it twice.
    assert.equal(
      hermesIsTimeout(GATEWAY_TIMEOUT_ERROR),
      true,
      `fixture error_classifier.timeout_substrings ${JSON.stringify(mirror.error_classifier.timeout_substrings)} no longer match connector.ts GATEWAY_TIMEOUT_ERROR "${GATEWAY_TIMEOUT_ERROR}"`,
    );
    assert.equal(
      hermesIsRetryable(GATEWAY_TIMEOUT_ERROR),
      false,
      `fixture error_classifier.retryable_substrings ${JSON.stringify(mirror.error_classifier.retryable_substrings)} now match GATEWAY_TIMEOUT_ERROR "${GATEWAY_TIMEOUT_ERROR}": Hermes would retry a send that may have landed`,
    );
    // Why the phrase: the client's bare word is neither, so Hermes would re-send the reply.
    assert.equal(hermesIsTimeout("TIMEOUT"), false);
    assert.equal(hermesIsRetryable("TIMEOUT"), false);
    // NETWORK is the client's other fixed word, and Hermes retries it.
    assert.equal(hermesIsRetryable("NETWORK"), true, "fixture no longer lists a pattern matching the client's NETWORK");
    assert.equal(hermesIsTimeout("NETWORK"), false);
  });

  test("AC-2: every approval-prompt string and gateway status string in the fixture is caught by detectInternalLeak()", () => {
    // `status_strings` entries that Hermes writes only to its log, never to a chat. Each carries the
    // reason; the test below fails if one is removed from the fixture without being removed here.
    const NOT_CHAT_FACING: Record<string, string> = {
      "agent/prompt_builder.py:_truncate_content:remedy#1":
        "queue_warning=False: 'the truncation is logged with the marker as the only disclosure, never queued for the chat status line'",
    };
    const all: Array<[string, string]> = [
      ...Object.entries(mirror.approval_prompt_strings).map(([k, v]) => [`approval_prompt_strings["${k}"]`, v] as [string, string]),
      ...Object.entries(mirror.status_strings).map(([k, v]) => [`status_strings["${k}"]`, v] as [string, string]),
    ];
    assert.ok(all.length >= 15, `the fixture lost its strings (${all.length} left)`);
    const missed = all
      .filter(([name]) => !Object.keys(NOT_CHAT_FACING).some((k) => name.includes(`"${k}"`)))
      .filter(([, template]) => !detectInternalLeak(renderTemplate(template)).leaks)
      .map(([name, template]) => `${name} = ${JSON.stringify(template)}`);
    assert.deepEqual(
      missed,
      [],
      "Hermes (at the fixture's revision) emits these into a chat and internal-leak.ts does not catch them",
    );
    for (const key of Object.keys(NOT_CHAT_FACING)) {
      assert.ok(key in mirror.status_strings, `NOT_CHAT_FACING names ${key}, which the fixture no longer records: remove it here`);
    }
  });

  test("AC-2: the compaction notice (#65) and the context-file truncation warning (#481) are in the fixture, so they are covered", () => {
    const keys = Object.keys(mirror.status_strings).join("\n");
    assert.match(keys, /_build_codex_gpt5_autoraise_notice/, "the Codex auto-compaction notice (#65) is no longer captured");
    assert.match(keys, /_truncate_content:msg/, "the context-file truncation warning (#481) is no longer captured");
  });

  test("AC-2b: every Hermes config key the companion overlay sets to silence those messages exists in Hermes' config defaults", () => {
    // Hermes ignores an unknown key, so a renamed key silently undoes the fix at the source. The keys
    // are the `display.*`, `context_file_max_chars` and `compression.*` lines of
    // profile-templates/familytrip-companion/templates/config.overlay.yaml.tpl (#481, #65).
    const OVERLAY_KEYS = [
      "display.interim_assistant_messages",
      "display.suppress_warning_notifications",
      "context_file_max_chars",
      "compression.codex_gpt55_autoraise_notice",
    ];
    const overlayFile = new URL("../../../profile-templates/familytrip-companion/templates/config.overlay.yaml.tpl", import.meta.url);
    const lines = readFileSync(overlayFile, "utf8").split("\n");
    const at = new Map<string, number>();
    const stack: Array<{ indent: number; key: string }> = [];
    lines.forEach((line, i) => {
      const m = /^( *)([A-Za-z0-9_$.-]+):(.*)$/.exec(line);
      if (!m || line.trimStart().startsWith("#")) return;
      const indent = m[1]!.length;
      while (stack.length && stack[stack.length - 1]!.indent >= indent) stack.pop();
      stack.push({ indent, key: m[2]! });
      at.set(stack.map((s) => s.key).join("."), i + 1);
    });
    const known = new Set(mirror.config_keys);
    const problems: string[] = [];
    for (const key of OVERLAY_KEYS) {
      const line = at.get(key);
      if (line === undefined) {
        problems.push(`${key}: the overlay no longer sets it - drop it from OVERLAY_KEYS if that is deliberate`);
      } else if (!known.has(key)) {
        problems.push(`${key}: config.overlay.yaml.tpl line ${line} sets a key the fixture's Hermes config defaults do not have (Hermes would ignore it)`);
      }
    }
    assert.deepEqual(problems, []);
  });

  test("AC-3: the worst-case sendMessage is shorter than the gateway's outbound wait", () => {
    // The arithmetic in telegram-api.ts: a connector MarkdownV2 send gets a 429, waits the cap, then a
    // parse error; the plain-text fallback gets a 429, waits the cap, then hangs for the request bound.
    // (Round trips excluded: only the hang is a full bound.) A timed-out attempt is never retried.
    const worstSeconds = 2 * RETRY_AFTER_CAP_SECONDS + REQUEST_TIMEOUT_MS / 1000;
    assert.ok(
      worstSeconds < mirror.outbound_timeout_seconds,
      `worst-case sendMessage ${worstSeconds}s (2 x RETRY_AFTER_CAP_SECONDS=${RETRY_AFTER_CAP_SECONDS} + REQUEST_TIMEOUT_MS=${REQUEST_TIMEOUT_MS}/1000) is not below the gateway's outbound wait outbound_timeout_seconds=${mirror.outbound_timeout_seconds}: Hermes would give up on a send that is still going`,
    );
  });

  test("AC-4: the descriptor advertises only fields and ops the fixture knows, at the fixture's contract version", () => {
    assert.equal(
      CONTRACT_VERSION,
      mirror.relay_contract.contract_version,
      "protocol.ts CONTRACT_VERSION differs from the fixture's: read the contract diff before changing either",
    );
    assert.equal(TELEGRAM_DESCRIPTOR.contract_version, mirror.relay_contract.contract_version);
    const unknownFields = Object.keys(TELEGRAM_DESCRIPTOR).filter((f) => !mirror.relay_contract.descriptor_fields.includes(f));
    assert.deepEqual(unknownFields, [], "TELEGRAM_DESCRIPTOR fields the gateway's CapabilityDescriptor does not have (it drops unknown keys)");
    const unknownOps = (TELEGRAM_DESCRIPTOR.supported_ops ?? []).filter((op) => !mirror.relay_contract.ops.includes(op));
    assert.deepEqual(unknownOps, [], "TELEGRAM_DESCRIPTOR.supported_ops names ops the gateway never sends");
  });

  test("AC-4: every op the gateway can send is answered - parsed, or UNSUPPORTED_OP - never dropped", async () => {
    const advertised = new Set(TELEGRAM_DESCRIPTOR.supported_ops ?? []);
    const dropped: string[] = [];
    const wrong: string[] = [];
    for (const op of mirror.relay_contract.ops) {
      const action = { op, chat_id: "900", content: "hello", message_id: "7" };
      const { result } = await outbound({ action });
      if (!result) {
        dropped.push(op);
        continue;
      }
      const unsupported = result.success === false && result.error === "UNSUPPORTED_OP";
      const parsed = parseOutboundAction(action) !== null;
      if (advertised.has(op) && (unsupported || !parsed)) wrong.push(`${op}: advertised but answered UNSUPPORTED_OP`);
      if (!advertised.has(op) && !unsupported) wrong.push(`${op}: not advertised but handled`);
    }
    assert.deepEqual(dropped, [], "ops that got no outbound_result: the gateway would block until its 30 s wait");
    assert.deepEqual(wrong, []);
  });

  test("AC-4: a frame carrying fields the connector does not use (the routed-profile echo) is accepted unchanged", async () => {
    const plain = await outbound({ action: { op: "send", chat_id: "900", content: "hello" } });
    // Every frame-level field the gateway can add, and every metadata field the gateway stamps, at once.
    const used = new Set(["type", "requestId", "action"]);
    const extraFrame = Object.fromEntries(
      mirror.relay_contract.outbound_frame_fields.filter((f) => !used.has(f)).map((f) => [f, f === "platform" ? "telegram" : `${f}-value`]),
    );
    const metadata = Object.fromEntries(mirror.relay_contract.outbound_metadata_fields.map((f) => [f, `${f}-value`]));
    assert.ok(Object.keys(metadata).includes("profile"), "the fixture no longer lists the routed profile among outbound metadata");
    const echoed = await outbound({ ...extraFrame, action: { op: "send", chat_id: "900", content: "hello", metadata } });
    assert.deepEqual(echoed.result, plain.result);
    assert.deepEqual(echoed.telegram.sent, plain.telegram.sent, "the extra fields changed what reached Telegram");
  });

  test("AC-5: the fixture describes the revision the patch set is based on (hermes-patches/BASE_REV)", () => {
    const base = readFileSync(BASE_REV_FILE, "utf8");
    assert.equal(revisionMismatch(mirror.revision, base), null);
  });

  test("AC-5: a moved revision fails, naming both revisions and the capture command", () => {
    const message = revisionMismatch("4097709b0c", "5aa0000000");
    assert.ok(message, "a mismatch must be reported");
    assert.match(message, /4097709b0c/);
    assert.match(message, /5aa0000000/);
    assert.match(message, /capture-hermes-mirror\.py/);
    assert.equal(revisionMismatch("", "5aa0000000") !== null, true, "an empty fixture revision is a mismatch, not a match");
    assert.equal(revisionMismatch("4097709b0c\n", "4097709b0c") , null, "a trailing newline in BASE_REV is not a difference");
  });

  test("the fixture's own structure is whole, so an empty section cannot pass a test vacuously", () => {
    const m: HermesMirror = mirror;
    assert.equal(m.schema, 1);
    assert.match(m.revision, /^[0-9a-f]{10}$/);
    assert.ok(m.error_classifier.timeout_substrings.length > 0);
    assert.ok(m.error_classifier.retryable_substrings.length > 0);
    assert.ok(m.outbound_timeout_seconds > 0);
    assert.ok(Object.keys(m.approval_prompt_strings).length > 0);
    assert.ok(Object.keys(m.status_strings).length > 0);
    assert.ok(m.relay_contract.ops.includes("send") && m.relay_contract.ops.includes("edit"));
    assert.ok(m.relay_contract.descriptor_fields.includes("supported_ops"));
    assert.ok(Object.keys(m.source_files).length > 0);
    assert.ok(m.config_keys.length > 100);
    assert.match(CAPTURE_COMMAND, /capture-hermes-mirror\.py/);
  });
});
