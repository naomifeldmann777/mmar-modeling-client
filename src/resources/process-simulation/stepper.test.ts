/**
 * Tests for stepper.ts: a run of test model A from the beginning to the end (plan Phase 7:
 * "a run goes through from beginning to end"), a model the validator refuses, and the three
 * statuses. Graphs are built directly, with ids invented for the test.
 */
import { describe, expect, it } from "vitest";
import type { ConditionRow, GraphFlow, GraphGenerator, GraphNode, SimulationGraph } from "./graph";
import { runStatus, startRun, takeStep, type Run } from "./stepper";
import type { NodeConcept } from "./vocabulary";

// ---------------------------------------------------------------------------------
// Builders (as in firing.test.ts)
// ---------------------------------------------------------------------------------

const node = (id: string, concept: NodeConcept): GraphNode => ({ id, label: id, concept, incoming: [], outgoing: [] }); // wired by graph()
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

// Test model A: Start → Check stock (draws lager) → Decision → End ja | End nein.
const modelA = graph(
  [node("start", "Start"), node("check", "Activity"), node("dec", "Decision"), node("endja", "End"), node("endnein", "End")],
  [flow("f1", "start", "check"), flow("f2", "check", "dec"), flow("f3", "dec", "endja", is("lager", "ja")), flow("f4", "dec", "endnein", is("lager", "nein"))],
  [draw("g", "check", "lager", [["ja", 0.8], ["nein", 0.2]])],
);

/** The run after the user picks the step of `nodeId` (drawing `value`, if given). */
function pick(run: Run, nodeId: string, value?: string): Run {
  const step = run.steps.find((s) => s.node === nodeId && (value === undefined || s.draws.some((d) => d.value === value))); // what the user clicks
  if (!step) throw new Error(`no possible step for ${nodeId}`);
  return takeStep(run, step);
}

// ---------------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------------

describe("stepper", () => {
  it("runs test model A from the beginning to the end, waiting for the user at every step", () => {
    const started = startRun(modelA);
    if (!started.ok) throw new Error("model A must pass the validator");
    let run = started.run;

    expect(run.steps.map((s) => s.node)).toEqual(["start"]); // only the Start, and it still waits for a click
    run = pick(run, "start");
    expect(run.steps.map((s) => s.draws[0]?.value)).toEqual(["ja", "nein"]); // Check stock: the user picks the value
    run = pick(run, "check", "nein");
    expect(run.state.values).toEqual({ lager: "nein" });
    expect(run.steps.map((s) => s.produces)).toEqual([["f4"]]); // the Decision: one step, the path follows from the value
    expect(runStatus(run)).toBe("running");
    run = pick(run, "dec");
    run = pick(run, "endnein");

    expect(run.state.trace).toEqual(["start", "check", "dec", "endnein"]);
    expect(run.steps).toEqual([]); // nothing runs after an End
    expect(runStatus(run)).toBe("finished");
  });

  it("does not start a run on a model the validator refuses, and returns the problems", () => {
    const noEnd = graph([node("start", "Start"), node("a", "Activity")], [flow("f1", "start", "a")]); // no End element
    const started = startRun(noEnd);
    expect(started.ok).toBe(false);
    if (!started.ok) expect(started.problems.map((p) => p.check)).toContain(4); // check 4: at least one End element
  });

  it("leaves the old run unchanged when a step is taken", () => {
    const started = startRun(modelA);
    if (!started.ok) throw new Error("model A must pass the validator");
    const before = started.run;
    const after = pick(before, "start");
    expect(before.state.trace).toEqual([]); // still at the beginning
    expect(after.state.trace).toEqual(["start"]);
  });

  it("refuses a step that is not possible in the current run", () => {
    const started = startRun(modelA);
    if (!started.ok) throw new Error("model A must pass the validator");
    const later = pick(started.run, "start");
    expect(() => takeStep(later, started.run.steps[0])).toThrow(); // the Start step of the beginning, offered no more
  });

  it("says 'noStep' when nothing can run although no End has been reached", () => {
    // A state the validator should never let happen; built by hand, so the status is tested on its own.
    const run: Run = { graph: modelA, state: { sourceToken: false, tokens: {}, values: {}, trace: ["start"] }, steps: [] };
    expect(runStatus(run)).toBe("noStep");
  });
});
