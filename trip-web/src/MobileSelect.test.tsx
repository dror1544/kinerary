import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useState } from "react";
import { MobileSelect } from "./MobileSelect";

function Example() {
  const [value, setValue] = useState("morning");
  return <label>When<MobileSelect value={value} onChange={event => setValue(event.target.value)}><option value="morning">Morning</option><option value="evening">Evening</option><option value="unavailable" disabled>Unavailable</option></MobileSelect></label>;
}
beforeEach(() => {
  vi.stubGlobal("matchMedia", () => ({ matches: true }));
  Object.defineProperty(HTMLDialogElement.prototype, "showModal", { configurable: true, value: function (this: HTMLDialogElement) { this.setAttribute("open", ""); } });
  Object.defineProperty(HTMLDialogElement.prototype, "close", { configurable: true, value: function (this: HTMLDialogElement) { this.removeAttribute("open"); } });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
describe("mobile option picker", () => {
  it("opens readable options and updates the existing controlled select handler", () => {
    render(<Example />);
    const trigger = screen.getByRole("combobox", { name: "When" });
    fireEvent.pointerDown(trigger);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    fireEvent.pointerUp(trigger);
    fireEvent.click(trigger);
    expect(screen.getByRole("dialog", { name: "When" })).toBeVisible();
    expect(screen.getByRole("button", { name: /Morning/ })).toHaveFocus();
    expect(screen.getByRole("button", { name: "Unavailable" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Evening" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.getByRole("combobox")).toHaveValue("evening");
    expect(screen.getByRole("combobox")).toHaveFocus();
  });
  it("cancels without changing selection", () => {
    render(<Example />);
    fireEvent.keyDown(screen.getByRole("combobox"), { key: "Enter" });
    fireEvent(screen.getByRole("dialog"), new Event("cancel", { bubbles: false, cancelable: true }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.getByRole("combobox")).toHaveValue("morning");
  });
  it("leaves desktop native selection intact", () => {
    vi.stubGlobal("matchMedia", () => ({ matches: false }));
    render(<Example />);
    fireEvent.pointerDown(screen.getByRole("combobox"));
    fireEvent.pointerUp(screen.getByRole("combobox"));
    fireEvent.click(screen.getByRole("combobox"));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "evening" } });
    expect(screen.getByRole("combobox")).toHaveValue("evening");
  });
});
