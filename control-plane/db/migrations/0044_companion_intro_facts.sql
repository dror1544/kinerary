-- The facts a companion introduces itself with, kept so a LATER group join can
-- still compose one.
--
-- The organizer's introduction is composed at provisioning time, from a payload
-- written into notification_outbox in the same transaction. The group's cannot
-- be: there is no group yet, and there may not be one for days. When the
-- organizer finally adds the bot to a family group, the run that knew the
-- assistant's name, the site URL and the shared login is long over.
--
-- So the same facts are kept on the trip. Not a cache of something derivable —
-- the seed password in particular exists nowhere else the control plane can
-- read, and re-deriving the rest would mean re-reading a trip config the API
-- deliberately never serves raw (sanitizeConfig's blanket rule).
--
-- Nullable, and every reader treats absent as "no introduction to send" rather
-- than a reason to fail: trips provisioned before this column existed simply do
-- not get a group introduction, which is exactly what they get today.
ALTER TABLE control_plane.trips
  ADD COLUMN IF NOT EXISTS companion_intro jsonb;

COMMENT ON COLUMN control_plane.trips.companion_intro IS
  'Facts for the companion introduction (assistant name, site URL, language, shared login, proactive schedule). Written at provisioning; read when the bot joins a group. Never served to a client.';
