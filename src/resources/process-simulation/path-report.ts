/**
 * How the results of a path analysis are written out: the element list of one path, as the
 * panel shows it, the distribution of a time over the runs with its figures and how its mean
 * converges, for the charts, and the whole result as CSV, for the export.
 *
 * Used by: the path-analysis panel (element list, distribution) and its "Export CSV" button.
 *
 * Why in the library and not in the panel: the texts follow from the concepts, not from the
 * client (Plan2 A5: display texts belong with the algorithm, so a new concept is described
 * correctly without a change to the client).
 *
 * Deliberately NOT here: no file, no download, no MMAR. This file only turns plain data into
 * text.
 *
 * The element list follows BEE-UP's path results: one line per executed node, the branches of
 * a split indented, each branch marked as one, and at a Decision or OR-Split the condition of
 * the flow that was taken. A path's trace advances one branch until it waits at its join, then
 * the next (path-analysis.ts), so every branch is one block of lines.
 *
 * Source: spec 9 and 9.1 (what the path analysis reports).
 */
import { describeDistribution, type Drawable } from "./distributions"; // a continuous draw is shown as its distribution
import type { ConditionRow, SimulationGraph } from "./graph"; // node and flow names, conditions
import type { PathAnalysisResult, TraceEntry } from "./path-analysis"; // what is written out
import { WAITING_CONCEPTS, type NodeConcept } from "./vocabulary"; // joins close the branches of a split

/** The result of an analysis that ran. */
export type CompletedAnalysis = Extract<PathAnalysisResult, { ok: true }>;

/** One line of a path's element list. */
export interface PathLine {
  depth: number; // how deep inside parallel or inclusive branches: 0 outside any
  branchStart: boolean; // the first node of a branch, marked "*" in the list
  text: string; // e.g. Decision "lager?" → lager == nein
}

const SPLITS: readonly NodeConcept[] = ["AND-Split", "OR-Split", "ForkActivity"]; // open branches that a join closes
const DECIDING: readonly NodeConcept[] = ["Decision", "OR-Split"]; // the flow they take follows from a condition

// ---------------------------------------------------------------------------------
// The element list of a path
// ---------------------------------------------------------------------------------

/**
 * The lines of a path, one per executed node. Example, Start → AND-Split → (Task 1) and
 * (Task 2) → AND-Join → Decision → End:
 *
 *   depth 0          Start "Start"
 *   depth 0          AND-Split "Split"
 *   depth 1  start   Activity "Task 1"
 *   depth 1  start   Activity "Task 2"
 *   depth 0          AND-Join "Join"
 *   depth 0          Decision "On stock?" → Stock == no
 *   depth 0          End "End"
 */
export function pathLines(graph: SimulationGraph, trace: readonly TraceEntry[]): PathLine[] {
  // A stack: one entry per split whose join has not run yet, holding the flows that split sent
  // out. The last entry is the innermost split. Example, Split ─f1─▶ a1 ─fa─▶ a2 ─▶ Join and
  // Split ─f2─▶ b1 ─▶ Join:
  //   after Split:  open = [ {f1, f2} ]   a1 takes f1, which is in the set: first node of a branch, "*"
  //                                       a2 takes fa, which is not: same branch, no "*"
  //                                       b1 takes f2, which is: a new branch, "*"
  //   after Join:   open = [ ]            the join removed (pop) the entry of its split
  // With a split inside a branch, its entry lies on top: [ {f1, f2}, {f3, f4} ]. The order of
  // the trace alone cannot tell a new branch from the next node of the same one; where the
  // token came from (the flow taken) can.
  const open: Set<string>[] = [];
  return trace.map((entry) => {
    const concept = graph.nodes[entry.node].concept; // what the node is
    if ((WAITING_CONCEPTS as readonly NodeConcept[]).includes(concept) && open.length > 0) open.pop(); // a join closes the innermost split; it is written outside its branches
    const branchStart = open.length > 0 && entry.consumes.some((flowId) => open[open.length - 1].has(flowId)); // it takes a token the split put there
    const line = { depth: open.length, branchStart, text: describeEntry(graph, entry) }; // at the depth of the branches it belongs to
    if (SPLITS.includes(concept)) open.push(new Set(entry.produces)); // its branches follow, one level deeper
    return line;
  });
}

