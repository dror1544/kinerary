import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../App";

// #699 S1b (docs/specs/sprint-9/699-user-photo-library.md): the account's "Photo library" section on the dashboard.
// Every address below is an example.com placeholder and the key a test value.
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
const KEY = "TESTKEY-sentinel-9f8e7d6c5b4a";
// A raw server message is never shown: every stubbed error carries this, and one also carries the key.
const RAW = "RAW-SERVER-MESSAGE";
const SERVER = "https://photos.example.com";
const PUBLIC = "https://share.example.com";

type Connection = {
  id: string; service: "immich" | "google_photos"; serverUrl: string | null; publicUrl: string | null;
  state: "active" | "needs_reconnect"; isDefault: boolean; lastCheckedAt: string | null; lastErrorCode: string | null;
};
const immich = (over: Partial<Connection> = {}): Connection => ({
  id: "phc_aaaaaaaaaaaaaaaa", service: "immich", serverUrl: SERVER, publicUrl: null, state: "active", isDefault: true,
  lastCheckedAt: "2026-11-20T10:00:00.000Z", lastErrorCode: null, ...over,
});
const google = (over: Partial<Connection> = {}): Connection => ({
  id: "phc_bbbbbbbbbbbbbbbb", service: "google_photos", serverUrl: null, publicUrl: null, state: "active", isDefault: false,
  lastCheckedAt: "2026-11-21T10:00:00.000Z", lastErrorCode: null, ...over,
});

type Call = { call: string; path: string; body?: string; headers: Headers };
type Handler = (call: Call) => Response | Promise<Response> | undefined;

let consoleSpies: ReturnType<typeof vi.spyOn>[] = [];
beforeEach(() => {
  document.cookie = "kit_csrf=csrf-test-token";
  consoleSpies = (["log", "info", "warn", "error", "debug"] as const).map((level) => vi.spyOn(console, level).mockImplementation(() => undefined));
});
afterEach(() => {
  vi.unstubAllGlobals();
  for (const spy of consoleSpies) spy.mockRestore();
  window.localStorage.clear();
  document.cookie = "kit_csrf=; expires=Thu, 01 Jan 1970 00:00:00 GMT";
});

function mount(options: { list?: Connection[]; me?: Record<string, unknown>; handle?: Handler; getStatus?: number; path?: string } = {}) {
  const calls: Call[] = [];
  const state = { list: options.list ?? [] };
  vi.stubGlobal("fetch", vi.fn(async (input: unknown, init?: RequestInit) => {
    const path = String(input); const method = init?.method || "GET";
    const call: Call = { call: `${method} ${path}`, path, body: init?.body as string | undefined, headers: new Headers(init?.headers) };
    calls.push(call);
    if (path === "/v1/me") return json({ id: "user_owner", displayName: "Dana", ...(options.me ?? {}) });
    if (path === "/v1/trips") return json({ trips: [] });
    const custom = options.handle?.(call);
    if (custom) return custom;
    if (call.call === "GET /v1/photo-connections") {
      if (options.getStatus === 503) return json({ error: "photo_library_not_configured", message: RAW }, 503);
      return json({ connections: state.list });
    }
    return json({ error: "NOT_FOUND", message: RAW }, 404);
  }));
  render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })}><MemoryRouter initialEntries={[options.path ?? "/trips"]}><App /></MemoryRouter></QueryClientProvider>);
  return { calls, state };
}

const section = async () => {
  const heading = await screen.findByRole("heading", { name: "Photo library" });
  return heading.closest("section") as HTMLElement;
};
const keyInput = () => screen.getByLabelText("API key") as HTMLInputElement;
const fill = async (server: string, key: string, publicUrl?: string) => {
  fireEvent.change(await screen.findByLabelText("Server address"), { target: { value: server } });
  fireEvent.change(keyInput(), { target: { value: key } });
  if (publicUrl !== undefined) fireEvent.change(screen.getByLabelText("Public address (optional)"), { target: { value: publicUrl } });
};
const submit = () => fireEvent.click(screen.getByRole("button", { name: /^(Connect|Reconnect) Immich$/ }));

