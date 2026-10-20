import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import indexHtml from "../../index.html?raw";
import nginxConf from "../../nginx.conf?raw";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../App";

const TRIP_ID = "trip_abcdefgh";
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
type Submission = { action: string; method: string; token: string | null; tokenInQuery: boolean };
let submissions: Submission[];
let calls: string[];

function mount(route = `/trips/${TRIP_ID}/app`, grantFor: (n: number) => unknown = (n) => ({ runtimeOrigin: "https://runtime.example.test", framePath: `/t/${TRIP_ID}/`, launchToken: `fixture-grant-${n}` })) {
  let launches = 0;
  calls = [];
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push(`${init?.method ?? "GET"} ${url}`);
    if (url === "/v1/me") return json({ id: "user_test", displayName: "Owner" });
    if (url === "/v1/trips") return json({ trips: [] });
    if (url === `/v1/trips/${TRIP_ID}/launch`) { launches += 1; return json(grantFor(launches)); }
    return json({ error: "NOT_FOUND" }, 404);
  }));
  return render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })}><MemoryRouter initialEntries={[route]}><App /></MemoryRouter></QueryClientProvider>);
}

beforeEach(() => {
  submissions = [];
  sessionStorage.clear();
  window.history.replaceState(null, "", "/");
  vi.spyOn(HTMLFormElement.prototype, "submit").mockImplementation(function (this: HTMLFormElement) {
    const data = new FormData(this);
    submissions.push({ action: this.action, method: this.method, token: data.get("token") as string | null, tokenInQuery: this.action.includes("?") || this.action.includes("fixture-grant") });
  });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); sessionStorage.clear(); window.history.replaceState(null, "", "/"); });

describe("opening a trip is a top-level form POST of the launch grant, with no frame", () => {
  it("submits a hidden form to the runtime's launch path with the token in the body and renders no iframe", async () => {
    mount();
    await vi.waitFor(() => expect(submissions).toHaveLength(1));
    expect(submissions[0]).toEqual({ action: `https://runtime.example.test/t/${TRIP_ID}/__launch`, method: "post", token: "fixture-grant-1", tokenInQuery: false });
    expect(document.querySelector("iframe")).toBeNull();
    expect(document.querySelector("form[hidden]")).not.toBeNull();
    // The token is a form value only: not in an href, src, or any other attribute, and the form does not suppress Origin.
    const form = document.querySelector("form")!;
    expect(form.getAttribute("rel")).toBeNull();
    expect(form.getAttribute("referrerpolicy")).toBeNull();
    for (const element of Array.from(document.querySelectorAll("*"))) {
      for (const name of element.getAttributeNames()) {
        if (element.tagName === "INPUT" && name === "value") continue;
        expect(element.getAttribute(name) ?? "", `${element.tagName}[${name}]`).not.toContain("fixture-grant");
      }
    }
    expect(calls.filter((call) => call.endsWith("/launch"))).toEqual([`POST /v1/trips/${TRIP_ID}/launch`]);
  });

  it("refuses a grant whose origin or path is not this trip's launch path", async () => {
    for (const bad of [
      { runtimeOrigin: "javascript:alert(1)", framePath: `/t/${TRIP_ID}/`, launchToken: "x" },
      { runtimeOrigin: "https://runtime.example.test/extra", framePath: `/t/${TRIP_ID}/`, launchToken: "x" },
      { runtimeOrigin: "https://runtime.example.test", framePath: "/t/trip_otherrrr/", launchToken: "x" },
      { runtimeOrigin: "https://user:pw@runtime.example.test", framePath: `/t/${TRIP_ID}/`, launchToken: "x" },
    ]) {
      mount(`/trips/${TRIP_ID}/app`, () => bad);
      expect(await screen.findByText("This trip is not ready to open.")).toBeInTheDocument();
      expect(submissions).toHaveLength(0);
      cleanup(); sessionStorage.clear();
    }
  });
});

