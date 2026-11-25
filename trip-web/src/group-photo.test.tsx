/**
 * The Telegram group photo, on the site (docs/specs/sprint-9/x-trip-group-photo.md): the OFFER after a logo upload and the
 * STATUS line, in Organizer settings.
 *
 *   - AC-4  with the switch off neither the offer nor the status line is drawn (and a member never reaches the page);
 *   - AC-1  nothing is requested until the organizer presses the button; pressing it POSTs /api/group-photo with the session,
 *           and the line reads what the SITE says, "done" only when the site says done;
 *   - AC-2  bot_lacks_rights reads with the instruction a person can act on; AC-3 no_group and no_logo read as such;
 *   - AC-6  failed reads with Telegram's description;
 *   - a request that is on its way is asked about again until it has an answer.
 * The server half is tests/group-photo-site.test.js.
 */
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { dayItems, config, renderTrip, stubTripFetch, todayContext, useJsdomBasics } from "./test/video-fixtures";

beforeEach(() => { useJsdomBasics(); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.useRealTimers(); localStorage.clear(); window.location.hash = ""; });

const NONE_LOGO = { url: null, source: "none", updated_at: null };
const UPLOAD = { url: "/api/trip/logo?v=0123456789abcdef", source: "upload", updated_at: "2026-11-24 10:00:00" };
const MEMBER = { username: "bat", name: "בת", name_en: "Bat", is_organizer: false };
const ASK = "Also make it the Telegram group photo";
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const view = (status: string, detail: string | null = null, message: string | null = null) => ({
  status,
  request: status === "none" ? null : { id: 1, status, detail, requested_at: "2026-12-03T10:00:00Z", finished_at: null },
  message,
});

interface Site { state: { logo: unknown; photo: ReturnType<typeof view>; refuse?: number }; asked: Array<{ method: string; headers: unknown; body: unknown }>; reads: number }

function serve(features: Record<string, boolean>, { logo = UPLOAD as unknown, photo = view("none"), user }: { logo?: unknown; photo?: ReturnType<typeof view>; user?: Record<string, unknown> } = {}): Site {
  const site: Site = { state: { logo, photo }, asked: [], reads: 0 };
  const items = dayItems();
  const base = stubTripFetch(() => ({ config: config(features), today: todayContext(items), items, user, ui: { logo: site.state.logo } }));
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), "http://trip.test");
    if (url.pathname === "/api/group-photo") {
      if ((init?.method ?? "GET") === "POST") {
        site.asked.push({ method: "POST", headers: init?.headers instanceof Headers ? Object.fromEntries(init.headers.entries()) : init?.headers, body: init?.body });
        if (site.state.refuse) return json({ error: site.state.refuse === 422 ? "no_logo" : "feature_off" }, site.state.refuse);
        site.state.photo = view("pending", null, "The request is on its way to the group. This usually takes a minute or two.");
        return json(site.state.photo, 202);
      }
      site.reads += 1;
      return json(site.state.photo);
    }
    return base(input);
  }));
  return site;
}

async function openSettings() {
  renderTrip({ hash: "organizer-settings" });
  return screen.findByRole("heading", { name: "Trip look" });
}

