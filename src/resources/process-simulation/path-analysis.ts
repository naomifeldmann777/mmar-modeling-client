/**
 * The path analysis: many runs of the process, with the system choosing every step, and
 * their results aggregated into paths (spec 9).
 *
 * Used by: the path-analysis panel (later), which passes the graph the transformer built and
 * the user's settings, and shows the result.
 *
 * How a run goes. It uses the same two operations as the stepper (firing.ts), and only who
 * picks a step differs (spec 9):
 * 1. The possible steps are listed (operation 1).
 * 2. The system picks one:
 *    - which node runs: the one that consumes the token placed most recently. So a branch is
 *      advanced until it waits at its join, and only then the next branch (decided for the
 *      path analysis, as in BEE-UP). The order does not change the result of a run (spec 7);
 *      fixing it keeps one way through the model from splitting into several paths that differ
 *      only in the order of parallel branches.
 *    - which values it draws: every random generator at the node draws one value with
 *      `sample`, discrete or continuous, the same function as the stepper's "Draw" (spec 6.2,
 *      9). The step with these values is taken; a continuous value is given to it with
 *      `fixValues` (spec 7: picking such a step means giving the value).
 * 3. The step is carried out (operation 2), and the run is at 1 again, until an End element
 *    has run ("finished"), no step is possible ("noStep"), or MAX_STEPS steps have been taken
 *    ("aborted": e.g. a loop that kept being entered).
 *
 * Times (spec 9.1), derived alongside the run, so the firing rule stays free of time:
 * - execution time: the sum of the execution times of all executed nodes;
 * - cycle time: every token carries the time from which it is available; a node starts at the
 *   latest time of the tokens it consumes and its tokens are available after its execution
 *   time; the cycle time is the time at which the End element finishes. A join thus waits for
 *   its longest branch.
 *
 * A path is a trace, the sequence of executed nodes (spec 9). Since execution times are fixed,
 * every run of a path has the same execution time and cycle time. The values drawn do not make
 * a path: with a continuous distribution almost every run draws other numbers, but runs that
 * execute the same nodes take the same path.
 *
 * Deliberately NOT here: no reading of the model, no display, no export. Nothing assumes a
 * user (plan 11). The random numbers come from a generator started with a seed, so the same
 * seed, graph and number of runs always give the same result.
 *
 * Source: spec 9 and 9.1 (path analysis, times), spec 7 (the two operations), spec 6.2 (drawing).
 */
import { sample, type Drawable } from "./distributions"; // draws every value, as the stepper's "Draw" does
import { executeStep, fixValues, initialState, possibleSteps, type Draw, type RunState, type Step } from "./firing"; // the two operations, shared with the stepper; fixValues gives a continuous value
import type { SimulationGraph } from "./graph"; // what the analysis works on
import { validateGraph, type ValidationProblem } from "./validator"; // checked before the first run, as for the stepper

export const DEFAULT_RUNS = 1000; // what the panel proposes (decided for the path analysis)
export const MAX_RUNS = 100000; // the most runs one analysis makes: enough to find a path of 0.01 % (about 10 runs of it), and about 10 s in the browser
export const MAX_STEPS = 1000; // the most steps one run takes; a run that reaches it is "aborted"

// ---------------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------------

/** What the user sets. */
export interface PathAnalysisOptions {
  runs: number; // how many runs; kept between 1 and MAX_RUNS
  seed?: number; // the start value of the random numbers; without one, a new one is chosen and reported
}

/** One executed step of a run: enough to show it, e.g. which flow a Decision took. */
export interface TraceEntry {
  node: string; // uuid of the executed node
  consumes: string[]; // flows it took its tokens from
  produces: string[]; // flows it put tokens on: at a Decision or OR-Split, the branches taken
  draws: Draw[]; // the values it drew; empty when nothing is drawn there
}

/** How a run ended. */
export type RunOutcome = "finished" | "noStep" | "aborted"; // an End ran / no step possible / MAX_STEPS reached

/** One run, kept whole (spec 9: the complete trace, not only counters). */
export interface AnalysedRun {
  outcome: RunOutcome; // how it ended
  trace: TraceEntry[]; // every executed step, in order
  executionTime: number; // seconds of work done, also for a run that did not finish
  cycleTime: number | null; // seconds until the End finished; null when no End ran
  path: number | null; // index in PathAnalysisResult.paths; null for a run that did not finish
}

