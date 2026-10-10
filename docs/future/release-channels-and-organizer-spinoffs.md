# Release channels, per-trip versions and organizer spin-offs

Status: **concept — not built.** The idea was confirmed by the owner on
2026-09-25. Its first slice (record which version built each trip, #127
option 1) is what the owner chose to do "now" on #127; #127 carries no sprint
milestone, and #190 says nothing else in it is scheduled for Sprint 6. This document is
to be settled **before slice 3** is started.

Tracked in #190 (the requirement, the owner's words, the slices) and #127 (the
first slice). Read the "From the owner" and "Proposed" labels below: only the
first kind is decided.

## The idea

Today every trip runs whatever the last person to install a companion happened
to point the installer at. The end state is different in kind: **an organizer
can make their own change to how their trip behaves, it goes live for that trip
only, and the product learns from whether it helped.** A change that proves
itself can become part of the product for everyone, with the organizer credited.

That loop is the point. Pinning a trip to a version, giving trips to channels
and running A/B comparisons are the plumbing that makes the loop possible.

## Why this is not just "versioning"

Three separate wishes, all from the owner, arrived together and pull the same
way:

- **A/B testing** — different trips run different versions, and the difference
  is measured.
- **Future-only rollout** — existing trips keep the version they have; new trips
  get a newer one; some families are alpha or beta users.
- **The organizer's own spin-off** — the crown jewel. A change made by one
  organizer, deployed only for them, visible to nobody else, from which the
  product can learn.

The first two are operator-driven. The third hands the pen to the organizer,
which is what makes the safety questions below serious rather than procedural.

## Where things stand

