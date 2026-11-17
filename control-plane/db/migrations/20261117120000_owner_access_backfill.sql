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
-- dashboard access, so neither is touched. Re-running changes nothing: no row matches once it has run.
UPDATE control_plane.trip_memberships
SET dashboard_access = true, runtime_access = true
WHERE role = 'owner'
  AND status = 'active'
  AND dashboard_access = false
  AND runtime_access = false;
