-- rollback: compatible — data-only: sets two existing boolean flags to true on owner rows; no schema change, and older code reads the same columns
-- An owner who cannot open their own trip.
--
-- signup.ts (grantApproved) and organizer-invite.ts (createTripFor) inserted the owner's trip_memberships row
-- without dashboard_access / runtime_access, so both took their column default (false, migration 0020). Every access
-- query filters on those flags (telegram-mini-app.ts loadAccess, portal.ts), so a trip created through either path
-- had an owner who could not open it: a Mini App launch ignored the chat's active trip and showed the chooser.
-- Both inserts now set the flags; this repairs the rows already written.
--
-- Scope is deliberately narrow: role = 'owner' AND status = 'active' AND both flags false. Secondary organizers
-- (role 'organizer') are dashboard_access = false on purpose (secondary-organizers.ts), and members never get
-- dashboard access, so neither is touched. A torn-down trip (slug renamed `retired-…`, or a binding closed
-- 'trip_destroyed') is left as it is: teardown keeps the owner's membership active, and granting access to a trip
-- that no longer exists would only reopen routes that do not check retirement. Re-running changes nothing: no row
-- matches once it has run.
UPDATE control_plane.trip_memberships m
SET dashboard_access = true, runtime_access = true
WHERE m.role = 'owner'
  AND m.status = 'active'
  AND m.dashboard_access = false
  AND m.runtime_access = false
  AND NOT EXISTS (SELECT 1 FROM control_plane.trips t WHERE t.id = m.trip_id AND t.slug LIKE 'retired-%')
  AND NOT EXISTS (SELECT 1 FROM control_plane.telegram_chat_bindings d
                   WHERE d.trip_id = m.trip_id AND d.closed_reason = 'trip_destroyed');
