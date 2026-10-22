// @vitest-environment jsdom
/**
 * Component tests for the concept-mapping popup: which rows it shows, that a choice is
 * saved in the browser at once, and how export and import behave.
 *
 * The engine is replaced by a fake: the real one builds a WebGLRenderer when it is
 * imported. Every id is invented for the test (plan 3: no real uuids in code). As in
 * the other dialog tests, cleanup() is called by hand (vitest `globals` is off) and the
 * dialog flags of uiStore are reset before each test, since the store is module-global.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { NAME_ATTRIBUTE_UUID } from "@/constants";

const fake = vi.hoisted(() => ({
  globalObject: { tabContext: [] as unknown[], selectedTab: 0 }, // the open tabs; empty means no model is open
  globalClassObject: { getIcon: async () => "" }, // no icons: the tests are about the rows, not the pictures
}));
vi.mock("@/engine", () => fake); // keeps the real engine (and WebGL) out of the test
vi.mock("@/resources/services/logger", () => ({ logger: { log: vi.fn() } })); // the real logger would raise snackbars

const { default: MappingDialog } = await import("./MappingDialog"); // imported after the mocks are in place
const { useUiStore } = await import("@/resources/store/uiStore"); // to open the dialog the way the menu will
const { storageKey } = await import("@/resources/process-simulation/mapping"); // to look into localStorage

const name = (uuid: string, value: string) => ({ uuid, uuid_attribute: NAME_ATTRIBUTE_UUID, value }); // a Name attribute instance

/** A model with two tasks, one flow between them, and one bendpoint on the flow. */
const tab = {
  sceneType: {
    classes: [
      { uuid: "m-task", name: "Task", geometry: "", attributes: [{ uuid: NAME_ATTRIBUTE_UUID, name: "Name" }] }, // a node metaclass
      { uuid: "m-bend", name: "Bendpoint", geometry: "", attributes: [] }, // the kinks of a drawn flow
    ],
    relationclasses: [
      {
        uuid: "m-flow", // the flow metaclass
        name: "Flow", // sorts before "Task", so the flow is the first row
        geometry: "", // no icon
        bendpoint: "m-bend", // makes instances of m-bend bendpoints
        attributes: [{ uuid: NAME_ATTRIBUTE_UUID, name: "Name" }, { uuid: "m-condition", name: "Condition" }], // offered by name
      },
    ],
  },
  sceneInstance: {
    uuid: "scene-1", // the model's id, which the mapping is stored under
    name: "Test model", // shown in the title
    class_instances: [
      { uuid: "i-a", uuid_class: "m-task", attribute_instance: [name("a-a-name", "Check stock")] }, // a named task
      { uuid: "i-b", uuid_class: "m-task", attribute_instance: [name("a-b-name", "Ship")] }, // another named task
      { uuid: "i-bend", uuid_class: "m-bend", attribute_instance: [] }, // must not appear
    ],
    relationclasses_instances: [
      {
        uuid: "i-flow", // the flow from Check stock to Ship
        uuid_relationclass: "m-flow", // its metaclass
        attribute_instance: [name("a-flow-name", ""), { uuid: "a-flow-condition", uuid_attribute: "m-condition", value: "" }], // unnamed, with a condition
        role_instance_from: { uuid_has_reference_class_instance: "i-a" }, // source
        role_instance_to: { uuid_has_reference_class_instance: "i-b" }, // target
      },
    ],
  },
};
const FLOW = "(unnamed) (Check stock → Ship)"; // how the unnamed flow is labelled

/** Renders the dialog and opens it through uiStore, as the menu entry will. */
function openDialog() {
  render(<MappingDialog />); // mounted closed, as in AppLayout
  act(() => useUiStore.getState().openDialog("processSimulationMapping")); // the effect then reads the model
}

/** Picks an option in the MUI Select with the given accessible name. */
function choose(selectName: string, option: string) {
  fireEvent.mouseDown(screen.getByRole("combobox", { name: selectName })); // MUI opens its list on mouse down
  fireEvent.click(screen.getByRole("option", { name: option })); // and selects on click
}

/** The mapping currently saved in localStorage for the test model. */
const stored = () => JSON.parse(localStorage.getItem(storageKey("scene-1")) ?? "null"); // null when nothing was saved

/** Picks `file` in the hidden import input. */
function importFile(content: unknown) {
  const input = document.body.querySelector('input[type="file"]') as HTMLInputElement; // hidden, so not reachable by role
  fireEvent.change(input, { target: { files: [new File([JSON.stringify(content)], "mapping.json")] } }); // what choosing a file does
}

