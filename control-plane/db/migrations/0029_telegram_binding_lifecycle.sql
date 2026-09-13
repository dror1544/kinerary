-- Gives a chat↔trip binding a lifecycle, so a reassignment CLOSES the old
-- binding instead of overwriting it.
--
-- 0019 made chat_id the primary key, which meant the provisioner's
-- ON CONFLICT (chat_id) DO UPDATE silently retargeted an existing binding:
-- the row that said "this group belongs to trip A" became "this group belongs
-- to trip B" with no trace that it had ever meant anything else. The sprint
-- plan forbids exactly that — reassignment must "close rather than overwrite
-- the old binding" and "cannot silently retarget another active group", and
-- reviewed reassignment has to "preserve binding history". None of that is
-- expressible while one chat can only ever have one row.
--
-- So the table becomes append-only in practice: chat_id stops being the key,
-- history accumulates, and "the binding in force" is expressed as a PARTIAL
-- UNIQUE INDEX over the open rows. Same shape 0028 uses for one live interview
-- per chat, for the same reason — the uniqueness that matters is scoped to
-- what is still current, not to everything the table has ever held.
--
-- READERS MUST FILTER. Every routing lookup has to carry `closed_at IS NULL`.
-- A closed binding that still resolves is worse than no lifecycle at all: it
-- would route a group to a trip it was deliberately detached from, which on a
-- shared bot means another organizer's trip. The two production readers
-- (chat-router.ts's resolveChatRoute and app.ts's chat-routing endpoint) are
-- updated in the same change as this migration.

ALTER TABLE control_plane.telegram_chat_bindings
  ADD COLUMN id            text,
  ADD COLUMN closed_at     timestamptz,
  ADD COLUMN closed_reason text;

-- Existing rows are all currently in force, so they keep closed_at NULL and
-- simply acquire an id. Derived from chat_id rather than random so the
-- backfill is deterministic and re-runnable.
UPDATE control_plane.telegram_chat_bindings
   SET id = 'tcb_' || md5(chat_id)
 WHERE id IS NULL;

ALTER TABLE control_plane.telegram_chat_bindings
  ALTER COLUMN id SET NOT NULL;

ALTER TABLE control_plane.telegram_chat_bindings
  DROP CONSTRAINT telegram_chat_bindings_pkey;

ALTER TABLE control_plane.telegram_chat_bindings
  ADD CONSTRAINT telegram_chat_bindings_pkey PRIMARY KEY (id);

-- The real invariant, and the one the provisioner now relies on rather than
-- ON CONFLICT: at most one OPEN binding per chat. A second concurrent
-- provision racing to bind the same chat loses here rather than quietly
-- overwriting the winner.
CREATE UNIQUE INDEX telegram_chat_bindings_active_chat_idx
  ON control_plane.telegram_chat_bindings (chat_id)
  WHERE closed_at IS NULL;

-- Reading a chat's history — what it was bound to, and when that ended.
CREATE INDEX telegram_chat_bindings_chat_history_idx
  ON control_plane.telegram_chat_bindings (chat_id, closed_at);

-- A closed binding must say why it closed, and an open one must not claim a
-- reason. Keeps "closed" from being expressible as a half-state that a reader
-- filtering on only one of the two columns would disagree about.
ALTER TABLE control_plane.telegram_chat_bindings
  ADD CONSTRAINT telegram_chat_bindings_closed_reason_ck
  CHECK ((closed_at IS NULL) = (closed_reason IS NULL));

ALTER TABLE control_plane.telegram_chat_bindings
  ADD CONSTRAINT telegram_chat_bindings_closed_reason_len_ck
  CHECK (closed_reason IS NULL OR char_length(closed_reason) BETWEEN 1 AND 64);

-- The same opaque-id discipline 0005 applied to every other primary key.
-- 0019's table was excluded then because its key was a Telegram chat id — a
-- real external identifier, not an opaque one. Now that there is a surrogate
-- key, it carries the shared format like everything else.
ALTER TABLE control_plane.telegram_chat_bindings
  ADD CONSTRAINT telegram_chat_bindings_id_is_opaque
  CHECK (id ~ '^[a-z]{2,12}_[A-Za-z0-9]{8,64}$');
