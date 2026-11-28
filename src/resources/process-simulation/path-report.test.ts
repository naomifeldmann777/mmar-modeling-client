/**
 * Tests for path-report.ts: the element list of a path (branches, conditions, draws) and the
 * CSV export. The results come from real analyses with a fixed seed. Ids are invented.
 */
import { describe, expect, it } from "vitest";
import type { ConditionRow, GraphFlow, GraphGenerator, GraphNode, SimulationGraph } from "./graph";
import { analysePaths } from "./path-analysis";
import { CLASS_COUNT, formatShare, groupIntoClasses, pathAnalysisCsv, pathLines, timeDistribution, type CompletedAnalysis } from "./path-report";
import type { NodeConcept } from "./vocabulary";

// Builders, as in path-analysis.test.ts
const node = (id: string, concept: NodeConcept, executionTime = 0): GraphNode => ({ id, label: id, concept, executionTime, incoming: [], outgoing: [] });
const is = (variableName: string, value: string, logicalOperator: string | null = null): ConditionRow => ({ variableName, operator: "==", value, logicalOperator });
const flow = (id: string, source: string, target: string, ...rows: ConditionRow[]): GraphFlow => ({ id, label: id, source, target, condition: rows });
const draw = (id: string, at: string, variable: string, entries: [string, number][]): GraphGenerator => ({
  id, label: id, node: at, variable, distribution: { type: "Discrete", entries: entries.map(([value, probability]) => ({ value, probability })) }, unmapped: [],
});
function graph(nodes: GraphNode[], flows: GraphFlow[], generators: GraphGenerator[] = []): SimulationGraph {
  const result: SimulationGraph = {
    nodes: Object.fromEntries(nodes.map((n) => [n.id, n])),
    flows: Object.fromEntries(flows.map((f) => [f.id, f])),
    generators: Object.fromEntries(generators.map((g) => [g.id, g])),
    variables: Object.fromEntries(generators.map((g) => [g.variable!, { id: g.variable!, label: g.variable!, name: g.variable! }])),
    issues: [],
  };
  for (const f of flows) {
    result.nodes[f.source!].outgoing.push(f.id);
    result.nodes[f.target!].incoming.push(f.id);
  }
  return result;
}
function analysed(g: SimulationGraph, runs: number): CompletedAnalysis {
  const result = analysePaths(g, { runs, seed: 1 });
  if (!result.ok) throw new Error(result.problems.map((p) => p.message).join(" | "));
  return result;
}

// BEE-UP's example: Start → AND-Split → (Task1) and (Task2) → AND-Join → Decision on Stock → Task3 | Task4 → End.
const beeUp = graph(
  [node("start", "Start"), node("split", "AND-Split"), node("task1", "Activity", 30), node("task2", "Activity", 20), node("join", "AND-Join"), node("dec", "Decision"), node("task3", "Activity", 10), node("task4", "Activity", 5), node("end3", "End"), node("end4", "End")],
  [
    flow("f0", "start", "split"), flow("f1", "split", "task1"), flow("f2", "split", "task2"), flow("f3", "task1", "join"), flow("f4", "task2", "join"), flow("f5", "join", "dec"),
    flow("no", "dec", "task3", is("stock", "No")), flow("yes", "dec", "task4", is("stock", "Yes")), flow("f8", "task3", "end3"), flow("f9", "task4", "end4"),
  ],
  [draw("g", "split", "stock", [["Yes", 0.5], ["No", 0.5]])],
);

