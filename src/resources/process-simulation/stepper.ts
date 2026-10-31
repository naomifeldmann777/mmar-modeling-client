/**
 * The stepper: one run of the process, which the user advances step by step (spec 8,
 * plan Phase 7).
 *
 * A run goes like this:
 * 1. Start: the validator checks the graph. If it finds a problem, the run does not start and
 *    the problems are returned, each with the element it concerns (spec 8, step 1). Otherwise
 *    the run begins with the single token in front of the Start and no value drawn.
 * 2. The possible steps are listed (firing rule, operation 1).
 * 3. The user picks one; it is carried out (operation 2), and the run is at step 2 again.
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
import { executeStep, initialState, possibleSteps, type RunState, type Step } from "./firing"; // the two operations of the firing rule
import type { SimulationGraph } from "./graph"; // what a run works on
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

/** Starts a run on `graph`, if the validator finds no problem (spec 8, step 1). */
export function startRun(graph: SimulationGraph): StartResult {
  const problems = validateGraph(graph); // every check of spec 10 and beyond
  if (problems.length > 0) return { ok: false, problems }; // the run does not start
  return { ok: true, run: runAt(graph, initialState()) }; // one token in front of the Start, nothing drawn
}

/**
 * Carries out `step`, which must be one of `run.steps`, and returns the run after it. The old
 * run stays unchanged.
 */
export function takeStep(run: Run, step: Step): Run {
  if (!run.steps.includes(step)) throw new Error("This step is not possible in the current state of the run."); // a programming error in the caller, never a user mistake
  return runAt(run.graph, executeStep(run.state, step)); // operation 2, then the new possible steps
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

/** Whether an End element has been executed in this run. */
function reachedEnd(graph: SimulationGraph, state: RunState): boolean {
  return state.trace.some((nodeId) => graph.nodes[nodeId]?.concept === "End"); // the trace holds every executed node, in order
}
