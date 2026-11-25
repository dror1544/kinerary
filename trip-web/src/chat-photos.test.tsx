/**
 * The organizer's "Trip photos from the chat" settings (docs/specs/sprint-9/x-trip-photos-and-moments.md, Part A).
 *
 * It renders for an organizer, under each of its own two switches (`chat_photos_to_album`, `trip_moments_capture`), and nowhere else:
 * not for a member, not with the switch off or not literally true, not before the site has said what the settings are.
 * Each change PATCHes only its own key and shows what the site stored; an unknown stored mode shows as the most restrictive.
 */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OrganizerSettings } from "./App";
import { normalizeMomentMode } from "./chat-photos";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  localStorage.clear();
});

const BASE = { participants: [{ username: "alice", name: "אליס", name_en: "Alice", color: "#123456" }] };
const BOTH = { ...BASE, features: { chat_photos_to_album: true, trip_moments_capture: true } };

function renderMore({ isOrganizer, config, lang = "en" }: { isOrganizer: boolean; config: object; lang?: "en" | "he" }) {
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <OrganizerSettings lang={lang} isOrganizer={isOrganizer} config={config} />
    </QueryClientProvider>,
  );
}

function stubSettings(initial: Record<string, unknown>, { failPatch = false } = {}) {
  let stored = { timezone: null, group_change_line: true, ...initial };
  const calls: { method: string; url: string; body: Record<string, unknown> | null }[] = [];
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    calls.push({ method, url, body: init?.body ? JSON.parse(String(init.body)) : null });
    const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    if (url.endsWith("/api/settings") && method === "PATCH") {
      if (failPatch) return json({ error: "organizer_only" }, 403);
      stored = { ...stored, ...JSON.parse(String(init?.body)) };
      return json(stored);
    }
    if (url.endsWith("/api/settings")) return json(stored);
    return json({});
  }));
  return calls;
}
const DEFAULTS = { group_photo_autosave: true, moment_capture_mode: "ask_in_chat" };
const patches = <T extends { method: string }>(calls: T[]) => calls.filter((c) => c.method === "PATCH");

describe("Trip photos from the chat", () => {
  it("shows an organizer both choices with the spec's labels and defaults", async () => {
    stubSettings(DEFAULTS);
    renderMore({ isOrganizer: true, config: BOTH });
    expect(await screen.findByRole("heading", { name: "Trip photos from the chat" })).toBeInTheDocument();
    expect(await screen.findByRole("switch", { name: "Save photos posted in the group" })).toBeChecked();
    const mode = await screen.findByRole("combobox", { name: "New trip moments" });
    expect(mode).toHaveValue("ask_in_chat");
    expect(Array.from((mode as HTMLSelectElement).options).map((o) => o.text)).toEqual(["Ask in the chat", "Save as a draft for organizers", "Publish straight away"]);
  });

  it("is in Hebrew for a Hebrew trip", async () => {
    stubSettings(DEFAULTS);
    renderMore({ isOrganizer: true, config: BOTH, lang: "he" });
    expect(await screen.findByRole("switch", { name: "לשמור תמונות שמפורסמות בקבוצה" })).toBeInTheDocument();
    expect(await screen.findByRole("combobox", { name: "רגעי טיול חדשים" })).toBeInTheDocument();
  });

  it("turning the photo saving off PATCHes only that key and shows what the site stored", async () => {
    const calls = stubSettings(DEFAULTS);
    renderMore({ isOrganizer: true, config: BOTH });
    const toggle = await screen.findByRole("switch", { name: "Save photos posted in the group" });
    fireEvent.click(toggle);
    await waitFor(() => expect(patches(calls)).toHaveLength(1));
    expect(patches(calls)[0].body).toEqual({ group_photo_autosave: false });
    await waitFor(() => expect(screen.getByRole("switch", { name: "Save photos posted in the group" })).not.toBeChecked());
  });

  it("choosing a moment mode PATCHes only moment_capture_mode", async () => {
    const calls = stubSettings(DEFAULTS);
    renderMore({ isOrganizer: true, config: BOTH });
    const mode = await screen.findByRole("combobox", { name: "New trip moments" });
    fireEvent.change(mode, { target: { value: "publish" } });
    await waitFor(() => expect(patches(calls)).toHaveLength(1));
    expect(patches(calls)[0].body).toEqual({ moment_capture_mode: "publish" });
    await waitFor(() => expect(screen.getByRole("combobox", { name: "New trip moments" })).toHaveValue("publish"));
  });

  it("an unknown stored mode shows as the most restrictive one, never publish", async () => {
    stubSettings({ ...DEFAULTS, moment_capture_mode: "publish-everything" });
    renderMore({ isOrganizer: true, config: BOTH });
    expect(await screen.findByRole("combobox", { name: "New trip moments" })).toHaveValue("organizer_draft");
    expect(normalizeMomentMode(undefined)).toBe("organizer_draft");
    expect(normalizeMomentMode("PUBLISH")).toBe("organizer_draft");
    expect(normalizeMomentMode("publish")).toBe("publish");
  });

  it("each control is under its own switch", async () => {
    stubSettings(DEFAULTS);
    renderMore({ isOrganizer: true, config: { ...BASE, features: { chat_photos_to_album: true } } });
    expect(await screen.findByRole("switch", { name: "Save photos posted in the group" })).toBeInTheDocument();
    expect(screen.queryByRole("combobox", { name: "New trip moments" })).toBeNull();
    cleanup();
    renderMore({ isOrganizer: true, config: { ...BASE, features: { trip_moments_capture: true } } });
    expect(await screen.findByRole("combobox", { name: "New trip moments" })).toBeInTheDocument();
    expect(screen.queryByRole("switch", { name: "Save photos posted in the group" })).toBeNull();
  });

  it("does not show to a member, and asks the site nothing", async () => {
    const calls = stubSettings(DEFAULTS);
    renderMore({ isOrganizer: false, config: BOTH });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(screen.queryByRole("heading", { name: "Trip photos from the chat" })).toBeNull();
    expect(calls.filter((c) => c.url.endsWith("/api/settings"))).toEqual([]);
  });

  it("does not show with both switches off, absent or not literally true, and asks the site nothing", async () => {
    const calls = stubSettings(DEFAULTS);
    for (const config of [BASE, { ...BASE, features: {} }, { ...BASE, features: { chat_photos_to_album: "true", trip_moments_capture: 1 } }]) {
      renderMore({ isOrganizer: true, config });
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(screen.queryByRole("heading", { name: "Trip photos from the chat" })).toBeNull();
      cleanup();
    }
    expect(calls.filter((c) => c.url.endsWith("/api/settings"))).toEqual([]);
  });

  it("shows no control until the site has said what the settings are, and says so when saving fails", async () => {
    const calls = stubSettings(DEFAULTS, { failPatch: true });
    renderMore({ isOrganizer: true, config: BOTH });
    expect(screen.queryByRole("switch", { name: "Save photos posted in the group" })).toBeNull();
    fireEvent.click(await screen.findByRole("switch", { name: "Save photos posted in the group" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Could not save");
    expect(patches(calls)).toHaveLength(1);
  });
});
