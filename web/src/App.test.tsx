import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { App } from "./App";

function renderRoute(route: string) {
  return render(
    <MemoryRouter initialEntries={[route]}>
      <App />
    </MemoryRouter>,
  );
}

describe("Kinerary SPA routes", () => {
  it("renders the public landing route and its primary action", async () => {
    renderRoute("/");
    expect(await screen.findByRole("heading", { name: /keep your family trip moving/i })).toBeInTheDocument();
    expect(screen.getAllByRole("link", { name: /start a trip/i }).length).toBeGreaterThan(0);
  });

  it("updates the plans-changed scenario without leaving the route", async () => {
    renderRoute("/");
    const tab = await screen.findByRole("tab", { name: /dinner moves/i });
    fireEvent.click(tab);
    expect(screen.getByRole("heading", { name: /one update, everyone aligned/i })).toBeInTheDocument();
  });

  it("renders the trip-intent route directly", async () => {
    renderRoute("/trips/new");
    expect(await screen.findByRole("heading", { name: /where are you headed/i })).toBeInTheDocument();
    expect(screen.getByLabelText(/destination/i)).toBeInTheDocument();
  });

  it("renders the sign-in route directly", async () => {
    renderRoute("/sign-in");
    expect(await screen.findByRole("heading", { name: /good to see you/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /continue with google/i })).toBeInTheDocument();
  });

  it("renders the lifecycle-oriented trip dashboard preview", async () => {
    renderRoute("/trips");
    expect(await screen.findByRole("heading", { name: "My trips" })).toBeInTheDocument();
    expect(screen.getByText(/active now/i)).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: /past trips/i })).toBeInTheDocument();
  });
});
