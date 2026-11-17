import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";

// Video Release 1C, AC-29 and the boundary notes (docs/specs/sprint-9/x-video-r1-group-line.md): the group line is its
// own path. It neither uses nor widens the relay, nothing outside the control plane can create a targeted outbox row,
// and no module of it can be handed a chat id. Source-level pins, because these are properties of what is imported and
// what is written, not of any one run.
const src = (name: string) => readFileSync(fileURLToPath(new URL(`../src/${name}`, import.meta.url)), "utf8");
const NEW_MODULES = ["plan-change-poller.ts", "plan-change-line.ts", "trip-audience.ts", "runtime-upstream.ts"];

describe("the group line stays out of the relay (AC-29)", () => {
  test("none of its modules imports from relay/ or names a relay connector", () => {
    for (const name of NEW_MODULES) {
      const source = src(name);
      assert.ok(!/from\s+["']\.\/relay\//.test(source), `${name} imports from relay/`);
      assert.ok(!/RelayConnector|HttpTelegramClient|connector\./.test(source), `${name} names a relay type`);
    }
  });

  test("the outbox dispatcher still does not import the relay, and the one relay import in server.ts is the root validator", () => {
    assert.ok(!/relay\//.test(src("outbox-dispatcher.ts")));
    const imports = src("server.ts").split("\n").filter((line) => /from\s+["']\.\/relay\//.test(line));
    assert.deepEqual(imports, ['import { telegramApiRoot } from "./relay/telegram-api.js";']);
  });
});

describe("no chat id is an input to a targeted row", () => {
  test("enqueueTripMessage's input has no chat id, and writes recipient NULL", () => {
    const source = src("trip-audience.ts");
    const input = source.slice(source.indexOf("export interface EnqueueTripMessageInput"), source.indexOf("/**", source.indexOf("export interface EnqueueTripMessageInput")));
    assert.ok(!/chat/i.test(input), input);
    assert.match(source, /VALUES \(\$1, \$2, \$3, NULL, \$4::jsonb, NULL, \$3, 'control-plane', 'pending', \$5, \$6, \$7\)/);
  });

  test("only the poller enqueues a targeted message: no route, tool or other module calls enqueueTripMessage", () => {
    const callers = readdirSync(fileURLToPath(new URL("../src/", import.meta.url)), { recursive: true, encoding: "utf8" })
      .filter((file) => file.endsWith(".ts") && file !== "trip-audience.ts")
      .filter((file) => /\benqueueTripMessage\s*\(/.test(src(file)));
    assert.deepEqual(callers, ["plan-change-poller.ts"]);
  });

  test("the dispatcher's targeted path reads the chat from confirmAudience, never from row.recipient", () => {
    const source = src("outbox-dispatcher.ts");
    const targeted = source.slice(source.indexOf("async function dispatchTargetedRow"));
    assert.ok(!/\.recipient/.test(targeted), "dispatchTargetedRow reads recipient");
    assert.match(targeted, /chatId: audience\.chatId/);
  });
});

describe("the poller sends the key only where the gateway's allow-list says", () => {
  test("it finds the site through runtimeUpstreamFor, the one lookup the gateway route also uses, and never follows a redirect", () => {
    const poller = src("plan-change-poller.ts");
    assert.match(poller, /runtimeUpstreamFor\(db, tripId, deps\.upstreamHostSuffixes\)/);
    assert.match(poller, /redirect: "manual"/);
    assert.match(src("portal.ts"), /runtimeUpstreamFor\(deps\.db, tripId, deps\.runtimeUpstreamHostSuffixes\)/);
  });

  test("a failure line names the trip and a code, and never the address or the key", () => {
    const poller = src("plan-change-poller.ts");
    for (const line of poller.split("\n").filter((l) => l.includes("structuredLog"))) {
      assert.ok(!/origin|url|exchangeKey|apiKey/i.test(line), line);
    }
  });
});