/**
 * One executed node as the user reads it. Examples:
 *   Activity "Check stock": lager = ja
 *   Activity "Take order": amount ~ Normal (μ = 100, σ = 15)
 *   Decision "lager?" → lager == nein
 *   OR-Split "Extras" → kunde == premium, lager == ja
 *
 * A continuous draw is written as its distribution, not as its value: a path is a sequence of
 * nodes, and its runs drew different numbers. The trace kept is the one of its first run, whose
 * number would read as if it held for the whole path. Which numbers belong to the path is said
 * by the condition taken at the next Decision or OR-Split, e.g. → amount >= 100.
 */
export function describeEntry(graph: SimulationGraph, entry: TraceEntry): string {
  const node = graph.nodes[entry.node]; // the executed node
  const draws = entry.draws.map((draw) => {
    const distribution = graph.generators[draw.generator]?.distribution; // what the value was drawn from
    return distribution && distribution.type !== "Discrete" ? `${draw.variableName} ~ ${describeDistribution(distribution as Drawable)}` : `${draw.variableName} = ${draw.value}`; // `as`: a run only draws from a supported type (check 14)
  }); // the values drawn there
  const taken = DECIDING.includes(node.concept) ? entry.produces.map((flowId) => describeTaken(graph, flowId)) : []; // why the token went where it went
  return `${node.concept} "${node.label}"${draws.length > 0 ? `: ${draws.join(", ")}` : ""}${taken.length > 0 ? ` → ${taken.join(", ")}` : ""}`;
}

/** A flow that was taken: its condition, or where it leads when it has none. */
function describeTaken(graph: SimulationGraph, flowId: string): string {
  const flow = graph.flows[flowId]; // the flow the token went on
  if (flow.condition && flow.condition.length > 0) return conditionText(flow.condition); // e.g. lager == nein AND kunde == premium
  return `"${graph.nodes[flow.target ?? ""]?.label ?? "?"}"`; // no condition: the element it leads to
}

/** The rows of a condition as one text, e.g. "lager == ja AND kunde == premium". */
export function conditionText(rows: readonly ConditionRow[]): string {
  return rows.map((row, index) => `${index > 0 ? `${row.logicalOperator} ` : ""}${row.variableName} ${row.operator} ${row.value}`).join(" "); // the first row has no logical operator
}

// ---------------------------------------------------------------------------------
// The distribution of a time over the runs
// ---------------------------------------------------------------------------------

/** The times whose distribution can be shown; transport time and distance may follow. */
export type TimeQuantity = "executionTime" | "cycleTime";

export const MAX_SINGLE_VALUES = 30; // up to this many different values, each one is shown on its own; more are grouped into classes
export const CLASS_COUNT = 20; // the number of classes of equal width when they are grouped
export const MIN_RUNS_FOR_INTERVAL = 30; // a confidence interval from fewer runs is not trustworthy: σ itself is too uncertain, and the mean not yet near a normal distribution
export const MAX_CONVERGENCE_POINTS = 400; // more points than this add nothing a chart in the panel can show, and 100 000 would slow it down
const Z_95 = 1.96; // 95 % of a normal distribution lie within ±1.96 standard deviations of its mean

/** One value, or one class of values, and how many finished runs had it. */
export interface DistributionEntry {
  from: number; // seconds; the value itself, or where its class begins
  to: number; // the same as `from` for a single value; where its class ends
  runs: number; // finished runs with a time in it
  share: number; // runs / all finished runs, so the shares add up to 1
}

