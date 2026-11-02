// @vitest-environment jsdom
//
// Tests for stepper-session.ts: starting the stepper on the open model (with and without a
// stored mapping), the mode (5 while open, back to view mode when stopped), and stopping with a
// message when the tab, the model or the mode changes. `@/engine` is mocked: the real barrel
// builds a WebGLRenderer at module scope. The store, the event bus, the logger, the mapping
// and the transformer are the real ones. Every id is invented for the test.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SceneInstance, SceneType } from "@gds";

const mocks = vi.hoisted(() => ({
  globalObject: { tabContext: [] as { sceneType: unknown; sceneInstance: unknown }[], selectedTab: 0 }, // the open tabs
  globalStateObject: { setState: vi.fn(), stateNames: ["SelectionMode (drag)", "ViewMode", "DrawingMode (insert)", "DrawingModeRelationClass (line)", "SimulationMode", "ProcessSimulationMode"] }, // the interaction mode
}));
vi.mock("@/engine", () => ({
  globalObject: mocks.globalObject,
  globalStateObject: mocks.globalStateObject,
}));

import { saveMapping } from "@/resources/process-simulation/mapping";
import { eventBus } from "@/resources/services/event-bus";
import { useLogStore } from "@/resources/store/logStore";
import { useProcessSimulationStore } from "@/resources/store/processSimulationStore";
import { useStateStore } from "@/resources/store/stateStore";
import { startStepper, stopStepper } from "./stepper-session";

// A model with a Start box, an End box and one line between them.
const sceneType = { classes: [{ uuid: "m-box", name: "Box", attributes: [] }], relationclasses: [{ uuid: "m-flow", name: "Flow", attributes: [] }] } as unknown as SceneType;
const sceneInstance = {
  uuid: "scene-1",
  class_instances: [{ uuid: "start", uuid_class: "m-box", attribute_instance: [] }, { uuid: "end", uuid_class: "m-box", attribute_instance: [] }],
  relationclasses_instances: [{ uuid: "f1", uuid_class: "m-flow", uuid_relationclass: "m-flow", attribute_instance: [], role_instance_from: { uuid_has_reference_class_instance: "start" }, role_instance_to: { uuid_has_reference_class_instance: "end" } }],
} as unknown as SceneInstance;

const store = () => useProcessSimulationStore.getState();
const snackbar = () => useLogStore.getState().snackbar;

beforeEach(() => {
  window.localStorage.clear(); // no stored mapping unless a test saves one
  mocks.globalObject.tabContext = [{ sceneType, sceneInstance }]; // the model is open
  mocks.globalStateObject.setState.mockClear();
  store().reset();
  useLogStore.setState({ snackbar: { open: false, message: "", severity: "info" } });
  useStateStore.setState({ activeState: "ProcessSimulationMode" }); // what setState(5) shows; the mocked engine does not set it
});

afterEach(() => {
  if (store().active) stopStepper(); // ends the event subscriptions of a test that left the stepper open
});

describe("stepper-session", () => {
  it("starts a run on the open model with its stored mapping, and locks the model", () => {
    saveMapping({ sceneInstanceId: "scene-1", elements: { start: { concept: "Start" }, end: { concept: "End" }, f1: { concept: "SequenceFlow" } } }, window.localStorage);
    startStepper();
    expect(store().active).toBe(true);
    expect(store().problems).toEqual([]);
    expect(store().run?.steps.map((s) => s.node)).toEqual(["start"]); // the token in front of the Start
    expect(mocks.globalStateObject.setState).toHaveBeenLastCalledWith(5); // ProcessSimulationMode
  });

  it("opens with the validator's problems when nothing is mapped yet", () => {
    startStepper(); // no stored mapping: an empty one, so the graph has no Start
    expect(store().active).toBe(true);
    expect(store().run).toBeNull();
    expect(store().problems.map((p) => p.check)).toContain(4);
  });

  it("does not open without an open model, and says so", () => {
    mocks.globalObject.tabContext = [];
    startStepper();
    expect(store().active).toBe(false);
    expect(snackbar().message).toContain("Open a model first");
  });

  it("stops when the user chooses another mode, and leaves that mode as it is", () => {
    startStepper();
    mocks.globalStateObject.setState.mockClear();
    useStateStore.getState().setActiveState("DrawingMode (insert)"); // e.g. a click on the palette
    expect(store().active).toBe(false);
    expect(snackbar().message).toContain("because another mode was chosen");
    expect(mocks.globalStateObject.setState).not.toHaveBeenCalled(); // the user's mode stays
  });

  it("goes back to view mode on 'Stop simulation'", () => {
    startStepper();
    stopStepper();
    expect(store().active).toBe(false);
    expect(mocks.globalStateObject.setState).toHaveBeenLastCalledWith(1); // back to view mode
  });

  it("stops with a message when the user switches tabs", () => {
    startStepper();
    eventBus.publish("tabChanged");
    expect(store().active).toBe(false);
    expect(snackbar().message).toContain("because you switched tabs");
  });

  it("stops when another user changes its model, but not when another tab's model changes", () => {
    startStepper(); // on tab 0
    eventBus.publish("remoteSceneInstanceChanged", { tabIndex: 1, instanceUuids: ["x"] }); // a shared model in another tab
    expect(store().active).toBe(true);
    eventBus.publish("remoteSceneInstanceChanged", { tabIndex: 0, instanceUuids: ["start"] }); // e.g. a collaborator moves the Start
    expect(store().active).toBe(false);
    expect(snackbar().message).toContain("because another user changed the model");
  });

  it("stops when its model changes, but not when another model changes", () => {
    startStepper();
    eventBus.publish("sceneInstanceMutated", { sceneInstanceUuid: "scene-2" }); // another open model
    expect(store().active).toBe(true);
    eventBus.publish("sceneInstanceMutated", { sceneInstanceUuid: "scene-1" }); // the model of the run, e.g. changed by another user
    expect(store().active).toBe(false);
    expect(snackbar().message).toContain("because the model was changed");
  });
});
