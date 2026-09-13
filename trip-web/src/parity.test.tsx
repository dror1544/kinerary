import { afterEach, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { Readiness, CurrencyConverter } from "./readiness";
import { LostFound, VenueFeedback, ActivityRsvp, GroupActivities } from "./group-utilities";
import { configSchema, createItineraryItem } from "./api";
import { PlanTools } from "./plan-tools";
import { Account } from "./account";
const clients: QueryClient[] = [];
function mount(node: ReactNode) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  clients.push(client);
  return render(
    <QueryClientProvider client={client}>{node}</QueryClientProvider>,
  );
}
afterEach(() => {
  cleanup();
  clients.forEach((c) => c.clear());
  clients.length = 0;
  vi.unstubAllGlobals();
  localStorage.clear();
});
function mock(handler: (url: string, init: RequestInit) => unknown) {
  const fn = vi.fn(async (url: string, init: RequestInit = {}) => {
    const body = handler(url, init);
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  });
  vi.stubGlobal("fetch", fn);
  return fn;
}
const config = {
  tasks: [
    {
      id: "t1",
      text: { he: "דרכון", en: "Passport" },
      owner: { he: "דנה", en: "Dana" },
      deadline: "2026-10-01",
    },
  ],
  packing_general: [
    [
      { he: "כללי", en: "General" },
      { he: "מטען", en: "Charger" },
    ],
  ] as [{ he: string; en: string }, { he: string; en: string }][],
  travel_info: {
    health: [{ he: "תרופות", en: "Medication" }],
    countries: { Japan: { emergency: { police: "110" } } },
  },
  phases: [],
};
it("shows shared task attribution and persists completion through the Classic API", async () => {
  let done = false;
  const fetch = mock((url, init) => {
    if (url === "/api/tasks/t1/done") {
      done = true;
      return { done: true };
    }
    if (url === "/api/tasks/done")
      return done ? [{ task_id: "t1", done_by: "alice" }] : [];
    return { rates: {}, home: "USD" };
  });
  mount(<Readiness config={config} lang="en" />);
  const box = await screen.findByRole("checkbox", { name: "Passport" });
  await waitFor(() => expect(box).toBeEnabled());
  fireEvent.click(box);
  await screen.findByText(/Completed by alice/);
  expect(fetch.mock.calls.some(([u]) => u === "/api/tasks/t1/done")).toBe(true);
});
it("packing shares Classic storage keys and Hebrew renders real information", () => {
  localStorage.setItem("pack-pack-general-מטען", "1");
  mock((u) => (u.includes("tasks") ? [] : { rates: {} }));
  mount(<Readiness config={config} lang="he" />);
  expect(screen.getByRole("checkbox", { name: "כללי — מטען" })).toBeChecked();
  expect(screen.getByText("תרופות")).toBeVisible();
  expect(screen.getByRole("link", { name: "110" })).toHaveAttribute(
    "href",
    "tel:110",
  );
});
it("failed task writes do not report completion", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async (u: string) =>
        new Response(
          JSON.stringify(
            u.includes("/t1/")
              ? { error: "failed" }
              : u.includes("tasks")
                ? []
                : { rates: {} },
          ),
          { status: u.includes("/t1/") ? 500 : 200 },
        ),
    ),
  );
  mount(<Readiness config={config} lang="en" />);
  const box = await screen.findByRole("checkbox", { name: "Passport" });
  await waitFor(() => expect(box).toBeEnabled());
  fireEvent.click(box);
  await screen.findByRole("alert");
  expect(box).not.toBeChecked();
});
it("public Lost & Found never reads private reports", async () => {
  const fetch = mock(() => ({ ok: true }));
  mount(<LostFound lang="en" authenticated={false} />);
  fireEvent.change(screen.getByLabelText("Your name"), {
    target: { value: "Finder" },
  });
  fireEvent.change(screen.getByLabelText("Found item"), {
    target: { value: "Hat" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Send report" }));
  await screen.findByText("Saved.");
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(fetch.mock.calls[0][1]!.method).toBe("POST");
});
it("resolving a found item updates the visible shared status", async () => {
  let resolved = 0;
  mock((u, i) => {
    if (i?.method === "PATCH") {
      resolved = 1;
      return { ok: true };
    }
    return [
      {
        id: 1,
        name: "Finder",
        phone: "",
        item: "Hat",
        location: "Lobby",
        resolved,
      },
    ];
  });
  mount(<LostFound lang="en" />);
  fireEvent.click(await screen.findByRole("button", { name: "Mark resolved" }));
  await screen.findByText("Resolved");
  expect(screen.getByRole("button", { name: "Reopen" })).toBeEnabled();
});
it("venue comments retain a draft after failure and only expose own deletion", async () => {
  mock((u) =>
    u.includes("ratings")
      ? {}
      : [
          { id: 1, username: "alice", body: "Mine" },
          { id: 2, username: "bob", body: "Other" },
        ],
  );
  mount(<VenueFeedback id="venue-1" username="alice" lang="en" />);
  await screen.findByText("Other");
  expect(
    screen.getAllByRole("button", { name: "Delete comment" }),
  ).toHaveLength(1);
  fireEvent.change(screen.getByLabelText("Comment"), {
    target: { value: "New note" },
  });
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response("{}", { status: 500 })),
  );
  fireEvent.click(screen.getByRole("button", { name: "Post comment" }));
  await screen.findByRole("alert");
  expect(screen.getByLabelText("Comment")).toHaveValue("New note");
});
it("RSVP uses the configured activity id and keeps the note", async () => {
  const fetch = mock(() => []);
  mount(<ActivityRsvp id="activity/a" lang="en" />);
  fireEvent.change(screen.getByLabelText("RSVP note (optional)"), {
    target: { value: "Meet at gate" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Going" }));
  await screen.findByText("Saved.");
  const call = fetch.mock.calls.find(([, i]) => i?.method === "POST")!;
  expect(call[0]).toBe("/api/rsvps/activity%2Fa");
  expect(JSON.parse(String(call[1]!.body))).toEqual({
    status: "yes",
    note: "Meet at gate",
  });
});
it("currency conversion uses cross rates and exposes the rate date", async () => {
  mock(() => ({
    base: "USD",
    home: "ILS",
    date: "2026-09-10",
    rates: { ILS: 4, JPY: 160 },
  }));
  mount(<CurrencyConverter lang="en" />);
  await screen.findByText(/2026-09-10/);
  fireEvent.change(screen.getByLabelText("From"), { target: { value: "ILS" } });
  fireEvent.change(screen.getByLabelText("To"), { target: { value: "JPY" } });
  expect(screen.getByText("40 JPY")).toBeVisible();
});
it("config schema keeps parity fields without accepting arbitrary fields", () => {
  const result = configSchema.parse({
    ...config,
    privateExtra: "do not retain",
    phases: [
      {
        id: "a",
        venues: [{ id: "v", name: { en: "Place" } }],
        rsvp_activities: [{ id: "r", price: { en: "Free" } }],
      },
    ],
  });
  expect(result.tasks).toHaveLength(1);
  expect(result.phases?.[0].rsvp_activities?.[0].price).toEqual({ en: "Free" });
  expect(result).not.toHaveProperty("privateExtra");
});
it("itinerary edit sends the revision precondition", async () => {
  const fetch = mock(() => ({ revision: "new" }));
  await createItineraryItem({
    phase_id: "a",
    date: "2026-09-11",
    text_he: "item",
    expected_revision: "old",
  });
  expect(new Headers(fetch.mock.calls[0][1]!.headers).get("if-match")).toBe(
    "old",
  );
});
it("day editor preserves both languages and sends the selected revision", async () => {
  const fetch = mock((u) =>
    u.includes("original") ? { items: [], days: [] } : [],
  );
  mount(
    <PlanTools
      config={{ phases: [{ id: "a" }] }}
      itinerary={{
        revision: "r1",
        items: [],
        days: [
          {
            phase_id: "a",
            date: "2026-09-11",
            label_he: "ישן",
            label_en: "Old",
          },
        ],
      }}
      lang="en"
    />,
  );
  fireEvent.change(screen.getByLabelText("Day"), {
    target: { value: "2026-09-11" },
  });
  expect(screen.getByLabelText("English day title")).toHaveValue("Old");
  fireEvent.change(screen.getByLabelText("Hebrew day title"), {
    target: { value: "חדש" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Save day title" }));
  await screen.findByText("Saved.");
  const call = fetch.mock.calls.find(([, i]) => i?.method === "PATCH")!;
  expect(new Headers(call[1]!.headers).get("if-match")).toBe("r1");
  expect(JSON.parse(String(call[1]!.body)).label_en).toBe("Old");
});
it("password form refuses mismatches and clears matching passwords after success", async () => {
  mock(() => ({ googleClientId: null }));
  mount(<Account currentUser={{ username: "alice" }} lang="en" />);
  fireEvent.change(screen.getByLabelText("New password"), {
    target: { value: "new-password" },
  });
  fireEvent.change(screen.getByLabelText("Repeat password"), {
    target: { value: "different" },
  });
  expect(
    screen.getByRole("button", { name: "Change password" }),
  ).toBeDisabled();
  fireEvent.change(screen.getByLabelText("Repeat password"), {
    target: { value: "new-password" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Change password" }));
  await screen.findByText("Saved.");
  expect(screen.getByLabelText("New password")).toHaveValue("");
});

it("keeps Sprint 5 places without IDs and ticket links without issuing feedback requests", () => {
  const fetch = mock(() => []);
  const parsed = configSchema.parse({ phases: [{ id: "tokyo", dates: { start: "2026-09-19", end: "2026-09-21" }, venues: [{ name: { en: "Museum" }, tickets: "https://example.com/tickets" }] }] });
  mount(<GroupActivities config={parsed} lang="en" />);
  expect(screen.getByRole("heading", { name: "Museum" })).toBeInTheDocument();
  expect(screen.getByRole("link", { name: /Official site/ })).toHaveAttribute("href", "https://example.com/tickets");
  expect(parsed.phases?.[0].dates?.end).toBe("2026-09-21");
  expect(fetch).not.toHaveBeenCalled();
});

it("offers every phase date in plan tools even before a day has activities", async () => {
  const fetch = mock((url) => url.includes("original") ? { revision: "original", days: [], items: [] } : []);
  mount(<PlanTools lang="en" config={{ phases: [{ id: "tokyo", dates: { start: "2026-09-19", end: "2026-09-21" } }] }} itinerary={{ revision: "r-current", days: [], items: [] }} />);
  fireEvent.change(screen.getByLabelText("Day"), { target: { value: "2026-09-20" } });
  fireEvent.change(screen.getByLabelText("English day title"), { target: { value: "Arrival" } });
  fireEvent.click(screen.getByRole("button", { name: "Save day title" }));
  await waitFor(() => expect(fetch.mock.calls.some(([url]) => url === "/api/itinerary/days")).toBe(true));
  const call = fetch.mock.calls.find(([url]) => url === "/api/itinerary/days")!;
  expect(JSON.parse(String(call[1]!.body))).toMatchObject({ date: "2026-09-20", phase_id: "tokyo", label_en: "Arrival" });
  expect(new Headers(call[1]!.headers).get("If-Match")).toBe("r-current");
});