/** A time over the finished runs: how often each value occurred, and its figures. */
export interface TimeDistribution {
  entries: DistributionEntry[]; // ascending
  grouped: boolean; // true: the entries are classes (more than MAX_SINGLE_VALUES different values)
  runs: number; // the finished runs it is taken over
  mean: number; // the expected value E, the same as the expected time of the summary
  standardDeviation: number; // σ, how far the times lie from E on average (divided by the number of runs)
  minimum: number; // the shortest time
  maximum: number; // the longest
  quantile90: number; // 90 % of the finished runs took this long or less
  halfWidth95: number | null; // E is known to ± this with 95 % confidence (see confidenceHalfWidth); null for fewer than MIN_RUNS_FOR_INTERVAL runs
  cumulative: { time: number; share: number }[]; // at every different time, ascending: the share of the finished runs that took this long or less; the last share is 1. Exact also when `entries` are classes
}

/**
 * The distribution of `quantity` over the finished runs of `result`, with its figures; null
 * when no run finished. Only finished runs count, as for the expected times (spec 9.1).
 *
 * Example, test model A (ET 6 s with lager = ja, 65 s with nein), 1000 runs, 800 of them ja:
 *   entries      [{ from: 6, to: 6, runs: 800, share: 0.8 }, { from: 65, to: 65, runs: 200, share: 0.2 }]
 *   cumulative   [{ time: 6, share: 0.8 }, { time: 65, share: 1 }]
 *   mean 17.8   standardDeviation 23.6   minimum 6   maximum 65   quantile90 65   halfWidth95 1.46
 *
 * With fixed execution times every path has one time, so there are as many values as paths
 * with different times. Loops, and later random times, give many values; past
 * MAX_SINGLE_VALUES they are grouped into CLASS_COUNT classes of equal width (a histogram).
 */
export function timeDistribution(result: CompletedAnalysis, quantity: TimeQuantity): TimeDistribution | null {
  const times = result.allRuns.filter((run) => run.outcome === "finished").map((run) => run[quantity]!).sort((a, b) => a - b); // `!`: a finished run has a cycle time; ascending, for the quantile
  if (times.length === 0) return null; // nothing to show
  const n = times.length; // the finished runs
  const mean = times.reduce((sum, time) => sum + time, 0) / n; // E
  const standardDeviation = Math.sqrt(times.reduce((sum, time) => sum + (time - mean) ** 2, 0) / n); // σ: the square root of the mean squared distance from E (the variance)
  const minimum = times[0]; // sorted
  const maximum = times[n - 1];
  const quantile90 = times[Math.ceil(0.9 * n) - 1]; // the smallest time that at least 90 % of the runs do not exceed ("nearest rank")

  const counts = new Map<number, number>(); // time -> runs with it, in ascending order since `times` is sorted
  for (const time of times) counts.set(time, (counts.get(time) ?? 0) + 1);
  const grouped = counts.size > MAX_SINGLE_VALUES; // too many values to tell apart side by side
  const values = [...counts].map(([time, runs]) => ({ from: time, to: time, runs, share: runs / n })); // one entry per different time
  const entries = grouped ? groupIntoClasses(values) : values;
  let below = 0; // runs up to the time reached so far
  const cumulative = [...counts].map(([time, runs]) => ({ time, share: (below += runs) / n })); // one step per different time
  const squares = times.reduce((sum, time) => sum + (time - mean) ** 2, 0); // the squared distances from E, added up
  return { entries, grouped, runs: n, mean, standardDeviation, minimum, maximum, quantile90, cumulative, halfWidth95: confidenceHalfWidth(squares, n) };
}

/** A share as a percentage, e.g. 80 % or 12.5 %; two decimals below 1 %, so a rare path does not read as 0 %. */
export function formatShare(share: number): string {
  const percent = share * 100; // e.g. 0.0006 -> 0.06
  return `${percent > 0 && percent < 1 ? percent.toFixed(2) : String(Math.round(percent * 10) / 10)} %`;
}

// ---------------------------------------------------------------------------------
// How the mean converges
// ---------------------------------------------------------------------------------

