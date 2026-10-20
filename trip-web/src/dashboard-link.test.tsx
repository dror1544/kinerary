import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AppMenu } from "./App";
import { dashboardHref } from "./dashboard-link";
import type { CurrentUser } from "./api";

afterEach(cleanup);

const noop = vi.fn();
function renderMenu(currentUser: CurrentUser | undefined, lang: "en" | "he" = "en") {
  return render(<AppMenu open lang={lang} currentUser={currentUser} isOrganizer={Boolean(currentUser?.is_organizer)} setOpen={noop} setLang={noop} openTab={noop} openModule={noop} />);
}

describe("the organizer's way back to the dashboard", () => {
  it("shows an Organizer dashboard entry only when the session carries dashboard_url", () => {
    renderMenu({ username: "alice", is_organizer: true, dashboard_url: "https://portal.example.test/trips/trip_abcdefgh/setup" });
    const link = screen.getByRole("link", { name: "Organizer dashboard" });
    expect(link).toHaveAttribute("href", "https://portal.example.test/trips/trip_abcdefgh/setup");
  });

  it("is in Hebrew when the trip is", () => {
    renderMenu({ username: "alice", is_organizer: true, dashboard_url: "https://portal.example.test/trips/trip_abcdefgh/setup" }, "he");
    expect(screen.getByRole("link", { name: "לוח המארגן" })).toBeInTheDocument();
  });

  it("is absent for a member, a direct organizer login and a signed-out menu", () => {
    for (const user of [{ username: "bob" }, { username: "alice", is_organizer: true }, undefined] as (CurrentUser | undefined)[]) {
      renderMenu(user);
      expect(screen.queryByTestId("organizer-dashboard-link")).toBeNull();
      expect(screen.queryByText("Organizer dashboard")).toBeNull();
      cleanup();
    }
  });

  it("refuses any href that is not plain http(s) without credentials", () => {
    for (const bad of ["javascript:alert(1)", "data:text/html,x", "vbscript:x", "//evil.example/x", "/relative", "https://user:pw@portal.example.test/", "not a url", ""]) {
      expect(dashboardHref(bad), bad).toBe("");
      renderMenu({ username: "alice", is_organizer: true, dashboard_url: bad });
      expect(screen.queryByTestId("organizer-dashboard-link"), bad).toBeNull();
      cleanup();
    }
    expect(dashboardHref("https://portal.example.test/trips/trip_abcdefgh/setup")).toBe("https://portal.example.test/trips/trip_abcdefgh/setup");
    expect(dashboardHref("http://localhost:5173/trips/x/setup")).toBe("http://localhost:5173/trips/x/setup");
  });
});
