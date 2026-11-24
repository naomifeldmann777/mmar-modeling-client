/**
 * The stepper: one run of the process, which the user advances step by step (spec 8,
 * plan Phase 7).
 *
 * A run goes like this:
 * 1. Start: the validator checks the graph. If it finds a problem, the run does not start and
 *    the problems are returned, each with the element it concerns (spec 8, step 1). Otherwise
 *    the run begins with the single token in front of the Start and no value drawn.
 * 2. The possible steps are listed (firing rule, operation 1).
 * 3. The user picks one; it is carried out (operation 2), and the run is at step 2 again. A
 *    step that draws from a continuous distribution has its value open (firing.ts): the user
 *    types the value in or lets it be drawn (`drawValues`), and `takeStep` checks it before
 *    it completes the step with `fixValues` (spec 7: picking such a step means giving the value).
 * 4. The run is over as soon as a token has reached an End element (spec 8).
 *
 * Used by: the stepper panel and its store (Phase 8), which show the run and pass the user's
 * choice in. A run is plain data: every function here returns a new run and leaves the old one
 * unchanged, so the panel can simply keep the latest one.
 *
 * Deliberately NOT here:
 * - No reading of the model or the mapping: the run works on the graph the transformer built.
 * - No display and no highlighting: that is the panel's job.
 * - No automatic steps. Decided in Phase 7: the stepper waits for the user after every step,
 *   even when only one step is possible, so the user can follow the token element by element.
 *   This deviates on purpose from spec 8 ("If only one step is possible, it is executed
 *   directly").
 *
 * Decided in Phase 7: when no step is possible any more, the status says why, in neutral words:
 * "finished" when a token has reached an End element, "noStep" otherwise. A model that passes
 * the validator should never end with "noStep"; if it does, the status says so honestly.
 *
 * Source: spec 8 (the stepper), spec 7 (the two operations), plan Phase 7.
 */
import { colourSet, describeDistribution, sample, type Drawable } from "./distributions"; // a typed-in value is checked against what the distribution can give; "Draw" draws one
import { executeStep, fixValues, initialState, possibleSteps, type Draw, type RunState, type Step } from "./firing"; // the two operations of the firing rule; fixValues gives a continuous value
import type { SimulationGraph } from "./graph"; // what a run works on
import { parseDecimal, writeDecimal } from "./numbers"; // a typed-in value is read with a comma or a dot and kept with a dot
import { validateGraph, type ValidationProblem } from "./validator"; // checked before a run starts

/** One run: the graph, where the run stands, and what the user can do next. */
export interface Run {
  graph: SimulationGraph; // the model as the transformer built it when the run started
  state: RunState; // tokens, drawn values and the trace of executed nodes
  steps: Step[]; // the possible steps in this state (operation 1); empty when the run is over
}

/**
 * Where a run stands:
 * - "running": at least one step is possible, the user picks the next one;
 * - "finished": a token has reached an End element, the run is over (spec 8);
 * - "noStep": no step is possible, but no End element has been reached.
 */
export type RunStatus = "running" | "finished" | "noStep";

/** The result of starting a run: the run, or the problems that keep it from starting. */
export type StartResult =
  | { ok: true; run: Run } // the graph passed the validator
  | { ok: false; problems: ValidationProblem[] }; // spec 8, step 1: each problem with its element

/** The result of taking a step: the run after it, or why a value the user gave was refused. */
export type StepResult =
  | { ok: true; run: Run } // the step was carried out
  | { ok: false; message: string }; // a value is missing, is no number, or cannot be drawn; the run stays as it was

/** Starts a run on `graph`, if the validator finds no problem (spec 8, step 1). */
export function startRun(graph: SimulationGraph): StartResult {
  const problems = validateGraph(graph); // every check of spec 10 and beyond
  if (problems.length > 0) return { ok: false, problems }; // the run does not start
  return { ok: true, run: runAt(graph, initialState()) }; // one token in front of the Start, nothing drawn
}

/**
 * Carries out `step`, which must be one of `run.steps`, and returns the run after it. The old
 * run stays unchanged. A step with an open value needs `values`: generator uuid -> the value as
 * the user typed it, with a comma or a dot. Each one must be a number the distribution can give.
 *
 * Example: Check stock draws amount ~ Uniform [10, 20] (generator g).
 *   takeStep(run, step, { g: "12,5" })   -> { ok: true, run }    amount = 12.5
 *   takeStep(run, step, { g: "25" })     -> { ok: false, message: "amount cannot be 25: Uniform [10, 20] gives no value above 20." }
 */
