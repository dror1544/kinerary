import assert from "node:assert/strict";
import { createServer } from "node:http";
import net from "node:net";
import { test } from "node:test";
import { checkGatewayReachable, readCapped, startPlanChangePoller } from "../src/plan-change-poller.js";

// The group line's one dependency, said out loud at start (docs/specs/sprint-9/597-per-gateway-and-per-trip-keys.md,
// AC-K2.13): the poller asks the runtime gateway's GET /health, with no key, retrying at start, and a gateway that never
// answers is ONE warn line with a code and the consequence. No database: nothing here reads a trip.

const KEY = "readiness-test-exchange-key";
const parse = (lines: string[]) => lines.map((line) => JSON.parse(line));
const unreachable = "plan_change_poll.gateway_unreachable";
// The retry wait is unref'd on purpose (it must never keep the API process alive); a test with nothing else open
// holds the event loop itself while it waits.
async function holdingLoop<T>(run: () => Promise<T>): Promise<T> {
  const hold = setInterval(() => {}, 1_000);
  try { return await run(); } finally { clearInterval(hold); }
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => { const { port } = probe.address() as net.AddressInfo; probe.close(() => resolve(port)); });
  });
}

async function withGateway<T>(status: number, run: (origin: string, requests: Array<{ url: string; headers: Record<string, unknown> }>) => Promise<T>): Promise<T> {
  const requests: Array<{ url: string; headers: Record<string, unknown> }> = [];
  const server = createServer((req, res) => {
    requests.push({ url: req.url ?? "", headers: { ...req.headers } });
    res.writeHead(status, { "content-type": "application/json" });
    res.end('{"ok":true}');
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  try { return await run(`http://127.0.0.1:${(server.address() as net.AddressInfo).port}`, requests); }
  finally { await new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }); }
}

test("AC-K2.13: a gateway that answers /health is silent, and is asked with no key", async () => {
  await withGateway(200, async (origin, requests) => {
    const logs: string[] = [];
    assert.equal(await checkGatewayReachable({ runtimeOrigin: `${origin}/`, log: (line) => logs.push(line) }), true);
    assert.deepEqual(logs, []);
    assert.equal(requests.length, 1);
    assert.equal(requests[0]!.url, "/health");
    assert.equal(requests[0]!.headers["x-api-key"], undefined, "the control-plane key is not sent to a route that needs none");
    assert.equal(requests[0]!.headers.authorization, undefined);
  });
});

test("AC-K2.13: a gateway that is not listening is one warn line: a reason code and the consequence, no address, no key", async () => {
  const origin = `http://127.0.0.1:${await freePort()}`;
  const logs: string[] = [];
  assert.equal(await checkGatewayReachable({ runtimeOrigin: origin, log: (line) => logs.push(line) }), false);
  const lines = parse(logs);
  assert.equal(lines.length, 1);
  assert.equal(lines[0].level, "warn");
  assert.equal(lines[0].event, unreachable);
  assert.equal(lines[0].safe_error_code, "GATEWAY_UNREACHABLE");
  assert.equal(lines[0].consequence, "the group line cannot reach any trip until the runtime gateway answers");
  const text = logs.join("\n");
  assert.ok(!text.includes(origin) && !text.includes("127.0.0.1") && !text.includes(KEY), "no address and no key in the line");
});

test("AC-K2.13: a gateway that answers /health with an error status is the same line with that status as the code", async () => {
  await withGateway(503, async (origin) => {
    const logs: string[] = [];
    assert.equal(await checkGatewayReachable({ runtimeOrigin: origin, log: (line) => logs.push(line) }), false);
    assert.equal(parse(logs)[0].safe_error_code, "GATEWAY_HTTP_503");
    assert.ok(!logs.join("\n").includes("127.0.0.1"));
  });
});

test("AC-K2.13: a gateway that never answers is a timeout code, and the check says so instead of hanging", async () => {
  const logs: string[] = [];
  const hang = ((_url: string | URL | Request, init?: RequestInit) => new Promise((_resolve, reject) => {
    init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
  })) as typeof fetch;
  const started = Date.now();
  const keepAlive = setInterval(() => {}, 100); // AbortSignal.timeout's timer is unref'd, and nothing else here holds the loop open
  try {
    assert.equal(await checkGatewayReachable({ runtimeOrigin: "http://gateway.invalid", fetchImpl: hang, log: (line) => logs.push(line) }), false);
  } finally { clearInterval(keepAlive); }
  assert.ok(Date.now() - started < 10_000, "bounded by a short timeout");
  assert.equal(parse(logs)[0].safe_error_code, "GATEWAY_TIMEOUT");
  assert.ok(!logs.join("\n").includes("gateway.invalid"));
});

