/**
 * Tests for chart-scale.ts: clean ticks, the top of a share axis, numbers with two decimals.
 */
import { describe, expect, it } from "vitest";
import { formatNumber, niceCeiling, niceTicks } from "./chart-scale";

describe("chart-scale", () => {
  it("puts ticks at clean numbers", () => {
    expect(niceTicks(0, 100, 4)).toEqual([0, 50, 100]); // a step of 25 is not clean: 50
    expect(niceTicks(1, 1000, 4)).toEqual([500, 1000]); // 250 -> 500
    expect(niceTicks(0.1, 0.4, 3)).toEqual([0.1, 0.2, 0.3, 0.4]); // without 0.30000000000000004
    expect(niceTicks(5, 5, 4)).toEqual([5]); // a single value
  });

  it("tops a share axis at a clean share, and writes numbers with at most two decimals", () => {
    expect([niceCeiling(0.8), niceCeiling(0.3), niceCeiling(0.2), niceCeiling(0)]).toEqual([1, 0.5, 0.2, 1]);
    expect([formatNumber(52.5), formatNumber(6), formatNumber(832.456)]).toEqual(["52.5", "6", "832.46"]);
  });
});
