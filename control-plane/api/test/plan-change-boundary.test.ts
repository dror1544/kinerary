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

describe("the poller sends the control-plane key to the runtime gateway and nowhere else (K2, AC-K2.11)", () => {
  test("it builds no trip-site URL: the only address it requests is runtimeOrigin, and it never follows a redirect", () => {
    const poller = src("plan-change-poller.ts");
    const code = poller.split("\n").filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line)).join("\n");
    // Exactly one place builds a URL, and it starts at deps.runtimeOrigin.
    assert.deepEqual(code.match(/const url = .*/g), ['const url = `${deps.runtimeOrigin.replace(/\\/$/, "")}/internal/t/${encodeURIComponent(tripId)}${ROUTE}${since ? `?since=${encodeURIComponent(since)}` : ""}`;']);
    assert.equal((code.match(/fetchImpl\(/g) ?? []).length, 1, "one outbound call per trip");
    // The start-up readiness probe is the only other one: GET <runtimeOrigin>/health, sent with no key and no headers.
    const probes = code.match(/\(deps\.fetchImpl \?\? fetch\)\(.*/g) ?? [];
    assert.equal(probes.length, 1, "one readiness probe");
    assert.match(probes[0]!, /^\(deps\.fetchImpl \?\? fetch\)\(`\$\{deps\.runtimeOrigin\.replace\(\/\\\/\$\/, ""\)\}\/health`, \{$/);
    assert.ok(!/fetch\(/.test(code.replace(/\(deps\.fetchImpl \?\? fetch\)\(/g, "").replace(/fetchImpl\(/g, "")), "no other call to fetch");
    assert.match(code, /redirect: "manual"/);
    assert.ok(!/upstreamOrigin|upstreamBasePath|private_url|api\/internal\/control-plane/.test(code), "no trip-site address or route is built here");
  });

  test("runtimeUpstreamFor is a readiness check only: its origin is never read, and the gateway route uses the same lookup", () => {
    const poller = src("plan-change-poller.ts");
    assert.match(poller, /runtimeUpstreamFor\(db, tripId, deps\.upstreamHostSuffixes, deps\.upstreamAllowedHosts\)/);
    assert.ok(!/ready\.(upstream|routeRef|tripKey)/.test(poller));
    assert.match(src("portal.ts"), /runtimeUpstreamFor\(deps\.db, tripId, deps\.runtimeUpstreamHostSuffixes, deps\.runtimeUpstreamAllowedHosts\)/);
  });

  test("server.ts hands the poller the portal's runtimeOrigin", () => {
    assert.match(src("server.ts"), /startPlanChangePoller\(\{[^}]*runtimeOrigin: portal\.runtimeOrigin/s);
  });

  test("a failure line names the trip and a code, and never the address or the key", () => {
    const poller = src("plan-change-poller.ts");
    for (const line of poller.split("\n").filter((l) => l.includes("structuredLog"))) {
      assert.ok(!/origin|url|exchangeKey|apiKey/i.test(line), line);
    }
  });
});
