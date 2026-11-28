/**
 * AC-4 of docs/specs/sprint-9/699-user-photo-library.md: the control plane fetches an address a person typed, so every
 * call goes through photo-library-guard.ts. The guard is on the RESOLVED address, at every call, and the connection is
 * made to exactly the address that was checked (no second resolution between the check and the connect).
 *
 * Every server here is a stand-in on a loopback port chosen at runtime; nothing reaches the network. A request the guard
 * refuses must never reach the stand-in, so each refusal also asserts the stand-in saw nothing.
 */
import assert from "node:assert/strict";
import { createSocket } from "node:dgram";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, test } from "node:test";
import {
  PhotoLibraryGuardError, classifyAddress, guardedFetch, parseLibraryAddress, systemResolver, type Resolver,
} from "../src/photo-library-guard.js";

let server: Server;
let port = 0;
const hits: string[] = [];
let handler: (request: IncomingMessage, response: ServerResponse) => void = (_request, response) => { response.end("ok"); };

before(async () => {
  server = createServer((request, response) => { hits.push(`${request.method} ${request.url}`); handler(request, response); });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = (server.address() as AddressInfo).port;
});

after(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

function reset(next?: typeof handler): void {
  hits.length = 0;
  handler = next ?? ((_request, response) => { response.end("ok"); });
}

async function refusal(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    assert.ok(error instanceof PhotoLibraryGuardError, `expected a guard error, got ${String(error)}`);
    return error.code;
  }
  assert.fail("the request was not refused");
}

const noResolver: Resolver = async () => { throw new Error("a literal address must not be resolved"); };

test("the address classes: loopback, link-local, metadata, private, unspecified, multicast, mapped IPv6, public", () => {
  const cases: Array<[string, string]> = [
    ["127.0.0.1", "loopback"], ["127.5.6.7", "loopback"], ["::1", "loopback"],
    ["169.254.169.254", "metadata"], ["fd00:ec2::254", "metadata"], ["169.254.1.1", "link_local"], ["fe80::1", "link_local"],
    ["10.1.2.3", "private"], ["172.16.0.1", "private"], ["172.31.255.255", "private"], ["192.168.1.1", "private"],
    ["100.64.0.1", "private"], ["fc00::1", "private"], ["fd12:3456::1", "private"], ["fec0::1", "private"],
    ["0.0.0.0", "unspecified"], ["0.1.2.3", "unspecified"], ["::", "unspecified"],
    ["224.0.0.1", "multicast"], ["239.255.255.250", "multicast"], ["ff02::1", "multicast"],
    ["255.255.255.255", "reserved"], ["240.0.0.1", "reserved"], ["192.0.2.1", "reserved"], ["2001:db8::1", "reserved"],
    // IPv4-mapped and IPv4-embedding IPv6 forms are judged as the IPv4 address they carry.
    ["::ffff:127.0.0.1", "loopback"], ["::ffff:7f00:1", "loopback"], ["::ffff:169.254.169.254", "metadata"],
    ["::ffff:a9fe:a9fe", "metadata"], ["::ffff:10.0.0.1", "private"], ["::ffff:c0a8:101", "private"],
    ["0:0:0:0:0:ffff:7f00:1", "loopback"], ["64:ff9b::7f00:1", "loopback"], ["2002:7f00:1::1", "loopback"],
    ["::127.0.0.1", "reserved"],
    ["172.32.0.1", "public"], ["8.8.8.8", "public"], ["2606:4700::1111", "public"], ["::ffff:8.8.8.8", "public"],
    ["not-an-address", "reserved"],
  ];
  for (const [address, expected] of cases) assert.equal(classifyAddress(address), expected, address);
});

test("only http and https, with no credentials in the address, are accepted", () => {
  for (const raw of ["ftp://photos.example.test/", "file:///etc/passwd", "javascript:alert(1)", "gopher://photos.example.test/",
    "http://user:pass@photos.example.test/", "http://user@photos.example.test/", "photos.example.test", "", 42, null,
    "http://photos.example.test/?x=1", "http://photos.example.test/#frag"]) {
    assert.throws(() => parseLibraryAddress(raw), (error: unknown) => error instanceof PhotoLibraryGuardError && error.code === "invalid_address", String(raw));
  }
  assert.equal(parseLibraryAddress("https://Photos.Example.TEST/immich/").href, "https://photos.example.test/immich");
});

