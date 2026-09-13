-- The assistant's wake-words, as a routing fact the control plane owns.
--
-- Sprint 5 puts one shared bot in every trip's group chat. In a DM that is
-- fine — a 1:1 with the bot is addressed to the bot by definition. In a GROUP
-- it is not: without a relevance gate the bot answers every message between
-- family members, which is both useless and, on a shared bot, a way to burn
-- one trip's tokens on another trip's small talk.
--
-- Hermes solves this for a directly-connected adapter with
-- `telegram.mention_patterns`. That does NOT survive the relay: the gateway
-- projects only a generic policy (requireAddress / freeResponseScopes /
-- allowOtherBots) to a connector, and mention_patterns is not in that
-- vocabulary — the adapter that reads it is disabled outright by the
-- relay-exclusive sweep. So under Sprint 5's model the wake-word gate is the
-- ROUTER's job, and the router needs its own copy of the names rather than
-- reaching into a Hermes profile directory it cannot see from a container.
--
-- Both languages, because that is how a bilingual group actually types: the
-- same assistant is "בוטסאן" to one person and "botsan" to the next. Stored as
-- an array rather than two columns for exactly that reason — the count is a
-- property of the trip, not of the schema, and a trip may reasonably carry a
-- nickname as a third entry.
--
-- NULL and empty both mean "no names configured", and the gate treats them the
-- same way: fall back to @mention and reply-to-bot, which is the connector's
-- documented default. It deliberately does NOT mean "answer everything".
ALTER TABLE control_plane.trips
  ADD COLUMN assistant_names text[];

-- A NULL *element* is the one genuinely broken shape: it is not a name, and it
-- makes every read of the array carry a null check that nothing else needs.
--
-- Deliberately NOT checking for blank/whitespace entries here, though the first
-- draft did. PostgreSQL forbids a subquery in a CHECK, so expressing "no
-- element is blank" over an array needs either unnest (a subquery) or a custom
-- IMMUTABLE function — machinery out of proportion to the risk, because a
-- blank entry is already inert: addressing.ts's mentionsName() trims its name
-- and returns false on an empty one, so a blank wake-word matches nothing
-- rather than matching everything. There is a test for exactly that.
ALTER TABLE control_plane.trips
  ADD CONSTRAINT trips_assistant_names_no_null_elements
  CHECK (assistant_names IS NULL OR array_position(assistant_names, NULL) IS NULL);
