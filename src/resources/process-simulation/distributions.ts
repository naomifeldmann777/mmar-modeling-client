/**
 * What a distribution is, apart from any run: drawing a value from it, the values it can
 * yield, and how it is written for the user.
 *
 * Used by: the path analysis (sample), the stepper (sample for "Draw", colourSet to refuse an
 * entered value, describeDistribution), the validator (colourSet for the test values of
 * checks 20 to 22) and path-report (describeDistribution).
 *
 * Deliberately NOT here: no graph, no step, no run. A distribution goes in, a value, a set
 * of values or a text comes out.
 *
 * Every function expects a distribution the validator has accepted: a known type and every
 * parameter a number (checks 12 and 14). That is why the parameters are read with `!`.
 *
 * Source: spec 2.2 (the types and their data), 6.1 (the colour set), 6.2 (drawing).
 */
import type { Distribution } from "./graph"; // the distributions as the transformer reads them

/** A distribution the simulation can draw from: every type but "Unsupported" (check 14). */
export type Drawable = Exclude<Distribution, { type: "Unsupported" }>;

/**
 * The values a variable can take (spec 6.1). Examples:
 *   Discrete ja / nein   -> { values: ["ja", "nein"] }
 *   Uniform 10 to 20     -> { from: 10, to: 20 }
 *   Normal               -> { from: -Infinity, to: Infinity }
 */
export type ColourSet = { values: string[] } | { from: number; to: number };

/**
 * Draws one value and returns it as text, as the run keeps every value (VariableValues).
 * `random` gives numbers between 0 and 1: seeded in the path analysis, Math.random for the
 * stepper's "Draw". Examples:
 *   Discrete ja 0.8 / nein 0.2   -> "ja"
 *   Normal (100, 15)             -> "87.31243…"
 */
export function sample(distribution: Drawable, random: () => number): string {
  switch (distribution.type) {
    case "Discrete": {
      let threshold = random(); // a point between 0 and 1; the probabilities add up to 1 (check 12)
      for (const entry of distribution.entries) {
        threshold -= entry.probability!; // walk along the values until the point is passed: ja 0.8 covers 0 to 0.8
        if (threshold < 0) return entry.value; // this value is drawn
      }
      return distribution.entries[distribution.entries.length - 1].value; // only when rounding leaves the point at the very end
    }
    case "Uniform":
      return String(distribution.minimum! + random() * (distribution.maximum! - distribution.minimum!)); // evenly between Minimum and Maximum
    case "Exponential":
      return String(-distribution.mean! * Math.log(1 - random())); // 1 - random() is never 0, so the logarithm is finite
    case "Normal": {
      const radius = Math.sqrt(-2 * Math.log(1 - random())); // Box-Muller: two numbers between 0 and 1 give one normally distributed number
      return String(distribution.mean! + distribution.standardDeviation! * radius * Math.cos(2 * Math.PI * random())); // shifted to Mean, stretched by StandardDeviation
    }
  }
}

/** The values a variable drawn from `distribution` can take (spec 6.1). */
export function colourSet(distribution: Drawable): ColourSet {
  switch (distribution.type) {
    case "Discrete": return { values: distribution.entries.map((entry) => entry.value) }; // the values listed
    case "Uniform": return { from: distribution.minimum!, to: distribution.maximum! }; // the interval
    case "Exponential": return { from: 0, to: Infinity }; // never negative
    case "Normal": return { from: -Infinity, to: Infinity }; // not truncated: every number (spec 6.2)
  }
}

/**
 * The distribution as the user reads it. Examples:
 *   ja 0.8 · nein 0.2      Normal (μ = 100, σ = 15)      Uniform [10, 20]      Exponential (mean = 30)
 */
export function describeDistribution(distribution: Drawable): string {
  switch (distribution.type) {
    case "Discrete": return distribution.entries.map((entry) => `${entry.value} ${entry.probability}`).join(" · "); // as on the model's label
    case "Normal": return `Normal (μ = ${distribution.mean}, σ = ${distribution.standardDeviation})`; // the usual symbols
    case "Uniform": return `Uniform [${distribution.minimum}, ${distribution.maximum}]`; // an interval, as written in mathematics
    case "Exponential": return `Exponential (mean = ${distribution.mean})`; // the only parameter it reads
  }
}
