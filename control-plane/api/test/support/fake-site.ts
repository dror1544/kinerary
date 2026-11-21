/**
 * The trip site's adopt/release rules, as the control-plane tests' fake site applies them. The REAL rules are
 * server/control-plane-auth.js; tests/fixtures/site-binding-cases.json is the one case table both sides run (against the
 * real site in tests/control-plane-binding-cases.test.js, against these functions in site-binding-cases.test.ts), so the
 * fake cannot drift from the site without one of the two failing.
 */
export interface FakeSiteState {
  /** `<trip>:<username>` -> the control-plane user bound to that participant. */
  bindings: Map<string, string>;
  /** `<trip>:<username>` bound by an INVITE (never displaced, never released through this path). */
  invited: Set<string>;
  /** `<trip>:<username>` -> the invite id on an invite binding (what makes a second provision of the same invite idempotent). */
  inviteIds: Map<string, string>;
}
export interface FakeSitePerson { username: string; role?: string | undefined }

export const newFakeSiteState = (): FakeSiteState => ({ bindings: new Map(), invited: new Set(), inviteIds: new Map() });

export function fakeAdopt(state: FakeSiteState, people: readonly FakeSitePerson[] | undefined, input: { tripId: string; userId: string; runtimeUsername: string }): "ok" | "refused" | "conflict" {
  const key = `${input.tripId}:${input.runtimeUsername}`;
  const person = (people ?? []).find((p) => p.username === input.runtimeUsername);
  if (!person || person.role !== "member") return "refused";                       // not a participant, or an organizer
  if (state.invited.has(key)) return "conflict";                                  // an invite-bound binding is never displaced
  for (const [other, user] of state.bindings) {
    if (user === input.userId && other !== key && other.startsWith(`${input.tripId}:`)) return "conflict"; // this user already stands for someone else
  }
  state.bindings.set(key, input.userId);                                          // any other binding on the name is a leftover: replaced
  return "ok";
}

export function fakeRelease(state: FakeSiteState, input: { tripId: string; userId: string; runtimeUsername: string }): boolean {
  const key = `${input.tripId}:${input.runtimeUsername}`;
  if (state.invited.has(key) || state.bindings.get(key) !== input.userId) return false;
  state.bindings.delete(key);
  return true;
}

/**
 * The INVITE binding (POST /api/internal/control-plane/participants): a redeeming account is bound to an existing
 * participant with the invite's id on the binding. Differs from adopt in that the binding is invite-bound, and that
 * a leftover claim binding (not invite-bound) on the name is replaced: the control plane has already checked that no
 * claim is live. Held to the `provision` section of tests/fixtures/site-binding-cases.json.
 */
export function fakeProvision(state: FakeSiteState, people: readonly FakeSitePerson[] | undefined, input: { tripId: string; userId: string; runtimeUsername: string; inviteId: string }): "ok" | "refused" | "conflict" {
  const key = `${input.tripId}:${input.runtimeUsername}`;
  const person = (people ?? []).find((p) => p.username === input.runtimeUsername);
  if (!person || person.role !== "member") return "refused";
  if (state.invited.has(key)) {
    // The same invite by the same account again is idempotent; anyone else's invite binding is never displaced.
    return state.bindings.get(key) === input.userId && state.inviteIds.get(key) === input.inviteId ? "ok" : "conflict";
  }
  for (const [other, user] of state.bindings) {
    // This account already stands for a participant (another one, or this one by a claim, which is not an invite's binding).
    if (user === input.userId && other.startsWith(`${input.tripId}:`)) return "conflict";
  }
  // Whatever else is on the name is a leftover claim binding of another account: replaced.
  state.bindings.set(key, input.userId);
  state.invited.add(key);
  state.inviteIds.set(key, input.inviteId);
  return "ok";
}
