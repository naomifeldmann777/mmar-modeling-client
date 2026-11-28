/**
 * Clean axis numbers for the charts of the path analysis: ticks at 1, 2 or 5 × a power of
 * ten, the top of a share axis, and numbers written with at most two decimals.
 *
 * Used by: TimeDistributionChart and ConvergenceChart, so both axes read alike.
 *
 * Deliberately NOT here: no drawing and no React; numbers in, numbers or text out.
 */

/** A number with at most two decimals, e.g. 52.5 or 6, for ticks and labels. */
export function formatNumber(value: number): string {
  return String(Math.round(value * 100) / 100);
}

/** The top of a share axis: the smallest of 1, 2, 2.5, 5 × a power of ten that reaches `value`. */
export function niceCeiling(value: number): number {
  if (value <= 0) return 1; // no share at all: any axis will do
  const power = 10 ** Math.floor(Math.log10(value)); // e.g. 0.1 for 0.6
  return [1, 2, 2.5, 5, 10].map((step) => step * power).find((candidate) => candidate >= value - 1e-12)!; // e.g. 0.3: 0.1, 0.2, 0.25 are too small, 0.5 reaches it; the tolerance keeps 0.2 at 0.2
}

/** About `count` clean ticks from `low` to `high`: multiples of 1, 2 or 5 × a power of ten. */
export function niceTicks(low: number, high: number, count: number): number[] {
  if (!(high > low)) return [low]; // one value: one tick, and no endless loop below
  const rough = (high - low) / count; // the step if any number would do
  const power = 10 ** Math.floor(Math.log10(rough)); // its order of magnitude
  const step = [1, 2, 5, 10].map((factor) => factor * power).find((candidate) => candidate >= rough * (1 - 1e-9))!; // the next clean step; the tolerance keeps 0.3 / 3 = 0.10000000000000002 at 0.1
  const ticks: number[] = [];
  for (let tick = Math.ceil(low / step) * step; tick <= high + 1e-9; tick += step) ticks.push(Math.round(tick * 1e9) / 1e9); // rounded, so 0.1 + 0.2 shows as 0.3
  return ticks;
}
