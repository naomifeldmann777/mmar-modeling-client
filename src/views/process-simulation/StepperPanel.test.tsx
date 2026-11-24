// @vitest-environment jsdom
//
// Tests for StepperPanel: test model A clicked through from the beginning to the end, the
// problems of a model that cannot start, Restart and Stop. The store is the real one; the
// highlighting and the session are mocked, since they need the 3D engine (stepper-highlight
// and stepper-session have their own tests). Every id is invented for the test.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { GraphFlow, GraphNode, SimulationGraph } from "@/resources/process-simulation/graph";
import type { NodeConcept } from "@/resources/process-simulation/vocabulary";

const mocks = vi.hoisted(() => ({ showHighlights: vi.fn(), clearHighlights: vi.fn(), stopStepper: vi.fn() }));
vi.mock("./stepper-highlight", () => ({ showHighlights: mocks.showHighlights, clearHighlights: mocks.clearHighlights }));
vi.mock("./stepper-session", () => ({ stopStepper: mocks.stopStepper }));

import { useProcessSimulationStore } from "@/resources/store/processSimulationStore";
import StepperPanel from "./StepperPanel";

const node = (id: string, label: string, concept: NodeConcept): GraphNode => ({ id, label, concept, executionTime: 0, incoming: [], outgoing: [] }); // wired by graph()
const flow = (id: string, source: string, target: string, value?: string): GraphFlow => ({
  id, label: "Name", source, target, condition: value === undefined ? [] : [{ variableName: "lager", operator: "==", value, logicalOperator: null }], // "lager == value", or no condition
});

function graph(nodes: GraphNode[], flows: GraphFlow[], withDraw: boolean): SimulationGraph {
  const result: SimulationGraph = {
    nodes: Object.fromEntries(nodes.map((n) => [n.id, n])),
    flows: Object.fromEntries(flows.map((f) => [f.id, f])),
    generators: withDraw ? { g: { id: "g", label: "Draw", node: "check", variable: "v", distribution: { type: "Discrete", entries: [{ value: "ja", probability: 0.8 }, { value: "nein", probability: 0.2 }] }, unmapped: [] } } : {}, // Check stock draws lager
    variables: withDraw ? { v: { id: "v", label: "Stock", name: "lager" } } : {},
    issues: [],
  };
  for (const f of flows) {
    result.nodes[f.source!].outgoing.push(f.id); // as the transformer wires them
    result.nodes[f.target!].incoming.push(f.id);
  }
  return result;
}

// Test model A: Start → Check stock (draws lager) → In stock? → Ship | Cancel.
const modelA = () =>
  graph(
    [node("start", "Start", "Start"), node("check", "Check stock", "Activity"), node("dec", "In stock?", "Decision"), node("ship", "Ship", "End"), node("cancel", "Cancel", "End")],
    [flow("f1", "start", "check"), flow("f2", "check", "dec"), flow("f3", "dec", "ship", "ja"), flow("f4", "dec", "cancel", "nein")],
    true,
  );

const click = (text: string) => fireEvent.click(screen.getByRole("button", { name: text })); // a button by its exact text

beforeEach(() => {
  vi.clearAllMocks();
  useProcessSimulationStore.getState().reset();
});

afterEach(() => cleanup());

