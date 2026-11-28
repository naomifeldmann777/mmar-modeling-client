// @vitest-environment jsdom
//
// Tests for TimeDistributionChart: per value one bar per value or class and the expected value
// marked, no numbers on the bars; cumulative the steps with the 90 % line. The chart takes no
// hover or click.
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import type { TimeDistribution } from "@/resources/process-simulation/path-report";
import TimeDistributionChart from "./TimeDistributionChart";

afterEach(() => cleanup());

/** Model A's execution time: 6 s in 80 % of the runs, 65 s in 20 %. */
const TWO_VALUES: TimeDistribution = {
  entries: [{ from: 6, to: 6, runs: 800, share: 0.8 }, { from: 65, to: 65, runs: 200, share: 0.2 }],
  grouped: false, runs: 1000, mean: 17.8, standardDeviation: 23.6, minimum: 6, maximum: 65, quantile90: 65,
  cumulative: [{ time: 6, share: 0.8 }, { time: 65, share: 1 }], halfWidth95: 1.46,
};

/** The texts of the chart. */
const texts = (container: HTMLElement) => [...container.querySelectorAll("text")].map((text) => text.textContent);

describe("TimeDistributionChart", () => {
  it("draws one bar per value without numbers on it, and marks E", () => {
    const { container } = render(<TimeDistributionChart distribution={TWO_VALUES} name="execution time" view="perValue" />);
    expect(container.querySelectorAll("path")).toHaveLength(2); // one bar per value, no line between them
    expect(texts(container)).toContain("E");
    expect(texts(container)).not.toContain("80 %"); // the shares are in the table; the axis reads 0, 50 and 100 %
    expect(screen.queryAllByRole("button")).toHaveLength(0); // nothing to hover or click
  });

  it("keeps a tiny share visible as a sliver", () => {
    const close: TimeDistribution = {
      ...TWO_VALUES,
      entries: [{ from: 31, to: 31, runs: 6005, share: 0.6005 }, { from: 40, to: 40, runs: 3955, share: 0.3955 }, { from: 53, to: 53, runs: 4, share: 0.0004 }, { from: 54, to: 54, runs: 8, share: 0.0008 }, { from: 55, to: 55, runs: 28, share: 0.0028 }],
      mean: 34.6,
    };
    const { container } = render(<TimeDistributionChart distribution={close} name="cycle time" view="perValue" />);
    const heights = [...container.querySelectorAll("path")].map((bar) => bar.getAttribute("d")!.split(" ")).map((d) => Number(d[2]) - Number(d[7])); // "M left baseline V … Q left top …": baseline minus top
    expect(heights[2]).toBeGreaterThan(0); // 0.04 % of the axis would be far below a pixel
  });

  it("draws a bar per class when the values are grouped", () => {
    const grouped: TimeDistribution = { ...TWO_VALUES, grouped: true, entries: [{ from: 0, to: 10, runs: 3, share: 0.75 }, { from: 10, to: 20, runs: 0, share: 0 }, { from: 20, to: 30, runs: 1, share: 0.25 }] };
    const { container } = render(<TimeDistributionChart distribution={grouped} name="cycle time" view="perValue" />);
    expect(container.querySelectorAll("path")).toHaveLength(2); // an empty class draws nothing
  });

  it("writes the 90 % label where the steps cannot cover it", () => {
    const label = (distribution: TimeDistribution) => {
      const { container } = render(<TimeDistributionChart distribution={distribution} name="cycle time" view="cumulative" />);
      const text = [...container.querySelectorAll("text")].find((element) => element.textContent?.startsWith("90 %"))!;
      const result = { text: text.textContent, anchor: text.getAttribute("text-anchor") };
      cleanup();
      return result;
    };
    expect(label(TWO_VALUES)).toEqual({ text: "90 % finish within 65 s", anchor: "end" }); // the quantile at the right end: left of it, above the line, where the steps are below 90 %
    const early: TimeDistribution = { ...TWO_VALUES, entries: [{ from: 615, to: 615, runs: 9, share: 0.9 }, { from: 4230, to: 4230, runs: 1, share: 0.1 }], quantile90: 615, cumulative: [{ time: 615, share: 0.9 }, { time: 4230, share: 1 }] };
    expect(label(early)).toEqual({ text: "90 % finish within 615 s", anchor: "start" }); // the quantile at the left end: right of it, below the line, where the steps are at 90 % or more
  });

  it("draws classes instead of single bars that would be too thin, and says so", () => {
    const crowded: TimeDistribution = { ...TWO_VALUES, entries: [{ from: 615, to: 615, runs: 39, share: 0.39 }, { from: 625, to: 625, runs: 17, share: 0.17 }, { from: 4230, to: 4230, runs: 44, share: 0.44 }], mean: 2000 }; // 615 and 625 s lie less than 3 units apart on this axis
    const { container } = render(<TimeDistributionChart distribution={crowded} name="cycle time" view="perValue" />);
    expect(container.querySelectorAll("path")).toHaveLength(2); // the class with 615 and 625 s, and the one with 4230 s
    expect(screen.getByText(/the bars show classes of equal width; the table lists every time/)).toBeTruthy();
    cleanup();
    render(<TimeDistributionChart distribution={TWO_VALUES} name="execution time" view="perValue" />);
    expect(screen.queryByText(/classes of equal width/)).toBeNull(); // 6 and 65 s lie far apart: single bars
  });

  it("draws the cumulative steps with the 90 % line", () => {
    const { container } = render(<TimeDistributionChart distribution={TWO_VALUES} name="cycle time" view="cumulative" />);
    expect(screen.getByRole("img", { name: "Cumulative distribution of the cycle time over the finished runs" })).toBeTruthy();
    expect(screen.getByText("90 % finish within 65 s")).toBeTruthy(); // 80 % are done after 6 s, all after 65 s
    const steps = container.querySelector("path")!.getAttribute("d")!; // the one line: right, up, right, up, right
    expect(steps.match(/[HV]/g)).toEqual(["H", "V", "H", "V", "H"]); // flat between the values, never sloping
  });
});
