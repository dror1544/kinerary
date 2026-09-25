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
 * ── WHY 38000 AND NOT 3000 ────────────────────────────────────────────────
 *
 * The suite used to allocate upward from 3095, which put 29 of these entries
 * inside 3100-3999 — and that block is not ours. Every provisioned trip runs
 * its own trip-mcp bridge on `3000 + vmid` (mcp_bridge.py's
 * `mcp_port_for_vmid`, clamped to 3100-3999), on the same Mac where these
 * tests run. Proxmox hands out VMIDs from 100 upward, so the live allocation
 * mapped almost one-to-one onto the old test block: VMID 104, 105, 106, 107
 * were all in use at once on 2026-09-18, and 3106 is `mcpExtract`.
 *
 * It bit exactly as you would expect and read as something else entirely:
 * `trip-mcp exited with code 1 before becoming ready`, no mention of a port,
 * and node:test then cancelled a sibling test that was mid-flight. It looks
 * like a broken MCP server, not like somebody else owning the socket.
 *
 * The TESTS moved rather than the bridges, because a bridge port is not free
 * to change: it is derived from the container, written into every companion's
 * profile config and recorded in topology.yaml, so moving it would orphan
 * the bridges already deployed. A test port is a named constant behind
 * `assertUnique()` with a rule that no test may write a literal, so moving it
 * costs one file. `assertClearOfTripBridges()` keeps it moved.
 *
 * 38000+ is clear of the bridge range, of the legacy shared bridges (3001,
 * 3011, 3013), of the control plane (4310-4312, 4399) and of its databases
 * (5433, 5434), and is comfortably below the ephemeral range macOS allocates
 * from (49152+), so nothing here can collide with an outbound socket either.
 */

/**
 * Ports a provisioned trip's own trip-mcp bridge can take, from
 * `mcp_port_for_vmid`. Not ours to bind, on any machine that provisions trips.
 */
export const TRIP_BRIDGE_PORT_RANGE = { first: 3100, last: 3999 };

export const PORTS = {
  companionControl:        38201,
  companionConversation:   38202,
  // ── Full trip servers ──────────────────────────────────────────────────
  telegramSso:             38095,
  telegramSsoConfigResync: 38100,
  telegramSsoGroupBind:    38102,
  multiOrganizer:          38096,
  configVersionsRestart:   38097,
  configVersionsBoot:      38098,
  serverDefault:           38099,  // helpers/server.js fallback — server.test.js
  agentParticipants:       38101,
  bookingExtractServer:    38104,
  errorHandling:           38105,
  currencyRates:           38107,
  scheduleReviewServer:    38109,
  itineraryOverlaySync:    38113,
  planSingleSource:        38119,
  planSingleSourceBoot:    38120,
  itineraryPlanLayerServer: 38118,
  configDayLinksServer:    38114,
  configAllowList:         38126,  // tests/config-allow-list.test.js — hostile config, issue #172
  configAllowListPromote:  38127,  // tests/config-allow-list.test.js — malformed plan config, issue #172

  modernParity:            38298,
  modernEnrichment:        38194,
  heroHttp:                38196,
  tripEventsHttp:          38198,
  controlPlaneSession:     38296,
  tripMcpEnabled:          38300,
  tripMcpDisabled:         38301,
  tripMcpPublicOrigin:     38302,
  tripMcpNoSdk:            38303,
  // control-plane/api/test/group-document-to-plan.integration.test.ts
  groupDocumentServer:     38294,

  // Servers a single describe() spawns with a patched config of its own.
  currencyRatesUsdHome:    38111,
  currencyRatesUsdOnly:    38112,
  configDayLinksSeeded:    38115,

  // ── MCP servers ────────────────────────────────────────────────────────
  controlPlaneSessionMcp:  38295,
  groupDocumentMcp:        38293,
  mcpExtract:              38106,
  itineraryPlanLayerMcp:   38108,
  mcpDefault:              38117,
  mcpBookingConfirmation:  38116,
  mcpBudget:               38121,
  mcpHealthUnreachable:    38122,
  mcpHealthReachable:      38123,
  mcpHealthAuth:           38125,

  // ── Stand-ins for services the server calls out to ─────────────────────
  bookingExtractMockHermes: 38103,
  mcpHealthTripSite:        38124,
  scheduleReviewMockHermes: 38110,
};

function assertUnique(table) {
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
function assertClearOfTripBridges(table) {
  const { first, last } = TRIP_BRIDGE_PORT_RANGE;
  const clashes = Object.entries(table)
    .filter(([, port]) => port >= first && port <= last)
    .map(([name, port]) => `${name} (${port} = the bridge of VMID ${port - 3000})`);
  if (clashes.length > 0) {
    throw new Error(
      `helpers/ports.js: ${clashes.length} test port(s) fall inside ${first}-${last}, ` +
      'which belongs to provisioned trips\' trip-mcp bridges (mcp_port_for_vmid = 3000 + vmid): ' +
      `${clashes.join(', ')}. A trip on that VMID makes the test fail as "exited before ` +
      'becoming ready" with no mention of a port. Allocate from 38000 instead.'
    );
  }
}

assertUnique(PORTS);
assertClearOfTripBridges(PORTS);