/** A distinct path: all finished runs with the same trace. */
export interface AnalysedPath {
  nodes: string[]; // the trace: uuids of the executed nodes, in order
  trace: TraceEntry[]; // the steps of its first run, for showing it
  count: number; // how many runs took it
  probability: number; // count / all runs, so aborted and stuck runs make the paths add up to less than 1
  executionTime: number; // seconds, the same in every run of the path
  cycleTime: number; // seconds, the same in every run of the path
}

/** The result of an analysis: the aggregated paths and every run, or the validator's problems. */
export type PathAnalysisResult =
  | {
      ok: true; // the graph passed the validator and the runs were made
      runs: number; // how many runs were made
      seed: number; // the start value used, so the analysis can be repeated exactly
      paths: AnalysedPath[]; // most probable first
      allRuns: AnalysedRun[]; // every run, in the order made
      noStep: number; // runs that got stuck
      aborted: number; // runs that reached MAX_STEPS
      expectedExecutionTime: number | null; // mean over the finished runs = Σ path time × probability, scaled to the finished runs; null when none finished
      expectedCycleTime: number | null; // likewise
      nodeExecutions: Record<string, number>; // node uuid -> how often it ran, over all runs
    }
  | { ok: false; problems: ValidationProblem[] }; // spec 10: nothing runs when the validator finds a problem

// ---------------------------------------------------------------------------------
// The analysis
// ---------------------------------------------------------------------------------

/**
 * Runs the process `options.runs` times and aggregates the runs (spec 9).
 *
 * Example, test model A (lager drawn 0.8 ja / 0.2 nein), 1000 runs: two paths,
 * "Start, Check stock, lager?, End ja" with a probability near 0.8, and the "nein" path near 0.2.
 */
export function analysePaths(graph: SimulationGraph, options: PathAnalysisOptions): PathAnalysisResult {
  const problems = validateGraph(graph); // the same checks as before a stepper run (spec 10)
  if (problems.length > 0) return { ok: false, problems }; // nothing runs

  const { runs, seed, random } = prepare(options); // how many, and the random numbers
  const allRuns: AnalysedRun[] = []; // spec 9: every run is kept
  for (let i = 0; i < runs; i++) allRuns.push(analyseRun(graph, random)); // one run after the other, from the same random sequence
  return aggregate(allRuns, runs, seed);
}

/** How analysePathsInPortions reports and pauses; given by the caller, since only it knows the browser. */
export interface PortionControl {
  onProgress: (done: number, total: number) => void; // after every portion, and once at the end
  pause: () => Promise<void>; // between two portions: lets the browser draw the progress
  cancelled: () => boolean; // asked after every pause: true stops the analysis
}

export const PORTION_MS = 50; // how long one portion runs before the browser may draw: short enough for a moving bar, long enough to cost little

/**
 * The same analysis as analysePaths, in portions of about PORTION_MS: after each portion it
 * reports how many runs are done and pauses, so the browser can draw a progress bar. The runs
 * come from the same random sequence in the same order, so the result is exactly that of
 * analysePaths with the same options. null when it was cancelled; nothing of it is kept.
 *
 * Example: 100 000 runs of about 0.1 ms each: about 220 portions of some 450 runs, each
 * followed by onProgress(450, 100000), onProgress(900, 100000), …
 */
export async function analysePathsInPortions(graph: SimulationGraph, options: PathAnalysisOptions, control: PortionControl): Promise<PathAnalysisResult | null> {
  const problems = validateGraph(graph); // as in analysePaths
  if (problems.length > 0) return { ok: false, problems };

  const { runs, seed, random } = prepare(options);
  const allRuns: AnalysedRun[] = [];
  let portionStart = performance.now(); // when the current portion began
  for (let i = 0; i < runs; i++) {
    allRuns.push(analyseRun(graph, random)); // the same runs as analysePaths makes
    if (performance.now() - portionStart < PORTION_MS) continue; // the portion goes on
    control.onProgress(i + 1, runs); // runs done so far
    await control.pause(); // the browser draws
    if (control.cancelled()) return null; // "Cancel" was clicked in the meantime
    portionStart = performance.now(); // the next portion
  }
  control.onProgress(runs, runs); // all done
  return aggregate(allRuns, runs, seed);
}

