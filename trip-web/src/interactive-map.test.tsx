import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { InteractiveMap } from "./App";

const mocks = vi.hoisted(() => ({ maps: [] as any[], markers: [] as any[], worker: vi.fn() }));
vi.mock("maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url", () => ({ default: "/assets/test-worker.js" }));
vi.mock("maplibre-gl", () => ({
  setWorkerUrl: mocks.worker,
  NavigationControl: class {},
  Map: class {
    handlers: Record<string, Function> = {};
    options: any;
    remove = vi.fn(); resize = vi.fn(); jumpTo = vi.fn(); flyTo = vi.fn(); fitBounds = vi.fn();
    addControl = vi.fn(); addSource = vi.fn(); addLayer = vi.fn();
    getStyle = () => ({ layers: [{ id: "labels", type: "symbol" }] });
    on = (event: string, callback: Function) => { this.handlers[event] = callback; };
    constructor(options: any) { this.options = options; mocks.maps.push(this); }
  },
  Marker: class {
    remove = vi.fn();
    constructor() { mocks.markers.push(this); }
    setLngLat() { return this; }
    addTo() { return this; }
  },
}));
const pins = [
  { id: "stay:a", phaseId: "a", lat: 35, lng: 139, title: "Hotel", subtitle: "Tokyo", kind: "stay" as const },
  { id: "stop:b", phaseId: "a", lat: 35.1, lng: 139.1, title: "Park", subtitle: "Walk", kind: "stop" as const },
];
afterEach(() => { cleanup(); vi.useRealTimers(); mocks.maps.length = 0; mocks.markers.length = 0; vi.clearAllMocks(); });

it("installs the bundled worker and places trip markers before the basemap loads", async () => {
  render(<InteractiveMap pins={pins} lang="en" onOpenItinerary={() => {}} />);
  await waitFor(() => expect(mocks.maps).toHaveLength(1));
  expect(mocks.worker).toHaveBeenCalledWith("/assets/test-worker.js");
  expect(mocks.markers).toHaveLength(2);
  expect(mocks.maps[0].jumpTo).toHaveBeenCalledWith({ center: [139, 35], zoom: 16 });
  fireEvent.click(screen.getByRole("button", { name: "Next" }));
  expect(mocks.maps[0].flyTo).toHaveBeenLastCalledWith(expect.objectContaining({ center: [139.1, 35.1], pitch: 0 }));
});

it("switches to 3D at the selected stop, reports readiness, and cleans up on return to 2D", async () => {
  const view = render(<InteractiveMap pins={pins} lang="en" onOpenItinerary={() => {}} />);
  await waitFor(() => expect(mocks.maps).toHaveLength(1));
  fireEvent.click(screen.getByRole("button", { name: "Next" }));
  fireEvent.click(screen.getByRole("button", { name: "3D" }));
  await waitFor(() => expect(mocks.maps).toHaveLength(2));
  const map = mocks.maps[1];
  expect(mocks.maps[0].remove).toHaveBeenCalledOnce();
  expect(map.options.pitch).toBe(50);
  expect(map.jumpTo).toHaveBeenCalledWith({ center: [139.1, 35.1], zoom: 16 });
  expect(screen.getByRole("status")).toHaveTextContent("Loading 3D");
  act(() => { map.handlers["style.load"](); map.handlers.sourcedata({ sourceId: "buildings", isSourceLoaded: true }); });
  expect(map.addLayer).toHaveBeenCalledWith(expect.objectContaining({ type: "fill-extrusion" }), "labels");
  expect(screen.queryByRole("status")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "2D" }));
  await waitFor(() => expect(mocks.maps).toHaveLength(3));
  expect(map.remove).toHaveBeenCalledOnce();
  expect(mocks.maps[2].options.pitch).toBe(0);
  view.unmount();
  expect(mocks.maps[2].remove).toHaveBeenCalledOnce();
});

it("offers 2D when the 3D provider stalls, while preserving trip navigation", async () => {
  render(<InteractiveMap pins={pins} lang="en" onOpenItinerary={() => {}} />);
  await waitFor(() => expect(mocks.maps).toHaveLength(1));
  vi.useFakeTimers();
  await act(async () => { fireEvent.click(screen.getByRole("button", { name: "3D" })); });
  act(() => { vi.advanceTimersByTime(15000); });
  expect(screen.getByRole("status")).toHaveTextContent("Switch to 2D");
  expect(mocks.markers).toHaveLength(4);
  fireEvent.click(screen.getByRole("button", { name: "Next" }));
  expect(mocks.maps[1].flyTo).toHaveBeenCalledWith(expect.objectContaining({ center: [139.1, 35.1], pitch: 50 }));
});