test("a loopback address is refused, in every spelling, and the server never sees the request", async () => {
  reset();
  for (const raw of [`http://127.0.0.1:${port}/`, `http://127.9.9.9:${port}/`, `http://[::1]:${port}/`, `http://[::ffff:127.0.0.1]:${port}/`,
    `http://[::ffff:7f00:1]:${port}/`, `http://2130706433:${port}/`, `http://0x7f000001:${port}/`, `http://0177.0.0.1:${port}/`, `http://localhost:${port}/`]) {
    const resolver: Resolver = async () => [{ address: "127.0.0.1", family: 4 }];
    assert.equal(await refusal(guardedFetch(parseLibraryAddress(raw), {}, { resolve: resolver })), "address_not_allowed", raw);
  }
  assert.deepEqual(hits, []);
});

test("the metadata address, link-local and the private ranges are refused", async () => {
  reset();
  for (const raw of ["http://169.254.169.254/latest/meta-data", "http://[fe80::1]/", "http://169.254.10.10/", "http://10.0.0.5/",
    "http://172.16.4.4/", "http://172.31.0.1/", "http://192.168.1.20/", "http://[fd00::5]/", "http://[::ffff:169.254.169.254]/",
    "http://[::ffff:10.0.0.1]/", "http://0.0.0.0/", "http://[::]/", "http://224.0.0.1/"]) {
    assert.equal(await refusal(guardedFetch(parseLibraryAddress(raw), {}, { resolve: noResolver })), "address_not_allowed", raw);
  }
});

test("a name that resolves to a private address is refused, even when only one of its addresses is private", async () => {
  reset();
  const toPrivate: Resolver = async () => [{ address: "10.0.0.5", family: 4 }];
  assert.equal(await refusal(guardedFetch(parseLibraryAddress(`http://photos.example.test:${port}/`), {}, { resolve: toPrivate })), "address_not_allowed");
  const mixed: Resolver = async () => [{ address: "8.8.8.8", family: 4 }, { address: "127.0.0.1", family: 4 }];
  assert.equal(await refusal(guardedFetch(parseLibraryAddress(`http://photos.example.test:${port}/`), {}, { resolve: mixed })), "address_not_allowed");
  const mapped: Resolver = async () => [{ address: "::ffff:169.254.169.254", family: 6 }];
  assert.equal(await refusal(guardedFetch(parseLibraryAddress(`http://photos.example.test:${port}/`), {}, { resolve: mapped })), "address_not_allowed");
  const nothing: Resolver = async () => [];
  assert.equal(await refusal(guardedFetch(parseLibraryAddress(`http://photos.example.test:${port}/`), {}, { resolve: nothing })), "unreachable");
  assert.deepEqual(hits, []);
});

test("the allow-list lets a named host through, and the connection goes to the address that was checked", async () => {
  reset((_request, response) => { response.end("from the stand-in"); });
  const literal = await guardedFetch(parseLibraryAddress(`http://127.0.0.1:${port}/x`), {}, { allowedPrivateHosts: ["127.0.0.1"], resolve: noResolver });
  assert.equal(literal.status, 200);
  assert.equal(literal.body.toString(), "from the stand-in");

  // `.test` names exist in no DNS: the request can only arrive if it was sent to the address the resolver returned.
  let calls = 0;
  const pinned: Resolver = async () => { calls += 1; return [{ address: "127.0.0.1", family: 4 }]; };
  const named = await guardedFetch(parseLibraryAddress(`http://immich.home.test:${port}/y`), {}, { allowedPrivateHosts: ["immich.home.test"], resolve: pinned });
  assert.equal(named.body.toString(), "from the stand-in");
  assert.equal(calls, 1, "exactly one resolution per call: the check and the connect use the same address");
  assert.deepEqual(hits, ["GET /x", "GET /y"]);

  // A different name that resolves to the same private address is NOT allowed by the first name's entry.
  assert.equal(await refusal(guardedFetch(parseLibraryAddress(`http://other.home.test:${port}/`), {}, { allowedPrivateHosts: ["immich.home.test"], resolve: pinned })), "address_not_allowed");
  // The metadata address is never allowed, whatever the list says.
  assert.equal(await refusal(guardedFetch(parseLibraryAddress("http://169.254.169.254/"), {}, { allowedPrivateHosts: ["169.254.169.254"], resolve: noResolver })), "address_not_allowed");
});

