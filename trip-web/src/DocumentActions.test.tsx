// The plan's timeline offers the same authenticated document three ways:
// view (a tab), download (a file) and the Apple Wallet pass (a file). Only
// "view" opens a window; the other two must never touch one.
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { JourneyView } from "./App";
import { type ItineraryItem, getAuthenticatedDocument } from "./api";
vi.mock("./api", async (original) => ({ ...await original<typeof import("./api")>(), getAuthenticatedDocument: vi.fn() }));
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

const item: ItineraryItem = {
  item_uid: "booking_7", phase_id: "colmar", date: "2090-03-10", time: "afternoon", item_type: "booking", text_he: "מלון", text_en: "Hotel",
  booking: { id: 7, type: "hotel", name: "Hotel", conf_file: "hotel.pdf", pkpass_file: "hotel.pkpass" },
};
let windowOpen: ReturnType<typeof vi.spyOn>;
let assign: ReturnType<typeof vi.fn>;
let clicked: { download: string; href: string; inBody: boolean }[];
beforeEach(() => {
  // jsdom has no scrollIntoView, and the journey scrolls to its focus.
  Element.prototype.scrollIntoView = vi.fn();
  windowOpen = vi.spyOn(window, "open").mockReturnValue(null);
  assign = vi.fn();
  clicked = [];
  vi.stubGlobal("navigator", Object.assign(Object.create(navigator), { userActivation: { isActive: true } }));
  vi.stubGlobal("location", { ...window.location, assign });
  vi.stubGlobal("URL", Object.assign(URL, { createObjectURL: vi.fn(() => "blob:document"), revokeObjectURL: vi.fn() }));
  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) {
    clicked.push({ download: this.download, href: this.href, inBody: document.body.contains(this) });
  });
  vi.mocked(getAuthenticatedDocument).mockResolvedValue(new Blob(["pdf"], { type: "application/pdf" }));
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <JourneyView itinerary={{ revision: "t", days: [{ phase_id: "colmar", date: "2090-03-10", label_en: "Arrive" }], items: [item] }}
        lang="en" onHeroPhaseChange={() => {}} focus={{ phaseId: "colmar", date: "2090-03-10" }} />
    </QueryClientProvider>,
  );
});

it("Confirmation opens the fetched document in one new tab", async () => {
  fireEvent.click(screen.getByRole("button", { name: "Confirmation" }));
  await waitFor(() => expect(windowOpen).toHaveBeenCalledWith("blob:document", "_blank", "noopener"));
  expect(windowOpen).toHaveBeenCalledTimes(1);
  expect(clicked).toEqual([]);
});

it("Download saves the file under its own name from a link that is in the page when clicked", async () => {
  fireEvent.click(screen.getByRole("button", { name: "Download" }));
  await waitFor(() => expect(clicked).toHaveLength(1));
  expect(clicked[0]).toMatchObject({ download: "hotel.pdf", href: "blob:document", inBody: true });
  expect(document.querySelector("a[download]")).toBeNull();
  expect(windowOpen).not.toHaveBeenCalled();
  expect(assign).not.toHaveBeenCalled();
});

it("Apple Wallet saves the pass file and opens no window", async () => {
  fireEvent.click(screen.getByRole("button", { name: "Apple Wallet" }));
  await waitFor(() => expect(clicked).toHaveLength(1));
  expect(clicked[0]).toMatchObject({ download: "hotel.pkpass", href: "blob:document", inBody: true });
  expect(getAuthenticatedDocument).toHaveBeenCalledWith(expect.stringContaining("/api/bookings/wallet-apple/hotel.pkpass"));
  expect(windowOpen).not.toHaveBeenCalled();
  expect(assign).not.toHaveBeenCalled();
});
