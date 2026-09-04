import { render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";
import { tokenStore } from "./api";
import App, { classicHrefForLocation } from "./App";

describe("Modern trip SPA", () => {
  it("shows the login experience when no runtime token exists", () => {
    localStorage.clear();
    render(
      <QueryClientProvider client={new QueryClient()}>
        <App />
      </QueryClientProvider>,
    );
    expect(screen.getByRole("heading", { name: /open your trip/i })).toBeInTheDocument();
  });

  it("recognizes the gateway runtime session marker", () => {
    localStorage.clear();
    localStorage.setItem("trip-token", "runtime-gateway-session");
    expect(tokenStore.get()).toBe("runtime-gateway-session");
  });

  it("points Classic fallback at the API server during local Vite preview", () => {
    expect(classicHrefForLocation("/classic.html", "127.0.0.1", "4185")).toBe("http://127.0.0.1:3000/classic.html");
    expect(classicHrefForLocation("/t/demo/classic.html", "example.com", "")).toBe("/t/demo/classic.html");
  });
});