describe("pathLines", () => {
  it("indents the branches of a split, marks where each begins, and names the condition taken", () => {
    const path = analysed(beeUp, 50).paths.find((p) => p.nodes.includes("task3"))!; // the "No" path
    expect(pathLines(beeUp, path.trace)).toEqual([
      { depth: 0, branchStart: false, text: 'Start "start"' },
      { depth: 0, branchStart: false, text: 'AND-Split "split": stock = No' }, // drawn at the split
      { depth: 1, branchStart: true, text: 'Activity "task1"' },
      { depth: 1, branchStart: true, text: 'Activity "task2"' },
      { depth: 0, branchStart: false, text: 'AND-Join "join"' }, // back outside the branches
      { depth: 0, branchStart: false, text: 'Decision "dec" → stock == No' }, // as BEE-UP: On Stock? --> Stock = 'No'
      { depth: 0, branchStart: false, text: 'Activity "task3"' },
      { depth: 0, branchStart: false, text: 'End "end3"' },
    ]);
  });

  it("indents nested branches deeper, and marks only the first node of a branch", () => {
    const nested = graph(
      [node("start", "Start"), node("outer", "AND-Split"), node("a", "Activity"), node("inner", "AND-Split"), node("b", "Activity"), node("c", "Activity"), node("innerJoin", "AND-Join"), node("d", "Activity"), node("outerJoin", "AND-Join"), node("end", "End")],
      [
        flow("f0", "start", "outer"), flow("f1", "outer", "a"), flow("f2", "a", "inner"), flow("f3", "inner", "b"), flow("f4", "inner", "c"),
        flow("f5", "b", "innerJoin"), flow("f6", "c", "innerJoin"), flow("f7", "innerJoin", "outerJoin"), flow("f8", "outer", "d"), flow("f9", "d", "outerJoin"), flow("f10", "outerJoin", "end"),
      ],
    );
    const lines = pathLines(nested, analysed(nested, 1).paths[0].trace).map((line) => `${line.depth}${line.branchStart ? "*" : " "} ${line.text.split('"')[1]}`); // e.g. "1* a"
    expect(lines).toEqual(["0  start", "0  outer", "1* a", "1  inner", "2* b", "2* c", "1  innerJoin", "1* d", "0  outerJoin", "0  end"]);
  });

  it("joins the rows of a condition with their logical operators", () => {
    const g = graph(
      [node("start", "Start"), node("check", "Activity"), node("dec", "Decision"), node("e1", "End"), node("e2", "End")],
      [flow("f0", "start", "check"), flow("f1", "check", "dec"), flow("both", "dec", "e1", is("l", "ja"), is("k", "p", "AND")), flow("other", "dec", "e2", is("l", "nein"), is("k", "s", "OR"))],
      [draw("gl", "check", "l", [["ja", 1], ["nein", 0]]), draw("gk", "check", "k", [["p", 1], ["s", 0]])],
    );
    expect(pathLines(g, analysed(g, 1).paths[0].trace)[2].text).toBe('Decision "dec" → l == ja AND k == p');
  });

  it("writes a continuous draw as its distribution, not as the number of the path's first run", () => {
    const below: ConditionRow = { variableName: "amount", operator: "<", value: "100", logicalOperator: null };
    const g = graph(
      [node("start", "Start"), node("take", "Activity"), node("dec", "Decision"), node("small", "End"), node("large", "End")],
      [flow("f0", "start", "take"), flow("f1", "take", "dec"), flow("f2", "dec", "small", below), flow("f3", "dec", "large", { ...below, operator: ">=" })],
      [{ ...draw("g", "take", "amount", []), distribution: { type: "Normal", mean: 100, standardDeviation: 15 } }],
    );
    const lines = pathLines(g, analysed(g, 20).paths.find((p) => p.nodes.includes("large"))!.trace).map((line) => line.text);
    expect(lines.slice(1, 3)).toEqual(['Activity "take": amount ~ Normal (μ = 100, σ = 15)', 'Decision "dec" → amount >= 100']); // the condition says which numbers belong to this path
  });
});

describe("pathAnalysisCsv", () => {
  it("writes the summary, the paths, the executions per node and every run, for Excel", () => {
    const result = analysed(beeUp, 4);
    const lines = pathAnalysisCsv(beeUp, result, "Order; v2").split("\r\n");
    expect(lines[0]).toBe('Path analysis;"Order; v2"'); // a semicolon inside a text is quoted
    expect(lines).toContain("Runs;4");
    expect(lines).toContain("Expected execution time (s);" + String(result.expectedExecutionTime).replace(".", ",")); // a decimal comma
    expect(lines).toContain("Path;Probability (%);Runs;Execution time (s);Cycle time (s);Elements");
    const firstPath = lines[lines.indexOf("Path;Probability (%);Runs;Execution time (s);Cycle time (s);Elements") + 1];
    expect(firstPath.startsWith(`1;${String(result.paths[0].probability * 100).replace(".", ",")};${result.paths[0].count};`)).toBe(true);
    expect(firstPath).toContain('"Start ""start"" > AND-Split'); // quotes inside a text are doubled
    expect(lines).toContain(`Node;Executions;Mean per run`);
    expect(lines).toContain(`"Start ""start""";4;1`); // the Start ran once per run
    expect(lines.filter((line) => /^\d+;finished;\d+;/.test(line))).toHaveLength(4); // one line per run
  });
});

