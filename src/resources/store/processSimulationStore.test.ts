// The process-simulation store. Pure state, so no engine mocks: opening the stepper on a
// model that passes or fails the validator, picking steps, restarting and closing. The graph
// is test model A, built directly with ids invented for the test.
import { beforeEach, describe, expect, it } from "vitest";
import type { GraphFlow, GraphNode, SimulationGraph } from "@/resources/process-simulation/graph";
import type { NodeConcept } from "@/resources/process-simulation/vocabulary";
import { useProcessSimulationStore } from "./processSimulationStore";

const node = (id: string, concept: NodeConcept): GraphNode => ({ id, label: id, concept, incoming: [], outgoing: [] }); // wired by graph()
const flow = (id: string, source: string, target: string, value?: string): GraphFlow => ({
  id, label: id, source, target, condition: value === undefined ? [] : [{ variableName: "lager", operator: "==", value, logicalOperator: null }], // "lager == value", or no condition
});

function graph(nodes: GraphNode[], flows: GraphFlow[], withDraw: boolean): SimulationGraph {
  const result: SimulationGraph = {
    nodes: Object.fromEntries(nodes.map((n) => [n.id, n])),
    flows: Object.fromEntries(flows.map((f) => [f.id, f])),
    generators: withDraw ? { g: { id: "g", label: "g", node: "check", variable: "lager", distribution: [{ value: "ja", probability: 0.8 }, { value: "nein", probability: 0.2 }] } } : {}, // Check stock draws lager
    variables: withDraw ? { lager: { id: "lager", label: "lager", name: "lager" } } : {},
    issues: [],
  };
  for (const f of flows) {
    result.nodes[f.source!].outgoing.push(f.id); // as the transformer wires them
    result.nodes[f.target!].incoming.push(f.id);
  }
  return result;
}

// Test model A: Start → Check stock (draws lager) → Decision → End ja | End nein.
const modelA = () =>
  graph(
    [node("start", "Start"), node("check", "Activity"), node("dec", "Decision"), node("endja", "End"), node("endnein", "End")],
    [flow("f1", "start", "check"), flow("f2", "check", "dec"), flow("f3", "dec", "endja", "ja"), flow("f4", "dec", "endnein", "nein")],
    true,
  );

const state = () => useProcessSimulationStore.getState();

beforeEach(() => state().reset());

describe("processSimulationStore", () => {
  it("starts closed", () => {
    expect(state().active).toBe(false);
    expect(state().run).toBeNull();
  });

  it("opens the stepper with a run when the model passes the validator", () => {
    state().open("scene-1", modelA());
    expect(state().active).toBe(true);
    expect(state().sceneInstanceId).toBe("scene-1");
    expect(state().run?.steps.map((s) => s.node)).toEqual(["start"]); // the token in front of the Start
    expect(state().problems).toEqual([]);
  });

  it("opens the stepper with the problems when the model fails the validator", () => {
    state().open("scene-1", graph([node("start", "Start"), node("a", "Activity")], [flow("f1", "start", "a")], false)); // no End
    expect(state().active).toBe(true); // the panel shows the problems
    expect(state().run).toBeNull();
    expect(state().problems.map((p) => p.check)).toContain(4);
  });

  it("carries out the picked step, and restarts from the beginning", () => {
    state().open("scene-1", modelA());
    state().pick(state().run!.steps[0]); // the Start
    state().pick(state().run!.steps.find((s) => s.draws[0]?.value === "ja")!); // Check stock, lager = ja
    expect(state().run?.state.values).toEqual({ lager: "ja" });

    state().restart();
    expect(state().run?.state.trace).toEqual([]); // back at the beginning
    expect(state().run?.steps.map((s) => s.node)).toEqual(["start"]);
  });

  it("opens with a message when no graph could be built", () => {
    state().openWithMessage("scene-1", "The stored concept mapping could not be read.");
    expect(state().active).toBe(true);
    expect(state().run).toBeNull();
    expect(state().message).toBe("The stored concept mapping could not be read.");
  });

  it("closes completely on 'Stop simulation'", () => {
    state().open("scene-1", modelA());
    state().close();
    expect(state()).toMatchObject({ active: false, sceneInstanceId: null, run: null, problems: [], message: null });
  });
});