test("the guard runs on every call: a name that starts resolving somewhere else is refused on the next call", async () => {
  reset();
  let call = 0;
  const rebinding: Resolver = async () => { call += 1; return [{ address: call === 1 ? "127.0.0.1" : "169.254.169.254", family: 4 }]; };
  const options = { allowedPrivateHosts: ["rebind.example.test"], resolve: rebinding };
  // The first call resolves to the allowed host's address and lands; the second resolves to the metadata address and is
  // refused, although the name has not changed: the check is on what the name resolves to now.
  const url = parseLibraryAddress(`http://rebind.example.test:${port}/`);
  assert.equal((await guardedFetch(url, {}, options)).status, 200);
  assert.equal(await refusal(guardedFetch(url, {}, options)), "address_not_allowed");
  assert.equal(call, 2);
  assert.equal(hits.length, 1);
});

test("a redirect is refused, to another host or to the same one", async () => {
  const options = { allowedPrivateHosts: ["127.0.0.1"], resolve: noResolver };
  for (const location of ["http://169.254.169.254/latest/meta-data", `http://127.0.0.1:${port}/elsewhere`]) {
    for (const status of [301, 302, 307, 308]) {
      reset((_request, response) => { response.writeHead(status, { location }); response.end(); });
      assert.equal(await refusal(guardedFetch(parseLibraryAddress(`http://127.0.0.1:${port}/start`), {}, options)), "redirect_refused", `${status} ${location}`);
      assert.deepEqual(hits, ["GET /start"], "the redirect target is never requested");
    }
  }
});

test("an oversized response is cut off, whether or not it announces its length", async () => {
  const options = { allowedPrivateHosts: ["127.0.0.1"], resolve: noResolver, maxBytes: 1024 };
  reset((_request, response) => { response.writeHead(200, { "content-length": String(4096) }); response.end(Buffer.alloc(4096, 97)); });
  assert.equal(await refusal(guardedFetch(parseLibraryAddress(`http://127.0.0.1:${port}/`), {}, options)), "response_too_large");
  reset((_request, response) => {
    response.writeHead(200);
    const timer = setInterval(() => { if (!response.write(Buffer.alloc(512, 98))) return; }, 5);
    response.on("close", () => clearInterval(timer));
  });
  assert.equal(await refusal(guardedFetch(parseLibraryAddress(`http://127.0.0.1:${port}/`), {}, options)), "response_too_large");
  reset((_request, response) => { response.end(Buffer.alloc(1024, 99)); });
  assert.equal((await guardedFetch(parseLibraryAddress(`http://127.0.0.1:${port}/`), {}, options)).body.length, 1024);
});

test("a server that does not answer, or answers a byte at a time, hits the total deadline", async () => {
  const options = { allowedPrivateHosts: ["127.0.0.1"], resolve: noResolver, timeoutMs: 300 };
  reset(() => { /* never answers */ });
  let started = Date.now();
  assert.equal(await refusal(guardedFetch(parseLibraryAddress(`http://127.0.0.1:${port}/`), {}, options)), "timeout");
  assert.ok(Date.now() - started < 2000);
  // A trickle keeps a socket-idle timer alive forever; the deadline is for the whole exchange.
  reset((_request, response) => {
    response.writeHead(200);
    const timer = setInterval(() => response.write("x"), 50);
    response.on("close", () => clearInterval(timer));
  });
  started = Date.now();
  assert.equal(await refusal(guardedFetch(parseLibraryAddress(`http://127.0.0.1:${port}/`), {}, options)), "timeout");
  assert.ok(Date.now() - started < 2000);
});

