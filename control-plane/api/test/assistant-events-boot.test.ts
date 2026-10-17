/**
 * #327 precondition 1: `relay/server.ts`'s boot line for assistant events.
 *
 * Unset -> no emitter, no purge timer, one log line `assistant_events.disabled`.
 * `ASSISTANT_EVENTS_ENABLED=1` -> emitter wired, purge scheduled, one log line
 * `assistant_events.enabled`. The line carries the effective boolean and the
 * word "env" — never the raw setting value, which is not itself a secret but
 * is also not part of the fixed contract a boot check greps for.
 *
 * "No emitter" and "no purge timer" for the unset case are ALREADY GREEN,
 * pinned by assistant-events-replay.test.ts ("with the setting unset, the
 * week writes nothing") and assistant-events-purge-schedule.test.ts ("flag
 * unset, 0, or a typo: no timer is created and purge is never called") —
 * this file re-asserts the same two functions directly rather than
 * duplicating those suites, and is the ONLY new-behaviour half: the log line
 * itself, which did not exist before this change (RED before, GREEN after).
 *
 * `relay/server.ts` runs `main()` on import (see
 * assistant-events-purge-schedule.test.ts's own wiring-pin test, which
 * established this exact technique first), so its boot line is verified by
 * reading the source rather than executing the entrypoint.
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import type pg from "pg";
import { assistantEventsFromEnv, assistantEventsSetting } from "../src/analytics/emitter.js";
import { startAssistantEventsPurge } from "../src/analytics/purge-schedule.js";

const fakeDb = {} as pg.Pool;

describe("assistant-events boot: the effective setting", () => {
  test("unset, 0, or a typo: OFF, and unrecognized values say so", () => {
    assert.deepEqual(assistantEventsSetting({}), { enabled: false, unrecognized: false });
    assert.deepEqual(assistantEventsSetting({ ASSISTANT_EVENTS_ENABLED: "" }), { enabled: false, unrecognized: false });
    assert.deepEqual(assistantEventsSetting({ ASSISTANT_EVENTS_ENABLED: "0" }), { enabled: false, unrecognized: false });
    assert.deepEqual(assistantEventsSetting({ ASSISTANT_EVENTS_ENABLED: "true" } as NodeJS.ProcessEnv), { enabled: false, unrecognized: true });
  });

  test("exactly \"1\": ON", () => {
    assert.deepEqual(assistantEventsSetting({ ASSISTANT_EVENTS_ENABLED: "1" } as NodeJS.ProcessEnv), { enabled: true, unrecognized: false });
    // Surrounding whitespace, as a hand-edited env file tends to carry, is trimmed.
    assert.deepEqual(assistantEventsSetting({ ASSISTANT_EVENTS_ENABLED: " 1 \n" } as NodeJS.ProcessEnv), { enabled: true, unrecognized: false });
  });

  test("unset: no emitter and no purge timer — the two things the boot line promises", () => {
    const events = assistantEventsFromEnv({}, fakeDb, () => {});
    assert.equal(events, undefined, "no emitter");
    let timers = 0;
    const stop = startAssistantEventsPurge({}, fakeDb, () => {}, {
      scheduler: {
        setTimeout: () => { timers += 1; return {}; },
        setInterval: () => { timers += 1; return {}; },
        clearTimeout: () => {},
        clearInterval: () => {},
      },
    });
    assert.equal(stop, undefined, "no purge timer");
    assert.equal(timers, 0);
  });

  test("\"1\" with a database: emitter wired, purge scheduled", () => {
    const events = assistantEventsFromEnv({ ASSISTANT_EVENTS_ENABLED: "1" } as NodeJS.ProcessEnv, fakeDb, () => {});
    assert.ok(events, "the emitter is wired");
    events!.stop();
    let timers = 0;
    const stop = startAssistantEventsPurge({ ASSISTANT_EVENTS_ENABLED: "1" } as NodeJS.ProcessEnv, fakeDb, () => {}, {
      scheduler: {
        setTimeout: () => { timers += 1; return {}; },
        setInterval: () => { timers += 1; return {}; },
        clearTimeout: () => {},
        clearInterval: () => {},
      },
    });
    assert.equal(typeof stop, "function", "the purge is scheduled");
    assert.equal(timers, 2);
    stop!();
  });
});

describe("assistant-events boot: the log line relay/server.ts emits", () => {
  test("the boot line names the effective boolean and the source, never the raw setting value", async () => {
    const source = await readFile(fileURLToPath(new URL("../src/relay/server.ts", import.meta.url)), "utf8");
    assert.match(
      source,
      /import \{ assistantEventsFromEnv, assistantEventsSetting \} from "\.\.\/analytics\/emitter\.js"/,
      "imports the pure setting reader, not just the emitter factory",
    );
    // The exact call, so a rework that renames the event or drops a field
    // fails this test rather than silently changing what a restart script
    // can grep for.
    assert.match(
      source,
      /const eventsSetting = assistantEventsSetting\(process\.env\);/,
    );
    const bootLine = source.slice(source.indexOf("const eventsSetting = assistantEventsSetting"));
    assert.match(
      bootLine,
      /log\(structuredLog\("info", eventsSetting\.enabled \? "assistant_events\.enabled" : "assistant_events\.disabled", \{/,
    );
    // Exactly two fields: the effective boolean and the literal source "env".
    // Anything else here is a secret risk this test exists to catch — see
    // #327's "ask the manager" clause: the boot line must never grow past the
    // boolean and the word "env".
    const call = bootLine.slice(0, bootLine.indexOf("}));") + 4);
    assert.match(call, /enabled: eventsSetting\.enabled,/);
    assert.match(call, /source: "env",/);
    // Only the object literal's own fields, not the ternary's `? … :` colon.
    const fields = call.slice(call.indexOf("{"), call.lastIndexOf("}"));
    assert.equal((fields.match(/^\s*\w+:/gm) ?? []).length, 2, "no third field snuck into the boot line");
    // It fires unconditionally at boot — before the `if (runtime.db) {` gate
    // that guards polling and the purge schedule — so a conformance-mode
    // process (no database at all) still says which state it chose, exactly
    // like relay.assistant_events does one line above.
    const bootLineIndex = source.indexOf("const eventsSetting = assistantEventsSetting");
    const dbGateIndex = source.indexOf("if (runtime.db) {");
    assert.ok(dbGateIndex === -1 || bootLineIndex < dbGateIndex, "the boot line runs before the db-only gate, not inside it");
  });
});
