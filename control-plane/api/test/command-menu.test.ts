import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { publishCommandMenu, routerCommandMenus } from "../src/relay/command-menu.js";
import type { TelegramClient } from "../src/relay/telegram-api.js";

// What the router answers itself (relay/dispatch.ts). Anything else a menu
// offers is a command the command gate refuses.
const ROUTER_COMMANDS = new Set(["help", "name", "group"]);

describe("routerCommandMenus — the menu is the router's, not Hermes's", () => {
  test("every advertised command is one the router handles", () => {
    for (const menu of routerCommandMenus()) {
      for (const { command } of menu.commands) {
        assert.ok(ROUTER_COMMANDS.has(command), `${menu.scope}/${menu.languageCode ?? "-"} offers /${command}`);
      }
    }
  });

  test("/name is offered everywhere; /group only outside groups", () => {
    for (const menu of routerCommandMenus()) {
      const names = menu.commands.map((c) => c.command);
      assert.ok(names.includes("name"), `${menu.scope} lacks /name`);
      assert.equal(names.includes("group"), menu.scope !== "all_group_chats", `${menu.scope} /group placement`);
    }
  });

  test("each language replaces all three scopes, so no older list outranks ours", () => {
    for (const lang of [undefined, "en", "he"]) {
      const scopes = routerCommandMenus().filter((m) => m.languageCode === lang).map((m) => m.scope).sort();
      assert.deepEqual(scopes, ["all_group_chats", "all_private_chats", "default"], `language ${lang ?? "-"}`);
    }
  });

  test("commands and descriptions fit Telegram's limits", () => {
    for (const menu of routerCommandMenus()) {
      for (const { command, description } of menu.commands) {
        assert.match(command, /^[a-z0-9_]{1,32}$/);
        assert.ok(description.length >= 1 && description.length <= 256);
      }
    }
  });
});

function fakeTelegram(setMyCommands?: TelegramClient["setMyCommands"]): TelegramClient {
  return { setMyCommands } as unknown as TelegramClient;
}

describe("publishCommandMenu", () => {
  test("publishes every menu with a scope object and no blank language_code", async () => {
    const calls: Parameters<NonNullable<TelegramClient["setMyCommands"]>>[0][] = [];
    const ok = await publishCommandMenu(fakeTelegram(async (params) => { calls.push(params); return true; }));
    assert.equal(ok, true);
    assert.equal(calls.length, routerCommandMenus().length);
    assert.ok(calls.every((c) => typeof c.scope?.type === "string"));
    assert.ok(calls.every((c) => c.languageCode === undefined || c.languageCode.length > 0));
  });

  test("a refused or thrown call is counted, never thrown", async () => {
    let n = 0;
    const lines: string[] = [];
    const ok = await publishCommandMenu(fakeTelegram(async () => {
      n += 1;
      if (n === 2) throw new Error("network");
      return n !== 3;
    }), (line) => lines.push(line));
    assert.equal(ok, false);
    assert.equal(n, routerCommandMenus().length, "a failure does not stop the rest");
    assert.match(lines.join("\n"), /"failed":2/);
  });

  test("a client that cannot set menus is a no-op", async () => {
    assert.equal(await publishCommandMenu(fakeTelegram()), false);
  });
});
