# Who owns a trip's companion identity

**Status: proposal, not implemented.** Written 2026-09-11, from the gap that
`/switch` exposed: `italy-2026` has a working companion on disk
(`~/.hermes/profiles/italy2026`) and no way to become active, because the only
place the control plane ever recorded that name was a chat binding it never
got to write.

This is a follow-up to `trip-bot-command-surface.md`, not a prerequisite. The
commands ship without it; they simply cannot activate a companion the database
cannot name.

## 1. The defect, stated precisely

Two different questions are answered by one column.

| Question | Should be owned by | Is owned by today |
|---|---|---|
| which trip is this chat talking to? | `telegram_chat_bindings` | `telegram_chat_bindings` ✓ |
| which companion serves this trip? | the trip | `telegram_chat_bindings.hermes_profile` ✗ |

`hermes_profile` is a **property of the trip** stored on the **chat binding**.
Every consequence below follows from that one misplacement:

- A trip with no binding has no companion identity, however well-provisioned
  it is. That is `italy-2026`.
- `attach_profile_to_orphan_bindings` exists only to copy the value between
  rows that should never have held it separately.
- A trip with several bound chats stores the same string N times, and nothing
  makes those N copies agree.
- `/switch` has to reconstruct the value by reading *some other chat's*
  binding — which is why it silently produces a NULL for a trip that has never
  had one.

The provisioner already knows the right answer:
`hermes_profile = self._companion.install(handoff)`
([provisioner.py:1094](../control-plane/worker/control_plane_worker/provisioner.py)).
It is trip-scoped at the moment it is computed, and it is immediately written
somewhere chat-scoped.

