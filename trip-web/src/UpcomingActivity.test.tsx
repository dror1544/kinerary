import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { UpcomingActivity } from "./App";
import { type ItineraryItem, getAuthenticatedDocument } from "./api";
vi.mock("./api", async (original) => ({ ...await original<typeof import("./api")>(), getAuthenticatedDocument: vi.fn() }));
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
const item: ItineraryItem = { item_uid: "activity-2", phase_id: "kyoto", date: "2026-09-13", time: "10:00", item_type: "activity", text_he: "מקדש", text_en: "Temple", location_url: "https://maps.google.com/?q=temple", booking: { id: 2, type: "attraction", name: "Temple ticket", conf_file: "temple.pdf" } };
it("opens the exact plan item and keeps Maps independent", () => {
  const open = vi.fn();
  render(<UpcomingActivity item={item} lang="en" onOpenItinerary={open} />);
  expect(screen.getByRole("link", { name: "Google Maps" })).toHaveAttribute("href", item.location_url);
  fireEvent.click(screen.getByRole("link", { name: "Google Maps" }));
  expect(open).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "View Temple in the plan" }));
  expect(open).toHaveBeenCalledWith({ phaseId: "kyoto", date: "2026-09-13", itemUid: "activity-2" });
});
// What the document opens in depends on the browser, so each test pins one
// browser state: activation still live (new tab), expired (this tab), or the
// installed home-screen app (this tab, whatever the activation).
const browser = ({ active, standalone = false }: { active: boolean; standalone?: boolean }) => {
  const windowOpen = vi.spyOn(window, "open").mockReturnValue(null);
  const assign = vi.fn();
  vi.stubGlobal("navigator", Object.assign(Object.create(navigator), { userActivation: { isActive: active } }));
  vi.stubGlobal("matchMedia", vi.fn(() => ({ matches: standalone })));
  vi.stubGlobal("location", { ...window.location, assign });
  vi.stubGlobal("URL", Object.assign(URL, { createObjectURL: vi.fn(() => "blob:confirmation"), revokeObjectURL: vi.fn() }));
  vi.mocked(getAuthenticatedDocument).mockResolvedValue(new Blob(["confirmation"], { type: "application/pdf" }));
  return { windowOpen, assign };
};
const viewConfirmation = (onOpenItinerary = vi.fn()) => {
  render(<UpcomingActivity item={item} lang="en" onOpenItinerary={onOpenItinerary} />);
  fireEvent.click(screen.getByRole("button", { name: "View confirmation" }));
  return onOpenItinerary;
};
it("opens an authenticated confirmation for viewing without editing or navigating the plan", async () => {
  const { windowOpen, assign } = browser({ active: true });
  const open = viewConfirmation();
  // One tab, opened with the document already in hand — never a blank tab
  // opened before the fetch and filled in after it (that tab stayed blank).
  await waitFor(() => expect(windowOpen).toHaveBeenCalledWith("blob:confirmation", "_blank", "noopener"));
  expect(windowOpen).toHaveBeenCalledTimes(1);
  expect(assign).not.toHaveBeenCalled();
  expect(getAuthenticatedDocument).toHaveBeenCalledWith("/api/bookings/confirmation/temple.pdf");
  expect(open).not.toHaveBeenCalled();
  expect(screen.queryByRole("button", { name: /download|edit/i })).not.toBeInTheDocument();
});
it("opens nothing until the document has arrived", async () => {
  const { windowOpen } = browser({ active: true });
  let arrive!: (blob: Blob) => void;
  vi.mocked(getAuthenticatedDocument).mockReturnValue(new Promise<Blob>((resolve) => { arrive = resolve; }));
  viewConfirmation();
  await waitFor(() => expect(getAuthenticatedDocument).toHaveBeenCalled());
  expect(windowOpen).not.toHaveBeenCalled();
  arrive(new Blob(["confirmation"], { type: "application/pdf" }));
  await waitFor(() => expect(windowOpen).toHaveBeenCalledWith("blob:confirmation", "_blank", "noopener"));
});
it("opens the confirmation in this tab when the click's activation has expired", async () => {
  const { windowOpen, assign } = browser({ active: false });
  viewConfirmation();
  await waitFor(() => expect(assign).toHaveBeenCalledWith("blob:confirmation"));
  expect(windowOpen).not.toHaveBeenCalled();
});
it("opens the confirmation in this tab in the installed app, even with live activation", async () => {
  const { windowOpen, assign } = browser({ active: true, standalone: true });
  viewConfirmation();
  await waitFor(() => expect(assign).toHaveBeenCalledWith("blob:confirmation"));
  expect(windowOpen).not.toHaveBeenCalled();
});
it("says so when the confirmation cannot be fetched, and opens nothing", async () => {
  const { windowOpen, assign } = browser({ active: true });
  vi.mocked(getAuthenticatedDocument).mockRejectedValue(new Error("Confirmation not found"));
  viewConfirmation();
  expect(await screen.findByText("Confirmation not found")).toBeInTheDocument();
  expect(windowOpen).not.toHaveBeenCalled();
  expect(assign).not.toHaveBeenCalled();
});
it("omits absent confirmations and searches Maps when no location is stored", () => {
  render(<UpcomingActivity item={{ ...item, booking: null, location_url: null }} config={{ phases: [{ id: "kyoto", title: "Kyoto" }] }} lang="en" onOpenItinerary={vi.fn()} />);
  expect(screen.queryByRole("button", { name: "View confirmation" })).not.toBeInTheDocument();
  expect(screen.getByRole("link", { name: "Google Maps" })).toHaveAttribute("href", "https://www.google.com/maps/search/?api=1&query=Temple%2C%20Kyoto");
});
