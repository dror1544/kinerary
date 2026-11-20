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
}
export interface FakeSitePerson { username: string; role?: string | undefined }

export const newFakeSiteState = (): FakeSiteState => ({ bindings: new Map(), invited: new Set() });

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
