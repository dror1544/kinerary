import assert from "node:assert/strict";
import { test } from "node:test";
import { createNotificationAdapter, FakeNotificationAdapter } from "../src/adapters/notification.js";
import { TelegramApiError, TelegramNotificationAdapter } from "../src/adapters/telegram.js";
import { startFakeTelegram, BOT_ID, BOT_TOKEN } from "./support/group-photo-stand-ins.js";

// server.ts decides whether the group photo exists at all with ONE test:
//
//     notification instanceof TelegramNotificationAdapter     (and the web profile's exchange key)
//
// and says `group_photo.disabled` on stderr when it is false. server.ts is a script and cannot be imported, so this pins the two
// facts that decision rests on: the adapter the outbox is given is the Telegram adapter ITSELF (not a wrapper, which would
// switch the feature off in production with every other test green), and the fake adapter is not one.

test("the outbox's notification adapter for `telegram` is the TelegramNotificationAdapter itself", () => {
  // server.ts builds it as validateBeforeProvider(profile, () => createNotificationAdapter(...)), and config.ts's
  // validateBeforeProvider is `validate; return providerFactory()`: the factory's object, unwrapped.
  const made = createNotificationAdapter("telegram", { telegram: { botToken: BOT_TOKEN, superAdminChatId: "1", db: {} as never } });
  assert.ok(made instanceof TelegramNotificationAdapter);
});

test("the fake adapter (messaging: fake) is not one, so a deployment on it gets group_photo.disabled and no poller", () => {
  const made = createNotificationAdapter("fake");
  assert.ok(made instanceof FakeNotificationAdapter);
  assert.equal(made instanceof TelegramNotificationAdapter, false);
});

test("the adapter answers the bot's id once, from getMe, and keeps it only after a success", async () => {
  const telegram = await startFakeTelegram();
  try {
    const adapter = new TelegramNotificationAdapter({ botToken: BOT_TOKEN, superAdminChatId: "1", db: {} as never, apiRoot: telegram.root });
    assert.equal(await adapter.botId(), BOT_ID);
    assert.equal(await adapter.botId(), BOT_ID);
    assert.equal(telegram.count("getMe"), 1, "cached after the first success");
    const wrong = new TelegramNotificationAdapter({ botToken: "999:wrong", superAdminChatId: "1", db: {} as never, apiRoot: telegram.root });
    await assert.rejects(wrong.botId(), (error: unknown) => error instanceof TelegramApiError && error.httpStatus === 401);
    await assert.rejects(wrong.botId());
    assert.equal(telegram.count("getMe"), 1, "a refused token is never asked past the fake's own check, and nothing is cached");
  } finally { await telegram.close(); }
});
