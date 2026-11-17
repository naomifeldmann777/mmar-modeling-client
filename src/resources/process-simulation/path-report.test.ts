/**
 * Tests for path-report.ts: the element list of a path (branches, conditions, draws) and the
 * CSV export. The results come from real analyses with a fixed seed. Ids are invented.
 */
import { describe, expect, it } from "vitest";
import type { ConditionRow, GraphFlow, GraphGenerator, GraphNode, SimulationGraph } from "./graph";
import { analysePaths } from "./path-analysis";
import { pathAnalysisCsv, pathLines, type CompletedAnalysis } from "./path-report";
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