describe("timeDistribution", () => {
  /** A finished analysis whose finished runs have the execution times `times`, and one run that did not finish. */
  function withTimes(times: number[]): CompletedAnalysis {
    const runs = times.map((time) => ({ outcome: "finished" as const, trace: [], executionTime: time, cycleTime: time + 1, path: 0 }));
    return { ok: true, runs: times.length + 1, seed: 1, paths: [], allRuns: [...runs, { outcome: "aborted", trace: [], executionTime: 999, cycleTime: null, path: null }], noStep: 0, aborted: 1, expectedExecutionTime: null, expectedCycleTime: null, nodeExecutions: {} };
  }

  it("counts each value over the finished runs, with E, σ, minimum, maximum and the 90 % quantile", () => {
    const distribution = timeDistribution(withTimes([...Array(8).fill(6), 65, 65]), "executionTime")!; // 80 % 6 s, 20 % 65 s; the aborted run's 999 s does not count
    expect(distribution.entries).toEqual([{ from: 6, to: 6, runs: 8, share: 0.8 }, { from: 65, to: 65, runs: 2, share: 0.2 }]);
    expect(distribution.grouped).toBe(false);
    expect(distribution.mean).toBeCloseTo(17.8, 10); // 0.8 × 6 + 0.2 × 65
    expect(distribution.standardDeviation).toBeCloseTo(23.6, 10); // √(0.8 × 11.8² + 0.2 × 47.2²)
    expect([distribution.minimum, distribution.maximum, distribution.quantile90]).toEqual([6, 65, 65]); // the 9th of 10 sorted times is 65
    expect(distribution.cumulative).toEqual([{ time: 6, share: 0.8 }, { time: 65, share: 1 }]); // 80 % took 6 s or less, all 65 s or less
    expect(timeDistribution(withTimes([6, 65]), "cycleTime")!.entries.map((entry) => entry.from)).toEqual([7, 66]); // the other quantity
  });

  it("groups more than 30 different values into 20 classes of equal width", () => {
    const distribution = timeDistribution(withTimes(Array.from({ length: 40 }, (_, i) => i * 10)), "executionTime")!; // 0, 10, …, 390 s
    expect(distribution.grouped).toBe(true);
    expect(distribution.entries).toHaveLength(CLASS_COUNT);
    expect(distribution.entries[0]).toEqual({ from: 0, to: 19.5, runs: 2, share: 0.05 }); // 0 and 10 s
    expect(distribution.entries[CLASS_COUNT - 1]).toEqual({ from: 370.5, to: 390, runs: 2, share: 0.05 }); // 380 and 390 s: the maximum is in the last class
    expect(distribution.cumulative).toHaveLength(40); // the steps stay exact: one per different time, not per class
    expect(distribution.cumulative[3]).toEqual({ time: 30, share: 0.1 });
  });

  it("writes a share with one decimal, a rare one with two so it does not read as 0 %", () => {
    expect([formatShare(0.8), formatShare(0.39555), formatShare(0.0006), formatShare(0)]).toEqual(["80 %", "39.6 %", "0.06 %", "0 %"]);
  });

  it("adds single values up in classes, as the chart does when its bars would be too thin", () => {
    const classes = groupIntoClasses([{ from: 615, to: 615, runs: 39, share: 0.39 }, { from: 625, to: 625, runs: 17, share: 0.17 }, { from: 4230, to: 4230, runs: 44, share: 0.44 }]);
    expect(classes).toHaveLength(CLASS_COUNT);
    expect(classes[0]).toEqual({ from: 615, to: 795.75, runs: 56, share: 0.56 }); // 615 and 625 s together
    expect(classes[CLASS_COUNT - 1]).toEqual({ from: 4049.25, to: 4230, runs: 44, share: 0.44 }); // the last value in the last class
    expect(classes.slice(1, -1).every((entry) => entry.runs === 0)).toBe(true);
  });

  it("is null when no run finished", () => {
    expect(timeDistribution(withTimes([]), "executionTime")).toBeNull();
  });

  it("is in the CSV as the spread of both times", () => {
    const lines = pathAnalysisCsv(beeUp, analysed(beeUp, 4), "Order").split("\r\n");
    expect(lines.filter((line) => /^(Standard deviation|Minimum|Maximum|90 % quantile)/.test(line)).map((line) => line.split(";")[0])).toEqual([
      "Standard deviation of the execution time (s)", "Minimum execution time (s)", "Maximum execution time (s)", "90 % quantile of the execution time (s)",
      "Standard deviation of the cycle time (s)", "Minimum cycle time (s)", "Maximum cycle time (s)", "90 % quantile of the cycle time (s)",
    ]);
  });
});