export function takeStep(run: Run, step: Step, values: Readonly<Record<string, string>> = {}): StepResult {
  if (!run.steps.includes(step)) throw new Error("This step is not possible in the current state of the run."); // a programming error in the caller, never a user mistake
  const open = step.draws.filter((draw) => draw.value === null); // the continuous draws, whose value the user gives
  const given: Record<string, string> = {}; // the values as fixValues takes them
  for (const draw of open) {
    const text = values[draw.generator] ?? ""; // as typed; nothing typed is ""
    const problem = valueProblem(distributionOf(run.graph, draw), draw.variableName, text); // a mistake of the user, shown in the panel
    if (problem) return { ok: false, message: problem };
    given[draw.generator] = writeDecimal(parseDecimal(text)!); // "12,5" is kept as "12.5", like a drawn value; `!`: valueProblem has read it
  }
  const complete = open.length > 0 ? fixValues(run.graph, run.state, step, given) : step; // with its values, the step knows where its tokens go
  if (!complete) return { ok: false, message: "With this value no outgoing condition holds." }; // ruled out by checks 21 and 22 for every value the distribution can give
  return { ok: true, run: runAt(run.graph, executeStep(run.state, complete)) }; // operation 2, then the new possible steps
}

/** A value for every open draw of `step`, drawn at random: what the "Draw" button passes to takeStep. */
export function drawValues(run: Run, step: Step): Record<string, string> {
  return Object.fromEntries(step.draws.filter((draw) => draw.value === null).map((draw) => [draw.generator, sample(distributionOf(run.graph, draw), Math.random)])); // Math.random: a stepper run need not be repeatable, unlike the path analysis
}

/** The distribution of an open draw, e.g. "Normal (μ = 100, σ = 15)", for the panel to show next to the field. */
export function describeOpenDraw(run: Run, draw: Draw): string {
  return describeDistribution(distributionOf(run.graph, draw)); // the text the path details use as well
}

/** Where `run` stands (see RunStatus). */
export function runStatus(run: Run): RunStatus {
  if (reachedEnd(run.graph, run.state)) return "finished"; // spec 8: over as soon as a token has reached an End
  return run.steps.length > 0 ? "running" : "noStep"; // otherwise: is there anything left to do?
}

/** The run in `state`, with the steps possible there. */
function runAt(graph: SimulationGraph, state: RunState): Run {
  const steps = reachedEnd(graph, state) ? [] : possibleSteps(graph, state); // after an End nothing runs any more (spec 8)
  return { graph, state, steps };
}

/** The distribution an open draw comes from. */
function distributionOf(graph: SimulationGraph, draw: Draw): Drawable {
  return graph.generators[draw.generator].distribution as Drawable; // `as`: an open draw comes from a Normal, Uniform or Exponential, never from an Unsupported type (check 14)
}

/**
 * Why `text` cannot be the value of `name`, drawn from `distribution`; null when it can.
 * Examples, for Exponential (mean = 30):
 *   ""     -> "Enter a value for amount, or let it be drawn."
 *   "abc"  -> "\"abc\" is not a number. Write it with a dot or a comma, e.g. 12.5."
 *   "-1"   -> "amount cannot be -1: Exponential (mean = 30) gives no value below 0."
 */
function valueProblem(distribution: Drawable, name: string, text: string): string | null {
  if (text.trim() === "") return `Enter a value for ${name}, or let it be drawn.`; // nothing typed
  const value = parseDecimal(text); // the same reading as in conditions
  if (value === null) return `"${text}" is not a number. Write it with a dot or a comma, e.g. 12.5.`;
  const set = colourSet(distribution); // the values it can give (spec 6.1)
  if (!("from" in set)) return null; // a discrete distribution has no open draw; only satisfies TypeScript
  if (value < set.from) return `${name} cannot be ${text.trim()}: ${describeDistribution(distribution)} gives no value below ${set.from}.`; // e.g. a negative waiting time
  if (value > set.to) return `${name} cannot be ${text.trim()}: ${describeDistribution(distribution)} gives no value above ${set.to}.`;
  return null; // a value the distribution can give
}

/** Whether an End element has been executed in this run. */
function reachedEnd(graph: SimulationGraph, state: RunState): boolean {
  return state.trace.some((nodeId) => graph.nodes[nodeId]?.concept === "End"); // the trace holds every executed node, in order
}
