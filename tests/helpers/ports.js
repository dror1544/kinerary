/**
 * ports.js — every port the test suite binds, in one place.
 *
 * node:test runs the listed files concurrently (--test-concurrency=4 in
 * package.json), so two files that bind the same port race for it and the
 * loser dies with EADDRINUSE — usually not the file that is actually at
 * fault, and only sometimes, depending on scheduling.
 *
 * Each file used to pick its own number and leave a "3095-31NN already
 * claimed by other test files" comment for the next one. That drifted five
 * separate times, because two files counting upward from the same comment
 * land on the same number: 3098, 3107, 3110, 3111 and 3112 each had two
 * owners. A comment describing the allocation cannot enforce it — this table
 * is the allocation, and assertUnique() below fails the import rather than
 * letting a duplicate surface later as a flaky EADDRINUSE.
 *
 * Only fixed ports belong here. A stand-in that binds port 0 and reads its
 * address back cannot collide, and needs no entry.
 *
 * Adding a test that binds a port: add a named entry here, and import it.
 * Never write a port literal in a test file. That rule is not style: a literal
 * is invisible to both checks below, which only ever see this table.
 * `mcp-budget.test.js` passed a bare `MCP_PORT: '3113'` and so held the same
 * port as `itineraryOverlaySync` — a real duplicate that `assertUnique()`
 * could not report, because only one of the two was ever declared here.
 *
 * ── WHY 28000 AND NOT 3000, AND NOT 38000 ────────────────────────────────
 *
 * The suite used to allocate upward from 3095, which put 29 of these entries
 * inside 3100-3999 — and that block is not ours. Every provisioned trip runs
 * its own trip-mcp bridge on `3000 + vmid` (mcp_port_for_vmid, clamped to
 * 3100-3999), on the same Mac where these tests run. Proxmox hands out VMIDs
 * from 100 upward, so the live allocation mapped almost one-to-one onto the
 * old test block: VMID 104, 105, 106, 107 were all in use at once on
 * 2026-09-18, and 3106 is `mcpExtract`.
 *
 * It bit exactly as you would expect and read as something else entirely:
 * `trip-mcp exited with code 1 before becoming ready`, no mention of a port,
 * and node:test then cancelled a sibling test that was mid-flight. It looks
 * like a broken MCP server, not like somebody else owning the socket.
 *
 * The TESTS moved rather than the bridges, because a bridge port is not free
 * to change: it is derived from the container, written into every companion's
 * profile config and recorded in topology.yaml, so moving it would orphan
 * the bridges already deployed. `assertClearOfTripBridges()` keeps it moved.
 *
 * The first move went to 38000+, reasoning only about macOS, whose ephemeral
 * (outbound) range is 49152-65535. CI runs on Linux, whose default
 * `ip_local_port_range` is 32768-60999, and 38000+ is INSIDE it. Several test
 * files bind port 0 or open many outbound connections at
 * --test-concurrency=4, so the kernel can hand one of them a number in this
 * table an instant before a test server binds it. Observed once on CI
 * (run 36181059100: EADDRINUSE on 38202, then "Server exited with code 1
 * before becoming ready"; an earlier PR hit 38194). That causal theory was
 * NOT reproduced — it cannot be on macOS — it is the explanation that fits
 * the log, and the fix is to make it impossible.
 *
 * So the table now lives at 28000+: below 32768, hence clear of the Linux
 * range and of macOS's, clear of the trip bridges (3100-3999), the legacy
 * shared bridges (3001, 3011, 3013), the control plane (4310-4312, 4399),
 * its databases (5433, 5434) and the usual dev ports (3000, 5173, 8080).
 * assertBelowEphemeralRange() keeps it there.
 */

/**
 * Ports a provisioned trip's own trip-mcp bridge can take, from
 * `mcp_port_for_vmid`. Not ours to bind, on any machine that provisions trips.
 */
/**
 * First port of Linux's default ephemeral range (`ip_local_port_range`,
 * 32768-60999). macOS's (49152+) starts higher, so this is the binding limit.
 */
export const EPHEMERAL_RANGE_FIRST = 32768;

export const TRIP_BRIDGE_PORT_RANGE = { first: 3100, last: 3999 };