/** The mean of a time after the first `runs` finished runs, and how sure it is. */
export interface ConvergencePoint {
  runs: number; // k: the finished runs so far, in the order they were made
  mean: number; // the mean of their times
  halfWidth: number | null; // the 95 % confidence interval is mean ± this; null before MIN_RUNS_FOR_INTERVAL runs
}

/**
 * How the mean of `quantity` settles as runs are added (the law of large numbers): one point
 * per number of finished runs k, at most MAX_CONVERGENCE_POINTS of them, always with the first
 * and the last. The chart draws k on a logarithmic axis, so the points are spread the same
 * way: every k at first, then further and further apart (1, 2, 3, …, 100, 103, 106, …, 99 000,
 * 100 000), each equally far from the next on the chart.
 *
 * The runs are gone through once, in the order they were made, keeping the mean and the sum of
 * squared distances up to date (Welford's method: no sum is recomputed for every k, and no
 * precision is lost by subtracting large sums).
 *
 * Example, test model A, CT of the first five runs 6, 65, 6, 6, 6 s:
 *   means 6, 35.5, 25.7, 20.8, 17.8 s; no interval yet (fewer than 30 runs)
 */
export function convergence(result: CompletedAnalysis, quantity: TimeQuantity): ConvergencePoint[] {
  const times = result.allRuns.filter((run) => run.outcome === "finished").map((run) => run[quantity]!); // in the order the runs were made; `!`: a finished run has a cycle time
  const kept = new Set(Array.from({ length: MAX_CONVERGENCE_POINTS }, (_, i) => Math.round(times.length ** (i / (MAX_CONVERGENCE_POINTS - 1))))); // n^0 = 1 to n^1 = n in equal steps of the logarithm; the rounding makes the first ones every k
  const points: ConvergencePoint[] = [];
  let mean = 0; // of the runs so far
  let squares = 0; // their squared distances from that mean, added up
  times.forEach((time, index) => {
    const k = index + 1; // runs so far
    const delta = time - mean; // the new time's distance from the old mean
    mean += delta / k; // the new mean
    squares += delta * (time - mean); // Welford: the old and the new distance together update the sum exactly
    if (kept.has(k)) points.push({ runs: k, mean, halfWidth: confidenceHalfWidth(squares, k) }); // includes the first (n^0) and the last (n^1)
  });
  return points;
}

/**
 * Half the width of the 95 % confidence interval of a mean of `n` times, from their squared
 * distances from the mean added up (`squares`): 1.96 · s / √n, where s is the standard
 * deviation estimated from the runs (divided by n − 1, since a few runs would underestimate
 * it otherwise) and s / √n the standard error, how much a mean of n runs varies. null for
 * fewer than MIN_RUNS_FOR_INTERVAL runs.
 * Example: test model A, 1000 runs, s ≈ 23.6 s -> 1.96 · 23.6 / √1000 ≈ 1.46 s.
 */
function confidenceHalfWidth(squares: number, n: number): number | null {
  if (n < MIN_RUNS_FOR_INTERVAL) return null; // not trustworthy yet
  return (Z_95 * Math.sqrt(squares / (n - 1))) / Math.sqrt(n);
}

/**
 * Single values, ascending, added up in CLASS_COUNT classes of equal width from the first to
 * the last; the last class includes the last value. Used by timeDistribution for more than
 * MAX_SINGLE_VALUES values, and by the chart when single bars would be too thin to see.
 * Example: 615 s (39 %), 625 s (17 %), …, 4230 s (1 %) -> 615–795.75 s (56 %), 795.75–976.5 s, …
 */
export function groupIntoClasses(values: DistributionEntry[]): DistributionEntry[] {
  const minimum = values[0].from; // ascending
  const maximum = values[values.length - 1].from;
  const width = (maximum - minimum) / CLASS_COUNT; // more than 0 as soon as there are two values
  const classes = Array.from({ length: CLASS_COUNT }, (_, index) => ({ from: minimum + index * width, to: minimum + (index + 1) * width, runs: 0, share: 0 })); // empty classes too, so the gaps show
  for (const value of values) {
    const target = classes[width === 0 ? 0 : Math.min(CLASS_COUNT - 1, Math.floor((value.from - minimum) / width))]; // the maximum would fall just past the last class
    target.runs += value.runs;
    target.share += value.share;
  }
  return classes;
}

