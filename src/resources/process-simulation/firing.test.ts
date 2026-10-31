/**
 * Tests for firing.ts: the test models of the OCPN Build Guide, run step by step, each
 * checking what the guide says should be observed ("Expect: ..."). Graphs are built directly,
 * with ids invented for the test.
 */
import { describe, expect, it } from "vitest";
import { executeStep, initialState, possibleSteps, type RunState } from "./firing";
import type { ConditionRow, GraphFlow, GraphGenerator, GraphNode, SimulationGraph } from "./graph";
import type { NodeConcept } from "./vocabulary";

// ---------------------------------------------------------------------------------
// Builders (as in validator.test.ts)
// ---------------------------------------------------------------------------------

const node = (id: string, concept: NodeConcept): GraphNode => ({ id, label: id, concept, incoming: [], outgoing: [] }); // wired by graph()
const is = (variableName: string, value: string): ConditionRow => ({ variableName, operator: "==", value, logicalOperator: null }); // "variable == value"
const flow = (id: string, source: string, target: string, ...rows: ConditionRow[]): GraphFlow => ({ id, label: id, source, target, condition: rows });
const draw = (id: string, at: string, variable: string, entries: [string, number][]): GraphGenerator => ({
  id, label: id, node: at, variable, distribution: entries.map(([value, probability]) => ({ value, probability })),
});
const LAGER: [string, number][] = [["ja", 0.8], ["nein", 0.2]]; // the Build Guide's distribution

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

/** Executes the step of `nodeId` (with the drawn `value`, if there is a choice); fails the test if there is none. */
function take(g: SimulationGraph, state: RunState, nodeId: string, value?: string): RunState {
  const step = possibleSteps(g, state).find((s) => s.node === nodeId && (value === undefined || s.draws.some((d) => d.value === value))); // the one the "user" picks
  if (!step) throw new Error(`no possible step for ${nodeId}${value ? ` drawing ${value}` : ""}`);
  return executeStep(state, step);
}

/** Executes the given steps one after another, from the beginning of a run. */
const run = (g: SimulationGraph, ...picks: [string, string?][]) => picks.reduce((state, [nodeId, value]) => take(g, state, nodeId, value), initialState());

const nodesOf = (g: SimulationGraph, state: RunState) => possibleSteps(g, state).map((s) => s.node); // which nodes can fire

// Test model A: Start → Check stock (draws lager) → Decision → End ja | End nein.
const modelA = graph(
  [node("start", "Start"), node("check", "Activity"), node("dec", "Decision"), node("endja", "End"), node("endnein", "End")],
  [flow("f1", "start", "check"), flow("f2", "check", "dec"), flow("f3", "dec", "endja", is("lager", "ja")), flow("f4", "dec", "endnein", is("lager", "nein"))],
  [draw("g", "check", "lager", LAGER)],
);

// ---------------------------------------------------------------------------------
// The two operations
// ---------------------------------------------------------------------------------

describe("firing: the two operations", () => {
  it("begins with the Start as the only possible step, and nothing drawn (spec 8, step 1)", () => {
    expect(possibleSteps(modelA, initialState())).toEqual([{ node: "start", fromSource: true, consumes: [], draws: [], produces: ["f1"], skips: [] }]);
  });

  it("execution moves the tokens, writes the value and extends the trace, without changing the old state", () => {
    const before = run(modelA, ["start"]); // one token on f1
    const after = take(modelA, before, "check", "nein"); // Check stock draws nein
    expect(before).toEqual({ sourceToken: false, tokens: { f1: 1 }, values: {}, trace: ["start"] }); // unchanged
    expect(after).toEqual({ sourceToken: false, tokens: { f2: 1 }, values: { lager: "nein" }, trace: ["start", "check"] });
  });
});

// ---------------------------------------------------------------------------------
// The test models of the OCPN Build Guide
// ---------------------------------------------------------------------------------

