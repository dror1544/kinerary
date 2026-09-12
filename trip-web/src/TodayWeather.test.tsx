import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, expect, it, vi } from "vitest";
import { TodayWeather, weatherPhase } from "./TodayWeather";
import { getWeather, type TripConfig } from "./api";
vi.mock("./api", () => ({ getWeather: vi.fn() }));
afterEach(() => { cleanup(); vi.resetAllMocks(); });
const config: TripConfig = { phases: [
  { id: "tokyo", title: "Tokyo", start: "2026-09-12", end: "2026-09-12", mapStop: { lat: 35, lng: 139, name: "Tokyo" } },
  { id: "kyoto", title: "Kyoto", dates: { start: "2026-09-13", end: "2026-09-15" }, mapStop: { lat: 34, lng: 135, name: "Kyoto" } },
] };
function show(value = config) {
  render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><TodayWeather config={value} today="2026-09-12" lang="en" /></QueryClientProvider>);
}
it("follows destinations and stops at the provider forecast horizon", async () => {
  vi.mocked(getWeather).mockImplementation(async (lat, _lon, date) => ({ source: "open-meteo", date, forecast_dates: ["2026-09-12", "2026-09-13"], temperature_max: lat === 35 ? 28 : 22, temperature_min: null, precipitation_probability: 0 }));
  show();
  expect(screen.getByRole("button", { name: "Back" })).toBeDisabled();
  expect(await screen.findByText("High 28°C · Low —")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Next" }));
  expect(await screen.findByText("High 22°C · Low —")).toBeInTheDocument();
  expect(screen.getByText("Kyoto")).toBeInTheDocument();
  expect(getWeather).toHaveBeenCalledWith(34, 135, "2026-09-13");
  expect(screen.getByRole("button", { name: "Next" })).toBeDisabled();
  fireEvent.click(screen.getByRole("button", { name: "Back" }));
  expect(screen.getByText("Tokyo")).toBeInTheDocument();
});
it("uses the active itinerary day over phase date ranges", () => {
  expect(weatherPhase(config, { revision: "1", days: [{ date: "2026-09-12", phase_id: "kyoto" }], items: [] }, "2026-09-12")?.id).toBe("kyoto");
  expect(weatherPhase(config, undefined, "2026-08-01")).toBeUndefined();
});
it("does not substitute the first stop for an unmapped day", () => {
  show({ phases: [] });
  expect(screen.getByText("No planned location")).toBeInTheDocument();
  expect(getWeather).not.toHaveBeenCalled();
});
it("handles unavailable forecasts without inventing temperatures or a horizon", async () => {
  vi.mocked(getWeather).mockResolvedValue({ source: "unavailable", date: "2026-09-12", stale: true });
  show();
  expect(await screen.findByText("Forecast unavailable for this day.")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Next" })).toBeDisabled();
});