describe("StepperPanel", () => {
  it("is clicked through test model A from the beginning to the end", () => {
    useProcessSimulationStore.getState().open("scene-1", modelA());
    render(<StepperPanel />);

    expect(screen.getByText("Confirm the next step.")).toBeTruthy(); // one step: the user still confirms it
    expect(screen.getByText("in front of the Start")).toBeTruthy(); // the token
    expect(screen.getByText("not drawn yet")).toBeTruthy(); // lager has no value yet
    click('Start "Start"');

    expect(screen.getByText("Choose the next step.")).toBeTruthy(); // two values to choose from
    click('Activity "Check stock": lager = ja (80 %)'); // the probability is shown for information
    expect(screen.queryByRole("button", { name: 'Activity "Check stock": lager = nein (20 %)' })).toBeNull(); // the other value is gone
    expect(screen.getByRole("cell", { name: "ja" })).toBeTruthy(); // lager = ja in the variable table

    click('Decision "In stock?" → Ship'); // the path follows from the value: one step
    click('End "Ship"');

    expect(screen.getByText("The run is over.")).toBeTruthy();
    expect(screen.getAllByRole("listitem").map((item) => item.textContent)).toEqual(["none", 'Start "Start"', 'Activity "Check stock"', 'Decision "In stock?"', 'End "Ship"']); // the tokens (none left), then the trace
    expect(mocks.showHighlights).toHaveBeenCalledTimes(5); // the 3D model follows every state: the beginning and four steps
  });

  it("asks for the value of a continuous draw, refuses one the distribution cannot give, and draws one", () => {
    const g = modelA();
    g.generators.g.distribution = { type: "Uniform", minimum: 10, maximum: 20 }; // lager is now drawn continuously
    g.flows.f3.condition = [{ variableName: "lager", operator: "<", value: "15", logicalOperator: null }];
    g.flows.f4.condition = [{ variableName: "lager", operator: ">=", value: "15", logicalOperator: null }];
    useProcessSimulationStore.getState().open("scene-1", g);
    render(<StepperPanel />);
    click('Start "Start"');

    const field = screen.getByRole("textbox", { name: "lager" }); // one field for the open value
    fireEvent.change(field, { target: { value: "25" } });
    click('Activity "Check stock": lager ~ Uniform [10, 20]'); // the step names the distribution
    expect(screen.getByText("lager cannot be 25: Uniform [10, 20] gives no value above 20.")).toBeTruthy(); // refused, the run waits

    fireEvent.change(screen.getByRole("textbox", { name: "lager" }), { target: { value: "12,3456" } });
    click('Activity "Check stock": lager ~ Uniform [10, 20]');
    expect(screen.getByRole("cell", { name: "12.35" })).toBeTruthy(); // kept as 12.3456, shown with two decimals
    expect(screen.getByRole("button", { name: 'Decision "In stock?" → Ship' })).toBeTruthy(); // 12.3456 < 15

    click("Restart");
    click('Start "Start"');
    click("Draw"); // the value is drawn at random
    expect(screen.queryByRole("textbox")).toBeNull(); // the step is taken: no open value left
    expect(screen.queryByText("not drawn yet")).toBeNull(); // lager has a value
  });

  it("goes back to the beginning on Restart", () => {
    useProcessSimulationStore.getState().open("scene-1", modelA());
    render(<StepperPanel />);
    click('Start "Start"');
    click("Restart");
    expect(screen.getByRole("button", { name: 'Start "Start"' })).toBeTruthy();
    expect(screen.getByText("Nothing has run yet.")).toBeTruthy();
  });

  it("shows why the run cannot start, and offers only Stop", () => {
    useProcessSimulationStore.getState().open("scene-1", graph([node("start", "Start", "Start"), node("a", "A", "Activity")], [flow("f1", "start", "a")], false)); // no End
    render(<StepperPanel />);
    expect(screen.getByText(/The run cannot start/)).toBeTruthy();
    expect(screen.getByText(/Check 4:/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Restart" })).toBeNull(); // there is no run to restart
    expect(mocks.showHighlights).not.toHaveBeenCalled(); // nothing to highlight
  });

  it("stops through the session, which also unlocks the model", () => {
    useProcessSimulationStore.getState().open("scene-1", modelA());
    render(<StepperPanel />);
    click("Stop simulation");
    expect(mocks.stopStepper).toHaveBeenCalledTimes(1);
  });

  it("removes the highlighting when it closes", () => {
    useProcessSimulationStore.getState().open("scene-1", modelA());
    const { unmount } = render(<StepperPanel />);
    unmount();
    expect(mocks.clearHighlights).toHaveBeenCalled();
  });
});
