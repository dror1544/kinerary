import assert from "node:assert/strict";
import { describe, mock, test } from "node:test";
import { TelegramNotificationAdapter } from "../src/adapters/telegram.js";
import { architectureProfileSchema, validateArchitectureProfile } from "../src/config.js";
import { chatForOutboxRow, isOperatorNotice, resolveOperatorNoticesChatId } from "../src/operator-chats.js";
import { dispatchUpdate } from "../src/relay/dispatch.js";

// Issue #649: operator build notices must not land in the owner's own chat with the bot.
// Deployment ids are not named here (hard rule 6): these are arbitrary stand-ins.
const SUPER_ADMIN = "1111";
const OPS_GROUP = "-1009999";

describe("which chat an outbox row is sent to", () => {
  const row = (notification_type: string, recipient: string | null = SUPER_ADMIN) => ({ notification_type, recipient });

  test("every operator_* notice goes to the ops chat when one is set, including the ones the worker queues", () => {
    for (const type of ["operator_provisioning_approved", "operator_provisioning_complete", "operator_provisioning_failed"]) {
      assert.equal(chatForOutboxRow(row(type), OPS_GROUP), OPS_GROUP, type);
    }
  });

  test("unset: an operator notice goes where the row says, the super admin, exactly as before", () => {
    assert.equal(chatForOutboxRow(row("operator_provisioning_complete"), undefined), SUPER_ADMIN);
    assert.equal(chatForOutboxRow(row("operator_provisioning_complete"), ""), SUPER_ADMIN);
  });

  test("a notice meant for an organizer is never redirected to the ops chat", () => {
    for (const type of ["provisioning_complete", "provisioning_failed", "companion_ready", "trip_plan_changed"]) {
      assert.equal(isOperatorNotice(type), false, type);
      assert.equal(chatForOutboxRow(row(type, "7777"), OPS_GROUP), "7777", type);
    }
  });

  test("a row with no recipient stays unsendable even when an ops chat is set", () => {
    assert.equal(chatForOutboxRow(row("operator_provisioning_complete", null), OPS_GROUP), null);
  });
});

describe("resolving the setting", () => {
  const resolver = (map: Record<string, string>) => async (ref: string) => {
    if (!(ref in map)) throw new Error(`secret reference ${ref} is unset or empty`);
    return map[ref]!;
  };

  test("not named: undefined, nothing resolved", async () => {
    let calls = 0;
    const out = await resolveOperatorNoticesChatId({}, SUPER_ADMIN, () => {}, async () => { calls++; return "x"; });
    assert.equal(out, undefined);
    assert.equal(calls, 0);
  });

  test("named: the resolved value, trimmed, negative group id intact", async () => {
    const out = await resolveOperatorNoticesChatId(
      { operator_notices_chat_id_secret_ref: "env://OPS" }, SUPER_ADMIN, () => {}, resolver({ "env://OPS": ` ${OPS_GROUP}\n` }),
    );
    assert.equal(out, OPS_GROUP);
  });

  test("named but unresolvable: throws, so a misconfigured ops chat is never a silent fallback to the private chat", async () => {
    await assert.rejects(
      resolveOperatorNoticesChatId({ operator_notices_chat_id_secret_ref: "env://OPS" }, SUPER_ADMIN, () => {}, resolver({})),
      /unset or empty/,
    );
  });

  test("the same chat as the super admin is refused loudly and treated as unset", async () => {
    const lines: string[] = [];
    const out = await resolveOperatorNoticesChatId(
      { operator_notices_chat_id_secret_ref: "env://OPS" }, SUPER_ADMIN, (l) => lines.push(l), resolver({ "env://OPS": SUPER_ADMIN }),
    );
    assert.equal(out, undefined);
    assert.match(lines.join("\n"), /operator_notices\.same_as_super_admin/);
    assert.doesNotMatch(lines.join("\n"), new RegExp(SUPER_ADMIN));
  });
});

describe("the profile schema", () => {
  const signup = {
    telegram_bot_token_secret_ref: "env://A",
    super_admin_subject_digest: `sha256:${"0".repeat(64)}`,
    super_admin_chat_id_secret_ref: "env://B",
    action_secret_ref: "env://C",
    webhook_secret_ref: "env://D",
  };
  const profile = (extra: Record<string, unknown>) => ({
    version: 1,
    environment: "test",
    public_api: { bind_host: "127.0.0.1", port: 4301 },
    worker: { queue: "postgres", health_bind_host: "127.0.0.1", health_port: 4302 },
    database: { connection_secret_ref: "env://CONTROL_PLANE_DATABASE_URL" },
    adapters: { compute: "fake", ingress: "fake", agent_runtime: "fake", messaging: "telegram", secrets: "fake" },
    test_resources: { enabled: true, label_key: "kinerary.test_run_id", allowed_name_prefix: "kinerary-test-local" },
    signup: { ...signup, ...extra },
  });

  test("operator_notices_chat_id_secret_ref is optional and takes a secret reference", () => {
    assert.doesNotThrow(() => validateArchitectureProfile(profile({})));
    const parsed = validateArchitectureProfile(profile({ operator_notices_chat_id_secret_ref: "env://CONTROL_PLANE_OPERATOR_CHAT_ID" }));
    assert.equal(parsed.signup?.operator_notices_chat_id_secret_ref, "env://CONTROL_PLANE_OPERATOR_CHAT_ID");
  });

  test("a literal chat id is not a secret reference", () => {
    assert.doesNotThrow(() => architectureProfileSchema.parse(profile({})), "the control profile is valid, so the next failure is the literal's");
    assert.throws(
      () => architectureProfileSchema.parse(profile({ operator_notices_chat_id_secret_ref: OPS_GROUP })),
      /operator_notices_chat_id_secret_ref|opaque env/,
    );
  });
});