describe("coming back to a spent launcher never re-submits by itself", () => {
  it("a history entry that already launched shows Open trip again, and a click launches once more", async () => {
    window.history.replaceState({ kineraryLaunched: TRIP_ID }, "");
    mount();
    expect(await screen.findByRole("button", { name: "Open trip again" })).toBeInTheDocument();
    expect(screen.getAllByRole("link", { name: "My trips" }).length).toBeGreaterThan(0);
    expect(calls.filter((call) => call.endsWith("/launch"))).toEqual([]);
    expect(submissions).toHaveLength(0);
    fireEvent.click(screen.getByRole("button", { name: "Open trip again" }));
    await vi.waitFor(() => expect(submissions).toHaveLength(1));
    expect(submissions[0].token).toBe("fixture-grant-1");
  });

  it("a back_forward document load of this very route is treated the same way", async () => {
    vi.spyOn(performance, "getEntriesByType").mockReturnValue([{ type: "back_forward", name: `${window.location.origin}/trips/${TRIP_ID}/app` } as unknown as PerformanceEntry]);
    window.history.replaceState(null, "", `/trips/${TRIP_ID}/app`);
    mount();
    expect(await screen.findByRole("button", { name: "Open trip again" })).toBeInTheDocument();
    expect(submissions).toHaveLength(0);
    window.history.replaceState(null, "", "/");
  });

  it("a back_forward load of a different page does not block a later, deliberate open", async () => {
    vi.spyOn(performance, "getEntriesByType").mockReturnValue([{ type: "back_forward", name: `${window.location.origin}/trips` } as unknown as PerformanceEntry]);
    window.history.replaceState(null, "", `/trips/${TRIP_ID}/app`);
    mount();
    await vi.waitFor(() => expect(submissions).toHaveLength(1));
    window.history.replaceState(null, "", "/");
  });

  it("a page restored from the back/forward cache drops the spent grant and waits for a click", async () => {
    mount();
    await vi.waitFor(() => expect(submissions).toHaveLength(1));
    const restored = new Event("pageshow"); Object.defineProperty(restored, "persisted", { value: true });
    act(() => { window.dispatchEvent(restored); });
    expect(await screen.findByRole("button", { name: "Open trip again" })).toBeInTheDocument();
    expect(document.querySelector("form")).toBeNull();
    expect(submissions).toHaveLength(1);
  });

  it("a launch loop (the gateway sending the browser straight back) stops with a message instead of minting grants forever", async () => {
    sessionStorage.setItem("kineraryLaunchLog", JSON.stringify([1, 2, 3].map(() => ({ t: TRIP_ID, at: Date.now() }))));
    mount();
    expect(await screen.findByText(/keeps sending you back here/)).toBeInTheDocument();
    expect(submissions).toHaveLength(0);
  });
});

describe("nothing in the web app frames anything or listens for a frame", () => {
  const all = import.meta.glob("../**/*.{ts,tsx,css}", { query: "?raw", import: "default", eager: true }) as Record<string, string>;
  const sources = Object.entries(all).filter(([file]) => !/\.test\.tsx?$/.test(file) && !file.includes("/test/"));

  it("has no iframe element, frame stylesheet, postMessage hand-off or runtime message listener in the source", () => {
    expect(sources.length).toBeGreaterThan(10);
    for (const [file, text] of sources) {
      expect(text, file).not.toMatch(/<iframe|iframe\s*[{,]|HTMLIFrameElement|\.contentWindow|postMessage|kinerary:launch|kinerary:runtime/);
    }
  });

  it("keeps the portal's referrer policy at one that sends an Origin to the launch endpoint", () => {
    expect(indexHtml).toMatch(/<meta name="referrer" content="strict-origin-when-cross-origin"/);
    expect(nginxConf).toMatch(/Referrer-Policy "strict-origin-when-cross-origin"/);
    expect(nginxConf).not.toMatch(/add_header\s+Referrer-Policy\s+"?no-referrer/);
    // Every location with its own add_header repeats it (nginx would otherwise drop the server-level one).
    for (const block of nginxConf.split(/\n  location /).slice(1).filter((part: string) => part.includes("add_header"))) expect(block).toContain("Referrer-Policy");
  });
});
