// @vitest-environment jsdom
//
// Tests for PathAnalysisPanel: starting with the settings, the summary and the paths of test
// model A, selecting a path (shown in the model and listed), sorting, an outdated result, the
// validator's problems, and Export / Close. The store is the real one; the highlighting and the
// session are mocked, since they need the 3D engine or the open model (path-highlight and
// path-analysis-session have their own tests). Ids are invented.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import type { GraphFlow, GraphNode, SimulationGraph } from "@/resources/process-simulation/graph";
import { analysePaths } from "@/resources/process-simulation/path-analysis";
import type { NodeConcept } from "@/resources/process-simulation/vocabulary";

const mocks = vi.hoisted(() => ({ showPath: vi.fn(), clearPathHighlight: vi.fn(), runPathAnalysis: vi.fn(), exportPathAnalysis: vi.fn(), closePathAnalysis: vi.fn() }));
vi.mock("./path-highlight", () => ({ showPath: mocks.showPath, clearPathHighlight: mocks.clearPathHighlight, PATH_COLOUR: "#ff9800" }));
vi.mock("./path-analysis-session", () => ({ runPathAnalysis: mocks.runPathAnalysis, exportPathAnalysis: mocks.exportPathAnalysis, closePathAnalysis: mocks.closePathAnalysis }));

import { usePathAnalysisStore } from "@/resources/store/pathAnalysisStore";
import PathAnalysisPanel from "./PathAnalysisPanel";

const node = (id: string, label: string, concept: NodeConcept, executionTime = 0): GraphNode => ({ id, label, concept, executionTime, incoming: [], outgoing: [] });
const flow = (id: string, source: string, target: string, value?: string): GraphFlow => ({
  id, label: "Name", source, target, condition: value === undefined ? [] : [{ variableName: "lager", operator: "==", value, logicalOperator: null }],
});

// Test model A: Start → Check stock (5 s, draws lager 0.8 / 0.2) → In stock? → Ship (1 s) | Reorder (60 s) → End.
function modelA(): SimulationGraph {
  const nodes = [node("start", "Start", "Start"), node("check", "Check stock", "Activity", 5), node("dec", "In stock?", "Decision"), node("ship", "Ship", "Activity", 1), node("reorder", "Reorder", "Activity", 60), node("end1", "Shipped", "End"), node("end2", "Reordered", "End")];
  const flows = [flow("f1", "start", "check"), flow("f2", "check", "dec"), flow("f3", "dec", "ship", "ja"), flow("f4", "dec", "reorder", "nein"), flow("f5", "ship", "end1"), flow("f6", "reorder", "end2")];
  const result: SimulationGraph = {
    nodes: Object.fromEntries(nodes.map((n) => [n.id, n])),
    flows: Object.fromEntries(flows.map((f) => [f.id, f])),
    generators: { g: { id: "g", label: "Draw", node: "check", variable: "v", distribution: { type: "Discrete", entries: [{ value: "ja", probability: 0.8 }, { value: "nein", probability: 0.2 }] }, unmapped: [] } },
    variables: { v: { id: "v", label: "Stock", name: "lager" } },
    issues: [],
  };
  for (const f of flows) {
    result.nodes[f.source!].outgoing.push(f.id);
    result.nodes[f.target!].incoming.push(f.id);
  }
  return result;
}

const store = () => usePathAnalysisStore.getState();
const click = (text: string) => fireEvent.click(screen.getByRole("button", { name: text }));
const pathRows = () => within(screen.getAllByRole("table")[0]).getAllByRole("row").slice(1); // the rows of the path table (the first table), without its header

/** The panel with an analysis of model A, as the session leaves it after "Start". */
function withResult() {
  const graph = modelA();
  store().open("scene-1");
  store().showResult(graph, analysePaths(graph, { runs: 1000, seed: 3 }));
  render(<PathAnalysisPanel />);
}

beforeEach(() => {
  vi.clearAllMocks();
  store().reset();
});

afterEach(() => cleanup());