describe("the Telegram adapter on both chats", () => {
  function fakeBotApi() {
    const calls: Array<{ body: Record<string, unknown> }> = [];
    mock.method(globalThis, "fetch", async (_url: string, init?: RequestInit) => {
      calls.push({ body: JSON.parse(String(init?.body)) });
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    });
    return calls;
  }

  test("with an ops chat configured, the approval request still goes to super_admin_chat_id, with its buttons", async () => {
    // server.ts builds the adapter from the super-admin id only; the ops chat is a separate value
    // that the adapter never receives. This pins the adapter side of that split.
    const calls = fakeBotApi();
    try {
      const ops = await resolveOperatorNoticesChatId(
        { operator_notices_chat_id_secret_ref: "env://OPS" }, SUPER_ADMIN, () => {}, async () => OPS_GROUP,
      );
      assert.equal(ops, OPS_GROUP);
      const db = { query: async () => ({ rows: [] }) };
      const adapter = new TelegramNotificationAdapter({ botToken: "bot-token", superAdminChatId: SUPER_ADMIN, db: db as never });
      await adapter.sendApprovalRequest({
        requestId: "sreq_1", displayName: "Dana", tripNameRequest: "Rome", approveToken: "a", rejectToken: "r",
        expiresAt: new Date(Date.now() + 60_000),
      });
      assert.equal(calls.length, 1);
      assert.equal(calls[0]!.body.chat_id, SUPER_ADMIN);
      assert.ok((calls[0]!.body.reply_markup as { inline_keyboard: unknown[] }).inline_keyboard.length > 0);
    } finally {
      mock.restoreAll();
    }
  });

  test("a notice sent to a negative group id reaches the Bot API as that same string", async () => {
    const calls = fakeBotApi();
    try {
      const adapter = new TelegramNotificationAdapter({ botToken: "bot-token", superAdminChatId: SUPER_ADMIN, db: {} as never });
      await adapter.sendMessage({ chatId: OPS_GROUP, text: "hello" });
      assert.equal(calls[0]!.body.chat_id, OPS_GROUP);
    } finally {
      mock.restoreAll();
    }
  });
});

describe("the relay stays silent in the ops chat", () => {
  // A pool that throws on any use: an ignored update must not even look anything up.
  const noDb = new Proxy({}, { get() { throw new Error("the relay touched the database for an ops-chat update"); } }) as never;
  const group = { id: Number(OPS_GROUP), type: "supergroup" };
  const from = { id: 777, is_bot: false, first_name: "Dror" };
  const botId = "8463178587";
  const updates: Record<string, unknown> = {
    "the bot being added to the group": {
      update_id: 1,
      my_chat_member: {
        chat: group, from,
        old_chat_member: { user: { id: Number(botId), is_bot: true }, status: "left" },
        new_chat_member: { user: { id: Number(botId), is_bot: true }, status: "member" },
      },
    },
    "a command (which an unbound chat would answer with the unbound text)": { update_id: 2, message: { message_id: 1, chat: group, from, text: "/name Rio" } },
    "plain text": { update_id: 3, message: { message_id: 2, chat: group, from, text: "hello everyone" } },
    "an @mention of the bot": { update_id: 4, message: { message_id: 3, chat: group, from, text: "@Kinerary_bot status?" } },
    "an edited message": { update_id: 5, edited_message: { message_id: 3, chat: group, from, text: "edited" } },
    "a button tap": { update_id: 6, callback_query: { id: "cq1", from, data: "anything", message: { message_id: 4, chat: group } } },
    "a supergroup migration notice": { update_id: 7, message: { message_id: 5, chat: group, from, migrate_to_chat_id: -1008888 } },
  };

  for (const [name, update] of Object.entries(updates)) {
    test(`ignores ${name}: no reply, no lookup, one debug line without the id`, async () => {
      const lines: string[] = [];
      const decision = await dispatchUpdate(noDb, update as never, undefined, (l) => lines.push(l), { id: botId, username: "Kinerary_bot" }, { opsChatId: OPS_GROUP });
      assert.equal(decision.kind, "ignore");
      assert.equal(decision.kind === "ignore" && decision.reason, "OPS_CHAT");
      assert.equal(lines.length, 1);
      assert.match(lines[0]!, /"level":"debug"/);
      assert.match(lines[0]!, /relay\.ops_chat_ignored/);
      assert.doesNotMatch(lines[0]!, /9999/);
    });
  }
});