test("AC-K2.13: starting the poller retries the check in the background, says so once when every try fails, and stopping it leaves nothing running", async () => {
  const origin = `http://127.0.0.1:${await freePort()}`;
  const logs: string[] = [];
  const calls: string[] = [];
  const spy = ((input: string | URL | Request, init?: RequestInit) => { calls.push(String(input)); return fetch(input, init); }) as typeof fetch;
  // db is never reached: the interval is far longer than this test.
  const stop = startPlanChangePoller({
    db: {} as never, exchangeKey: KEY, runtimeOrigin: origin, upstreamHostSuffixes: [], fetchImpl: spy, log: (line) => logs.push(line),
  }, 60 * 60_000, { attempts: 3, retryMs: 20 });
  try {
    const deadline = Date.now() + 5_000;
    while (!logs.length && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
    assert.deepEqual(calls, [`${origin}/health`, `${origin}/health`, `${origin}/health`], "one request per try, to /health only");
    assert.equal(parse(logs).filter((entry) => entry.event === unreachable).length, 1);
    assert.ok(!logs.join("\n").includes(origin) && !logs.join("\n").includes(KEY));
  } finally { stop(); }
});

test("AC-K2.13: a gateway that comes up while the poller is still trying is not reported (a normal cold start)", async () => {
  const logs: string[] = [];
  let tries = 0;
  const upLater = (async () => {
    tries += 1;
    if (tries < 3) throw new TypeError("fetch failed");
    return new Response("{\"ok\":true}", { status: 200 });
  }) as unknown as typeof fetch;
  assert.equal(await holdingLoop(() => checkGatewayReachable(
    { runtimeOrigin: "http://gateway.invalid", fetchImpl: upLater, log: (line) => logs.push(line) },
    { attempts: 5, retryMs: 1 },
  )), true);
  assert.equal(tries, 3);
  assert.deepEqual(logs, []);
});

test("AC-K2.13: stopping the poller ends the start-up retries without a line", async () => {
  const logs: string[] = [];
  let stopped = false;
  let tries = 0;
  const down = (async () => { tries += 1; stopped = true; throw new TypeError("fetch failed"); }) as unknown as typeof fetch;
  assert.equal(await holdingLoop(() => checkGatewayReachable(
    { runtimeOrigin: "http://gateway.invalid", fetchImpl: down, log: (line) => logs.push(line) },
    { attempts: 5, retryMs: 1, stopped: () => stopped },
  )), false);
  assert.equal(tries, 1);
  assert.deepEqual(logs, []);
});

// Boundary review of #599 (2026-11-19, F5): a trip site's answer is read no further than the cap, counted in BYTES.
test("readCapped: a body within the cap is returned whole, in UTF-8", async () => {
  assert.equal(await readCapped(new Response("{\"a\":\"שלום\"}"), 64), "{\"a\":\"שלום\"}");
  assert.equal(await readCapped(new Response(null), 64), "");
});

test("readCapped: a declared length over the cap is refused without reading the body", async () => {
  let pulled = 0;
  const body = new ReadableStream<Uint8Array>({ pull(controller) { pulled += 1; controller.enqueue(new Uint8Array(10)); } });
  const response = new Response(body, { headers: { "content-length": "1000" } });
  assert.equal(await readCapped(response, 100), "too_large");
  assert.ok(pulled <= 1, "the body is not drained");
});

test("readCapped: a stream that runs past the cap is cancelled there, not read to the end", async () => {
  let pulled = 0, cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) { pulled += 1; controller.enqueue(new Uint8Array(64)); },
    cancel() { cancelled = true; },
  });
  assert.equal(await readCapped(new Response(body), 100), "too_large");
  assert.ok(cancelled, "the stream is cancelled");
  assert.ok(pulled < 10, `stopped at the cap, not after ${pulled} chunks`);
});

test("readCapped: the cap counts bytes, not UTF-16 units", async () => {
  // 40 Hebrew letters are 40 UTF-16 units and 80 UTF-8 bytes.
  assert.equal(await readCapped(new Response("א".repeat(40)), 60), "too_large");
  assert.equal(await readCapped(new Response("א".repeat(40)), 80), "א".repeat(40));
});

test("readCapped: a stream that fails part-way is unreachable", async () => {
  const body = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new Uint8Array(4)); controller.error(new Error("reset")); } });
  assert.equal(await readCapped(new Response(body), 100), "unreachable");
});
