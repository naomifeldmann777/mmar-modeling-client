// Tests for distributions.ts: drawing from each type, the values each type can yield, and
// the text for the user. Fixed random numbers pin single draws; many seeded draws show the
// spread.
import { describe, expect, it } from "vitest";
import { colourSet, describeDistribution, sample, type Drawable } from "./distributions";
import { seededRandom } from "./path-analysis"; // the same seeded generator the path analysis uses

const DISCRETE: Drawable = { type: "Discrete", entries: [{ value: "ja", probability: 0.8 }, { value: "nein", probability: 0.2 }] };
const NORMAL: Drawable = { type: "Normal", mean: 100, standardDeviation: 15 };
const UNIFORM: Drawable = { type: "Uniform", minimum: 10, maximum: 20 };
const EXPONENTIAL: Drawable = { type: "Exponential", mean: 30 };

const always = (value: number) => () => value; // a "random" generator that always gives `value`
const draws = (distribution: Drawable, count: number) => {
  const random = seededRandom(7); // the same numbers in every test run
  return Array.from({ length: count }, () => Number(sample(distribution, random))); // as numbers, for the spread
};
const mean = (values: number[]) => values.reduce((sum, value) => sum + value, 0) / values.length;

describe("sample", () => {
  it("draws a discrete value by its probability", () => {
    expect(sample(DISCRETE, always(0.5))).toBe("ja"); // ja covers 0 to 0.8
    expect(sample(DISCRETE, always(0.9))).toBe("nein"); // nein covers 0.8 to 1
  });

  it("draws a uniform value between Minimum and Maximum", () => {
    expect(sample(UNIFORM, always(0))).toBe("10"); // the lower end
    expect(sample(UNIFORM, always(0.5))).toBe("15"); // the middle
    const values = draws(UNIFORM, 10000);
    expect(values.every((value) => value >= 10 && value <= 20)).toBe(true); // never outside
    expect(mean(values)).toBeCloseTo(15, 0); // centred
  });

  it("draws an exponential value that is never negative, around its Mean", () => {
    const values = draws(EXPONENTIAL, 10000);
    expect(values.every((value) => value >= 0)).toBe(true);
    expect(Math.abs(mean(values) - 30)).toBeLessThan(1.5); // within 5 % after 10 000 draws
  });

  it("draws a normal value around its Mean, spread by its StandardDeviation", () => {
    const values = draws(NORMAL, 10000);
    expect(Math.abs(mean(values) - 100)).toBeLessThan(1);
    const spread = Math.sqrt(mean(values.map((value) => (value - 100) ** 2))); // the measured standard deviation
    expect(Math.abs(spread - 15)).toBeLessThan(1);
  });

  it("gives the same values for the same seed", () => {
    expect(draws(NORMAL, 5)).toEqual(draws(NORMAL, 5)); // repeatable (spec 9)
  });
});

describe("colourSet", () => {
  it("gives the values of each type", () => {
    expect(colourSet(DISCRETE)).toEqual({ values: ["ja", "nein"] });
    expect(colourSet(UNIFORM)).toEqual({ from: 10, to: 20 });
    expect(colourSet(EXPONENTIAL)).toEqual({ from: 0, to: Infinity });
    expect(colourSet(NORMAL)).toEqual({ from: -Infinity, to: Infinity }); // not truncated
  });
});

describe("describeDistribution", () => {
  it("writes each type as the user reads it", () => {
    expect(describeDistribution(DISCRETE)).toBe("ja 0.8 · nein 0.2");
    expect(describeDistribution(NORMAL)).toBe("Normal (μ = 100, σ = 15)");
    expect(describeDistribution(UNIFORM)).toBe("Uniform [10, 20]");
    expect(describeDistribution(EXPONENTIAL)).toBe("Exponential (mean = 30)");
  });
});