describe("MappingDialog", () => {
  beforeEach(() => {
    cleanup(); // unmount the previous test's dialog
    localStorage.clear(); // every test starts without a saved mapping
    useUiStore.getState().reset(); // closes every dialog
    fake.globalObject.tabContext = [tab]; // a model is open unless a test says otherwise
  });

  it("asks for a model when none is open", () => {
    fake.globalObject.tabContext = []; // no tab
    openDialog(); // open anyway
    expect(screen.getByText(/Open a model first/)).toBeTruthy(); // nothing to map
  });

  it("lists every element with its metaclass, names the ends of a flow, and hides bendpoints", () => {
    openDialog(); // with the test model open
    expect(screen.getByText("Check stock")).toBeTruthy(); // a task by its Name attribute
    expect(screen.getByText(FLOW)).toBeTruthy(); // an unnamed flow is still recognisable
    expect(screen.queryByText("(unnamed)")).toBeNull(); // the bendpoint has no row
    expect(screen.getAllByText("not mapped")).toHaveLength(3); // two tasks and the flow, all unmapped
  });

  it("saves a chosen concept in the browser at once", () => {
    openDialog(); // nothing mapped yet
    choose("Concept of Ship", "Activity"); // the first dropdown
    expect(stored().elements["i-b"]).toEqual({ concept: "Activity" }); // saved without pressing anything
    expect(screen.getAllByText("not mapped")).toHaveLength(2); // the status column follows
  });

  it("offers a flow's attributes by name and stores the chosen attribute instance", () => {
    openDialog(); // nothing mapped yet
    choose(`Concept of ${FLOW}`, "SequenceFlow"); // a concept that reads data
    choose("TransitionCondition", "Condition"); // the second dropdown appears, labelled with the data concept and listing names
    expect(stored().elements["i-flow"]).toEqual({ concept: "SequenceFlow", data: { TransitionCondition: "a-flow-condition" } }); // the uuid, not the name
  });

  it("shows the saved mapping when it is opened again", () => {
    localStorage.setItem(storageKey("scene-1"), JSON.stringify({ sceneInstanceId: "scene-1", elements: { "i-a": { concept: "Activity" } } })); // an earlier visit
    openDialog(); // the effect loads it
    expect(screen.getByRole("combobox", { name: "Concept of Check stock" }).textContent).toBe("Activity"); // shown as chosen
  });

  it("exports the mapping as a JSON file", async () => {
    const createObjectURL = vi.fn((_blob: Blob) => "blob:mapping"); // jsdom has no object URLs
    Object.assign(URL, { createObjectURL, revokeObjectURL: vi.fn() }); // provided for this test
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined); // jsdom cannot download
    openDialog(); // nothing mapped yet
    choose("Concept of Ship", "Activity"); // something to export
    fireEvent.click(screen.getByRole("button", { name: "Export" })); // the export button
    expect(click).toHaveBeenCalledTimes(1); // the download was started
    expect(JSON.parse(await createObjectURL.mock.calls[0][0].text())).toEqual(stored()); // with the same content as the saved mapping
  });

  it("refuses to import a mapping of another model", async () => {
    openDialog(); // nothing mapped yet
    importFile({ sceneInstanceId: "scene-2", elements: {} }); // exported from another model
    expect(await screen.findByText("The mapping belongs to another model.")).toBeTruthy(); // said so
    expect(stored()).toBeNull(); // nothing was taken over
  });

  it("imports what fits and lists what was left out", async () => {
    openDialog(); // nothing mapped yet
    importFile({
      sceneInstanceId: "scene-1", // the right model
      elements: {
        "i-a": { concept: "Activity" }, // fits
        "i-b": { concept: "Task" }, // exists, but "Task" is no simulation concept
        "i-gone": { concept: "Activity" }, // the element was deleted
      },
    });
    expect(await screen.findByText('Ship (Task): "Task" is not a simulation concept.')).toBeTruthy(); // named with its metaclass
    expect(screen.getByText("i-gone: The element no longer exists in the model.")).toBeTruthy(); // only the uuid is left of it
    expect(stored().elements).toEqual({ "i-a": { concept: "Activity" } }); // the rest was taken over and saved
  });

  it("marks mapped elements as mapped", () => {
    openDialog(); // nothing mapped yet
    choose("Concept of Ship", "Activity"); // map one element
    expect(screen.getAllByText("mapped")).toHaveLength(1); // the mapped one
    expect(screen.getAllByText("not mapped")).toHaveLength(2); // the other two
    // The colours really arrive: MUI 9 ignores a palette path such as "success.main" on
    // Typography and leaves the text black. Without the app theme, MUI's defaults apply.
    expect(getComputedStyle(screen.getByText("mapped")).color).toBe("rgb(46, 125, 50)"); // default success.main
    expect(getComputedStyle(screen.getAllByText("not mapped")[0]).color).toBe("rgb(237, 108, 2)"); // default warning.main
  });

  it("explains the chosen concept when the dropdown is hovered", async () => {
    openDialog(); // nothing mapped yet
    choose("Concept of Ship", "Activity"); // the closed dropdown now shows "Activity"
    fireEvent.mouseOver(screen.getByRole("combobox", { name: "Concept of Ship" })); // hover the field, not just the word in it
    expect((await screen.findByRole("tooltip")).textContent).toBe("An activity that is executed during the process."); // spec 2.1
  });

  it("hides the field's explanation while its list is open", async () => {
    openDialog(); // nothing mapped yet
    choose("Concept of Ship", "Activity"); // something to explain
    const field = screen.getByRole("combobox", { name: "Concept of Ship" }); // the closed dropdown
    fireEvent.mouseOver(field); // hover: the explanation appears
    await screen.findByRole("tooltip"); // shown
    fireEvent.mouseDown(field); // open the list
    await waitFor(() => expect(screen.queryByText("An activity that is executed during the process.")).toBeNull()); // gone while the list is open
  });
});
