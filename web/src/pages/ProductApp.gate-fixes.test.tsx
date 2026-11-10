import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../App";
import { nextDay } from "../components/DateInput";

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
function mount(route: string, handler: (url: string, init?: RequestInit) => Response) {
  vi.stubGlobal("fetch", vi.fn(async (url, init) => handler(String(url), init)));
  render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })}><MemoryRouter initialEntries={[route]}><App /></MemoryRouter></QueryClientProvider>);
}
beforeEach(() => { vi.unstubAllGlobals(); sessionStorage.clear(); });
afterEach(() => { document.documentElement.lang = "en"; document.documentElement.removeAttribute("dir"); });

describe("sign-in page (#432)", () => {
  it("shows no session message on a fresh sign-in page, signed out", async () => {
    mount("/sign-in", (url) => url === "/v1/auth/capabilities" ? json({ google: false, emailPassword: true }) : json({}, 401));
    await screen.findByLabelText("Email");
    // /v1/me has answered 401 by now; the page must stay quiet about it.
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledWith("/v1/me", expect.anything()));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(screen.queryByText(/session is not active/i)).toBeNull();
  });
});

describe("trip creation dates (#433)", () => {
  const mountNewTrip = () => mount("/trips/new", (url) => url === "/v1/me" ? json({ id: "user_existing", displayName: "Organizer" }) : json({}, 404));

  it("nextDay is the following calendar day, across month and year ends", () => {
    expect(nextDay("2027-03-01")).toBe("2027-03-02");
    expect(nextDay("2027-02-28")).toBe("2027-03-01");
    expect(nextDay("2027-12-31")).toBe("2028-01-01");
    expect(nextDay("")).toBeUndefined();
    expect(nextDay("not-a-date")).toBeUndefined();
  });

  it("the end date opens on the day after the chosen start, and cannot precede it", async () => {
    mountNewTrip();
    const start = await screen.findByLabelText("Approximate start") as HTMLInputElement;
    const end = screen.getByLabelText("Approximate end") as HTMLInputElement;
    expect(end.min).toBe("");
    fireEvent.change(start, { target: { value: "2027-03-01" } });
    expect(end.min).toBe("2027-03-02");
    expect(end.value).toBe("2027-03-02");
    // A later start pushes a now-invalid end forward; a still-valid end is left alone.
    fireEvent.change(end, { target: { value: "2027-03-09" } });
    fireEvent.change(start, { target: { value: "2027-03-05" } });
    expect(end.value).toBe("2027-03-09");
    fireEvent.change(start, { target: { value: "2027-03-20" } });
    expect(end.min).toBe("2027-03-21");
    expect(end.value).toBe("2027-03-21");
  });

  it("refuses to submit an end date that is not after the start", async () => {
    const posts: string[] = [];
    mount("/trips/new", (url, init) => {
      if (init?.method === "POST") posts.push(url);
      return url === "/v1/me" ? json({ id: "user_existing", displayName: "Organizer" }) : json({}, 404);
    });
    fireEvent.change(await screen.findByLabelText("Destination"), { target: { value: "Rome" } });
    fireEvent.change(screen.getByLabelText("Approximate start"), { target: { value: "2027-03-10" } });
    fireEvent.change(screen.getByLabelText("Approximate end"), { target: { value: "2027-03-05" } });
    fireEvent.click(screen.getByRole("button", { name: "Create trip" }));
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(posts).toEqual([]);
  });

  it("date inputs follow the page's language and direction", async () => {
    mountNewTrip();
    for (const label of ["Approximate start", "Approximate end"]) {
      const input = await screen.findByLabelText(label);
      expect(input).toHaveAttribute("dir", "ltr");
      expect(input).toHaveAttribute("lang", "en");
    }
  });

  it("date inputs go right-to-left only when the page does", async () => {
    document.documentElement.lang = "he";
    document.documentElement.dir = "rtl";
    mountNewTrip();
    const input = await screen.findByLabelText("Approximate start");
    expect(input).toHaveAttribute("dir", "rtl");
    expect(input).toHaveAttribute("lang", "he");
  });
});
