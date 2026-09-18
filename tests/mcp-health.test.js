/**
 * mcp-health.test.js — can this bridge reach the trip it was configured for?
 *
 * A trip-mcp bridge can be running perfectly and still be useless. On
 * 2026-09-18 a freshly provisioned trip's bridge served MCP on loopback
 * happily — 50 tools, every call executing — while every one of those calls
 * died on the way to the trip's own site:
 *
 *   get_config -> connect EHOSTUNREACH 192.168.0.60:8080
 *
 * The organizer's companion answered "I can't retrieve the trip plan right
 * now", politely, for as long as anyone cared to ask. Nothing upstream
 * noticed: the bridge was up, the port was open, provisioning had reported
 * success. What was missing was anybody asking the bridge the one question
 * that matters — not "are you listening?" but "can you reach the trip?".
 *
 * That is what /health answers, and it is deliberately thin: whether the site
 * is reachable and what the failure was called. Never the URL (a LAN address
 * is infrastructure data, and infrastructure data does not live in this repo),
 * never a key, never anything about the trip itself.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { PORTS } from './helpers/ports.js';
import { startTestMcp, stopTestMcp, mcpApi } from './helpers/mcp.js';

/** `mcpApi` hands back the raw Response; every assertion here is about the body. */
async function health() {
  const res = await mcpApi('/health');
  return { status: res.status, body: await res.json() };
}

describe('GET /health — the bridge cannot reach the trip', () => {
  // The helper's default API_BASE_URL is 127.0.0.1:1, which nothing serves.
  before(async () => { await startTestMcp({ MCP_PORT: PORTS.mcpHealthUnreachable }); });
  after(() => stopTestMcp());

  test('says so, rather than reporting itself healthy for being alive', async () => {
    const res = await health();
    assert.equal(res.status, 503, 'a bridge that cannot reach its trip is not healthy');
    assert.equal(res.body.ok, false);
    assert.equal(res.body.site, 'unreachable');
  });

  test('names the failure, because EHOSTUNREACH and 401 need different fixes', async () => {
    const res = await health();
    assert.ok(res.body.code, `a reason to act on — got ${JSON.stringify(res.body)}`);
  });

  test('never says where the trip is, and never says the key', async () => {
    const res = await health();
    const body = JSON.stringify(res.body);
    assert.ok(!/127\.0\.0\.1:1\b|http:\/\//.test(body), `no address may appear: ${body}`);
    assert.ok(!/test-trip-key|test-mcp-key/.test(body), `no key may appear: ${body}`);
  });
});

describe('GET /health — the bridge can reach the trip', () => {
  const sitePort = PORTS.mcpHealthTripSite;
  let site;

  before(async () => {
    site = createServer((req, res) => {
      if (req.url === '/api/config') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ meta: { brand: 'A trip' } }));
        return;
      }
      res.writeHead(404).end();
    });
    await new Promise((r) => site.listen(sitePort, '127.0.0.1', r));
    await startTestMcp({
      MCP_PORT: PORTS.mcpHealthReachable,
      API_BASE_URL: `http://127.0.0.1:${sitePort}`,
    });
  });
  after(async () => {
    stopTestMcp();
    await new Promise((r) => site.close(r));
  });

  test('reports reachable', async () => {
    const res = await health();
    assert.equal(res.status, 200);
    assert.equal(res.body.ok, true);
    assert.equal(res.body.site, 'reachable');
  });

  test('and still says nothing about the trip itself', async () => {
    const res = await health();
    assert.ok(!JSON.stringify(res.body).includes('A trip'), 'health is not a data endpoint');
  });
});
