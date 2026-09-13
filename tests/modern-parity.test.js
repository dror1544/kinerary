import assert from "node:assert/strict";
import { before, after, test } from "node:test";
import {
  startTestServer,
  stopTestServer,
  api,
  loginAsAlice,
} from "./helpers/server.js";
import { PORTS } from "./helpers/ports.js";
let owner, member;
before(async () => {
  await startTestServer({ PORT: PORTS.modernParity });
  owner = await loginAsAlice();
  member = (
    await (
      await api("/api/auth/login", {
        method: "POST",
        body: { username: "bob", password: "1234" },
      })
    ).json()
  ).token;
});
after(stopTestServer);
const active = async () =>
  await (await api("/api/itinerary/active", { token: owner })).json();
async function edit(path, method, body, revision, token = owner) {
  return fetch(`http://127.0.0.1:${PORTS.modernParity}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      ...(revision ? { "if-match": revision } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
}
test("day title mutation refuses anonymous and member access", async () => {
  const body = {
    phase_id: "ny",
    date: "2026-08-01",
    label_he: "יום",
    label_en: "Day",
  };
  assert.equal(
    (await api("/api/itinerary/days", { method: "PATCH", body })).status,
    401,
  );
  assert.equal(
    (await api("/api/itinerary/days", { method: "PATCH", body, token: member }))
      .status,
    403,
  );
});
test("day title updates persist into Classic and preserve an immutable original", async () => {
  let state = await active();
  let day = state.days[0];
  if (!day) {
    await api("/api/itinerary/items", {
      method: "POST",
      token: owner,
      body: { phase_id: "ny", date: "2026-08-01", text_he: "Test" },
    });
    state = await active();
    day = state.days[0];
  }
  const original = await (
    await api("/api/itinerary/original", { token: owner })
  ).json();
  const r = await edit(
    "/api/itinerary/days",
    "PATCH",
    {
      phase_id: day.phase_id,
      date: day.date,
      label_he: "כותרת חדשה",
      label_en: "New title",
    },
    state.revision,
  );
  assert.equal(r.status, 200);
  const updated = await active();
  assert.equal(
    updated.days.find((d) => d.date === day.date && d.phase_id === day.phase_id)
      .label_en,
    "New title",
  );
  const legacy = await (
    await api(`/api/phases/${day.phase_id}/plan/days`, { token: owner })
  ).json();
  assert.ok(
    legacy.some((d) => d.date === day.date && d.label_en === "New title"),
  );
  assert.deepEqual(
    await (await api("/api/itinerary/original", { token: owner })).json(),
    original,
  );
});
test("stale edits fail with 409 and cannot replace a newer revision", async () => {
  const old = await active();
  const body = {
    phase_id: "ny",
    date: "2026-08-01",
    text_he: "Concurrent item",
  };
  assert.equal(
    (await edit("/api/itinerary/items", "POST", body, old.revision)).status,
    201,
  );
  const newer = await active();
  const r = await edit(
    "/api/itinerary/items",
    "POST",
    { ...body, text_he: "Stale overwrite" },
    old.revision,
  );
  assert.equal(r.status, 409);
  assert.deepEqual(await r.json(), {
    error: "itinerary_changed_reload_before_retry",
  });
  assert.equal((await active()).revision, newer.revision);
});
test("unknown day cannot create a phantom itinerary day", async () => {
  const state = await active();
  const r = await edit(
    "/api/itinerary/days",
    "PATCH",
    { phase_id: "unknown", date: "2026-01-01", label_he: "x", label_en: "x" },
    state.revision,
  );
  assert.equal(r.status, 404);
  assert.equal((await active()).revision, state.revision);
});
test("shared task, RSVP, and found-item writes advance their resource notifications without content", async () => {
  const controller = new AbortController();
  const r = await fetch(`http://127.0.0.1:${PORTS.modernParity}/api/events`, {
    headers: { authorization: `Bearer ${owner}` },
    signal: controller.signal,
  });
  const reader = r.body.getReader();
  let buffer = "";
  async function frame() {
    while (!buffer.includes("\n\n")) {
      const { value } = await reader.read();
      buffer += new TextDecoder().decode(value);
    }
    const end = buffer.indexOf("\n\n");
    const text = buffer.slice(0, end);
    buffer = buffer.slice(end + 2);
    return text;
  }
  const timeout = setTimeout(() => controller.abort(), 4000);
  try {
    const initial = JSON.parse((await frame()).split("data: ")[1]).revisions;
    await api("/api/tasks/t1/done", { method: "POST", token: member });
    await api("/api/rsvps/activity1", {
      method: "POST",
      token: member,
      body: { status: "yes", note: "Private note" },
    });
    await api("/api/lost-found", {
      method: "POST",
      body: { name: "Private finder", item: "Private item" },
    });
    let seen = {};
    while (
      !["tasks", "rsvps", "lost-found"].every((k) => seen[k] > initial[k])
    ) {
      const f = await frame();
      assert.doesNotMatch(f, /Private/);
      Object.assign(seen, JSON.parse(f.split("data: ")[1]).revisions);
    }
    assert.equal((await api("/api/lost-found")).status, 401);
  } finally {
    clearTimeout(timeout);
    controller.abort();
    await reader.cancel().catch(() => {});
  }
});
test("member can rate and comment; another member cannot delete that comment", async () => {
  assert.equal(
    (
      await api("/api/ratings", {
        method: "POST",
        token: member,
        body: { venue: "venue1", rating: 4 },
      })
    ).status,
    200,
  );
  const comment = await (
    await api("/api/comments/venue/venue1", {
      method: "POST",
      token: member,
      body: { body: "Member comment" },
    })
  ).json();
  assert.equal(
    (
      await api(`/api/comments/venue/${comment.id}`, {
        method: "DELETE",
        token: owner,
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await api(`/api/comments/venue/${comment.id}`, {
        method: "DELETE",
        token: member,
      })
    ).status,
    200,
  );
});
test("trivia controls and question bank remain admin scoped", async () => {
  assert.equal(
    (
      await api("/api/trivia/control", {
        method: "POST",
        token: member,
        body: { action: "start" },
      })
    ).status,
    403,
  );
  assert.equal(
    (await api("/api/trivia/questions", { token: member })).status,
    403,
  );
  assert.equal(
    (
      await api("/api/trivia/control", {
        method: "POST",
        token: owner,
        body: { action: "start" },
      })
    ).status,
    200,
  );
  const state = await (
    await api("/api/trivia/state", { token: member })
  ).json();
  assert.equal(state.status, "lobby");
  assert.equal(state.pausedRemainingMs, null);
  await api("/api/trivia/control", {
    method: "POST",
    token: owner,
    body: { action: "stop" },
  });
});

test("two real trivia players join, answer, reveal and finish without leaking answers early", async () => {
  const added = await api("/api/trivia/questions", {
    method: "POST",
    token: owner,
    body: {
      he: "אחת ועוד אחת?",
      en: "One plus one?",
      persons: "general",
      duration: 60,
      answers: [
        { he: "שתיים", en: "Two", correct: true },
        { he: "שלוש", en: "Three", correct: false },
      ],
    },
  });
  assert.equal(added.status, 200);
  await api("/api/trivia/control", {
    method: "POST",
    token: owner,
    body: { action: "start" },
  });
  const controllers = [];
  try {
    for (const token of [owner, member]) {
      const c = new AbortController();
      controllers.push(c);
      const r = await fetch(
        `http://127.0.0.1:${PORTS.modernParity}/api/trivia/events`,
        { headers: { authorization: `Bearer ${token}` }, signal: c.signal },
      );
      assert.equal(r.status, 200);
      const reader = r.body.getReader();
      await reader.read();
      reader.releaseLock();
    }
    const state = async () =>
      await (await api("/api/trivia/state", { token: member })).json();
    assert.deepEqual(Object.keys((await state()).players).sort(), [
      "alice",
      "bob",
    ]);
    await api("/api/trivia/control", {
      method: "POST",
      token: owner,
      body: { action: "launch" },
    });
    let s = await state();
    assert.equal(s.status, "question");
    assert.ok(s.question.answers.every((a) => a.correct === undefined));
    await api("/api/trivia/control", {
      method: "POST",
      token: owner,
      body: { action: "pause" },
    });
    s = await state();
    assert.ok(s.pausedRemainingMs > 0);
    assert.equal(
      (
        await api("/api/trivia/answer", {
          method: "POST",
          token: member,
          body: { answerIndex: 0 },
        })
      ).status,
      400,
    );
    await api("/api/trivia/control", {
      method: "POST",
      token: owner,
      body: { action: "resume" },
    });
    assert.equal(
      (
        await api("/api/trivia/answer", {
          method: "POST",
          token: member,
          body: { answerIndex: 0 },
        })
      ).status,
      200,
    );
    assert.equal(
      (
        await api("/api/trivia/answer", {
          method: "POST",
          token: owner,
          body: { answerIndex: 0 },
        })
      ).status,
      200,
    );
    s = await state();
    assert.equal(s.status, "reveal");
    assert.ok(s.question.answers.some((a) => a.correct === true));
    await api("/api/trivia/control", {
      method: "POST",
      token: owner,
      body: { action: "leaderboard" },
    });
    assert.equal((await state()).status, "leaderboard");
    await api("/api/trivia/control", {
      method: "POST",
      token: owner,
      body: { action: "stop" },
    });
    assert.equal((await state()).status, "gameover");
    assert.ok(
      (await (await api("/api/trivia/scores", { token: member })).json()).some(
        (row) => row.username === "bob",
      ),
    );
  } finally {
    controllers.forEach((c) => c.abort());
  }
});


test("a calendar-only day can receive a title without inventing an activity or changing the original", async () => {
  const state = await active();
  const original = await (await api("/api/itinerary/original", { token: owner })).json();
  const date = "2027-03-13";
  assert.ok(!state.days.some(d => d.phase_id === "ny" && d.date === date));
  const r = await edit("/api/itinerary/days", "PATCH", { phase_id: "ny", date, label_he: "יום פנוי", label_en: "Open day" }, state.revision);
  assert.equal(r.status, 200);
  const updated = await active();
  assert.equal(updated.days.find(d => d.phase_id === "ny" && d.date === date).label_en, "Open day");
  const content = items => items.map(({ revision_id, ...item }) => item);
  assert.deepEqual(content(updated.items), content(state.items));
  assert.deepEqual(await (await api("/api/itinerary/original", { token: owner })).json(), original);
  const legacy = await (await api("/api/phases/ny/plan/days", { token: owner })).json();
  assert.ok(legacy.some(d => d.date === date && d.label_en === "Open day"));
});