/** The number of runs, kept in range, the seed, chosen when none is given, and the random numbers it starts. */
function prepare(options: PathAnalysisOptions): { runs: number; seed: number; random: () => number } {
  const runs = Math.min(MAX_RUNS, Math.max(1, Math.floor(options.runs))); // a whole number in the allowed range, whatever was typed
  const seed = options.seed ?? Math.floor(Math.random() * 2 ** 31); // a whole number the user can type in again to repeat the analysis
  return { runs, seed, random: seededRandom(seed) }; // every random number of the analysis comes from here
}

/** The runs, grouped into paths, with the expected times and the executions per node. */
function aggregate(allRuns: AnalysedRun[], runs: number, seed: number): PathAnalysisResult {
  // Group the finished runs by their trace. The key is the node uuids in order.
  const byTrace = new Map<string, AnalysedPath>(); // trace key -> its path
  for (const run of allRuns) {
    if (run.outcome !== "finished") continue; // only finished runs form paths
    const nodes = run.trace.map((entry) => entry.node); // the path
    const key = nodes.join(" "); // uuids contain no spaces, so the key is unambiguous
    const path = byTrace.get(key); // seen before?
    if (path) path.count++; // one more run of it
    else byTrace.set(key, { nodes, trace: run.trace, count: 1, probability: 0, executionTime: run.executionTime, cycleTime: run.cycleTime! }); // first run of it; `!` because a finished run has a cycle time
  }
  const paths = [...byTrace.values()].sort((a, b) => b.count - a.count); // most probable first; sort keeps the order of first appearance among equals
  for (const path of paths) path.probability = path.count / runs; // the share of ALL runs
  const indexOf = new Map(paths.map((path, index) => [path.nodes.join(" "), index])); // trace key -> index in `paths`
  for (const run of allRuns) run.path = run.outcome === "finished" ? indexOf.get(run.trace.map((entry) => entry.node).join(" "))! : null; // each run points at its path

  const finished = allRuns.filter((run) => run.outcome === "finished"); // the runs the expected times are taken over
  const mean = (values: number[]) => (values.length > 0 ? values.reduce((sum, value) => sum + value, 0) / values.length : null); // null when there is nothing to average
  const nodeExecutions: Record<string, number> = {}; // filled below
  for (const run of allRuns) for (const entry of run.trace) nodeExecutions[entry.node] = (nodeExecutions[entry.node] ?? 0) + 1; // every execution counts, also in runs that did not finish

  return {
    ok: true,
    runs, // as made, after limiting
    seed, // as used
    paths,
    allRuns,
    noStep: allRuns.filter((run) => run.outcome === "noStep").length,
    aborted: allRuns.filter((run) => run.outcome === "aborted").length,
    expectedExecutionTime: mean(finished.map((run) => run.executionTime)), // spec 9.1
    expectedCycleTime: mean(finished.map((run) => run.cycleTime!)), // `!`: finished runs have one
    nodeExecutions,
  };
}

// ---------------------------------------------------------------------------------
// One run
// ---------------------------------------------------------------------------------

/** A token as the analysis sees it: when it was placed (for the order of branches) and from when it is available (for the cycle time). */
interface Stamp {
  placed: number; // the number of the step that placed it: higher is more recent
  available: number; // seconds after the start from which it can be consumed
}

