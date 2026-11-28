// @vitest-environment jsdom
//
// Tests for LogWindow: the entries, newest first, and folding the log to its title line and
// opening it again. The log store is the real one.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useLogStore } from "@/resources/store/logStore";
import LogWindow from "./LogWindow";

beforeEach(() => {
  vi.useFakeTimers(); // the entries are read throttled
  useLogStore.getState().clear();
  useLogStore.getState().log("Scene saved", "done");
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("LogWindow", () => {
  it("shows the entries while open, only its title while folded, and asks to be folded or opened", () => {
    const toggle = vi.fn();
    const { rerender } = render(<LogWindow folded={false} onToggleFold={toggle} />);
    act(() => vi.runAllTimers());
    expect(screen.getByText("Scene saved")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Hide the log" }));
    expect(toggle).toHaveBeenCalledTimes(1); // the column decides, since it also gives up the height

    rerender(<LogWindow folded onToggleFold={toggle} />);
    expect(screen.queryByText("Scene saved")).toBeNull(); // folded: the entries are gone
    expect(screen.getByText("Log")).toBeTruthy(); // the title stays
    expect(screen.getByRole("button", { name: "Show the log" })).toBeTruthy();
  });

  it("offers no fold button where nothing can take the height", () => {
    render(<LogWindow />);
    expect(screen.queryByRole("button", { name: "Hide the log" })).toBeNull();
  });
});