describe("the offer (AC-4, AC-1)", () => {
  it("AC-4: with trip_group_photo off, neither the button nor a status line is drawn, though the logo row is", async () => {
    serve({ trip_logo: true }, { photo: view("done") });
    await openSettings();
    expect(await screen.findByRole("heading", { name: "Trip logo" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: ASK })).toBeNull();
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("AC-4: a member never reaches it", async () => {
    serve({ trip_logo: true, trip_group_photo: true }, { user: MEMBER });
    renderTrip({ hash: "organizer-settings" });
    expect(await screen.findByText("Organizer access required.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: ASK })).toBeNull();
  });

  it("with it on and a logo, an organizer sees the button, and NOTHING has been requested", async () => {
    const site = serve({ trip_logo: true, trip_group_photo: true });
    await openSettings();
    expect(await screen.findByRole("button", { name: ASK })).toBeInTheDocument();
    expect(site.asked).toEqual([]);
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("with no logo at all there is nothing to offer", async () => {
    serve({ trip_logo: true, trip_group_photo: true }, { logo: NONE_LOGO });
    await openSettings();
    await screen.findByRole("heading", { name: "Trip logo" });
    await waitFor(() => expect(screen.queryByRole("button", { name: ASK })).toBeNull());
  });

  it("AC-1: pressing it POSTs /api/group-photo with the session, and the line says pending, not done", async () => {
    const site = serve({ trip_logo: true, trip_group_photo: true });
    await openSettings();
    fireEvent.click(await screen.findByRole("button", { name: ASK }));
    await waitFor(() => expect(site.asked).toHaveLength(1));
    expect(site.asked[0].method).toBe("POST");
    expect((site.asked[0].headers as Record<string, string>).authorization).toBe("Bearer test-token");
    const line = await screen.findByRole("status");
    expect(line.textContent).toMatch(/on its way/i);
    expect(line.textContent).not.toMatch(/done/i);
    expect(screen.getByRole("button", { name: ASK })).toBeDisabled();
  });

  it("after a logo upload the page offers it in words, still without asking", async () => {
    const site = serve({ trip_logo: true, trip_group_photo: true }, { logo: NONE_LOGO });
    // the upload answers, and the settings now carry the new logo
    const inner = (globalThis.fetch as unknown as (i: RequestInfo | URL, n?: RequestInit) => Promise<Response>);
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), "http://trip.test");
      if (url.pathname === "/api/ui-settings/logo" && init?.method === "POST") { site.state.logo = UPLOAD; return json({ logo: UPLOAD }); }
      return inner(input, init);
    }));
    await openSettings();
    fireEvent.change(await screen.findByLabelText("Choose image"), { target: { files: [new File([new Uint8Array([137, 80, 78, 71])], "logo.png", { type: "image/png" })] } });
    expect(await screen.findByText(/Want the Telegram group to use it too\?/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: ASK })).toBeInTheDocument();
    expect(site.asked).toEqual([]);
  });
});

describe("the status line says what the site says (AC-1, AC-2, AC-3, AC-6)", () => {
  const cases: Array<[string, string | null, RegExp]> = [
    ["done", null, /group's photo is now the trip logo/i],
    ["bot_lacks_rights", null, /Make the bot an admin with "Change group info", then ask again\./],
    ["no_group", null, /No Telegram group is connected/],
    ["no_logo", null, /no logo yet/],
    ["failed", "Telegram said: Bad Request: PHOTO_INVALID_DIMENSIONS", /did not set the photo.*PHOTO_INVALID_DIMENSIONS/],
    ["expired", null, /more than 24 hours.*Ask again/],
    ["sending", null, /setting the group photo now/],
  ];
  for (const [status, detail, words] of cases) {
    it(`${status}`, async () => {
      serve({ trip_logo: true, trip_group_photo: true }, { photo: view(status, detail) });
      await openSettings();
      const line = await screen.findByRole("status");
      expect(line.textContent).toMatch(words);
    });
  }

  it("Hebrew: the instruction a person can act on", async () => {
    localStorage.setItem("tripLang", "he");
    serve({ trip_logo: true, trip_group_photo: true }, { photo: view("bot_lacks_rights") });
    renderTrip({ hash: "organizer-settings" });
    expect((await screen.findByRole("status")).textContent).toMatch(/הפכו את הבוט למנהל/);
    expect(screen.getByRole("button", { name: "להפוך אותו גם לתמונת קבוצת הטלגרם" })).toBeInTheDocument();
  });

  it("a request that is on its way is read again until it has an answer", async () => {
    const site = serve({ trip_logo: true, trip_group_photo: true }, { photo: view("pending") });
    vi.useFakeTimers({ shouldAdvanceTime: true });
    await openSettings();
    await screen.findByRole("status");
    const before = site.reads;
    site.state.photo = view("done");
    await vi.advanceTimersByTimeAsync(6_000);
    await waitFor(() => expect(screen.getByRole("status").textContent).toMatch(/Done/));
    expect(site.reads).toBeGreaterThan(before);
    const settled = site.reads;
    await vi.advanceTimersByTimeAsync(20_000);
    expect(site.reads).toBe(settled);
  });

  it("the site refusing at once with no_logo reads as such, and a switch that is off server-side as not turned on", async () => {
    const site = serve({ trip_logo: true, trip_group_photo: true });
    site.state.refuse = 422;
    await openSettings();
    fireEvent.click(await screen.findByRole("button", { name: ASK }));
    expect((await screen.findByRole("alert")).textContent).toMatch(/no logo yet/);
    site.state.refuse = 409;
    fireEvent.click(screen.getByRole("button", { name: ASK }));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toMatch(/not turned on/));
  });
});
