/**
 * Tests for numbers.ts: numbers are read with a comma or a dot (plan 4), and nothing else
 * counts as a number.
 */
import { describe, expect, it } from "vitest";
import { parseDecimal } from "./numbers";

describe("parseDecimal", () => {
  it("reads a comma or a dot as decimal separator (plan 4)", () => {
    expect([parseDecimal("0,8"), parseDecimal("0.8"), parseDecimal(" 1 "), parseDecimal(".5"), parseDecimal("-2,5")]).toEqual([0.8, 0.8, 1, 0.5, -2.5]);
  });

  it("returns null for anything that is not a plain decimal", () => {
    expect([parseDecimal(""), parseDecimal("abc"), parseDecimal("1e3"), parseDecimal("0x10"), parseDecimal("1,2,3")]).toEqual([null, null, null, null, null]);
  });
});