describe("PathAnalysisPanel", () => {
  it("starts with 1000 runs and no seed, and with a seed when one is given", () => {
    store().open("scene-1");
    render(<PathAnalysisPanel />);
    click("Start");
    expect(mocks.runPathAnalysis).toHaveBeenLastCalledWith({ runs: 1000, seed: undefined }); // the proposed number, a new seed
    fireEvent.click(screen.getByRole("checkbox", { name: "Seed" }));
    fireEvent.change(screen.getByLabelText("Value"), { target: { value: "48213" } });
    fireEvent.change(screen.getByLabelText("Runs"), { target: { value: "200" } });
    click("Start");
    expect(mocks.runPathAnalysis).toHaveBeenLastCalledWith({ runs: 200, seed: 48213 });
  });

  it("refuses to start with a number of runs out of range or a seed that is no whole number", () => {
    store().open("scene-1");
    render(<PathAnalysisPanel />);
    fireEvent.change(screen.getByLabelText("Runs"), { target: { value: "200000" } }); // above MAX_RUNS
    expect((screen.getByRole("button", { name: "Start" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("Runs"), { target: { value: "100" } });
    fireEvent.click(screen.getByRole("checkbox", { name: "Seed" }));
    fireEvent.change(screen.getByLabelText("Value"), { target: { value: "1.5" } });
    expect((screen.getByRole("button", { name: "Start" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("shows the summary and the paths, the most probable first", () => {
    withResult();
    screen.getByText(/^Seed 3/); // in the summary, to repeat it; throws when it is missing
    screen.getByText("Paths (2)"); // throws when it is missing
    expect(pathRows().map((row) => row.textContent)).toEqual([expect.stringMatching(/^1\d+\.\d\d %6 s6 s$/), expect.stringMatching(/^2\d+\.\d\d %65 s65 s$/)]); // ship path, then reorder path
  });

  it("shows the most probable path at once, a clicked path instead, and none after a second click", () => {
    withResult();
    expect(mocks.showPath).toHaveBeenLastCalledWith(store().graph, store().result!.paths[0]); // path 1, so it is clear that paths can be selected
    fireEvent.click(pathRows()[1]); // path 2: reorder
    expect(mocks.showPath).toHaveBeenLastCalledWith(store().graph, store().result!.paths[1]);
    screen.getByText("Path 2"); // throws when it is missing
    screen.getByText('Decision "In stock?" → lager == nein'); // throws when it is missing // as BEE-UP names the decision
    fireEvent.click(pathRows()[1]);
    expect(store().selectedPath).toBeNull();
    expect(mocks.clearPathHighlight).toHaveBeenCalled();
  });

  it("sorts the paths by cycle time, keeping their numbers", () => {
    withResult();
    fireEvent.click(screen.getByText("CT"));
    expect(pathRows().map((row) => row.firstChild?.textContent)).toEqual(["2", "1"]); // the reorder path takes longer
  });

  it("says when the model was changed, and no longer shows a path in it", () => {
    withResult();
    fireEvent.click(pathRows()[0]);
    store().markStale(); // what the session does when the model differs
    cleanup();
    render(<PathAnalysisPanel />);
    screen.getByText(/The model was changed after this analysis/); // throws when it is missing
    fireEvent.click(pathRows()[0]);
    expect(store().selectedPath).toBeNull(); // not shown in the model
  });

  it("lists the validator's problems when the analysis cannot run", () => {
    const graph = modelA();
    delete graph.nodes.start; // no Start
    store().open("scene-1");
    store().showResult(graph, analysePaths(graph, { runs: 10, seed: 1 }));
    render(<PathAnalysisPanel />);
    screen.getByText(/The analysis cannot run/); // throws when it is missing
    expect(screen.queryByRole("button", { name: "Export CSV" })).toBeNull(); // nothing to export
  });

  it("shows the distribution of the execution time with its figures, and of the cycle time on request", () => {
    withResult(); // model A: ET 6 s (lager = ja) or 65 s (nein)
    const chart = screen.getByRole("img", { name: "Distribution of the execution time over the finished runs" });
    expect(chart.querySelectorAll("path")).toHaveLength(2); // a bar for 6 s and one for 65 s
    expect(screen.getByText("σ")).toBeTruthy(); // the figures next to the chart
    expect(screen.getByText("90 %")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Cycle time" }));
    expect(screen.getByRole("img", { name: "Distribution of the cycle time over the finished runs" })).toBeTruthy();
    fireEvent.click(screen.getByText("Values as a table")); // the table view
    const valuesTable = screen.getByRole("columnheader", { name: "Time" }).closest("table")!; // the distribution's table, not the path table
    expect(within(valuesTable).getAllByRole("row").map((row) => (row as HTMLTableRowElement).cells[0].textContent)).toEqual(["Time", "6 s", "65 s"]);

    fireEvent.click(screen.getByRole("button", { name: "Cumulative" }));
    expect(screen.getByRole("img", { name: "Cumulative distribution of the cycle time over the finished runs" })).toBeTruthy();
    expect(screen.getByText("90 % finish within 65 s")).toBeTruthy(); // one branch at a time, so CT = ET: about 80 % take 6 s, so 90 % are only done at 65 s
  });

  it("exports and closes through the session", () => {
    withResult();
    click("Export CSV");
    click("Close");
    expect(mocks.exportPathAnalysis).toHaveBeenCalledTimes(1);
    expect(mocks.closePathAnalysis).toHaveBeenCalledTimes(1);
  });
});