export const PORTS = {
  companionControl:        28201,
  companionConversation:   28202,
  // ── Full trip servers ──────────────────────────────────────────────────
  telegramSso:             28095,
  telegramSsoConfigResync: 28100,
  telegramSsoGroupBind:    28102,
  multiOrganizer:          28096,
  configVersionsRestart:   28097,
  configVersionsBoot:      28098,
  serverDefault:           28099,  // helpers/server.js fallback — server.test.js
  agentParticipants:       28101,
  bookingExtractServer:    28104,
  errorHandling:           28105,
  currencyRates:           28107,
  scheduleReviewServer:    28109,
  itineraryOverlaySync:    28113,
  planSingleSource:        28119,
  planSingleSourceBoot:    28120,
  itineraryPlanLayerServer: 28118,
  configDayLinksServer:    28114,
  configAllowList:         28126,  // tests/config-allow-list.test.js — hostile config, issue #172
  configAllowListPromote:  28127,  // tests/config-allow-list.test.js — malformed plan config, issue #172
  galleryBoundary:         28128,  // tests/gallery-boundary.test.js — issues #191/#194
  galleryHardening:        28129,  // tests/gallery-hardening.test.js — boundary audit round 2 of #191/#194
  // tests/trip-documents.test.js
  tripDocuments:           28299,

  modernParity:            28298,
  modernEnrichment:        28194,
  heroHttp:                28196,
  tripEventsHttp:          28198,
  controlPlaneSession:     28296,
  tripMcpEnabled:          28304,
  tripMcpDisabled:         28305,
  tripMcpPublicOrigin:     28306,
  tripMcpNoSdk:            28307,
  // control-plane/api/test/group-document-to-plan.integration.test.ts
  groupDocumentServer:     28294,

  // Servers a single describe() spawns with a patched config of its own.
  currencyRatesUsdHome:    28111,
  currencyRatesUsdOnly:    28112,
  configDayLinksSeeded:    28115,

  // ── MCP servers ────────────────────────────────────────────────────────
  controlPlaneSessionMcp:  28295,
  groupDocumentMcp:        28293,
  mcpExtract:              28106,
  mcpExtractEmpty:         28300,
  itineraryPlanLayerMcp:   28108,
  mcpDefault:              28117,
  mcpBookingConfirmation:  28116,
  mcpBudget:               28121,
  mcpHealthUnreachable:    28122,
  mcpHealthReachable:      28123,
  mcpHealthAuth:           28125,

  // ── Stand-ins for services the server calls out to ─────────────────────
  bookingExtractMockHermes: 28103,
  mcpHealthTripSite:        28124,
  scheduleReviewMockHermes: 28110,
};

export function assertUnique(table) {
  const owner = new Map();
  for (const [name, port] of Object.entries(table)) {
    if (owner.has(port)) {
      throw new Error(
        `helpers/ports.js: "${name}" and "${owner.get(port)}" both claim port ${port}. ` +
        'Two test files binding one port race under --test-concurrency.'
      );
    }
    owner.set(port, name);
  }
}

/**
 * No test port may sit where a provisioned trip's bridge can land.
 *
 * The duplicate check above only compares this table against itself, which is
 * why 3106 survived: `mcpExtract` was unique among test ports and still
 * belonged to VMID 106's bridge. This compares the table against the one
 * other allocator on the machine, so the next entry added by counting upward
 * from a neighbour fails at import instead of failing for whoever next runs
 * the suite beside a live trip.
 */
export function assertClearOfTripBridges(table) {
  const { first, last } = TRIP_BRIDGE_PORT_RANGE;
  const clashes = Object.entries(table)
    .filter(([, port]) => port >= first && port <= last)
    .map(([name, port]) => `${name} (${port} = the bridge of VMID ${port - 3000})`);
  if (clashes.length > 0) {
    throw new Error(
      `helpers/ports.js: ${clashes.length} test port(s) fall inside ${first}-${last}, ` +
      'which belongs to provisioned trips\' trip-mcp bridges (mcp_port_for_vmid = 3000 + vmid): ' +
      `${clashes.join(', ')}. A trip on that VMID makes the test fail as "exited before ` +
      'becoming ready" with no mention of a port. Allocate from 28000 instead.'
    );
  }
}

/**
 * No test port may sit in the OS's ephemeral range: [32768, 60999] on Linux
 * (CI), 49152+ on macOS. Anything at or above 32768 can be handed by the
 * kernel to an outbound connection or a port-0 listener an instant before a
 * test server binds it, which fails as a random EADDRINUSE on whichever file
 * lost the race. See the comment at the top of this file.
 */
export function assertBelowEphemeralRange(table) {
  const bad = Object.entries(table)
    .filter(([, port]) => port >= EPHEMERAL_RANGE_FIRST)
    .map(([name, port]) => `${name} (${port})`);
  if (bad.length > 0) {
    throw new Error(
      `helpers/ports.js: ${bad.length} test port(s) are >= ${EPHEMERAL_RANGE_FIRST}, inside the ` +
      'Linux ephemeral range 32768-60999 (and macOS 49152+), where the kernel can hand the ' +
      `port to another socket before the test binds it: ${bad.join(', ')}. Allocate from 28000.`
    );
  }
}

assertUnique(PORTS);
assertClearOfTripBridges(PORTS);
assertBelowEphemeralRange(PORTS);