describe("firing: test models of the OCPN Build Guide", () => {
  it("A: Check stock offers one step per value; afterwards exactly one branch is possible", () => {
    const steps = possibleSteps(modelA, run(modelA, ["start"]));
    expect(steps.map((s) => s.draws)).toEqual([
      [{ generator: "g", variableName: "lager", value: "ja", probability: 0.8 }], // probabilities for information only (spec 8)
      [{ generator: "g", variableName: "lager", value: "nein", probability: 0.2 }],
    ]);
    const atDecision = run(modelA, ["start"], ["check", "nein"]);
    expect(possibleSteps(modelA, atDecision).map((s) => s.produces)).toEqual([["f4"]]); // only the nein branch
    expect(run(modelA, ["start"], ["check", "nein"], ["dec"], ["endnein"])).toEqual({ sourceToken: false, tokens: {}, values: { lager: "nein" }, trace: ["start", "check", "dec", "endnein"] });
  });

  it("B: the second decision on the same variable takes the branch matching the first draw", () => {
    const g = graph(
      [node("start", "Start"), node("check", "Activity"), node("d1", "Decision"), node("ship", "Activity"), node("reorder", "Activity"), node("d2", "Decision"), node("e1", "End"), node("e2", "End")],
      [
        flow("f1", "start", "check"), flow("f2", "check", "d1"), flow("f3", "d1", "ship", is("lager", "ja")), flow("f4", "d1", "reorder", is("lager", "nein")),
        flow("f5", "ship", "d2"), flow("f6", "reorder", "d2"), flow("f7", "d2", "e1", is("lager", "ja")), flow("f8", "d2", "e2", is("lager", "nein")),
      ],
      [draw("g", "check", "lager", LAGER)],
    );
    const atD2 = run(g, ["start"], ["check", "ja"], ["d1"], ["ship"]);
    expect(possibleSteps(g, atD2).map((s) => s.produces)).toEqual([["f7"]]); // ja again: consistent with the draw
  });

  it("C: the draw at the gateway decides the branch in the same step", () => {
    const g = graph(
      [node("start", "Start"), node("gw", "Decision"), node("e1", "End"), node("e2", "End")],
      [flow("f1", "start", "gw"), flow("f2", "gw", "e1", is("lager", "ja")), flow("f3", "gw", "e2", is("lager", "nein"))],
      [draw("g", "gw", "lager", LAGER)],
    );
    const steps = possibleSteps(g, run(g, ["start"]));
    expect(steps.map((s) => [s.draws[0].value, s.produces])).toEqual([["ja", ["f2"]], ["nein", ["f3"]]]); // one step per value, each with its own branch
  });

  it("D: the AND-Join only fires once both branches carry a token, and keeps the drawn value", () => {
    const g = graph(
      [node("start", "Start"), node("split", "AND-Split"), node("check", "Activity"), node("prepare", "Activity"), node("join", "AND-Join"), node("end", "End")],
      [flow("f1", "start", "split"), flow("fa", "split", "check"), flow("fb", "split", "prepare"), flow("fa2", "check", "join"), flow("fb2", "prepare", "join"), flow("f2", "join", "end")],
      [draw("g", "check", "lager", LAGER)],
    );
    const afterSplit = run(g, ["start"], ["split"]);
    expect(nodesOf(g, afterSplit)).toEqual(["check", "check", "prepare"]); // two branches active; Check stock offers two values
    const oneDone = take(g, afterSplit, "check", "ja");
    expect(nodesOf(g, oneDone)).toEqual(["prepare"]); // the join still waits
    const bothDone = take(g, oneDone, "prepare");
    expect(possibleSteps(g, bothDone)).toEqual([{ node: "join", fromSource: false, consumes: ["fa2", "fb2"], draws: [], produces: ["f2"], skips: [] }]);
    expect(take(g, bothDone, "join").values).toEqual({ lager: "ja" }); // one store per run: nothing lost at the join
  });

  it("E: a branch not taken puts its token where it ends, so the OR-Join never blocks", () => {
    const g = graph(
      [node("start", "Start"), node("draw", "Activity"), node("or", "OR-Split"), node("a1", "Activity"), node("a2", "Activity"), node("join", "OR-Join"), node("end", "End")],
      [
        flow("f1", "start", "draw"), flow("f2", "draw", "or"),
        flow("b1", "or", "a1", is("lager", "ja")), flow("b2", "or", "a2", is("lager", "nein")),
        flow("d1", "a1", "join"), flow("d2", "a2", "join"), flow("f3", "join", "end"),
      ],
      [draw("g", "draw", "lager", LAGER)],
    );
    const atSplit = run(g, ["start"], ["draw", "ja"]);
    expect(possibleSteps(g, atSplit)).toEqual([{ node: "or", fromSource: false, consumes: ["f2"], draws: [], produces: ["b1"], skips: ["d2"] }]); // branch 2 skipped: its token goes straight to d2
    const done = run(g, ["start"], ["draw", "ja"], ["or"], ["a1"], ["join"]); // the join fires: d1 by A1, d2 by the skip
    expect(done.tokens).toEqual({ f3: 1 });
    expect(done.trace).not.toContain("a2"); // a skipped branch does not count as executed (spec 5.2)
  });

  it("F: a loop draws again on every pass, and the run ends as soon as ja is drawn", () => {
    const g = graph(
      [node("start", "Start"), node("check", "Activity"), node("dec", "Decision"), node("again", "Activity"), node("end", "End")],
      [flow("f1", "start", "check"), flow("f2", "check", "dec"), flow("fja", "dec", "end", is("lager", "ja")), flow("fnein", "dec", "again", is("lager", "nein")), flow("back", "again", "check")],
      [draw("g1", "check", "lager", LAGER), draw("g2", "again", "lager", [["ja", 0.4], ["nein", 0.6]])],
    );
    const state = run(g, ["start"], ["check", "nein"], ["dec"], ["again", "nein"], ["check", "ja"], ["dec"], ["end"]);
    expect(state.trace).toEqual(["start", "check", "dec", "again", "check", "dec", "end"]);
    expect(state.values).toEqual({ lager: "ja" }); // overwritten on every pass
  });

  it("G: a SynchronizedActivity waits for both places and counts as executed", () => {
    const g = graph(
      [node("start", "Start"), node("split", "AND-Split"), node("inspect", "SynchronizedActivity"), node("end", "End")],
      [flow("f1", "start", "split"), flow("pa", "split", "inspect"), flow("pb", "split", "inspect"), flow("f2", "inspect", "end")],
    );
    expect(run(g, ["start"], ["split"], ["inspect"], ["end"]).trace).toEqual(["start", "split", "inspect", "end"]);
  });

  it("I: when no condition holds, there is no step (the validator stops such a model beforehand)", () => {
    const g = graph(
      [node("start", "Start"), node("check", "Activity"), node("dec", "Decision"), node("e1", "End"), node("e2", "End")],
      [flow("f1", "start", "check"), flow("f2", "check", "dec"), flow("t1", "dec", "e1", is("lager", "ja")), flow("t2", "dec", "e2", is("lager", "vielleicht"))],
      [draw("g", "check", "lager", LAGER)],
    );
    expect(possibleSteps(g, run(g, ["start"], ["check", "nein"]))).toEqual([]); // the run would get stuck here
  });
});
