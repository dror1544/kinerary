import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { StarRating } from "./star-rating";
afterEach(cleanup);
it("previews cumulative stars without saving until selected", () => {
  const change = vi.fn();
  const { container, rerender } = render(<StarRating lang="en" value={2} onChange={change} />);
  expect(container.querySelectorAll(".is-filled")).toHaveLength(2);
  const fourth = screen.getByRole("radio", { name: "4 out of 5 stars" });
  fireEvent.mouseEnter(fourth.closest("label")!);
  expect(container.querySelectorAll(".is-filled")).toHaveLength(4);
  expect(change).not.toHaveBeenCalled();
  fireEvent.mouseLeave(container.querySelector(".star-rating-options")!);
  expect(container.querySelectorAll(".is-filled")).toHaveLength(2);
  fireEvent.click(fourth);
  expect(change).toHaveBeenCalledWith(4);
  rerender(<StarRating lang="en" value={4} onChange={change} />);
  expect(fourth).toBeChecked();
  expect(container.querySelectorAll(".is-filled")).toHaveLength(4);
});
it("provides a labeled native radio group in RTL and disables saving while pending", () => {
  const change = vi.fn();
  render(<StarRating lang="he" value={3} disabled onChange={change} />);
  expect(screen.getByRole("group", { name: "הדירוג שלך" })).toHaveAttribute("dir", "rtl");
  expect(screen.getByRole("radio", { name: "3 מתוך 5 כוכבים" })).toBeChecked();
  expect(screen.getAllByRole("radio")).toHaveLength(5);
  expect(screen.getByRole("radio", { name: "5 מתוך 5 כוכבים" })).toBeDisabled();
});
