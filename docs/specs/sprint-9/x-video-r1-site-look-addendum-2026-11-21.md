# Addendum to `x-video-r1-site-look.md` — the video layout becomes the only layout (2026-11-21)

Decided by the owner on 2026-11-21. Append this to `x-video-r1-site-look.md` when that spec lands on `main`
(it is still on `docs/spec-video-r1-site-look`, so this addendum is its own file rather than a conflicting copy of it).

## Decisions

1. **The classic Modern layout is removed** ("it is now stale from my point of view"). Every `videoLayout` branch in
   `trip-web/src` keeps only the video side. The Classic *site* (`site/classic.html`, `site/app.js`, the organizer's
   "Open Classic organizer fallback" link) is a different thing and is not touched.
2. **`site_video_layout` is retired.** It is deleted from `shared/feature-switches.js` and from the worker's mirror
   (`feature_block.py`), as decision 3 of `567-feature-switches.md` says a finished switch is. This overrides that rule's
   30-day wait: the owner decided the switch has nothing left to switch. A trip file or a stored setting that still names it is
   harmless: an unregistered name is off, the site drops it at boot with a log line and counts it in the config warnings, and the
   operator command refuses to set it. `plan_change_marks` stays a switch and is now read on its own.
   AC-1 ("both switches off: byte-for-byte what it is today") and AC-2's "with the switch off" halves no longer apply; AC-4 now
   reads "a trip file still naming `site_video_layout` serves no `recent_change` and tells a member nothing about the name".
3. **The hero opens big, once.** On first open of a page load the header is shown open, about 92% of the screen's height, with a
   photo fade and scale-in of 800 ms. It is the existing "open" state of the pull-to-stretch (`hero-scroll.ts`), started on mount:
   scrolling down shrinks it to the compact bar and lets the opening go; the pull-at-top stretch is unchanged.
   - Once per page load, not per tab: switching tab or page lets an open header go; it is never reopened. A language toggle is not a
     page change.
   - `prefers-reduced-motion`: the header is still big, with no animation. Right to left and left to right are the same (logical
     properties only). No photo: the skyline motif is capped at 170 px high along the bottom edge and rises in.
4. **Today's "Readiness" band is replaced by a "Trip anchors" card**: every booking the Bookings tab reads (`GET /api/bookings`,
   no new route), in date order (undated last), one row each — icon by type (✈️ 🏨 🚗 🎟️ 📌), name, kind, date or range, and the phase
   when the trip has more than one. A row opens that booking on the Bookings page. Empty state: a line and a link to Bookings. No
   filtering by role: members see all trip data. The Readiness page (tasks, packing, useful information) stays reachable from the
   More menu and at `#readiness`. The old band's "confirmation missing" rows are gone from Today.
