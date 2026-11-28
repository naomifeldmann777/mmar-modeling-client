// @vitest-environment jsdom
//
// Tests for ConvergenceChart: the line through the means, the band from 30 runs on, E marked,
// and the caption that says what the band means.
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import type { ConvergencePoint } from "@/resources/process-simulation/path-report";
import ConvergenceChart from "./ConvergenceChart";

afterEach(() => cleanup());

/** Means that settle at 17.8 s, with a band that narrows from the 30th run on. */
const SETTLING: ConvergencePoint[] = [
  { runs: 1, mean: 6, halfWidth: null },
  { runs: 2, mean: 35.5, halfWidth: null },
  { runs: 29, mean: 19, halfWidth: null },
  { runs: 30, mean: 18.5, halfWidth: 8.4 },
  { runs: 500, mean: 17.6, halfWidth: 2.1 },
  { runs: 1000, mean: 17.8, halfWidth: 1.5 },
];

describe("ConvergenceChart", () => {
  it("draws the means as a line and the band from 30 runs on, and marks E", () => {
    const { container } = render(<ConvergenceChart points={SETTLING} name="cycle time" />);
    expect(screen.getByRole("img", { name: "Mean cycle time over the number of runs, with its 95 % confidence interval" })).toBeTruthy();
    const [band, line] = [...container.querySelectorAll("path")].map((path) => path.getAttribute("d")!);
    expect(line.split(" L ")).toHaveLength(6); // one point per mean
    expect(band.split(" L ")).toHaveLength(6); // 3 points with a band: upper edge forth, lower edge back
    expect(screen.getByText("E")).toBeTruthy();
    expect(screen.getByText(/The band is its 95 % confidence interval, from 30 runs on/)).toBeTruthy();
  });

  it("draws no band while there are fewer than 30 runs", () => {
    const { container } = render(<ConvergenceChart points={SETTLING.slice(0, 3)} name="execution time" />);
    expect(container.querySelectorAll("path")).toHaveLength(1); // only the line
  });

  it("puts the runs on a logarithmic axis, 1, 10, 100, … equally far apart, many of them in thousands", () => {
    const { container } = render(<ConvergenceChart points={[{ runs: 1, mean: 800, halfWidth: null }, { runs: 100000, mean: 832, halfWidth: 1.8 }]} name="cycle time" />);
    const ticks = [...container.querySelectorAll("text")].filter((text) => ["1", "10", "100", "1000", "10k", "100k"].includes(text.textContent!));
    expect(ticks.map((tick) => tick.textContent)).toEqual(["1", "10", "100", "1000", "10k", "100k"]);
    const xs = ticks.map((tick) => Number(tick.getAttribute("x")));
    expect(xs.slice(1).map((x, i) => Math.round(x - xs[i]))).toEqual(Array(5).fill(Math.round(xs[1] - xs[0]))); // equal steps
  });
});
