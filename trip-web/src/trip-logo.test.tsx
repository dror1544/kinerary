/**
 * The trip's logo on the site (docs/specs/sprint-9/x-trip-logo.md), client half:
 *   AC-6   the header and the login page show the trip's logo, not the Kinerary mark;
 *   AC-7   a trip-directory logo shows too (the site resolves it); with neither, both show the Kinerary mark;
 *   AC-9   the organizer row is not rendered when the switch is off (and a member never sees Organizer settings);
 *   AC-12  a change refreshes the header without a reload (the "ui" query is invalidated, the new URL is a new image).
 * The server half is tests/trip-logo.test.js.
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import brandMark from "./assets/brand/mark.svg";
import brandLogo from "./assets/brand/logo.svg";
import App, { LoginLogo, headerLogoSource } from "./App";
import { config, dayItems, renderTrip, stubTripFetch, todayContext, useJsdomBasics } from "./test/video-fixtures";

beforeEach(() => { useJsdomBasics(); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); localStorage.clear(); window.location.hash = ""; });

const NONE = { url: null, source: "none", updated_at: null };
const UPLOAD = { url: "/api/trip/logo?v=0123456789abcdef", source: "upload", updated_at: "2026-11-24 10:00:00" };
const FROM_FILE = { url: "/api/trip/logo?v=fedcba9876543210", source: "config", updated_at: null };
const MEMBER = { username: "bat", name: "בת", name_en: "Bat", is_organizer: false };
const heroLogo = () => document.querySelector("img.hero-logo") as HTMLImageElement | null;

function serve(opts: { features?: Record<string, boolean>; logo?: unknown; metaLogo?: string; user?: Record<string, unknown> } = {}) {
  const items = dayItems();
  const cfg = config(opts.features) as { meta: Record<string, unknown> };
  if (opts.metaLogo) cfg.meta.logo = opts.metaLogo;
  return stubTripFetch(() => ({ config: cfg, today: todayContext(items), items, user: opts.user, ui: opts.logo === undefined ? {} : { logo: opts.logo } }));
}

describe("the header (AC-6, AC-7)", () => {
  it("shows the uploaded logo, not the Kinerary mark", async () => {
    serve({ logo: UPLOAD });
    renderTrip();
    await waitFor(() => expect(heroLogo()?.getAttribute("src")).toBe(UPLOAD.url));
  });

  it("shows a trip-directory logo the site resolved (a bare filename in meta.logo used to be ignored)", async () => {
    serve({ logo: FROM_FILE, metaLogo: "Logo.png" });
    renderTrip();
    await waitFor(() => expect(heroLogo()?.getAttribute("src")).toBe(FROM_FILE.url));
  });

  it("with neither, shows the Kinerary mark — also for a bare meta.logo filename whose file the site could not use", async () => {
    serve({ logo: NONE, metaLogo: "Logo.png" });
    renderTrip();
    await waitFor(() => expect(heroLogo()).not.toBeNull());
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(heroLogo()?.getAttribute("src")).toBe(brandMark);
  });

  it("a site from before this release (no logo in the settings) behaves as it did: the mark", async () => {
    serve({});
    renderTrip();
    await waitFor(() => expect(heroLogo()).not.toBeNull());
    expect(heroLogo()?.getAttribute("src")).toBe(brandMark);
  });

  it("headerLogoSource: the site's answer first, then an address in meta.logo, then the mark", () => {
    expect(headerLogoSource({ logo: UPLOAD as never }, "https://cdn.example/x.png")).toBe(UPLOAD.url);
    expect(headerLogoSource({ logo: NONE as never }, "https://cdn.example/x.png")).toBe("https://cdn.example/x.png");
    expect(headerLogoSource({ logo: NONE as never }, "/brand/custom.svg")).toBe("/brand/custom.svg");
    expect(headerLogoSource({ logo: NONE as never }, "Logo.png")).toBe(brandMark);
    expect(headerLogoSource({ logo: NONE as never }, "javascript:alert(1)")).toBe(brandMark);
    expect(headerLogoSource(undefined, undefined)).toBe(brandMark);
  });
});

describe("the login page (AC-6, AC-7)", () => {
  it("asks the public logo route, with no session", () => {
    render(<LoginLogo />);
    const img = document.querySelector("img.login-logo") as HTMLImageElement;
    expect(img.getAttribute("src")).toBe("/api/trip/logo");
  });

  it("falls back to the Kinerary mark when the trip has no logo (the route answers 404, the image errors)", () => {
    render(<LoginLogo />);
    fireEvent.error(document.querySelector("img.login-logo") as HTMLImageElement);
    const img = document.querySelector("img.login-logo") as HTMLImageElement;
    expect(img.getAttribute("src")).toBe(brandLogo);
    expect(img.getAttribute("alt")).toBe("Kinerary");
  });

  it("the whole signed-out page draws it", () => {
    localStorage.clear();
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 })));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<QueryClientProvider client={client}><App /></QueryClientProvider>);
    expect(document.querySelector("img.login-logo")?.getAttribute("src")).toBe("/api/trip/logo");
  });
});

describe("Organizer settings: the Trip logo row", () => {
  async function openSettings() {
    renderTrip({ hash: "organizer-settings" });
    return screen.findByRole("heading", { name: "Trip look" });
  }

  it("AC-9: with the switch off (absent) the row is not rendered", async () => {
    serve({ features: {} });
    await openSettings();
    expect(screen.queryByRole("heading", { name: "Trip logo" })).toBeNull();
    expect(screen.queryByText("Choose image")).toBeNull();
  });

  it("with the switch on, an organizer sees the row beside the trip's picture: a preview, Choose image, and no 'Use the Kinerary logo' while nothing is uploaded", async () => {
    serve({ features: { trip_logo: true }, logo: NONE });
    await openSettings();
    expect(await screen.findByRole("heading", { name: "Trip logo" })).toBeInTheDocument();
    expect(screen.getByText("Change hero picture")).toBeInTheDocument();
    expect(screen.getByLabelText("Choose image")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Use the Kinerary logo" })).toBeNull();
    expect(screen.getByRole("img", { name: "The Kinerary logo" }).getAttribute("src")).toBe(brandMark);
  });

  it("an organizer who has uploaded one sees it previewed and can go back to the Kinerary logo", async () => {
    serve({ features: { trip_logo: true }, logo: UPLOAD });
    await openSettings();
    expect((await screen.findByRole("img", { name: "The trip's logo" })).getAttribute("src")).toBe(UPLOAD.url);
    expect(screen.getByRole("button", { name: "Use the Kinerary logo" })).toBeInTheDocument();
  });

  it("Hebrew copy", async () => {
    localStorage.setItem("tripLang", "he");
    serve({ features: { trip_logo: true }, logo: UPLOAD });
    renderTrip({ hash: "organizer-settings" });
    expect(await screen.findByRole("heading", { name: "לוגו הטיול" })).toBeInTheDocument();
    expect(screen.getByLabelText("בחירת תמונה")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "שימוש בלוגו של Kinerary" })).toBeInTheDocument();
  });

  it("a member never reaches it (organizer access required), switch on or not", async () => {
    serve({ features: { trip_logo: true }, user: MEMBER });
    renderTrip({ hash: "organizer-settings" });
    expect(await screen.findByText("Organizer access required.")).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Trip logo" })).toBeNull();
  });

  it("choosing a file POSTs it as field `logo` with the session, then the header shows the new logo without a reload (AC-12)", async () => {
    let settings: unknown = { logo: NONE };
    const base = serve({ features: { trip_logo: true }, logo: NONE });
    const posts: { url: string; method: string; headers: unknown; body: FormData }[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), "http://trip.test");
      if (url.pathname === "/api/ui-settings/logo") {
        posts.push({ url: url.pathname, method: init?.method || "GET", headers: init?.headers, body: init?.body as FormData });
        settings = { logo: UPLOAD };
        return new Response(JSON.stringify({ design_variant: "modern", hero: { url: null, focal_x: 0.5, focal_y: 0.45 }, logo: UPLOAD }), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (url.pathname === "/api/ui-settings") {
        return new Response(JSON.stringify({ design_variant: "modern", hero: { url: null, focal_x: 0.5, focal_y: 0.45 }, ...(settings as object) }), { status: 200, headers: { "content-type": "application/json" } });
      }
      return base(input);
    }));
    await openSettings();
    await waitFor(() => expect(heroLogo()?.getAttribute("src")).toBe(brandMark));
    const file = new File([new Uint8Array([137, 80, 78, 71])], "logo.png", { type: "image/png" });
    fireEvent.change(await screen.findByLabelText("Choose image"), { target: { files: [file] } });
    await waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0].method).toBe("POST");
    expect(posts[0].headers).toEqual({ Authorization: "Bearer test-token" });
    expect((posts[0].body.get("logo") as File).name).toBe("logo.png");
    await waitFor(() => expect(heroLogo()?.getAttribute("src")).toBe(UPLOAD.url));
    expect(await screen.findByRole("button", { name: "Use the Kinerary logo" })).toBeInTheDocument();
  });

  it("'Use the Kinerary logo' sends DELETE and the header goes back", async () => {
    let settings: unknown = { logo: UPLOAD };
    const base = serve({ features: { trip_logo: true }, logo: UPLOAD });
    const methods: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), "http://trip.test");
      if (url.pathname === "/api/ui-settings/logo") { methods.push(init?.method || "GET"); settings = { logo: NONE }; return new Response(JSON.stringify({ logo: NONE }), { status: 200, headers: { "content-type": "application/json" } }); }
      if (url.pathname === "/api/ui-settings") return new Response(JSON.stringify({ design_variant: "modern", hero: { url: null, focal_x: 0.5, focal_y: 0.45 }, ...(settings as object) }), { status: 200, headers: { "content-type": "application/json" } });
      return base(input);
    }));
    await openSettings();
    await waitFor(() => expect(heroLogo()?.getAttribute("src")).toBe(UPLOAD.url));
    fireEvent.click(await screen.findByRole("button", { name: "Use the Kinerary logo" }));
    await waitFor(() => expect(methods).toEqual(["DELETE"]));
    await waitFor(() => expect(heroLogo()?.getAttribute("src")).toBe(brandMark));
  });

  it("the site's refusals are said in words: too large, not an image, switch off", async () => {
    const base = serve({ features: { trip_logo: true }, logo: NONE });
    let status = 413;
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input), "http://trip.test");
      if (url.pathname === "/api/ui-settings/logo") return new Response(JSON.stringify({ error: "x" }), { status, headers: { "content-type": "application/json" } });
      return base(input);
    }));
    await openSettings();
    const input = await screen.findByLabelText("Choose image");
    const file = new File([new Uint8Array([1])], "logo.png", { type: "image/png" });
    for (const [code, words] of [[413, /larger than 8 MB/], [400, /not an image the site can use/], [409, /not turned on/], [500, /Could not change the logo/]] as const) {
      status = code;
      fireEvent.change(input, { target: { files: [file] } });
      expect(await screen.findByRole("alert")).toHaveTextContent(words);
      await waitFor(() => expect(within(document.body).getByText("Choose image")).toBeInTheDocument());
    }
  });
});

describe("the installed app's name", () => {
  it("the iOS home-screen title is the trip's first 12 characters (the manifest does the same for the others)", async () => {
    const tag = document.createElement("meta");
    tag.setAttribute("name", "apple-mobile-web-app-title");
    tag.setAttribute("content", "Kinerary");
    document.head.appendChild(tag);
    try {
      serve({ logo: NONE });
      renderTrip();
      await waitFor(() => expect(tag.getAttribute("content")).toBe("Alsace 2026"));
    } finally { tag.remove(); }
  });
});
