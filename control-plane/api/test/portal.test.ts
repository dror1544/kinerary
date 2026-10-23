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
    google: { clientId: "test-client.apps.googleusercontent.com", verify: async () => ({ subject: "sub", displayName: "Name", emailVerified: false }) },
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


test("Google sign-in is off without web.google_client_id, validates it when set, and refuses the retired secret-ref pair by name", async () => {
  const raw = JSON.parse(await readFile(fileURLToPath(new URL("../../config/architecture.web.example.json", import.meta.url)), "utf8"));
  assert.equal(typeof raw.web.google_client_id, "string", "the example profile names the (public) client ID");
  delete raw.web.google_client_id;
  const profile = validateArchitectureProfile(raw);
  assert.equal(profile.web?.google_client_id, undefined);
  // A plain client ID is accepted; anything that is not one is refused.
  assert.equal(validateArchitectureProfile({ ...raw, web: { ...raw.web, google_client_id: "123-abc.apps.googleusercontent.com" } }).web?.google_client_id, "123-abc.apps.googleusercontent.com");
  for (const bad of ["env://GOOGLE_ID", "123-abc", "123-abc.apps.googleusercontent.com.evil.test", "https://123.apps.googleusercontent.com", "", " 123.apps.googleusercontent.com"]) {
    assert.throws(() => validateArchitectureProfile({ ...raw, web: { ...raw.web, google_client_id: bad } }), /google_client_id/, `refuses ${JSON.stringify(bad)}`);
  }
  // The retired OIDC pair: refused with a message that names the replacement, not a bare "unrecognized key".
  for (const old of ["google_client_id_secret_ref", "google_client_secret_ref"]) {
    assert.throws(
      () => validateArchitectureProfile({ ...raw, web: { ...raw.web, [old]: "env://GOOGLE_X" } }),
      (error: Error) => error.message.includes(`web.${old} is no longer supported`) && error.message.includes("web.google_client_id") && error.message.includes(".apps.googleusercontent.com"),
    );
  }
  assert.throws(() => validateArchitectureProfile({ ...raw, web: { ...raw.web, google_client_id_secret_ref: "env://A", google_client_secret_ref: "env://B" } }), /no longer supported/);
  const app = buildApp(profile, { portal: {
    db: {} as PortalDependencies["db"], runtimeAccounts: {} as PortalDependencies["runtimeAccounts"],
    publicOrigin: raw.web.public_origin, runtimeOrigin: raw.web.runtime_origin, runtimeExchangeKey: "test-key",
    runtimeUpstreamHostSuffixes: ["internal"], telegramBotUsername: "kinerary_bot", sessionTtlSeconds: 3600,
    enrollmentTtlSeconds: 3600, approvalTtlSeconds: 3600,
  } });
  try {
    const providers = await app.inject({ url: "/v1/auth/capabilities" });
    assert.deepEqual(providers.json(), { google: false, emailPassword: true, emailSignUp: false, telegramMiniApp: false });
    const response = await app.inject({ method: "POST", url: "/v1/auth/google", headers: { origin: raw.web.public_origin }, payload: { credential: "x" } });
    assert.equal(response.statusCode, 503);
    assert.deepEqual(response.json(), { error: "GOOGLE_SIGN_IN_UNAVAILABLE" });
    // The redirect flow is gone: its routes are not there to answer at all.
    for (const url of ["/v1/auth/google/start", "/v1/auth/google/callback?state=x&code=x"]) {
      assert.equal((await app.inject({ url })).statusCode, 404, url);
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

test("the profile's email block: resend needs its key and sender, the log provider is refused in production, and a stray field is not accepted", async () => {
  const raw = JSON.parse(await readFile(fileURLToPath(new URL("../../config/architecture.web.example.json", import.meta.url)), "utf8"));
  const withWeb = (extra: Record<string, unknown>, env = "development") => {
    const web = { ...raw.web, ...extra };
    if (extra.email_provider === undefined) delete web.email_provider;
    return { ...raw, environment: env, web: env === "production" ? { ...web, public_origin: "https://portal.example.test", runtime_origin: "https://runtime.example.test" } : web };
  };
  // Unconfigured is a valid profile (sign-up answers 503); so is a complete resend block.
  assert.equal(validateArchitectureProfile(withWeb({})).web?.email_provider, undefined);
  const resend = { email_provider: "resend", email_api_key_secret_ref: "env://EMAIL_API_KEY", email_from: "noreply@mail.example.test" };
  assert.equal(validateArchitectureProfile(withWeb(resend, "production")).web?.email_provider, "resend");
  // Half a resend block, a key with no provider, a sender that is not an address, an unknown provider.
  assert.throws(() => validateArchitectureProfile(withWeb({ ...resend, email_api_key_secret_ref: undefined })), /needs both/);
  assert.throws(() => validateArchitectureProfile(withWeb({ ...resend, email_from: undefined })), /needs both/);
  assert.throws(() => validateArchitectureProfile(withWeb({ email_api_key_secret_ref: "env://EMAIL_API_KEY" })), /need email_provider/);
  assert.throws(() => validateArchitectureProfile(withWeb({ ...resend, email_from: "not an address" })));
  assert.throws(() => validateArchitectureProfile(withWeb({ ...resend, email_provider: "smtp" })));
  assert.throws(() => validateArchitectureProfile(withWeb({ ...resend, email_api_key_secret_ref: "literal-key-in-the-profile" })), undefined, "a key must be a secret reference, never a value");
  // The log provider delivers nothing: fine for dev and tests, refused where it would swallow every link.
  assert.equal(validateArchitectureProfile(withWeb({ email_provider: "log" })).web?.email_provider, "log");
  assert.throws(() => validateArchitectureProfile(withWeb({ email_provider: "log" }, "production")), /sends nothing/);
});
