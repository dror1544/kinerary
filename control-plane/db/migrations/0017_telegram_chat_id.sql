-- user_identities has only ever stored an irreversible SHA256 digest of the
-- Telegram numeric ID (provider_subject_digest) — correct for identity
-- verification, but it means nothing in this codebase can ever message a
-- user back. Sprint 4's own exit gate requires the organizer receive a real
-- Telegram DM with their trip's private URL once provisioning completes, so
-- something has to hold a real, sendable chat id.
--
-- provider_subject_id is that value: the raw Telegram numeric id, kept
-- alongside the digest rather than instead of it (the digest stays the
-- identity-verification path; nothing about it changes). Nullable because
-- older rows predate this column and existing verification logic never
-- required it. Application code must never return this column through any
-- read API — same treatment as every other sender-only value in this
-- schema (approval tokens, webhook secrets).

ALTER TABLE control_plane.user_identities
  ADD COLUMN provider_subject_id text;