/** One run of the process, with the system choosing every step. */
function analyseRun(graph: SimulationGraph, random: () => number): AnalysedRun {
  let state = initialState(); // the token in front of the Start, nothing drawn (spec 8, step 1)
  const stamps: Record<string, Stamp[]> = {}; // flow uuid -> its tokens, oldest first, as executeStep counts them
  const trace: TraceEntry[] = []; // the steps of this run
  let executionTime = 0; // seconds of work so far

  for (let count = 0; count < MAX_STEPS; count++) { // count: the number of this step, also its `placed` stamp
    const steps = possibleSteps(graph, state); // operation 1
    if (steps.length === 0) return { outcome: "noStep", trace, executionTime, cycleTime: null, path: null }; // stuck: refused by the validator in a sound model
    const step = chooseStep(graph, state, steps, stamps, random); // the system picks
    if (!step) return { outcome: "noStep", trace, executionTime, cycleTime: null, path: null }; // a drawn value leads nowhere: ruled out by checks 20 to 22, so counted, not hidden

    const start = Math.max(0, ...step.consumes.map((flowId) => stamps[flowId][0].available)); // a node starts once all its tokens are available; the Start at 0
    for (const flowId of step.consumes) stamps[flowId].shift(); // those tokens are gone
    const node = graph.nodes[step.node]; // the node that runs
    const duration = node.executionTime ?? 0; // null is refused by the validator (check 27); 0 only satisfies TypeScript
    executionTime += duration; // spec 9.1: every execution counts
    for (const flowId of [...step.produces, ...step.skips]) (stamps[flowId] ??= []).push({ placed: count, available: start + duration }); // a skip token takes no time: the skipped branch is not executed

    state = executeStep(state, step); // operation 2
    trace.push({ node: step.node, consumes: step.consumes, produces: step.produces, draws: step.draws }); // what this step did
    if (node.concept === "End") return { outcome: "finished", trace, executionTime, cycleTime: start + duration, path: null }; // spec 8: the run is over once an End has run; `path` is set by analysePaths
  }
  return { outcome: "aborted", trace, executionTime, cycleTime: null, path: null }; // MAX_STEPS reached
}

/**
 * The step the system takes, complete with its values:
 * 1. the node whose tokens were placed most recently, so one branch is advanced until it
 *    waits, then the next; among equals, the first in the list;
 * 2. every random generator at that node draws one value with `sample`;
 * 3. of that node's steps, the one with these discrete values; a continuous value, still open
 *    in it, is given with fixValues.
 * null when no step has the drawn values or no way out holds for them; checks 20 to 22 rule
 * that out.
 *
 * Example: Check stock draws lager (ja 0.8 / nein 0.2) and amount ~ Normal (100, 15).
 *   its steps    [lager = ja, amount open]   [lager = nein, amount open]
 *   drawn        { g1: "nein", g2: "87.31243" }
 *   taken        [lager = nein, amount = 87.31243]
 */
function chooseStep(graph: SimulationGraph, state: RunState, steps: Step[], stamps: Record<string, Stamp[]>, random: () => number): Step | null {
  const recency = (step: Step) => Math.max(-1, ...step.consumes.map((flowId) => stamps[flowId][0].placed)); // when its tokens were placed; -1 for the Start, which takes none
  const latest = Math.max(...steps.map(recency)); // the most recent of all
  const nodeId = steps.find((step) => recency(step) === latest)!.node; // the first node with it; `!` because some step has it
  const options = steps.filter((step) => step.node === nodeId); // its steps: one per combination of discrete values, each with the same generators

  const drawn = Object.fromEntries(options[0].draws.map((draw) => [draw.generator, sample(graph.generators[draw.generator].distribution as Drawable, random)])); // one value per generator, in the order of the steps' draws; `as`: an Unsupported type is refused by check 14
  const step = options.find((option) => option.draws.every((draw) => draw.value === null || draw.value === drawn[draw.generator])); // the step with the drawn discrete values; a node that draws nothing has one step
  if (!step) return null; // a drawn discrete value leads nowhere
  return step.draws.some((draw) => draw.value === null) ? fixValues(graph, state, step, drawn) : step; // a continuous value decides now where the token goes
}

// ---------------------------------------------------------------------------------
// Random numbers
// ---------------------------------------------------------------------------------

/**
 * A generator of random numbers between 0 and 1, started with `seed`: the same seed always
 * gives the same sequence, which `Math.random` cannot do. The algorithm is Mulberry32, a
 * small public-domain generator by Tommy Ettinger; it is good enough for a simulation and
 * needs no dependency.
 */
export function seededRandom(seed: number): () => number {
  let state = seed >>> 0; // the seed as a 32-bit whole number
  return () => {
    state = (state + 0x6d2b79f5) >>> 0; // step the state by a fixed odd constant
    let mixed = state; // mix its bits, so neighbouring states give unrelated numbers
    mixed = Math.imul(mixed ^ (mixed >>> 15), mixed | 1);
    mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), mixed | 61);
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296; // a 32-bit number scaled into [0, 1)
  };
}