- A companion is rendered and wired by **whichever checkout the SSH forced
  command names** (#127). That is one global, unrecorded choice for every trip.
- The control plane already has a **release registry** — a release moves
  `candidate → verified → available`, and provisioning selects from the
  `available` ones — but the companion install path does not use it, and a trip
  does not record which version built it.
- Nothing lets one trip differ from another on purpose.

## Layer 1 — the plumbing (operator-facing)

From the requirement in #190:

1. **Every trip records the version that built it** — release id and template
   hash — and the fleet monitor can see it.
2. **Per-trip pinning.** A trip keeps its version until an operator moves it.
   A newer version becoming available changes nothing for existing trips.
3. **Channels and cohorts.** A new trip is assigned to a channel (`stable`,
   `beta`, `alpha`), each channel resolves to a release, and an operator can
   assign a named cohort or a percentage for an A/B comparison. Assignment is
   recorded so results can be compared later.
4. **Upgrade and rollback per trip**, with a recorded way back — the way the
   control plane's own release tooling already works — and never as a side
   effect of a shared checkout.
5. **Build from a release artifact, not a working directory.** Companion
   templates ship inside the release the control plane selects, and the
   installer is given a release id (#127 option 2).
6. **Deployment-neutral.** Channels, cohorts and pins are data and
   configuration. Nothing in the mechanism names a host, an address or a
   container of any one deployment.

## Layer 2 — the loop (the crown jewel)

**From the owner:** *the organizer can spin off their own change, which is
deployed only for them, but the product can learn from it.*

1. **The organizer makes a change** to their own trip's experience — how the
   assistant behaves, what the site shows, what it asks or reminds them of —
   without waiting for the product team.
2. **It is deployed for that trip only.** A spin-off is owned by that organizer,
   invisible to every other trip, and has a recorded way back.
3. **The product learns from it:** what the variant changed and whether it
   helped, measured by the outcome events that track 2 builds (#177 and what
   follows it), against trips that did not change.
4. **What works can be promoted.** A variant that proves itself becomes a
   candidate release for a channel, moving `alpha` → `beta` → `stable`, and the
   organizer who found it is told and credited.

## What an organizer may change — the safe surface

**Proposed, not decided.** The surface is **configuration and instruction, not
code**: the companion's persona and standing instructions, its reminders and
prompts, which modules the site shows, site configuration. Never code.

The boundary is an **allow-list**, and it fails the same way the rest of the
product's visibility rules do: anything not declared as changeable is refused,
and an unrecognised field resolves to "not allowed", never to "allowed". This
is the lesson of the configuration-serving work in #172 — a deny-list quietly
passes whatever it was never told about, and a spin-off surface would be the
place that mistake costs the most.

## Invariants a spin-off can never break

**Proposed, not decided** — but each of these is already a rule of the
product, and a spin-off may not relax any of them:

- The **visibility and authentication rules** that decide who sees what within
  a trip and outside it.
- What the companion is allowed to **do to trip data**, and who it may act for.
- **Spend limits** — a variant cannot raise its own model or tool budget.
- **Other families' privacy.** A spin-off sees only its own trip.

The requirement underneath all four: **a spin-off cannot widen its own
permissions.** The layer that applies an overlay must be unable to grant more
than the base version grants, however the overlay is worded.

## How an organizer says what they want

**Open.** Three candidates, and the choice is the organizer's experience, not a
technical detail:

- **In conversation** — "from now on remind us about the tickets the night
  before." The most natural, and the one where the safe surface is hardest to
  enforce, because the request arrives as free text.
- **A form** — a fixed set of options. Easy to keep inside the surface, and
  the least flexible.
- **A file** — for organizers who want to. Precise, and unsuitable for most.

Whichever it is, the stored result is the same: a **versioned overlay** on the
trip — *base version + this organizer's change* — so it survives a base upgrade
and can be diffed, reverted and compared. Slice 2 below is that data model.

## Review and preview

**Open.** Which changes go live at once because they sit inside the safe
surface and pass an automatic check, and which wait for an operator? Either
way, an organizer should see a **preview or dry run** before a change goes live
for their family.

## Learning without surveillance

The product can only learn from a family's variant by measuring what happened,
and that is acceptable only inside the consent and retention model that is
still to be settled before full production (#186). Whatever the loop measures
about a variant must be **counts and categories — never transcripts**, in line
with the metadata stance recorded for the analytics work
(`docs/trip-bot-analytics-and-metrics-design.md`, §16).

## Promotion

**Open.** Who decides that a variant becomes a release candidate, on what
evidence, and how the originating organizer is told and credited. The evidence
question depends on track 2's outcome events being trustworthy first.

## When the base version moves

**Open, and the hardest interaction.** A security fix has to reach every trip,
including pinned ones and ones carrying a spin-off. Two questions follow:

- How does a **pin** give way to a fix that must not wait?
- When the base changes under a spin-off, does the overlay **rebase
  automatically**, or does it **hold and ask** the organizer? Rebasing silently
  risks changing what the organizer chose; holding risks leaving a family on an
  old base.

## Sequence

Each slice is useful on its own.

1. **Record the version that built every trip** (#127 option 1: the commit, a
   dirty-tree flag and an allowed-ref check, shown to the fleet monitor).
   *Chosen "now" by the owner on #127 (2026-09-25).*
2. **Per-trip pin plus a stored overlay** — the data model for "base + this
   organizer's change".
3. **A safe, allow-listed overlay surface and a way to author it.**
4. **Channels, cohorts and A/B assignment.**
5. **Outcome comparison between variants**, then **promotion** to a release
   candidate.

## To settle before slice 3

- Is the unit of versioning the **companion profile**, the **trip-site
  payload**, or both? (#190 asks the same.)
- Exactly what is on the safe surface, and how it is enforced when the request
  arrives as free text.
- How an organizer authors a change (conversation, form or file).
- Which changes need an operator, and what the preview shows.
- How a pin interacts with a fix that must reach every trip.
- What "helped" means, in terms track 2 can measure.

## Related

- #190 — the requirement and the owner's words
- #127 — which checkout builds a companion (slice 1 and the release-artifact
  installer)
- #119 and #177 — a bridge-key defect and the outcome events the loop would
  learn from
- #172 — the allow-list rule the safe surface must follow
- #186 — consent, notice and retention before full production
- #189 — the Hermes upgrade, which has the same need in miniature: try a new
  version on a small part of the fleet before the rest
