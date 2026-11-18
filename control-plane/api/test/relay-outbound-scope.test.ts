/**
 * The outbound scope table (docs/specs/sprint-9/x-relay-chat-scope.md), pure:
 * every route kind against every kind of caller.
 */
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { ChatRoute } from "../src/chat-router.js";
import {
  CHAT_NOT_IN_SCOPE,
  SCOPE_CHECK_FAILED,
  outboundChatAllowed,
  outboundScopeOptions,
} from "../src/relay/outbound-scope.js";
import { hermesIsRetryable, hermesIsTimeout } from "./support/hermes-mirror.js";

const companion = (hermesProfile: string | null): ChatRoute => ({
  kind: "companion",
  tripId: "trip-1",
  hermesProfile,
  assistantNames: [],
});
const interview: ChatRoute = { kind: "interview", sessionId: "s1", tripId: "trip-1" };
const unbound: ChatRoute = { kind: "unbound" };

const OWN = "companion-colmar";
const OTHER = "companion-japan";
const INTERVIEWER = "kinerary-interviewer";
const MULTIPLEX = "kinerary-trip-intake";
const roles = { interviewerProfile: INTERVIEWER, multiplexGatewayId: MULTIPLEX };

describe("outboundChatAllowed", () => {
  test("a companion route with a profile: that profile and the declared multiplex gateway only", () => {
    assert.deepEqual(outboundChatAllowed(companion(OWN), OWN, roles), { allowed: true });
    assert.deepEqual(outboundChatAllowed(companion(OWN), MULTIPLEX, roles), { allowed: true });
    for (const caller of [OTHER, INTERVIEWER, "gw_x"]) {
      const verdict = outboundChatAllowed(companion(OWN), caller, roles);
      assert.equal(verdict.allowed, false, caller);
      if (!verdict.allowed) assert.equal(verdict.routeKind, "companion");
    }
  });

  test("a companion route with no profile: nobody, the multiplex gateway included", () => {
    for (const caller of [OWN, OTHER, INTERVIEWER, MULTIPLEX]) {
      const verdict = outboundChatAllowed(companion(null), caller, roles);
      assert.equal(verdict.allowed, false, caller);
      if (!verdict.allowed) assert.equal(verdict.routeKind, "companion_no_profile");
    }
    assert.equal(outboundChatAllowed(companion(""), OWN, roles).allowed, false, "an empty profile is no profile");
  });

  test("an interview route: the interviewer profile and the multiplex gateway only", () => {
    assert.deepEqual(outboundChatAllowed(interview, INTERVIEWER, roles), { allowed: true });
    assert.deepEqual(outboundChatAllowed(interview, MULTIPLEX, roles), { allowed: true });
    for (const caller of [OWN, OTHER, "gw_x"]) {
      const verdict = outboundChatAllowed(interview, caller, roles);
      assert.equal(verdict.allowed, false, caller);
      if (!verdict.allowed) assert.equal(verdict.routeKind, "interview");
    }
  });

  test("an unbound route: nobody", () => {
    for (const caller of [OWN, OTHER, INTERVIEWER, MULTIPLEX]) {
      const verdict = outboundChatAllowed(unbound, caller, roles);
      assert.equal(verdict.allowed, false, caller);
      if (!verdict.allowed) assert.equal(verdict.routeKind, "unbound");
    }
  });

  test("multiplex gateway not configured: no id is allowed on a route that is not its own", () => {
    const none = {};
    assert.equal(outboundChatAllowed(companion(OWN), MULTIPLEX, none).allowed, false);
    assert.equal(outboundChatAllowed(companion(OWN), "", none).allowed, false, "an empty id is not 'unset equals unset'");
    assert.deepEqual(outboundChatAllowed(companion(OWN), OWN, none), { allowed: true });
    assert.equal(outboundChatAllowed(interview, MULTIPLEX, none).allowed, false);
    assert.equal(outboundChatAllowed(interview, OWN, none).allowed, false);
    // Empty-string settings are unset, not a wildcard.
    assert.equal(outboundChatAllowed(interview, "", { interviewerProfile: "", multiplexGatewayId: "" }).allowed, false);
  });

  test("interviewer profile not configured: the interview row is the multiplex gateway's alone", () => {
    const r = { multiplexGatewayId: MULTIPLEX };
    assert.equal(outboundChatAllowed(interview, MULTIPLEX, r).allowed, true);
    assert.equal(outboundChatAllowed(interview, INTERVIEWER, r).allowed, false);
  });

  test("a refusal reason is a fixed word that names no profile", () => {
    const verdict = outboundChatAllowed(companion(OWN), OTHER, roles);
    assert.equal(verdict.allowed, false);
    if (!verdict.allowed) {
      assert.ok(!verdict.reason.includes(OWN) && !verdict.reason.includes(OTHER), verdict.reason);
    }
  });

  test("a route kind this function does not know is refused", () => {
    const verdict = outboundChatAllowed({ kind: "something-new" } as unknown as ChatRoute, OWN, roles);
    assert.equal(verdict.allowed, false);
  });
});

describe("the interviewer's own private chat between confirmation and the companion's binding", () => {
  const handover = { kind: "interview_handover" } as const;

  test("the interviewer profile and the multiplex gateway are allowed; a companion, and any other id, are refused", () => {
    assert.deepEqual(outboundChatAllowed(handover, INTERVIEWER, roles), { allowed: true });
    assert.deepEqual(outboundChatAllowed(handover, MULTIPLEX, roles), { allowed: true });
    for (const caller of [OWN, OTHER, "gw_x", ""]) {
      const verdict = outboundChatAllowed(handover, caller, roles);
      assert.equal(verdict.allowed, false, caller);
      if (!verdict.allowed) assert.equal(verdict.routeKind, "unbound");
    }
  });

  test("nothing configured: nobody", () => {
    assert.equal(outboundChatAllowed(handover, INTERVIEWER, {}).allowed, false);
    assert.equal(outboundChatAllowed(handover, "", { interviewerProfile: "", multiplexGatewayId: "" }).allowed, false);
  });
});

describe("the refusal words", () => {
  test("neither is a timeout nor retryable to the captured Hermes classifier (AC-9)", () => {
    for (const word of [CHAT_NOT_IN_SCOPE, SCOPE_CHECK_FAILED]) {
      assert.equal(hermesIsTimeout(word), false, `${word} must not read as a timeout`);
      assert.equal(hermesIsRetryable(word), false, `${word} must not be retried`);
    }
  });
});

describe("outboundScopeOptions", () => {
  test("without a database nothing is wired, so the connector refuses every outbound action", () => {
    assert.deepEqual(outboundScopeOptions(undefined, INTERVIEWER), {});
  });
});
