/**
 * How the results of a path analysis are written out: the element list of one path, as the
 * panel shows it, and the whole result as CSV, for the export.
 *
 * Used by: the path-analysis panel (element list) and its "Export CSV" button.
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
 *   Decision "lager?" → lager == nein
 *   OR-Split "Extras" → kunde == premium, lager == ja
 */
export function describeEntry(graph: SimulationGraph, entry: TraceEntry): string {
  const node = graph.nodes[entry.node]; // the executed node
  const draws = entry.draws.map((draw) => `${draw.variableName} = ${draw.value}`); // the values drawn there
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
