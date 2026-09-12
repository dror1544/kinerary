/**
 * A phase with places and no schedule is a real phase.
 *
 * The first organizer-run trip built from an interview arrived with five
 * phases, their dates, their hotels and their places — and no day-by-day,
 * because nothing yet turns planned places into dated days. The itinerary
 * dropped every phase that had no days, so the whole trip rendered as nothing:
 * "no phases, no locations, no data" (2026-09-12).
 */
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { buildPhaseGroups, PhasePlaces } from "./App";

afterEach(cleanup);

describe("a phase that has places but no days", () => {
  it("lists the places, with the links the transformer derived", () => {
    render(<PhasePlaces lang="en" venues={[
      { id: "tokyo-skytree", name: { en: "Tokyo Skytree", he: "טוקיו סקייטרי" }, maps: "https://maps.example/skytree", waze: "https://waze.example/skytree" },
      { id: "teamlab", name: { en: "TeamLab Planets", he: "טימלאב" }, maps: "https://maps.example/teamlab" },
    ]} />);

    expect(screen.getByText("Tokyo Skytree")).toBeInTheDocument();
    expect(screen.getByText("TeamLab Planets")).toBeInTheDocument();
    expect(screen.getAllByRole("link", { name: "Maps" })[0]).toHaveAttribute("href", "https://maps.example/skytree");
    expect(screen.getByRole("link", { name: "Waze" })).toHaveAttribute("href", "https://waze.example/skytree");
  });

  it("says the schedule is open rather than implying the trip is empty", () => {
    render(<PhasePlaces lang="en" venues={[{ id: "a", name: { en: "Somewhere" } }]} />);
    expect(screen.getByText(/no day-by-day for this phase yet/i)).toBeInTheDocument();
  });

  it("still has something honest to say with no places at all", () => {
    render(<PhasePlaces lang="he" venues={[]} />);
    expect(screen.getByText(/עוד לא תוכנן דבר לשלב הזה/)).toBeInTheDocument();
  });
});

describe("the phases the itinerary offers", () => {
  const PHASES = [
    { id: "tokyo", title: { en: "Tokyo" }, venues: [{ id: "skytree", name: { en: "Tokyo Skytree" } }] },
    { id: "hakone", title: { en: "Hakone" } },
  ];

  it("keeps a phase that has no days — that is what an interview-built trip looks like", () => {
    const groups = buildPhaseGroups(PHASES, [], "en");
    expect(groups.map((group) => group.id)).toEqual(["tokyo", "hakone"]);
    expect(groups[0].venues).toHaveLength(1);
  });

  it("still groups the days it does have, and keeps phases the days never mention", () => {
    const days = [
      { date: "2026-09-19", phase_id: "tokyo" },
      { date: "2026-09-20", phase_id: "tokyo" },
    ] as never[];
    const groups = buildPhaseGroups(PHASES, days, "en");
    expect(groups.find((group) => group.id === "tokyo")?.days).toHaveLength(2);
    expect(groups.find((group) => group.id === "hakone")?.days).toHaveLength(0);
  });

  it("a day for a phase the config does not have still gets a group of its own", () => {
    const groups = buildPhaseGroups(PHASES, [{ date: "2026-10-01", phase_id: "kyoto" }] as never[], "en");
    expect(groups.map((group) => group.id)).toContain("kyoto");
  });
});
