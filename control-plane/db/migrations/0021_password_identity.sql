-- Stopgap password-based identity for control-plane's own web-facing
-- endpoints (POST /v1/signup and every owner-scoped route), so testing and
-- early use don't require a Telegram Login Widget. The widget needs a
-- domain registered per-bot via @BotFather and doesn't fit this system's
-- "one shared bot routed to many trip profiles" model (project decision,
-- 2026-08-26) — real widget-based web login is deferred to feat/landing-spa's
-- fuller account system (Google OAuth + web_password_credentials, see its
-- migration 0021_web_password_credentials.sql), which supersedes this table
-- once merged. Deliberately minimal: scrypt hash only, no sessions, no CSRF.
CREATE TABLE control_plane.password_credentials (
  user_id text PRIMARY KEY REFERENCES control_plane.users(id) ON DELETE CASCADE,
  email_digest text NOT NULL UNIQUE CHECK (email_digest ~ '^sha256:[a-f0-9]{64}$'),
  password_hash text NOT NULL CHECK (char_length(password_hash) BETWEEN 32 AND 256),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
