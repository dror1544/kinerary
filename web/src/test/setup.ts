import "@testing-library/jest-dom/vitest";
import { afterEach, vi } from "vitest";
import { cleanup, configure } from "@testing-library/react";

afterEach(() => cleanup());

// Every route is lazy-loaded (App.tsx), so the first findBy* after a render
// can be waiting on a chunk import, not just a DOM update. The default 1000ms
// asyncUtilTimeout is too tight on a loaded machine (a 2026-09-29 nightly run
// saw a 2.58s import); 4000ms stays below vitest's 5000ms default testTimeout
// so a genuine hang still fails the test.
configure({ asyncUtilTimeout: 4000 });

Object.defineProperty(window, "scrollTo", {
  configurable: true,
  value: vi.fn(),
});