/** The key is nowhere: not in the markup, not in any field's value, not in either storage, not in any console call. */
function expectKeyGone() {
  expect(document.documentElement.innerHTML).not.toContain(KEY);
  for (const input of Array.from(document.querySelectorAll("input"))) expect(input.value).not.toContain(KEY);
  expect(JSON.stringify({ ...window.localStorage })).not.toContain(KEY);
  expect(JSON.stringify({ ...window.sessionStorage })).not.toContain(KEY);
  expect(window.location.href).not.toContain(KEY);
  for (const spy of consoleSpies) expect(JSON.stringify(spy.mock.calls)).not.toContain(KEY);
}
const posts = (calls: Call[], path: string) => calls.filter((c) => c.call === `POST ${path}`);

describe("Photo library section (#699 S1b)", () => {
  it("1. with no connection, says in plain words what connecting does and offers the Immich form", async () => {
    const { calls } = mount();
    const box = await section();
    expect(await within(box).findByLabelText("Server address")).toHaveAttribute("placeholder", SERVER);
    const text = box.textContent ?? "";
    expect(text).toMatch(/adds .*photos to an album/i);
    expect(text).toMatch(/story/i);
    expect(text).toMatch(/never deletes anything in your library/i);
    expect(text).toMatch(/share link/i);
    expect(text).toMatch(/No photo library is connected yet/);
    const key = keyInput();
    expect(key).toHaveAttribute("type", "password");
    expect(key).toHaveAttribute("autocomplete", "off");
    // Google Photos is a row that says it is coming, and a disabled control that asks nothing of the server.
    const googleButton = within(box).getByRole("button", { name: /Google Photos/ });
    expect(googleButton).toBeDisabled();
    fireEvent.click(googleButton);
    expect(calls.filter((c) => c.path.includes("google"))).toEqual([]);
    expect(calls.filter((c) => c.path.startsWith("/v1/photo-connections")).map((c) => c.call)).toEqual(["GET /v1/photo-connections"]);
  });

  it("2. connect: posts the address and key (no empty public address), shows the connection active, and the key is gone everywhere", async () => {
    const { calls, state } = mount({
      handle: (call) => {
        if (call.call !== "POST /v1/photo-connections/immich") return undefined;
        state.list = [immich({ lastCheckedAt: new Date().toISOString() })];
        // A response never carries a key; this one tries, to prove the page would not render it.
        return json({ connection: { ...state.list[0], apiKey: KEY } }, 201);
      },
    });
    await section();
    await fill(SERVER, KEY);
    submit();
    expect(await screen.findByText("Connected")).toBeInTheDocument();
    const sent = posts(calls, "/v1/photo-connections/immich");
    expect(sent).toHaveLength(1);
    expect(JSON.parse(sent[0]!.body!)).toEqual({ serverUrl: SERVER, apiKey: KEY });
    const box = await section();
    expect(within(box).getByText(SERVER)).toBeInTheDocument();
    // The list was read again after the connect.
    expect(calls.filter((c) => c.call === "GET /v1/photo-connections").length).toBeGreaterThanOrEqual(2);
    // Connected: no form left on screen, so no key field to hold anything.
    expect(screen.queryByLabelText("API key")).toBeNull();
    expectKeyGone();
  });

  it("2a. the key field is empty while the connect is still on its way, and the key is nowhere but the request body", async () => {
    let answer: (value: Response) => void = () => undefined;
    const { calls, state } = mount({
      handle: (call) => {
        if (call.call !== "POST /v1/photo-connections/immich") return undefined;
        return new Promise<Response>((resolve) => { answer = resolve; });
      },
    });
    await section();
    await fill(SERVER, `  ${KEY}\n`);
    submit();
    expect(await screen.findByRole("button", { name: "Checking with Immich…" })).toBeDisabled();
    expect(keyInput().value).toBe("");
    expectKeyGone();
    // Sent trimmed: a pasted trailing space or line break is not part of an Immich key.
    expect(JSON.parse(posts(calls, "/v1/photo-connections/immich")[0]!.body!)).toEqual({ serverUrl: SERVER, apiKey: KEY });
    state.list = [immich()];
    answer(json({ connection: state.list[0] }, 201));
    expect(await screen.findByText("Connected")).toBeInTheDocument();
    expectKeyGone();
  });

  it("2b. connect sends the public address when one is given", async () => {
    const { calls, state } = mount({
      handle: (call) => {
        if (call.call !== "POST /v1/photo-connections/immich") return undefined;
        state.list = [immich({ publicUrl: PUBLIC })];
        return json({ connection: state.list[0] }, 201);
      },
    });
    await section();
    await fill(SERVER, KEY, PUBLIC);
    submit();
    expect(await screen.findByText("Connected")).toBeInTheDocument();
    expect(JSON.parse(posts(calls, "/v1/photo-connections/immich")[0]!.body!)).toEqual({ serverUrl: SERVER, apiKey: KEY, publicUrl: PUBLIC });
    expectKeyGone();
  });

  const failures: [string, Record<string, unknown>, number, RegExp][] = [
    ["invalid_address", {}, 400, /^Enter the full address, starting with https:\/\//],
    ["address_not_allowed", {}, 400, /^This address is on a private network this service cannot reach\./],
    ["not_immich", {}, 422, /^There is no Immich at this address\./],
    ["unreachable", {}, 502, /^Immich could not be reached at this address\./],
    ["timeout", {}, 502, /^Immich took too long to answer\./],
    ["response_too_large", {}, 422, /^The server at this address answered with more than Immich sends\./],
    ["redirect_refused", {}, 422, /^This address sends visitors on to another address\./],
    ["invalid_key", {}, 422, /^Immich did not accept this key\. Make a new key in Immich and paste it here\.$/],
    ["key_lacks_permission", { permission: "album.read" }, 422, /^This key is missing the permission album\.read\. Make a new key in Immich with album\.read allowed and paste it here\.$/],
    ["invalid_request", { field: "apiKey" }, 400, /^Paste the API key Immich gave you\.$/],
    ["NOT_FOUND", {}, 404, /^This connection is no longer there\./],
    ["something_new", {}, 500, /^Something went wrong\. Please try again\.$/],
  ];
  it.each(failures)("3. %s: one plain sentence, the key field cleared, the form still usable", async (code, extra, status, sentence) => {
    let attempts = 0;
    const { calls } = mount({
      handle: (call) => {
        if (call.call !== "POST /v1/photo-connections/immich") return undefined;
        attempts += 1;
        return json({ error: code, message: `${RAW} ${KEY}`, ...extra }, status);
      },
    });
    await section();
    await fill(SERVER, KEY);
    submit();
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toMatch(sentence);
    expect(document.body.textContent).not.toContain(RAW);
    expect(keyInput().value).toBe("");
    expectKeyGone();
    // Still usable: the address stays, a new key goes again.
    expect((screen.getByLabelText("Server address") as HTMLInputElement).value).toBe(SERVER);
    fireEvent.change(keyInput(), { target: { value: "second-key" } });
    submit();
    await waitFor(() => expect(attempts).toBe(2));
    expect(JSON.parse(posts(calls, "/v1/photo-connections/immich")[1]!.body!)).toEqual({ serverUrl: SERVER, apiKey: "second-key" });
  });

  it("3b. a key-permission answer without a permission name still names the one Kinerary checks", async () => {
    mount({ handle: (call) => call.call === "POST /v1/photo-connections/immich" ? json({ error: "key_lacks_permission", message: RAW }, 422) : undefined });
    await section();
    await fill(SERVER, KEY);
    submit();
    expect((await screen.findByRole("alert")).textContent).toContain("album.read");
  });

  it("3c. a public address refused is named as the public address", async () => {
    mount({ handle: (call) => call.call === "POST /v1/photo-connections/immich" ? json({ error: "invalid_address", field: "publicUrl", message: RAW }, 400) : undefined });
    await section();
    await fill(SERVER, KEY, "share");
    submit();
    expect((await screen.findByRole("alert")).textContent).toMatch(/^Enter the public address in full/);
  });

  it("3d. 503 photo_library_not_configured on the list: the section is not drawn at all, and nothing more is asked", async () => {
    const { calls } = mount({ getStatus: 503 });
    expect(await screen.findByRole("heading", { name: "My trips" })).toBeInTheDocument();
    await waitFor(() => expect(calls.filter((c) => c.call === "GET /v1/photo-connections")).toHaveLength(1));
    // Let the 503 land and the page settle: a card drawn from it would be on screen by now.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(screen.queryByRole("heading", { name: "Photo library" })).toBeNull();
    expect(screen.queryByLabelText("API key")).toBeNull();
    expect(screen.queryByRole("button", { name: /Immich|Google Photos/ })).toBeNull();
    expect(document.body.textContent).not.toMatch(/photo librar|not available/i);
    expect(document.body.textContent).not.toContain(RAW);
    expect(calls.filter((c) => c.path.startsWith("/v1/photo-connections")).map((c) => c.call)).toEqual(["GET /v1/photo-connections"]);
  });

  it("3e. 503 on the connect itself: the key is cleared, the section goes, and nothing more is asked", async () => {
    const { calls } = mount({ handle: (call) => call.call === "POST /v1/photo-connections/immich" ? json({ error: "photo_library_not_configured", message: RAW }, 503) : undefined });
    await section();
    await fill(SERVER, KEY);
    submit();
    await waitFor(() => expect(screen.queryByRole("heading", { name: "Photo library" })).toBeNull());
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(screen.queryByRole("heading", { name: "Photo library" })).toBeNull();
    expect(screen.queryByLabelText("API key")).toBeNull();
    expect(document.body.textContent).not.toContain(RAW);
    expectKeyGone();
    expect(calls.filter((c) => c.path.startsWith("/v1/photo-connections")).map((c) => c.call)).toEqual(["GET /v1/photo-connections", "POST /v1/photo-connections/immich"]);
  });

  it("4. needs_reconnect: a clear Reconnect that reopens the form for that address; a 200 replace-in-place makes it active", async () => {
    const { calls, state } = mount({
      list: [immich({ state: "needs_reconnect", lastErrorCode: "invalid_key", publicUrl: PUBLIC })],
      handle: (call) => {
        if (call.call !== "POST /v1/photo-connections/immich") return undefined;
        state.list = [immich({ publicUrl: PUBLIC })];
        return json({ connection: state.list[0] }, 200);
      },
    });
    const box = await section();
    expect(await within(box).findByText(/needs reconnecting/i)).toBeInTheDocument();
    expect(within(box).queryByLabelText("API key")).toBeNull();
    fireEvent.click(within(box).getByRole("button", { name: "Reconnect" }));
    expect((screen.getByLabelText("Server address") as HTMLInputElement).value).toBe(SERVER);
    expect((screen.getByLabelText("Public address (optional)") as HTMLInputElement).value).toBe(PUBLIC);
    fireEvent.change(keyInput(), { target: { value: KEY } });
    submit();
    expect(await screen.findByText("Connected")).toBeInTheDocument();
    expect(screen.queryByText(/needs reconnecting/i)).toBeNull();
    expect(JSON.parse(posts(calls, "/v1/photo-connections/immich")[0]!.body!)).toEqual({ serverUrl: SERVER, apiKey: KEY, publicUrl: PUBLIC });
    expectKeyGone();
  });

  it("4b. an active connection whose last check could not reach Immich is a last-check line, not a reconnect", async () => {
    mount({ list: [immich({ lastErrorCode: "unreachable" })] });
    const box = await section();
    expect(await within(box).findByText(/The last check failed: Immich could not be reached/)).toBeInTheDocument();
    expect(within(box).queryByRole("button", { name: "Reconnect" })).toBeNull();
  });

  it("5. Test: calls /test, says the verdict in words and updates the state and last-checked line", async () => {
    const checkedAt = "2026-11-26T09:00:00.000Z";
    const { calls, state } = mount({
      list: [immich({ lastCheckedAt: "2026-11-01T09:00:00.000Z" })],
      handle: (call) => {
        if (call.call !== "POST /v1/photo-connections/phc_aaaaaaaaaaaaaaaa/test") return undefined;
        state.list = [immich({ state: "needs_reconnect", lastErrorCode: "invalid_key", lastCheckedAt: checkedAt })];
        return json({ connection: state.list[0], check: { ok: false, error: "invalid_key", message: RAW } });
      },
    });
    const box = await section();
    expect(await within(box).findByText(/Last checked Nov 1, 2026/)).toBeInTheDocument();
    fireEvent.click(within(box).getByRole("button", { name: "Test connection" }));
    expect(await within(box).findByText(/^Immich did not accept this key\./, { selector: "[role=status]" })).toBeInTheDocument();
    expect(await within(box).findByText(/Last checked Nov 26, 2026/)).toBeInTheDocument();
    expect(within(box).getByText(/needs reconnecting/i)).toBeInTheDocument();
    expect(posts(calls, "/v1/photo-connections/phc_aaaaaaaaaaaaaaaa/test")).toHaveLength(1);
    expect(document.body.textContent).not.toContain(RAW);
  });

  it("5b. Test that passes says so", async () => {
    mount({
      list: [immich()],
      handle: (call) => call.call === "POST /v1/photo-connections/phc_aaaaaaaaaaaaaaaa/test" ? json({ connection: immich(), check: { ok: true } }) : undefined,
    });
    const box = await section();
    fireEvent.click(await within(box).findByRole("button", { name: "Test connection" }));
    expect(await within(box).findByText("Immich answered and accepted the key.")).toBeInTheDocument();
  });

  it("6. default: exactly one of two is marked, Make default calls PUT and the other is marked; no control on a sole connection", async () => {
    const { calls, state } = mount({
      list: [immich({ isDefault: true }), google({ isDefault: false })],
      handle: (call) => {
        if (call.call !== "PUT /v1/photo-connections/phc_bbbbbbbbbbbbbbbb/default") return undefined;
        state.list = [immich({ isDefault: false }), google({ isDefault: true })];
        // The route answers the one connection it changed; the page reads the list again either way.
        return json({ connection: state.list[1] });
      },
    });
    const box = await section();
    const rows = await within(box).findAllByRole("listitem");
    expect(rows).toHaveLength(2);
    const marked = () => within(box).getAllByText("Default").map((node) => node.closest("li"));
    expect(marked()).toEqual([rows[0]]);
    expect(within(rows[0]!).queryByRole("button", { name: "Make default" })).toBeNull();
    fireEvent.click(within(rows[1]!).getByRole("button", { name: "Make default" }));
    await waitFor(() => expect(within(box).getAllByRole("listitem")[1]).toContainElement(within(box).getByText("Default")));
    expect(within(box).getAllByText("Default")).toHaveLength(1);
    expect(calls.filter((c) => c.call.startsWith("PUT")).map((c) => c.call)).toEqual(["PUT /v1/photo-connections/phc_bbbbbbbbbbbbbbbb/default"]);
  });

  it("6b. a sole connection has no default mark and no Make default", async () => {
    mount({ list: [immich()] });
    const box = await section();
    await within(box).findByText("Connected");
    expect(within(box).queryByRole("button", { name: "Make default" })).toBeNull();
    expect(within(box).queryByText("Default")).toBeNull();
  });

  it("7. Disconnect asks first; Keep sends nothing; Confirm sends DELETE and the row goes", async () => {
    const { calls, state } = mount({
      list: [immich()],
      handle: (call) => {
        if (call.call !== "DELETE /v1/photo-connections/phc_aaaaaaaaaaaaaaaa") return undefined;
        state.list = [];
        return json({ disconnected: true, connections: [] });
      },
    });
    const box = await section();
    fireEvent.click(await within(box).findByRole("button", { name: "Disconnect" }));
    const confirm = within(box).getByRole("group", { name: "Confirm disconnect" });
    expect(confirm.textContent).toMatch(/Nothing in your library is touched/);
    fireEvent.click(within(confirm).getByRole("button", { name: "Keep" }));
    expect(calls.filter((c) => c.call.startsWith("DELETE"))).toEqual([]);
    expect(within(box).getByText(SERVER)).toBeInTheDocument();
    fireEvent.click(within(box).getByRole("button", { name: "Disconnect" }));
    fireEvent.click(within(within(box).getByRole("group", { name: "Confirm disconnect" })).getByRole("button", { name: "Confirm disconnect" }));
    await waitFor(() => expect(within(box).queryByText(SERVER)).toBeNull());
    expect(calls.filter((c) => c.call.startsWith("DELETE")).map((c) => c.call)).toEqual(["DELETE /v1/photo-connections/phc_aaaaaaaaaaaaaaaa"]);
    expect(await within(box).findByLabelText("Server address")).toBeInTheDocument();
  });

  it("7b. a connection disconnected while its reconnect form is open takes the form with it", async () => {
    const { state } = mount({
      list: [immich({ state: "needs_reconnect" })],
      handle: (call) => {
        if (call.call !== "DELETE /v1/photo-connections/phc_aaaaaaaaaaaaaaaa") return undefined;
        state.list = [];
        return json({ disconnected: true, connections: [] });
      },
    });
    const box = await section();
    fireEvent.click(await within(box).findByRole("button", { name: "Reconnect" }));
    expect(within(box).getByRole("button", { name: "Reconnect Immich" })).toBeInTheDocument();
    fireEvent.click(within(box).getByRole("button", { name: "Disconnect" }));
    fireEvent.click(within(within(box).getByRole("group", { name: "Confirm disconnect" })).getByRole("button", { name: "Confirm disconnect" }));
    expect(await within(box).findByRole("button", { name: "Connect Immich" })).toBeInTheDocument();
    expect(within(box).queryByRole("button", { name: "Reconnect Immich" })).toBeNull();
    expect((within(box).getByLabelText("Server address") as HTMLInputElement).value).toBe("");
  });

  it("8. every change goes through the api client with the CSRF header, and the key is in no URL", async () => {
    const { calls, state } = mount({
      list: [immich({ state: "needs_reconnect" }), google()],
      handle: (call) => {
        if (call.call === "POST /v1/photo-connections/immich") { state.list = [immich({ isDefault: true }), google()]; return json({ connection: state.list[0] }, 200); }
        if (call.call === "POST /v1/photo-connections/phc_aaaaaaaaaaaaaaaa/test") return json({ connection: state.list[0], check: { ok: true } });
        if (call.call === "PUT /v1/photo-connections/phc_bbbbbbbbbbbbbbbb/default") { state.list = [immich({ isDefault: false }), google({ isDefault: true })]; return json({ connection: state.list[1] }); }
        if (call.call === "DELETE /v1/photo-connections/phc_bbbbbbbbbbbbbbbb") { state.list = [immich({ isDefault: true })]; return json({ disconnected: true, connections: state.list }); }
        return undefined;
      },
    });
    const box = await section();
    fireEvent.click(await within(box).findByRole("button", { name: "Reconnect" }));
    fireEvent.change(keyInput(), { target: { value: KEY } });
    submit();
    await within(box).findAllByText("Connected");
    fireEvent.click(within(box).getAllByRole("button", { name: "Test connection" })[0]!);
    await within(box).findByText("Immich answered and accepted the key.");
    fireEvent.click(within(box).getByRole("button", { name: "Make default" }));
    await waitFor(() => expect(calls.some((c) => c.call.startsWith("PUT"))).toBe(true));
    await waitFor(() => expect(within(box).getAllByRole("listitem")[1]).toContainElement(within(box).getByText("Default")));
    fireEvent.click(within(box).getAllByRole("button", { name: "Disconnect" })[1]!);
    fireEvent.click(within(within(box).getByRole("group", { name: "Confirm disconnect" })).getByRole("button", { name: "Confirm disconnect" }));
    await waitFor(() => expect(calls.some((c) => c.call.startsWith("DELETE"))).toBe(true));
    const mutations = calls.filter((c) => c.path.startsWith("/v1/photo-connections") && !c.call.startsWith("GET"));
    expect(mutations.map((c) => c.call.split(" ")[0])).toEqual(["POST", "POST", "PUT", "DELETE"]);
    for (const call of mutations) expect(call.headers.get("X-CSRF-Token")).toBe("csrf-test-token");
    for (const call of calls) expect(call.path).not.toContain(KEY);
    for (const call of calls.filter((c) => c.path.startsWith("/v1/photo-connections"))) expect(call.path).not.toContain("?");
    expectKeyGone();
  });

  it("the Mini App's trip list does not show the section and asks the server nothing about photo libraries", async () => {
    const { calls } = mount({ path: "/mini-app", me: { scope: "telegram" } });
    expect(await screen.findByRole("heading", { name: "My trips" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Photo library" })).toBeNull();
    expect(calls.filter((c) => c.path.startsWith("/v1/photo-connections"))).toEqual([]);
  });

  it("a Telegram-minted session is told to sign in with its password and asks the server nothing", async () => {
    const { calls } = mount({ me: { scope: "telegram" } });
    const box = await section();
    expect(within(box).getByText(/sign in with your password/i)).toBeInTheDocument();
    expect(within(box).queryByLabelText("API key")).toBeNull();
    expect(calls.filter((c) => c.path.startsWith("/v1/photo-connections"))).toEqual([]);
  });
});
