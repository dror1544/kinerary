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
 * Never write a port literal in a test file.
 */

export const PORTS = {
  // ── Full trip servers ──────────────────────────────────────────────────
  telegramSso:              3095,
  telegramSsoConfigResync:  3100,
  telegramSsoGroupBind:     3102,
  multiOrganizer:           3096,
  configVersionsRestart:    3097,
  configVersionsBoot:       3098,
  serverDefault:            3099,  // helpers/server.js fallback — server.test.js
  agentParticipants:        3101,
  bookingExtractServer:     3104,
  errorHandling:            3105,
  currencyRates:            3107,
  scheduleReviewServer:     3109,
  itineraryOverlaySync:     3113,
  itineraryPlanLayerServer: 3118,  // moved off 3107 (currencyRates)
  configDayLinksServer:     3114,  // moved off 3110 (scheduleReviewMockHermes)

  // Servers a single describe() spawns with a patched config of its own.
  currencyRatesUsdHome:     3111,
  currencyRatesUsdOnly:     3112,
  configDayLinksSeeded:     3115,  // moved off 3111 (currencyRatesUsdHome)

  // ── MCP servers ────────────────────────────────────────────────────────
  mcpExtract:               3106,
  itineraryPlanLayerMcp:    3108,
  mcpDefault:               3117,  // moved off 3098 (configVersionsBoot)
  mcpBookingConfirmation:   3116,  // moved off 3112 (currencyRatesUsdOnly)

  // ── Stand-ins for services the server calls out to ─────────────────────
  bookingExtractMockHermes: 3103,
  scheduleReviewMockHermes: 3110,
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

assertUnique(PORTS);