// ---------------------------------------------------------------------------------
// CSV
// ---------------------------------------------------------------------------------

/**
 * The whole result as CSV text, for Excel: semicolons between the fields and a comma as
 * decimal separator, as Excel expects it in German-speaking regions. Four tables one below
 * the other, separated by an empty line: summary, paths, executions per node, runs.
 */
export function pathAnalysisCsv(graph: SimulationGraph, result: CompletedAnalysis, modelName: string): string {
  const rows: (string | number | null)[][] = []; // every line of the file, as its fields
  rows.push(["Path analysis", modelName]); // what was analysed
  rows.push(["Runs", result.runs], ["Seed", result.seed]); // how, so it can be repeated
  rows.push(["Expected execution time (s)", round(result.expectedExecutionTime)], ["Expected cycle time (s)", round(result.expectedCycleTime)]); // spec 9.1
  for (const [quantity, name] of [["executionTime", "execution time"], ["cycleTime", "cycle time"]] as const) {
    const distribution = timeDistribution(result, quantity); // null when no run finished: the rows are left out
    if (distribution) rows.push([`95 % confidence interval of the expected ${name} (± s)`, round(distribution.halfWidth95)], [`Standard deviation of the ${name} (s)`, round(distribution.standardDeviation)], [`Minimum ${name} (s)`, distribution.minimum], [`Maximum ${name} (s)`, distribution.maximum], [`90 % quantile of the ${name} (s)`, distribution.quantile90]); // how sure the expected time is, and how the times spread around it
  }
  rows.push(["Aborted runs", result.aborted], ["Runs without a further step", result.noStep]); // runs that formed no path
  rows.push([]); // an empty line between the tables

  rows.push(["Path", "Probability (%)", "Runs", "Execution time (s)", "Cycle time (s)", "Elements"]); // one line per path
  result.paths.forEach((path, index) => rows.push([index + 1, round(path.probability * 100), path.count, path.executionTime, path.cycleTime, path.trace.map((entry) => describeEntry(graph, entry)).join(" > ")]));
  rows.push([]);

  rows.push(["Node", "Executions", "Mean per run"]); // spec 9: the executions per node
  for (const [nodeId, count] of Object.entries(result.nodeExecutions)) rows.push([describeNode(graph, nodeId), count, round(count / result.runs)]);
  rows.push([]);

  rows.push(["Run", "Outcome", "Path", "Execution time (s)", "Cycle time (s)"]); // spec 9: every run is kept
  result.allRuns.forEach((run, index) => rows.push([index + 1, OUTCOMES[run.outcome], run.path === null ? null : run.path + 1, run.executionTime, run.cycleTime]));

  return rows.map((fields) => fields.map(csvField).join(";")).join("\r\n") + "\r\n"; // Windows line ends, which Excel reads everywhere
}

const OUTCOMES = { finished: "finished", noStep: "no further step", aborted: "aborted" } as const; // how a run ended, in words

/** A node as the user reads it, e.g. Activity "Check stock". */
function describeNode(graph: SimulationGraph, nodeId: string): string {
  const node = graph.nodes[nodeId]; // every counted node is in the graph
  return `${node.concept} "${node.label}"`;
}

/** A number rounded to 4 decimals, so 79.60000000000001 is written as 79.6; null stays null. */
function round(value: number | null): number | null {
  return value === null ? null : Math.round(value * 10000) / 10000;
}

/** One field: a number with a decimal comma, a text in quotes when it holds a semicolon, a quote or a line break. */
function csvField(value: string | number | null): string {
  if (value === null) return ""; // e.g. the cycle time of a run that did not finish
  if (typeof value === "number") return String(value).replace(".", ","); // 0.8 -> 0,8
  return /[;"\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value; // a quote inside is doubled, as CSV requires
}
