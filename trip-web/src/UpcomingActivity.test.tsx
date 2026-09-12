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
it("opens an authenticated confirmation for viewing without editing or navigating the plan", async () => {
  const open = vi.fn();
  const replace = vi.fn();
  vi.spyOn(window, "open").mockReturnValue({ opener: null, location: { replace }, close: vi.fn() } as unknown as Window);
  vi.stubGlobal("URL", Object.assign(URL, { createObjectURL: vi.fn(() => "blob:confirmation"), revokeObjectURL: vi.fn() }));
  vi.mocked(getAuthenticatedDocument).mockResolvedValue(new Blob(["confirmation"], { type: "application/pdf" }));
  render(<UpcomingActivity item={item} lang="en" onOpenItinerary={open} />);
  fireEvent.click(screen.getByRole("button", { name: "View confirmation" }));
  await waitFor(() => expect(replace).toHaveBeenCalledWith("blob:confirmation"));
  expect(getAuthenticatedDocument).toHaveBeenCalledWith("/api/bookings/confirmation/temple.pdf");
  expect(open).not.toHaveBeenCalled();
  expect(screen.queryByRole("button", { name: /download|edit/i })).not.toBeInTheDocument();
});
it("omits absent confirmations and searches Maps when no location is stored", () => {
  render(<UpcomingActivity item={{ ...item, booking: null, location_url: null }} config={{ phases: [{ id: "kyoto", title: "Kyoto" }] }} lang="en" onOpenItinerary={vi.fn()} />);
  expect(screen.queryByRole("button", { name: "View confirmation" })).not.toBeInTheDocument();
  expect(screen.getByRole("link", { name: "Google Maps" })).toHaveAttribute("href", "https://www.google.com/maps/search/?api=1&query=Temple%2C%20Kyoto");
});
