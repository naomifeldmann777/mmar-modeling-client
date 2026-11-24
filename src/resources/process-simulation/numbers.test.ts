/**
 * Tests for numbers.ts: numbers are read with a comma or a dot (plan 4), and nothing else
 * counts as a number; numbers are written so that they are read back, and shown rounded.
 */
import { describe, expect, it } from "vitest";
import { displayValue, parseDecimal, writeDecimal } from "./numbers";

describe("parseDecimal", () => {
  it("reads a comma or a dot as decimal separator (plan 4)", () => {
    expect([parseDecimal("0,8"), parseDecimal("0.8"), parseDecimal(" 1 "), parseDecimal(".5"), parseDecimal("-2,5")]).toEqual([0.8, 0.8, 1, 0.5, -2.5]);
  });

  it("returns null for anything that is not a plain decimal", () => {
    expect([parseDecimal(""), parseDecimal("abc"), parseDecimal("1e3"), parseDecimal("0x10"), parseDecimal("1,2,3")]).toEqual([null, null, null, null, null]);
  });
});

describe("writeDecimal", () => {
  it("never writes exponent notation, so parseDecimal reads every drawn number back", () => {
    expect([writeDecimal(87.31243), writeDecimal(1e-7), writeDecimal(-2.5e-9), writeDecimal(1.5e21), writeDecimal(1000)]).toEqual(["87.31243", "0.0000001", "-0.0000000025", "1500000000000000000000", "1000"]);
    expect(parseDecimal(writeDecimal(1e-7))).toBe(1e-7); // String(1e-7) is "1e-7", which parseDecimal refuses
    expect([writeDecimal(-0), writeDecimal(-1e-25)]).toEqual(["0", "0"]); // no "-0"
  });
});

describe("displayValue", () => {
  it("rounds a number with more than two decimals to two and leaves everything else as written", () => {
    expect([displayValue("87.31243"), displayValue("87,316"), displayValue("100"), displayValue("0,8"), displayValue("ja"), displayValue("-0.001")]).toEqual(["87.31", "87.32", "100", "0,8", "ja", "0"]);
  });
});
