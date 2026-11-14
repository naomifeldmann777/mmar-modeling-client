/**
 * Tests for path-analysis.ts, on test models of the OCPN Build Guide extended by execution
 * times. Random numbers come from a fixed seed, so every result is reproducible. Graphs are
 * built directly, with ids invented for the test.
 */
import { describe, expect, it } from "vitest";
import type { ConditionRow, GraphFlow, GraphGenerator, GraphNode, SimulationGraph } from "./graph";
import { analysePaths, MAX_STEPS, seededRandom, type PathAnalysisResult } from "./path-analysis";
import type { NodeConcept } from "./vocabulary";

// ---------------------------------------------------------------------------------
// Builders (as in firing.test.ts), with an execution time per node
// ---------------------------------------------------------------------------------

const node = (id: string, concept: NodeConcept, executionTime = 0): GraphNode => ({ id, label: id, concept, executionTime, incoming: [], outgoing: [] }); // wired by graph()
const is = (variableName: string, value: string): ConditionRow => ({ variableName, operator: "==", value, logicalOperator: null }); // "variable == value"
const flow = (id: string, source: string, target: string, ...rows: ConditionRow[]): GraphFlow => ({ id, label: id, source, target, condition: rows });
const draw = (id: string, at: string, variable: string, entries: [string, number][]): GraphGenerator => ({
  id, label: id, node: at, variable, distribution: entries.map(([value, probability]) => ({ value, probability })),
});

function graph(nodes: GraphNode[], flows: GraphFlow[], generators: GraphGenerator[] = []): SimulationGraph {
  const result: SimulationGraph = {
    nodes: Object.fromEntries(nodes.map((n) => [n.id, n])),
    flows: Object.fromEntries(flows.map((f) => [f.id, f])),
    generators: Object.fromEntries(generators.map((g) => [g.id, g])),
    variables: Object.fromEntries(generators.map((g) => [g.variable!, { id: g.variable!, label: g.variable!, name: g.variable! }])), // variables named like their ids
    issues: [],
  };
  for (const f of flows) {
    result.nodes[f.source!].outgoing.push(f.id); // as the transformer wires them
    result.nodes[f.target!].incoming.push(f.id);
  }
  return result;
}

/** The result of a successful analysis; fails the test when the validator refused the graph. */
function analysed(g: SimulationGraph, runs: number, seed = 42): Extract<PathAnalysisResult, { ok: true }> {
  const result = analysePaths(g, { runs, seed });
  if (!result.ok) throw new Error(`refused: ${result.problems.map((p) => p.message).join(" | ")}`);
  return result;
}

// Test model A: Start → Check stock (draws lager 0.8 / 0.2) → Decision → End ja | End nein.
const modelA = graph(
  [node("start", "Start"), node("check", "Activity", 5), node("dec", "Decision"), node("endja", "End"), node("endnein", "End")],
  [flow("f1", "start", "check"), flow("f2", "check", "dec"), flow("f3", "dec", "endja", is("lager", "ja")), flow("f4", "dec", "endnein", is("lager", "nein"))],
  [draw("g", "check", "lager", [["ja", 0.8], ["nein", 0.2]])],
);

// ---------------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------------