**There is already precedent for the fix in this codebase.** Two other
companion facts were needed by the router and were correctly put on the trip:
`trips.assistant_names` (migration 0030 — "recorded as a ROUTING fact… the
router needs its own copy") and `trips.companion_intro` (0044). The profile
name is the one companion fact that did not get the same treatment.

## 2. The proposal — one column, one deletion

Add `trips.companion_profile text`. Make it the only writer and the only
reader. Delete the machinery that existed to keep the copies in sync.

The reason this is the *smallest* coherent fix rather than merely a correct
one is visible in the hot path. `resolveChatRoute` **already joins `trips`**:

```sql
SELECT b.trip_id, b.hermes_profile, t.assistant_names
  FROM control_plane.telegram_chat_bindings b
  JOIN control_plane.trips t ON t.id = b.trip_id
 WHERE b.chat_id = $1 AND b.closed_at IS NULL
```

so the routing change is `b.hermes_profile` → `t.companion_profile`. No new
query, no new join, no second lookup that could disagree with the first.

### Naming

`companion_profile`, matching `companion_intro` — not `hermes_profile`. The
value is "the address of this trip's companion"; that it is currently a Hermes
profile directory is one deployment's answer (§9). The wire field
(`source.profile`) and the gateway id stay as they are — this is a change of
*owner*, not of vocabulary, and renaming the protocol would make it bigger for
no gain.

## 3. How provisioning writes it

Inside the transaction that already records the trip's other companion facts,
next to `assistant_names`:

```python
hermes_profile = self._companion.install(handoff)
if hermes_profile:
    cur.execute(
        "UPDATE control_plane.trips SET companion_profile = %s WHERE id = %s",
        (hermes_profile, trip_id),
    )
```

Written **before** `bind_chat_to_trip`, so the identity exists whether or not
a chat is ever bound — which is the whole defect. `bind_chat_to_trip` loses
its `hermes_profile` parameter, and `attach_profile_to_orphan_bindings` is
**deleted**: it repairs a denormalisation that no longer exists.

Note what does *not* change: `install()` remains the single source of the
value, and it stays best-effort and non-fatal (A4). A failed install leaves
`companion_profile` NULL, the trip still deploys, still serves its site, and
still binds its chat.

## 4. How binding and switching resolve it

They stop resolving it at all — that is the point. Both become pure
chat→trip operations:

- `resolveChatRoute` reads `t.companion_profile` (one word, above).
- `switchChatToTrip` drops its "inherit the profile from the trip's most
  recent binding that has one" block entirely.
- `GET /internal/chat-routing` ([app.ts:1375](../control-plane/api/src/app.ts))
  joins `trips` the same way and keeps returning `hermesProfile` on the wire.

A switch then activates the correct companion by construction, because it
never carried the identity in the first place.

## 5. `italy-2026`, and every trip like it

The backfill has to answer: *which already-provisioned trips have a companion,
and what is it called?*

**The name is deterministic.** `_slugify_profile_name(slug)`
([companion_profile.py:26](../control-plane/worker/control_plane_worker/companion_profile.py))
strips non-alphanumerics from the slug. Checked against every profile actually
on the host on 2026-09-11:

| trip slug | derived | on disk |
|---|---|---|
| `italy-2026` | `italy2026` | ✓ |
| `japan-2026` | `japan2026` | ✓ |
| `japan-tokyo-hakone-kyoto-osaka-2026` | `japantokyohakonekyotoosaka2026` | ✓ |
| `shiran-usa-2026` | `shiranusa2026` | ✓ |

**Deriving it at ROUTING time would still be wrong, and the distinction is the
whole of this section.** Derivation gives a *name*; it gives no evidence the
thing exists. A trip whose companion never installed would derive a perfectly
well-formed name for a profile that is not there, and the router would address
a gateway that will never answer — failing silently, which is worse than
`companionPending` saying so honestly. So the router never derives.

**A backfill may derive, because a backfill can require evidence.** The
control plane already holds its own proof of a successful install:
`trips.assistant_names` is written **only** in the branch after
`install()` returned a name (provisioner.py, the `else:` after the null-check).
So:

```sql
UPDATE control_plane.trips t
   SET companion_profile = COALESCE(
         -- Strongest: a binding the provisioner itself wrote.
         (SELECT b.hermes_profile
            FROM control_plane.telegram_chat_bindings b
           WHERE b.trip_id = t.id AND b.hermes_profile IS NOT NULL
           ORDER BY b.created_at DESC LIMIT 1),
         -- Next: the control plane's own record that an install succeeded,
         -- with the name recomputed by the same rule that created it.
         CASE WHEN t.assistant_names IS NOT NULL
              THEN <slugify(t.slug)> END)
 WHERE t.companion_profile IS NULL;
```

On the current dev database that recovers `japan-2026` from its binding and
**`italy-2026` from its `assistant_names`** — the exact trip that could not be
switched to. No reprovisioning, no hand-filled column.

`assistant_names` is sufficient evidence, not necessary: a companion installed
for a trip whose assistant had no name would be missed (one such row exists —
`retired-japan-tokyo-hakone-kyoto-osaka-2026-2`). Those fall to §6's reconcile
path rather than being guessed.

**This does not contradict `_record_reachability`'s rule, and the difference
is worth stating because it looks like it does.** That function's docstring
forbids deriving reachability *"not from an open binding row, not from
`assistant_names` being populated"*, because "a binding can outlive the
profile it points at — exactly the false-healthy state that makes an
independent retry impossible to reason about."

The backfill here derives a **name**, which is a historical fact about what
provisioning installed. It does not derive **reachability**, which stays
exactly where it is: separately determined, never inferred from this column.
Writing `companion_profile` therefore says "this is what the companion is
called", never "the companion is up" — and a trip with a populated
`companion_profile` and no gateway connected under it is still unreachable,
reported as such, and still retryable. Keeping those two claims apart is the
same discipline that comment is defending.

## 6. Failure behaviour

| State | Behaviour |
|---|---|
| `companion_profile IS NULL` | Route resolves `companion` with a null profile — unchanged from today. `normalize.ts` drops with `COMPANION_PENDING`; the organizer is told the assistant is still being finished. Binding and switching still work. |
| Set, but no gateway connected for it | Already handled: `canReachProfile` → the trip is reported unreachable rather than served by another trip's process (`relay.multiplex_gateway_id` is the declared exception). |
| Set, but the profile does not exist on the host | Same as above — no gateway ever connects under that id. Detectable, and worth a `reachability` reason rather than silence. |
| Backfill could not determine a name | Left NULL. **Never derived at read time.** A `reconcile-companion` worker task — `install()` is idempotent and returns the name — is the recovery, and it is a normal provisioning operation rather than a database edit. |

The invariant to keep: **NULL means "no companion known", and it is always
honest.** A wrong non-NULL value is the failure mode worth engineering
against, because it fails silently.

## 7. Duplication removed

- `attach_profile_to_orphan_bindings` — **deleted** (~35 lines plus its tests).
- `bind_chat_to_trip`'s `hermes_profile` parameter and its
  "profile changed → close and reopen" branch — **deleted**. A binding
  lifecycle event should mean the chat moved, not that the companion was
  renamed; `profile_rebound` as a `closed_reason` stops existing.
- `redeemGroupBindingToken`'s `SELECT … WHERE trip_id = $3 AND hermes_profile
  IS NOT NULL ORDER BY created_at DESC LIMIT 1` inheritance — **deleted**.
- `switchChatToTrip`'s copy of that same inheritance — **deleted before it
  ever ships to anyone but this branch**.
- `telegram_chat_bindings.hermes_profile` — dropped in a **second** migration,
  after readers have moved, so a rollout is never mid-flight against a column
  that vanished. History is preserved by the trip column; the binding rows
  keep their real subject (which chat, which trip, when, why closed).

## 8. Tests that would have to pass

The one that proves the actual bug is fixed:

- **switching to an already-provisioned trip that has never had a binding
  activates its companion** — seed a trip with `companion_profile` set and
  *no* `telegram_chat_bindings` row at all, `/switch` to it, assert the
  resolved route carries that profile and that a subsequent message is stamped
  with it. This fails today and is the regression test for `italy-2026`.

Then:

- `/switch` between two trips activates each trip's own companion, and the
  second switch does not inherit the first's profile.
- A trip with `companion_profile IS NULL` binds, routes, and answers
  `companionPending` — never addresses a derived name.
- Two chats bound to one trip resolve the **same** profile, with no row
  carrying a copy.
- Provisioning writes `companion_profile` when no chat is bound at all
  (`recipient_chat_id` absent) — the case that produced this defect.
- The backfill recovers `japan-2026` from a binding and `italy-2026` from
  `assistant_names`, and leaves a trip with neither at NULL.
- Backfill is idempotent and re-runnable.
- The two-trip isolation matrix still holds: one trip's profile never reaches
  another trip's chat.

## 9. How this maps to one-process-per-trip / K3s

It is the change that makes that model expressible, rather than merely
compatible with it.

`per-trip-gateway-architecture.md` §4 already concludes **"the gateway id is
the profile name"** — one address, "with no second registry to keep in sync."
It then names where that address is read from: *"the binding already stored in
`trip_chat_bindings.hermes_profile`"*. That is the sentence this proposal
changes. Under one gateway per trip, the gateway id is a property of the
**trip's workload**, and reading it from a chat binding means a trip cannot be
addressed until somebody has talked to it — which is precisely backwards for
a process you intend to start, health-check, and route to.

The K3s plan already states the invariant this satisfies, as design principle
8: *"Companion configuration derives from **canonical trip/profile data**;
durable Hermes state belongs to the Hermes persistence model and is tenant
keyed."* Today it derives from a chat binding, which is neither canonical nor
trip data.

Concretely, `trips.companion_profile` becomes the tenant key:

- **Now** — a Hermes profile directory on the host, `install()`'s return value.
- **Per-trip gateway** — the gateway id a connected socket authenticates as,
  which `connector.ts` will key its `Map<string, Set<WebSocket>>` by.
- **K3s** — the workload identity: Deployment/Service name in the
  `kinerary-trips` namespace, and the tenant key for the companion's durable
  state.

All three are the same string, owned by the trip, written by whichever
`CompanionProfileAdapter` fulfilled the install —
`SshCompanionProfileAdapter`'s own docstring already anticipates this: *"The
planned K3s direction makes a trip companion an orchestrated deployable unit;
that becomes another implementation of this same `install()` and this class is
deleted."* Nothing above the adapter learns which one ran, which is only true
if the value lands in one trip-scoped place.

## 10. Sequencing, and why it does not block the commands

`/trips` and `/switch` ship first and unchanged. They are correct under both
models: they route chat→trip, which is the half that was never in question.
The only difference this makes to them is that `/switch` to a
never-bound-but-provisioned trip starts activating the companion instead of
reporting it pending — and it reports it honestly in the meantime.

Migration 0050 (the organizer links) is independent of everything here: a new
table keyed by Telegram digest, touching neither `trips` nor
`telegram_chat_bindings`. Deploying it now makes this work no harder.

**One sequencing hazard, already hit and resolved.** Migration numbers are
claimed per branch and the version key is the *filename*.
`feat/interview-interpret` had already taken `0048` and `0049` and applied
both to the dev database, so the organizer-links migration was renumbered
`0050` **before** being applied — had it gone in as `0048_telegram_organizer_links.sql`
and been renamed afterwards, `applyMigrations` would have re-run it under the
new name against a table that already existed. Whoever writes the migration in
this document should check the applied set on the target database first, not
just the highest number in their own branch.
