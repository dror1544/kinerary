import assert from "node:assert/strict";
import crypto from "node:crypto";
import { syncBuiltinESMExports } from "node:module";
import type pg from "pg";
import { test } from "node:test";

test("unknown and known-wrong email logins both perform one scrypt verification", async () => {
  const original = crypto.scrypt;
  let work = 0;
  crypto.scrypt = function (...args: Parameters<typeof crypto.scrypt>) { work++; return original.apply(crypto, args); } as typeof crypto.scrypt;
  syncBuiltinESMExports();
  try {
    const { verifyPasswordLogin } = await import("../src/password-identity.js");
    for (const rows of [[], [{ user_id: "user_fixture", password_hash: `scrypt:fixture-salt:${Buffer.alloc(32).toString("base64url")}` }]]) {
      work = 0;
      const db = { query: async () => ({ rows }) } as unknown as pg.Pool;
      const result = await verifyPasswordLogin(db, { email: "organizer@example.test", password: "wrong-password" });
      assert.deepEqual(result, { ok: false, error: "PASSWORD_LOGIN_INVALID_CREDENTIALS" });
      assert.equal(work, 1);
    }
  } finally { crypto.scrypt = original; syncBuiltinESMExports(); }
});