describe("analysePaths: paths and their probabilities", () => {
  it("A: finds both paths, the more probable first, with shares near the distribution", () => {
    const result = analysed(modelA, 10000); // many runs, so the shares settle
    expect(result.paths.map((path) => path.nodes)).toEqual([["start", "check", "dec", "endja"], ["start", "check", "dec", "endnein"]]);
    expect(result.paths[0].probability).toBeCloseTo(0.8, 1); // within 0.05
    expect(result.paths[0].count + result.paths[1].count).toBe(10000); // every run finished on one of them
    expect(result.paths[0].trace[1].draws.map((d) => d.value)).toEqual(["ja"]); // the trace shows what was drawn
    expect(result.paths[0].trace[2].produces).toEqual(["f3"]); // and which flow the Decision took
  });

  it("keeps every run and points it at its path, and counts the executions per node", () => {
    const result = analysed(modelA, 50);
    expect(result.allRuns).toHaveLength(50); // spec 9: every run is kept
    for (const run of result.allRuns) expect(result.paths[run.path!].nodes).toEqual(run.trace.map((entry) => entry.node));
    expect(result.nodeExecutions.start).toBe(50); // once per run
    expect(result.nodeExecutions.endja + result.nodeExecutions.endnein).toBe(50); // one End per run
  });

  it("refuses a graph the validator rejects, without making a run", () => {
    const noStart = graph([node("a", "Activity"), node("end", "End")], [flow("f", "a", "end")]); // no Start
    const result = analysePaths(noStart, { runs: 10, seed: 1 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.problems.map((p) => p.check)).toContain(4); // spec 10, check 4
  });

  it("makes at least one run, whatever number is given", () => {
    expect(analysed(modelA, 0).runs).toBe(1);
    expect(analysed(modelA, 2.7).runs).toBe(2); // whole runs only
  });
});

describe("analysePaths: the seed", () => {
  it("gives exactly the same result for the same seed", () => {
    expect(analysed(modelA, 200, 7)).toEqual(analysed(modelA, 200, 7));
  });

  it("chooses a seed when none is given and reports it, so the analysis can be repeated", () => {
    const first = analysePaths(modelA, { runs: 200 }); // no seed
    if (!first.ok) throw new Error("refused");
    expect(Number.isInteger(first.seed)).toBe(true); // a number the user can type in again
    expect(analysed(modelA, 200, first.seed)).toEqual(first); // typed in again: the same result
  });

  it("produces numbers between 0 and 1, the same sequence for the same seed", () => {
    const a = seededRandom(3), b = seededRandom(3); // two generators with one seed
    const numbers = Array.from({ length: 1000 }, () => a()); // a sequence from the first
    expect(numbers.every((n) => n >= 0 && n < 1)).toBe(true);
    expect(Array.from({ length: 1000 }, () => b())).toEqual(numbers); // the second repeats it
  });
});

describe("analysePaths: times (spec 9.1)", () => {
  // Parallel branches: Start → AND-Split → (A1 10 s → A2 5 s) and (B1 30 s → B2 0 s) → AND-Join → End.
  const parallel = graph(
    [node("start", "Start"), node("split", "AND-Split"), node("a1", "Activity", 10), node("a2", "Activity", 5), node("b1", "Activity", 30), node("b2", "Activity"), node("join", "AND-Join"), node("end", "End")],
    [
      flow("f0", "start", "split"),
      flow("fa1", "split", "a1"), flow("fa2", "a1", "a2"), flow("fa3", "a2", "join"),
      flow("fb1", "split", "b1"), flow("fb2", "b1", "b2"), flow("fb3", "b2", "join"),
      flow("f9", "join", "end"),
    ],
  );

  it("advances one branch until it waits at the join, then the next", () => {
    expect(analysed(parallel, 1).paths[0].nodes).toEqual(["start", "split", "a1", "a2", "b1", "b2", "join", "end"]); // not a1, b1, a2, b2
  });

  it("adds up all work as execution time, and waits for the longest branch in the cycle time", () => {
    const [path] = analysed(parallel, 1).paths;
    expect(path.executionTime).toBe(45); // 10 + 5 + 30
    expect(path.cycleTime).toBe(30); // branch A takes 15 s, branch B 30 s: the join waits for B
  });

  it("counts no time for a skipped OR branch, and every pass through a loop", () => {
    // OR-Split with branch 1 always entered (10 s) and branch 2 always skipped (50 s).
    const inclusive = graph(
      [node("start", "Start"), node("d", "Activity"), node("or", "OR-Split"), node("t1", "Activity", 10), node("t2", "Activity", 50), node("join", "OR-Join"), node("end", "End")],
      [
        flow("f0", "start", "d"), flow("f1", "d", "or"),
        flow("e1", "or", "t1", is("lager", "ja")), flow("x1", "t1", "join"),
        flow("e2", "or", "t2", is("lager", "nein")), flow("x2", "t2", "join"),
        flow("f9", "join", "end"),
      ],
      [draw("g", "d", "lager", [["ja", 1], ["nein", 0]])],
    );
    const [path] = analysed(inclusive, 20).paths;
    expect(path.nodes).toEqual(["start", "d", "or", "t1", "join", "end"]); // t2 is skipped, not executed (spec 5.2)
    expect([path.executionTime, path.cycleTime]).toEqual([10, 10]);
    expect(path.probability).toBe(1);
  });

  it("A: gives the expected times as the mean over the finished runs", () => {
    const result = analysed(modelA, 100);
    expect(result.expectedExecutionTime).toBe(5); // Check stock takes 5 s on every path
    expect(result.expectedCycleTime).toBe(5);
  });
});

describe("analysePaths: runs that do not finish", () => {
  it("F: aborts a run after MAX_STEPS when the loop is never left, and makes no path of it", () => {
    // Test model F, with "ja" never drawn: Start → Check stock → (ja: End | nein: Check again → Check stock).
    const loop = graph(
      [node("start", "Start"), node("check", "Activity", 1), node("dec", "Decision"), node("again", "Activity", 2), node("end", "End")],
      [flow("f1", "start", "check"), flow("f2", "check", "dec"), flow("fja", "dec", "end", is("lager", "ja")), flow("fnein", "dec", "again", is("lager", "nein")), flow("fback", "again", "check")],
      [draw("g1", "check", "lager", [["ja", 0], ["nein", 1]]), draw("g2", "again", "lager", [["ja", 0], ["nein", 1]])],
    );
    const result = analysed(loop, 3);
    expect([result.aborted, result.noStep, result.paths.length]).toEqual([3, 0, 0]); // all aborted
    expect(result.allRuns[0].trace).toHaveLength(MAX_STEPS); // kept whole all the same
    expect(result.expectedCycleTime).toBeNull(); // no run finished
    expect(result.allRuns[0].executionTime).toBeGreaterThan(0); // the work done is still counted
  });
});
