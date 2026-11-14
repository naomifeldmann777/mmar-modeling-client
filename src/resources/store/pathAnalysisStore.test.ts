// Tests for pathAnalysisStore: opening, showing a result or the problems, selecting and sorting
// paths, and an outdated result. The results come from a real analysis of a tiny graph.
import { beforeEach, describe, expect, it } from "vitest";
import type { GraphNode, SimulationGraph } from "@/resources/process-simulation/graph";
import { analysePaths } from "@/resources/process-simulation/path-analysis";
import type { NodeConcept } from "@/resources/process-simulation/vocabulary";
import { usePathAnalysisStore } from "./pathAnalysisStore";

const node = (id: string, concept: NodeConcept): GraphNode => ({ id, label: id, concept, executionTime: 0, incoming: [], outgoing: [] });
const startToEnd: SimulationGraph = {
  nodes: { start: { ...node("start", "Start"), outgoing: ["f"] }, end: { ...node("end", "End"), incoming: ["f"] } }, // Start → End
  flows: { f: { id: "f", label: "f", source: "start", target: "end", condition: [] } },
  generators: {},
  variables: {},
  issues: [],
};
const state = () => usePathAnalysisStore.getState();

beforeEach(() => state().reset());

describe("pathAnalysisStore", () => {
  it("opens empty, keeps a result, and closes", () => {
    state().open("scene-1");
    expect(state()).toMatchObject({ active: true, sceneInstanceId: "scene-1", result: null });
    state().showResult(startToEnd, analysePaths(startToEnd, { runs: 3, seed: 1 }));
    expect(state().result?.paths).toHaveLength(1); // Start → End
    expect(state().selectedPath).toBe(0); // the most probable path is shown at once
    state().close();
    expect(state()).toMatchObject({ active: false, result: null });
  });

  it("keeps the validator's problems instead of a result", () => {
    state().open("scene-1");
    const noEnd: SimulationGraph = { ...startToEnd, nodes: { start: node("start", "Start") }, flows: {} };
    state().showResult(noEnd, analysePaths(noEnd, { runs: 3, seed: 1 }));
    expect(state().result).toBeNull();
    expect(state().problems.map((p) => p.check)).toContain(4); // no End
  });

  it("selects a path, and refuses to while the result is outdated", () => {
    state().open("scene-1");
    state().showResult(startToEnd, analysePaths(startToEnd, { runs: 3, seed: 1 }));
    state().select(0);
    expect(state().selectedPath).toBe(0);
    state().markStale(); // the model was changed
    expect(state()).toMatchObject({ stale: true, selectedPath: null }); // the highlighting goes
    state().select(0);
    expect(state().selectedPath).toBeNull(); // refused
    state().showResult(startToEnd, analysePaths(startToEnd, { runs: 3, seed: 1 })); // a new analysis
    expect(state().stale).toBe(false); // up to date again
  });

  it("sorts, and keeps the order for the next analysis", () => {
    state().open("scene-1");
    state().sortBy("cycleTime");
    state().showResult(startToEnd, analysePaths(startToEnd, { runs: 3, seed: 1 }));
    expect(state().sort).toBe("cycleTime");
  });
});
