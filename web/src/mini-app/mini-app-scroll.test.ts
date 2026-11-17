import { expect, it } from "vitest";
import css from "./mini-app.css?raw";

// jsdom does no layout, so scrolling itself cannot be observed here. What can be pinned is the rule that makes it
// possible: the shell is a fixed-height, overflow:hidden column, and the sign-in / "Choose a trip" screens render a
// <main class="mini-app-unavailable"> directly inside it. Without its own overflow a long chooser is clipped and the
// trips below the fold cannot be reached.
function declarations(selector: string): string {
  const escaped = selector.replace(/[.>]/g, (c) => `\\${c}`).replace(/\s+/g, "\\s*");
  const match = new RegExp(`(?:^|\\})\\s*${escaped}\\s*\\{([^}]*)\\}`, "m").exec(css);
  return match ? match[1]! : "";
}

it("the sign-in / chooser screen scrolls inside the fixed-height shell", () => {
  expect(declarations(".mini-app-shell")).toMatch(/overflow:\s*hidden/);
  const screen = declarations(".mini-app-shell > .mini-app-unavailable");
  expect(screen, "no rule gives the sign-in screen its own scroll").not.toBe("");
  expect(screen).toMatch(/overflow-y:\s*auto|overflow:\s*auto/);
  expect(screen).toMatch(/min-height:\s*0/);
});

it("a short screen stays centred: the auto margin is not removed", () => {
  expect(declarations(".mini-app-unavailable")).toMatch(/margin:\s*auto/);
});