test("one deadline covers the name lookup too: a resolver that never answers is a timeout, not a hang", async () => {
  reset();
  const never: Resolver = () => new Promise(() => { /* never settles */ });
  const started = Date.now();
  assert.equal(await refusal(guardedFetch(parseLibraryAddress(`http://slow-dns.example.test:${port}/`), {}, { resolve: never, timeoutMs: 500 })), "timeout");
  const took = Date.now() - started;
  assert.ok(took >= 450 && took < 1500, `answered after ${took} ms, the deadline was 500`);
  // The time the lookup took counts against the same deadline as the exchange: a slow lookup plus a slow server is one timeout.
  const slow: Resolver = () => new Promise((resolve) => setTimeout(() => resolve([{ address: "127.0.0.1", family: 4 }]), 300));
  reset(() => { /* never answers */ });
  const second = Date.now();
  assert.equal(await refusal(guardedFetch(parseLibraryAddress(`http://slow.home.test:${port}/`), {}, { resolve: slow, allowedPrivateHosts: ["slow.home.test"], timeoutMs: 500 })), "timeout");
  assert.ok(Date.now() - second < 900, `the deadline restarted after the lookup (${Date.now() - second} ms)`);
});

test("the system resolver is c-ares with its own timeout, never the shared thread pool's getaddrinfo", async () => {
  const source = await readFile(fileURLToPath(new URL("../src/photo-library-guard.ts", import.meta.url)), "utf8");
  assert.match(source, /new (?:Dns)?Resolver\(\{\s*timeout:/);
  // getaddrinfo is not imported at all (the file header names it, in prose, as what is avoided).
  assert.doesNotMatch(source, /import\s*\{[^}]*\blookup\b[^}]*\}\s*from\s*"node:dns/);
});

test("the c-ares resolver gives up on a name server that never answers, and stops at once when cancelled", async () => {
  // A name server on loopback that receives every query and answers none.
  const silent = createSocket("udp4");
  let queries = 0;
  silent.on("message", () => { queries += 1; });
  await new Promise<void>((resolve) => silent.bind(0, "127.0.0.1", () => resolve()));
  const server = `127.0.0.1:${silent.address().port}`;
  try {
    const bounded = systemResolver(400, [server]);
    let started = Date.now();
    await assert.rejects(bounded.resolve("photos.example.test"));
    assert.ok(Date.now() - started < 2000, `c-ares gave up after ${Date.now() - started} ms`);
    assert.ok(queries > 0, "the stand-in name server was asked");
    const cancelled = systemResolver(60_000, [server]);
    started = Date.now();
    const pending = cancelled.resolve("photos.example.test");
    setTimeout(() => cancelled.cancel(), 100);
    await assert.rejects(pending);
    assert.ok(Date.now() - started < 1000, `cancel took ${Date.now() - started} ms`);
  } finally { silent.close(); }
});

test("a closed port reads as unreachable, and a guard error never carries the request's headers", async () => {
  const closed = createServer();
  await new Promise<void>((resolve) => closed.listen(0, "127.0.0.1", resolve));
  const closedPort = (closed.address() as AddressInfo).port;
  await new Promise<void>((resolve) => closed.close(() => resolve()));
  const secret = "header-secret-value-1234567890";
  try {
    await guardedFetch(parseLibraryAddress(`http://127.0.0.1:${closedPort}/`), { headers: { "x-api-key": secret } }, { allowedPrivateHosts: ["127.0.0.1"], resolve: noResolver });
    assert.fail("expected unreachable");
  } catch (error) {
    assert.ok(error instanceof PhotoLibraryGuardError);
    assert.equal(error.code, "unreachable");
    assert.doesNotMatch(`${error.message} ${error.stack ?? ""} ${JSON.stringify(error)}`, new RegExp(secret));
  }
});
