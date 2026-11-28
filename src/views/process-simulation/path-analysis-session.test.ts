// @vitest-environment jsdom
//
// Tests for path-analysis-session.ts: opening the panel, running the analysis on the open
// model, a model without a mapping, noticing a change of the model after the analysis, closing
// on a tab change, and the stepper and the path analysis giving way to each other. `@/engine`
// is mocked: the real barrel builds a WebGLRenderer at module scope. `mappingFor` is mocked, so
// the test does not depend on the names of the BPMN 2.0 metamodel. Ids are invented.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SceneInstance, SceneType } from "@gds";

const mocks = vi.hoisted(() => ({
  globalObject: { tabContext: [] as { sceneType: unknown; sceneInstance: unknown }[], selectedTab: 0 }, // the open tabs
  globalStateObject: { setState: vi.fn(), stateNames: ["SelectionMode (drag)", "ViewMode", "DrawingMode (insert)", "DrawingModeRelationClass (line)", "SimulationMode", "ProcessSimulationMode"] }, // for the stepper
}));
vi.mock("@/engine", () => ({ globalObject: mocks.globalObject, globalStateObject: mocks.globalStateObject }));
vi.mock("@/resources/process-simulation/mappings", async (importOriginal) => ({
  ...(await importOriginal<object>()), // resolveConcept stays real, the transformer needs it
  mappingFor: (sceneTypeName: string) => (sceneTypeName === "Test language" ? { Start: { concept: "Start" }, End: { concept: "End" }, Flow: { concept: "SequenceFlow" } } : null),
}));

import { eventBus } from "@/resources/services/event-bus";
import { useLogStore } from "@/resources/store/logStore";
import { usePathAnalysisStore } from "@/resources/store/pathAnalysisStore";
import { useProcessSimulationStore } from "@/resources/store/processSimulationStore";
import { useStateStore } from "@/resources/store/stateStore";
import { cancelPathAnalysis, closePathAnalysis, openPathAnalysis, runPathAnalysis } from "./path-analysis-session";
import { startStepper } from "./stepper-session";

// A model of the test language: Start → End.
const sceneType = {
  name: "Test language",
  classes: [{ uuid: "m-start", name: "Start", attributes: [] }, { uuid: "m-end", name: "End", attributes: [] }],
  relationclasses: [{ uuid: "m-flow", name: "Flow", attributes: [] }],
} as unknown as SceneType;
let sceneInstance: SceneInstance; // a fresh copy per test, since one test changes it

const store = () => usePathAnalysisStore.getState();
const snackbar = () => useLogStore.getState().snackbar;

beforeEach(() => {
  sceneInstance = {
    uuid: "scene-1",
    class_instances: [{ uuid: "start", uuid_class: "m-start", attribute_instance: [], coordinates_2d: { x: 0, y: 0 } }, { uuid: "end", uuid_class: "m-end", attribute_instance: [] }],
    relationclasses_instances: [{ uuid: "f1", uuid_class: "m-flow", uuid_relationclass: "m-flow", attribute_instance: [], role_instance_from: { uuid_has_reference_class_instance: "start" }, role_instance_to: { uuid_has_reference_class_instance: "end" } }],
  } as unknown as SceneInstance;
  mocks.globalObject.tabContext = [{ sceneType, sceneInstance }];
  store().reset();
  useProcessSimulationStore.getState().reset();
  useLogStore.setState({ snackbar: { open: false, message: "", severity: "info" } });
  useStateStore.setState({ activeState: "ProcessSimulationMode" }); // what the stepper's mode shows; the mocked engine does not set it
});

afterEach(() => {
  closePathAnalysis(); // ends the subscriptions and the comparison of a test that left the panel open
  vi.useRealTimers();
});

describe("path-analysis-session", () => {
  it("opens the panel on the open model, then analyses it", async () => {
    openPathAnalysis();
    expect(store()).toMatchObject({ active: true, sceneInstanceId: "scene-1", result: null }); // no result before "Start"
    await runPathAnalysis({ runs: 5, seed: 1 });
    expect(store().result?.paths.map((path) => path.nodes)).toEqual([["start", "end"]]);
    expect(store().result?.runs).toBe(5);
  });

  it("does not open without an open model, and says so", () => {
    mocks.globalObject.tabContext = [];
    openPathAnalysis();
    expect(store().active).toBe(false);
    expect(snackbar().message).toContain("Open a model first");
  });

  it("shows a message, and no result, when the model's scene type has no mapping", async () => {
    mocks.globalObject.tabContext = [{ sceneType: { ...sceneType, name: "Robotic System" }, sceneInstance }];
    openPathAnalysis();
    await runPathAnalysis({ runs: 5 });
    expect(store().result).toBeNull();
    expect(store().message).toBe('The process simulation has no mapping for the metamodel "Robotic System", so it cannot analyse this model.');
  });

  it("marks the result outdated once the model is changed, and not before", async () => {
    vi.useFakeTimers();
    openPathAnalysis();
    await runPathAnalysis({ runs: 5, seed: 1 });
    store().select(0); // a path is shown in the model
    vi.advanceTimersByTime(3000);
    expect(store().stale).toBe(false); // nothing changed
    (sceneInstance.class_instances[0] as unknown as { coordinates_2d: { x: number } }).coordinates_2d.x = 4; // e.g. the Start is moved
    vi.advanceTimersByTime(1000);
    expect(store()).toMatchObject({ stale: true, selectedPath: null }); // the panel says so; the highlighted path goes
    await runPathAnalysis({ runs: 5, seed: 1 }); // started again on the changed model
    expect(store().stale).toBe(false);
  });

  it("reports its progress while it runs, and keeps the earlier result when cancelled", async () => {
    openPathAnalysis();
    await runPathAnalysis({ runs: 5, seed: 1 }); // an earlier result
    const earlier = store().result;
    const seen: (number | undefined)[] = []; // the progress the dialog would show
    const unsubscribe = usePathAnalysisStore.subscribe((state) => seen.push(state.progress?.done));
    const running = runPathAnalysis({ runs: 100000, seed: 2 }); // long enough for several portions; returns after the first one, at its first pause
    expect(store().progress?.total).toBe(100000); // the dialog is open
    expect(store().progress!.done).toBeLessThan(100000); // and not yet done
    cancelPathAnalysis();
    await running;
    unsubscribe();
    expect(store().progress).toBeNull(); // the dialog is closed
    expect(store().result).toBe(earlier); // nothing of the cancelled analysis
    expect(seen.some((done) => done !== undefined && done > 0 && done < 100000)).toBe(true); // it ran in portions and said how far it got
  });

  it("closes with a message when the user switches tabs", () => {
    openPathAnalysis();
    eventBus.publish("tabChanged");
    expect(store().active).toBe(false);
    expect(snackbar().message).toContain("because you switched tabs");
  });

  it("gives way to the stepper, and the stepper to it", () => {
    openPathAnalysis();
    startStepper();
    expect([store().active, useProcessSimulationStore.getState().active]).toEqual([false, true]); // the stepper took the column
    openPathAnalysis();
    expect([store().active, useProcessSimulationStore.getState().active]).toEqual([true, false]); // and gave it back
  });
});
