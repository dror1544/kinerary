-- Real Telegram notification adapter: a mapping from a short opaque
-- callback_data reference to the full HMAC-signed approval-action token.
--
-- Telegram's inline-keyboard callback_data field caps at 64 bytes. The
-- signed action token (base64url JSON payload + "." + hex HMAC) produced by
-- approval-action.ts runs to ~190-200 bytes for a real requestId, so it
-- cannot be the callback_data value directly.
--
-- This table is a pure transport-layer workaround for that size limit, not a
-- new trust boundary: the ref is unguessable (16 random bytes) and merely
-- expands back to the exact original signed token, which is then verified by
-- the SAME unmodified verifyApprovalAction() as before. Sender identity is
-- still checked independently (WRONG_SENDER, via the real Telegram
-- callback_query.from.id), before this table is even consulted.

CREATE TABLE control_plane.telegram_callback_refs (
  ref        text        PRIMARY KEY CHECK (ref ~ '^cbk_[A-Za-z0-9]{8,64}$'),
  token      text        NOT NULL,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Supports a future cleanup job; not required for correctness today since
-- the wrapped token carries its own expiry, independently re-checked by
-- verifyApprovalAction on every resolution.
CREATE INDEX telegram_callback_refs_expires_idx
  ON control_plane.telegram_callback_refs (expires_at);
