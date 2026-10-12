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
    google: { authorizationUrl: () => "https://accounts.example.test", exchange: async () => ({ subject: "sub", displayName: "Name", emailVerified: false }) },
    runtimeAccounts: { participantExists: async () => true, provisionParticipant: async () => {} },
    publicOrigin: profile.web!.public_origin,
    runtimeOrigin: profile.web!.runtime_origin,
    runtimeExchangeKey: "exchange-key",
    runtimeUpstreamHostSuffixes: profile.web!.runtime_upstream_host_suffixes,
    telegramBotUsername: profile.web!.telegram_bot_username,
    sessionTtlSeconds: profile.web!.session_ttl_seconds,
    enrollmentTtlSeconds: 3600,
    approvalTtlSeconds: 3600,
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


test("Google is optional as a complete pair and unavailable routes fail explicitly", async () => {
  const raw = JSON.parse(await readFile(fileURLToPath(new URL("../../config/architecture.web.example.json", import.meta.url)), "utf8"));
  delete raw.web.google_client_id_secret_ref;
  delete raw.web.google_client_secret_ref;
  const profile = validateArchitectureProfile(raw);
  assert.throws(() => validateArchitectureProfile({ ...raw, web: { ...raw.web, google_client_id_secret_ref: "env://GOOGLE_ID" } }));
  assert.throws(() => validateArchitectureProfile({ ...raw, web: { ...raw.web, google_client_secret_ref: "env://GOOGLE_SECRET" } }));
  const app = buildApp(profile, { portal: {
    db: {} as PortalDependencies["db"], runtimeAccounts: {} as PortalDependencies["runtimeAccounts"],
    publicOrigin: raw.web.public_origin, runtimeOrigin: raw.web.runtime_origin, runtimeExchangeKey: "test-key",
    runtimeUpstreamHostSuffixes: ["internal"], telegramBotUsername: "kinerary_bot", sessionTtlSeconds: 3600,
    enrollmentTtlSeconds: 3600, approvalTtlSeconds: 3600,
  } });
  try {
    const providers = await app.inject({ url: "/v1/auth/capabilities" });
    assert.deepEqual(providers.json(), { google: false, emailPassword: true });
    for (const url of ["/v1/auth/google/start", "/v1/auth/google/callback?state=x&code=x"]) {
      const response = await app.inject({ url });
      assert.equal(response.statusCode, 503);
      assert.deepEqual(response.json(), { error: "GOOGLE_SIGN_IN_UNAVAILABLE" });
    }
  } finally { await app.close(); }
});


test("email login throttles before credential hashing and ignores spoofed forwarding headers", async () => {
  const raw = JSON.parse(await readFile(fileURLToPath(new URL("../../config/architecture.web.example.json", import.meta.url)), "utf8"));
  let queries = 0;
  const portal = {
    db: { query: async () => { queries++; return { rows: [] }; } } as unknown as PortalDependencies["db"],
    runtimeAccounts: {} as PortalDependencies["runtimeAccounts"], publicOrigin: raw.web.public_origin,
    runtimeOrigin: raw.web.runtime_origin, runtimeExchangeKey: "test-key", runtimeUpstreamHostSuffixes: ["internal"],
    telegramBotUsername: "kinerary_bot", sessionTtlSeconds: 3600, enrollmentTtlSeconds: 3600, approvalTtlSeconds: 3600,
  } satisfies PortalDependencies;
  const app = buildApp(validateArchitectureProfile(raw), { portal });
  try {
    for (let attempt = 0; attempt < 10; attempt++) {
      const response = await app.inject({ method: "POST", url: "/v1/auth/email-password", payload: { email: "unknown@example.test", password: "wrong-password" } });
      assert.equal(response.statusCode, 401);
    }
    const response = await app.inject({ method: "POST", url: "/v1/auth/email-password", headers: { "x-forwarded-for": "198.51.100.12" }, payload: { email: "unknown@example.test", password: "wrong-password" } });
    assert.equal(response.statusCode, 429);
    assert.deepEqual(response.json(), { error: "SIGN_IN_RATE_LIMITED" });
    assert.equal(response.headers["retry-after"], "60");
    assert.equal(queries, 10);
    // Other organizers behind the same proxy retain their own allowance.
    for (let attempt = 11; attempt <= 99; attempt++) {
      const another = await app.inject({ method: "POST", url: "/v1/auth/email-password", payload: { email: `unknown${attempt}@example.test`, password: "wrong-password" } });
      assert.equal(another.statusCode, 401);
    }
    const spoofed = await app.inject({ method: "POST", url: "/v1/auth/email-password", headers: { "x-forwarded-for": "198.51.100.55" }, payload: { email: "different@example.test", password: "wrong-password" } });
    assert.equal(spoofed.statusCode, 429);
    assert.equal(queries, 99);
  } finally { await app.close(); }
});
