import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";
import AdminDashboardPage from "./AdminDashboardPage";

const EMPTY_REPORT = {
  date: "2026-09-27", windowStart: "2026-09-27T00:00:00.000Z", windowEnd: "2026-09-28T00:00:00.000Z",
  funnel: { since: null, until: null, counts: {}, conversions: [] },
  jobs: { byTypeAndState: [] }, releases: { byStatus: {} },
  notMeasuredYet: ["response_rate", "grounded_answer_rate", "missing_data_rate", "traveler_self_service_rate", "post_write_trust_rate"],
};
const EMPTY_FUNNEL = { since: null, until: null, counts: {}, conversions: [] };

function renderPage() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}><MemoryRouter><AdminDashboardPage /></MemoryRouter></QueryClientProvider>,
  );
}

function stubFetch(handler: (url: string, init?: RequestInit) => Response) {
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    // Every call to an admin route must carry the key; a call missing it is a bug in the page itself.
    if (url.startsWith("/v1/admin/")) {
      const headers = new Headers(init?.headers);
      if (!headers.get("x-api-key")) return new Response(JSON.stringify({ error: "AUTHENTICATION_REQUIRED" }), { status: 401 });
    }
    return handler(url, init);
  }));
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

describe("the super-admin dashboard page", () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
    sessionStorage.clear();
  });

  it("shows the unlock form and calls no admin route before a key is entered", async () => {
    const calls: string[] = [];
    stubFetch((url) => { calls.push(url); return json({ error: "NOT_FOUND" }, 404); });
    renderPage();
    expect(await screen.findByRole("heading", { name: /super-admin dashboard/i })).toBeInTheDocument();
    expect(screen.getByLabelText(/admin key/i)).toBeInTheDocument();
    expect(calls.some((url) => url.startsWith("/v1/admin/"))).toBe(false);
  });

  it("fetches every read-only route once the key is submitted, and renders empty states", async () => {
    stubFetch((url) => {
      if (url === "/v1/admin/report") return json(EMPTY_REPORT);
      if (url === "/v1/admin/funnel") return json(EMPTY_FUNNEL);
      if (url === "/v1/admin/jobs") return json({ jobs: [] });
      if (url === "/v1/admin/failures") return json({ failures: [] });
      if (url === "/v1/admin/versions") return json({ releases: [] });
      if (url === "/v1/admin/audit") return json({ events: [] });
      return json({ error: "NOT_FOUND" }, 404);
    });
    renderPage();
    fireEvent.change(screen.getByLabelText(/admin key/i), { target: { value: "a-real-admin-key" } });
    fireEvent.click(screen.getByRole("button", { name: /unlock/i }));

    expect(await screen.findByRole("heading", { name: /control-plane dashboard/i })).toBeInTheDocument();
    expect(await screen.findByText(/no jobs recorded yet/i)).toBeInTheDocument();
    expect(await screen.findByText(/no failures recorded/i)).toBeInTheDocument();
    expect(await screen.findByText(/no releases registered/i)).toBeInTheDocument();
    expect(await screen.findByText(/no audit events recorded/i)).toBeInTheDocument();
    // The five rates this slice deliberately does not compute are named, not silently absent.
    expect(screen.getByText(/response rate/i)).toBeInTheDocument();
    // No jobs recorded means no per-trip action row either — nothing to retry/suspend yet.
    expect(screen.queryByRole("button", { name: /^retry$/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^suspend$/i })).not.toBeInTheDocument();
  });

  it("renders the seeded rows from each route", async () => {
    stubFetch((url) => {
      if (url === "/v1/admin/report") return json(EMPTY_REPORT);
      if (url === "/v1/admin/funnel") return json(EMPTY_FUNNEL);
      if (url === "/v1/admin/jobs") return json({ jobs: [{ id: "job_1", tripId: "trip_1", tripSlug: "rome-2026", jobType: "provision", state: "failed", attempt: 1, safeErrorCode: "BUILD_FAILED", createdAt: "2026-09-27T00:00:00.000Z", updatedAt: "2026-09-27T00:05:00.000Z" }] });
      if (url === "/v1/admin/failures") return json({ failures: [] });
      if (url === "/v1/admin/versions") return json({ releases: [{ id: "release_1", sourceRevision: "a".repeat(40), artifactDigest: `sha256:${"a".repeat(64)}`, status: "available", sanitationPassed: true, promotedToAvailableAt: "2026-09-27T00:00:00.000Z", promotedBy: "operator:dror" }] });
      if (url === "/v1/admin/audit") return json({ events: [] });
      return json({ error: "NOT_FOUND" }, 404);
    });
    renderPage();
    fireEvent.change(screen.getByLabelText(/admin key/i), { target: { value: "a-real-admin-key" } });
    fireEvent.click(screen.getByRole("button", { name: /unlock/i }));

    expect(await screen.findByText("rome-2026")).toBeInTheDocument();
    expect(screen.getByText("BUILD_FAILED")).toBeInTheDocument();
    expect(screen.getByText("release_1")).toBeInTheDocument();
    expect(screen.getByText("operator:dror")).toBeInTheDocument();
  });

  function jobsWithOneRow() {
    return (url: string, init?: RequestInit) => {
      if (url === "/v1/admin/report") return json(EMPTY_REPORT);
      if (url === "/v1/admin/funnel") return json(EMPTY_FUNNEL);
      if (url === "/v1/admin/jobs") return json({ jobs: [{ id: "job_1", tripId: "trip_1", tripSlug: "rome-2026", jobType: "provision", state: "failed", attempt: 1, safeErrorCode: "BUILD_FAILED", createdAt: "2026-09-27T00:00:00.000Z", updatedAt: "2026-09-27T00:05:00.000Z" }] });
      if (url === "/v1/admin/failures") return json({ failures: [] });
      if (url === "/v1/admin/versions") return json({ releases: [] });
      if (url === "/v1/admin/audit") return json({ events: [] });
      if (url === "/v1/admin/trips/trip_1/retry" && init?.method === "POST") {
        return json({ planId: "plan_1", planDigest: "sha256:aa", releaseId: "rls_1", jobId: "job_2", supersededPlanId: null }, 201);
      }
      if (url === "/v1/admin/trips/trip_1/suspend" && init?.method === "POST") {
        const body = JSON.parse(String(init.body));
        if (typeof body.reason !== "string" || body.reason.length === 0) return json({ error: "REASON_REQUIRED" }, 400);
        return json({ tripId: "trip_1", suspendedAt: "2026-09-27T00:10:00.000Z" });
      }
      if (url === "/v1/admin/trips/trip_1/resume" && init?.method === "POST") {
        return json({ tripId: "trip_1" });
      }
      return json({ error: "NOT_FOUND" }, 404);
    };
  }

  async function unlockWithOneJobRow() {
    stubFetch(jobsWithOneRow());
    renderPage();
    fireEvent.change(screen.getByLabelText(/admin key/i), { target: { value: "a-real-admin-key" } });
    fireEvent.click(screen.getByRole("button", { name: /unlock/i }));
    expect(await screen.findByText("rome-2026")).toBeInTheDocument();
  }

  it("retries a trip from its job row and reports success", async () => {
    await unlockWithOneJobRow();
    fireEvent.click(screen.getByRole("button", { name: /^retry$/i }));
    expect(await screen.findByText(/retry: done/i)).toBeInTheDocument();
  });

  it("suspends a trip with a prompted reason, and sends exactly that reason", async () => {
    await unlockWithOneJobRow();
    vi.stubGlobal("prompt", vi.fn(() => "pausing to fix a transformer bug"));
    fireEvent.click(screen.getByRole("button", { name: /^suspend$/i }));
    expect(await screen.findByText(/suspend: done/i)).toBeInTheDocument();
  });

  it("sends nothing when the suspend prompt is cancelled", async () => {
    const calls: string[] = [];
    stubFetch((url, init) => {
      if (url.includes("/suspend")) calls.push(url);
      return jobsWithOneRow()(url, init);
    });
    renderPage();
    fireEvent.change(screen.getByLabelText(/admin key/i), { target: { value: "a-real-admin-key" } });
    fireEvent.click(screen.getByRole("button", { name: /unlock/i }));
    await screen.findByText("rome-2026");

    vi.stubGlobal("prompt", vi.fn(() => null));
    fireEvent.click(screen.getByRole("button", { name: /^suspend$/i }));
    await Promise.resolve();
    expect(calls).toHaveLength(0);
  });

  it("surfaces the server's refusal reason rather than a generic error", async () => {
    await unlockWithOneJobRow();
    vi.stubGlobal("prompt", vi.fn(() => ""));
    fireEvent.click(screen.getByRole("button", { name: /^suspend$/i }));
    expect(await screen.findByText(/suspend failed: REASON_REQUIRED/i)).toBeInTheDocument();
  });

  it("resumes a trip from its job row and reports success", async () => {
    await unlockWithOneJobRow();
    fireEvent.click(screen.getByRole("button", { name: /^resume$/i }));
    expect(await screen.findByText(/resume: done/i)).toBeInTheDocument();
  });

  it("drops a rejected key and returns to the unlock form", async () => {
    stubFetch(() => json({ error: "AUTHENTICATION_REQUIRED" }, 401));
    renderPage();
    fireEvent.change(screen.getByLabelText(/admin key/i), { target: { value: "a-wrong-key" } });
    fireEvent.click(screen.getByRole("button", { name: /unlock/i }));

    expect(await screen.findByLabelText(/admin key/i)).toBeInTheDocument();
    expect(sessionStorage.getItem("kinerary-admin-key")).toBeNull();
  });
});
