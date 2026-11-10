-- rollback: compatible — adds one new table that only this release reads or writes; the previous release's Google sign-in never touches it
--
-- THE SPENT NONCES OF "SIGN IN WITH GOOGLE" (boundary review round 2, 2026-10-24).
--
-- The page asks GET /v1/auth/google/nonce for a nonce, has Google put it in the
-- ID token, and posts the token with the cookie that holds the nonce's secret.
-- Clearing that cookie only asks the browser to forget it: a captured
-- token+cookie pair could be posted again and again. So the route SPENDS the
-- nonce here, inside the sign-in transaction: INSERT ... ON CONFLICT DO NOTHING,
-- and no row inserted means it was spent already.
--
-- `nonce_digest` is the SHA-256 of the cookie's secret, which is exactly the
-- `nonce` claim in the token (hex), so the table holds nothing the token does
-- not already show and nothing that can be turned back into the secret.
--
-- `expires_at` is when the row may be forgotten: the cookie carries its own
-- issue time (inside what the nonce hashes), the route refuses anything older
-- than five minutes, and the row outlives that, so a purged row can never be
-- one the route would still accept. Expired rows are deleted by the next
-- sign-in; there is no job.
CREATE TABLE control_plane.google_signin_nonces (
  nonce_digest text PRIMARY KEY CHECK (nonce_digest ~ '^[a-f0-9]{64}$'),
  used_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL
);

CREATE INDEX google_signin_nonces_expires_idx ON control_plane.google_signin_nonces(expires_at);
