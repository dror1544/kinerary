import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { validateArchitectureProfile } from "../src/config.js";
import { buildApp } from "../src/app.js";
import { sha256, validatedReturnTo, type PortalDependencies } from "../src/portal.js";

test("return paths are same-origin and retain a join fragment", () => {
  assert.equal(validatedReturnTo("/trips/trip_abcdefgh/app?from=ready#panel"), "/trips/trip_abcdefgh/app?from=ready#panel");
  for (const attack of ["https://attacker.test", "//attacker.test/path", "/\\attacker.test", 12, null]) {
    assert.equal(validatedReturnTo(attack), "/trips");
  }
});

test("token digests are deterministic and never contain the source token", () => {
  const digest = sha256("raw-secret-token");
  assert.match(digest, /^sha256:[a-f0-9]{64}$/);
  assert.doesNotMatch(digest, /raw-secret-token/);
  assert.equal(digest, sha256("raw-secret-token"));
});

test("the web architecture example validates isolation and an upstream allowlist", async () => {
  const path = fileURLToPath(new URL("../../config/architecture.web.example.json", import.meta.url));
  const raw = JSON.parse(await readFile(path, "utf8"));
  const profile = validateArchitectureProfile(raw);
  assert.notEqual(profile.web?.public_origin, profile.web?.runtime_origin);
  assert.deepEqual(profile.web?.runtime_upstream_host_suffixes, ["localhost", "internal"]);
  assert.throws(() => validateArchitectureProfile({ ...raw, web: { ...raw.web, runtime_origin: raw.web.public_origin } }));
});

test("a web profile boots without duplicate trip routes and retires Telegram web authentication", async () => {
  const path = fileURLToPath(new URL("../../config/architecture.web.example.json", import.meta.url));
  const profile = validateArchitectureProfile(JSON.parse(await readFile(path, "utf8")));
  const portal = {
    db: {} as PortalDependencies["db"],
    google: { authorizationUrl: () => "https://accounts.example.test", exchange: async () => ({ subject: "sub", displayName: "Name" }) },
    runtimeAccounts: { participantExists: async () => true, provisionParticipant: async () => {} },
    publicOrigin: profile.web!.public_origin,
    runtimeOrigin: profile.web!.runtime_origin,
    runtimeExchangeKey: "exchange-key",
    runtimeUpstreamHostSuffixes: profile.web!.runtime_upstream_host_suffixes,
    telegramBotUsername: profile.web!.telegram_bot_username,
    sessionTtlSeconds: profile.web!.session_ttl_seconds,
    enrollmentTtlSeconds: 3600,
    approvalTtlSeconds: 3600,
    provisioningAdminSubjectDigests: new Set<string>(),
  } satisfies PortalDependencies;
  const app = buildApp(profile, { portal });
  try {
    const retired = await app.inject({ method: "POST", url: "/v1/signup", payload: { telegram: {}, trip_name_request: "Trip" } });
    assert.equal(retired.statusCode, 410);
    assert.deepEqual(retired.json(), { error: "TELEGRAM_WEB_AUTH_RETIRED" });
  } finally {
    await app.close();
  }
});
