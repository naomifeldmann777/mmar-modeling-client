// @vitest-environment jsdom
//
// P8 component tests for the reference-attribute dialog: it loads its context off the
// `openReferenceDialog` bus channel, offers only the instances the attribute type's
// Role allows, and sets / unsets the reference role instance. Then the model filter: only the
// open model's elements at first, others when ticked, each entry named with its model.
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { AttributeInstance, ClassInstance, RoleInstance } from "@gds";
import { NAME_ATTRIBUTE_UUID } from "@/constants";

const mocks = vi.hoisted(() => ({
  globalObject: {
    role_instances: [] as any[],
    current_class_instance: undefined as any,
    current_port_instance: undefined as any,
  } as any,
  instanceCreationHandler: { createRoleInstance: vi.fn() },
  // Typed `Promise<any>` so `mockResolvedValue(<gds instance>)` type-checks — an
  // inferred `async () => []` would fix the mock's return type to `never[]`.
  instanceUtility: {
    getClassInstance: vi.fn(async (): Promise<any> => undefined),
    getPortInstance: vi.fn(async (): Promise<any> => undefined),
    getSceneInstance: vi.fn(async (): Promise<any> => undefined),
    getAllClassInstances: vi.fn(async (): Promise<any[]> => []),
    getAllRelationClassInstances: vi.fn(async (): Promise<any[]> => []),
    getAllPortInstances: vi.fn(async (): Promise<any[]> => []),
    getAllSceneInstancesFromLocal: vi.fn(async (): Promise<any[]> => []),
    getTabContextSceneInstance: vi.fn(async (): Promise<any> => undefined),
    portInstancesOf: vi.fn((scene: any): any[] => scene.port_instances ?? []), // a model's ports, as the real one collects them
  },
  metaUtility: {
    getMetaClass: vi.fn(async (): Promise<any> => undefined),
    getMetaPort: vi.fn(async (): Promise<any> => undefined),
    getMetaAttribute: vi.fn(async (): Promise<any> => undefined),
  },
  expressionUtility: { attrvalByInst: vi.fn(async (): Promise<any> => "Referenced Task") },
  // P12: hybrid-algorithms-service imports the @/engine/global-definition LEAF directly,
  // so it bypasses the `@/engine` barrel mock and drags in a real WebGLRenderer at module
  // scope — this whole file fails to load without the mock below. (Same lesson as P9's
  // persistency-handler, P10's shared-doc-service and P11's renderers.)
  hybridAlgorithmsService: { checkHybridAlgorithms: vi.fn(async () => undefined) },
  // Both import the @/engine/global-definition leaf too.
  historyService: { record: vi.fn() },
  markActiveSceneDirty: vi.fn(),
}));

vi.mock("@/engine/hybrid-algorithms/hybrid-algorithms-service", () => ({
  hybridAlgorithmsService: mocks.hybridAlgorithmsService,
}));
vi.mock("@/resources/services/history-service", () => ({ historyService: mocks.historyService }));
vi.mock("@/resources/collaboration/local-change-publisher", () => ({
  markActiveSceneDirty: mocks.markActiveSceneDirty,
}));
vi.mock("@/engine", () => ({
  globalObject: mocks.globalObject,
  instanceCreationHandler: mocks.instanceCreationHandler,
}));
vi.mock("@/resources/services/instance-utility", () => ({ instanceUtility: mocks.instanceUtility }));
vi.mock("@/resources/services/meta-utility", () => ({ metaUtility: mocks.metaUtility }));
vi.mock("@/resources/services/expression-utility", () => ({ expressionUtility: mocks.expressionUtility }));
vi.mock("@/resources/services/scene-tree-service", () => ({ loadAllSceneInstances: vi.fn(async () => undefined) })); // the models are given by the instanceUtility mock; the real one would fetch every scene type's models from the server

import ReferenceAttributeDialog from "./ReferenceAttributeDialog";
import { eventBus } from "@/resources/services/event-bus";
import { useSelectionStore } from "@/resources/store/selectionStore";
import { useUiStore } from "@/resources/store/uiStore";
import { useLogStore } from "@/resources/store/logStore";

const ROLE_UUID = "role-1";
const ALLOWED_CLASS_UUID = "class-allowed";

/** A meta class whose reference attribute carries a Role allowing ALLOWED_CLASS_UUID. */
function metaClassWithReferenceAttribute() {
  return {
    uuid: "class-1",
    attributes: [
      {
        uuid: "attr-ref",
        name: "Sub-Process Reference",
        attribute_type: {
          uuid: "at-ref",
          role: {
            uuid: ROLE_UUID,
            class_references: [{ uuid: ALLOWED_CLASS_UUID }],
            relationclass_references: [],
            port_references: [],
            scenetype_references: [],
          },
        },
      },
    ],
  };
}

function referenceAttributeInstance(overrides: Record<string, unknown> = {}): AttributeInstance {
  return AttributeInstance.fromJS({
    uuid: "ai-ref",
    uuid_attribute: "attr-ref",
    name: "Sub-Process Reference",
    value: "...",
    table_attributes: [],
    ...overrides,
  }) as AttributeInstance;
}

/** A class instance that the Role allows, named through the "Name" meta attribute. */
function allowedClassInstance(): ClassInstance {
  return ClassInstance.fromJS({
    uuid: "ci-target",
    uuid_class: ALLOWED_CLASS_UUID,
    name: "Sub-Process",
    attribute_instance: [
      { uuid: "ai-name", uuid_attribute: NAME_ATTRIBUTE_UUID, value: "Referenced Task", table_attributes: [] },
    ],
  }) as ClassInstance;
}

/** A model (scene instance) holding `classInstances`. */
function model(uuid: string, name: string, classInstances: ClassInstance[] = [], sceneType = "st-bpmn") {
  return { uuid, name, uuid_scene_type: sceneType, class_instances: classInstances, relationclasses_instances: [], port_instances: [] };
}

/** The open model holds `classInstances`; no other model is loaded. */
function openModelHolds(...classInstances: ClassInstance[]) {
  mocks.instanceUtility.getTabContextSceneInstance.mockResolvedValue(model("scene-open", "Bestellabwicklung", classInstances));
}

/** The picker of class instances, by its label (the model filter is a combobox too). */
const classPicker = () => screen.getByRole("combobox", { name: /Select Referenced ClassInstance/ });

function openDialogWith(attributeInstance: AttributeInstance) {
  useUiStore.setState({
    dialogs: { ...useUiStore.getState().dialogs, referenceAttribute: true },
    dialogPayloads: { referenceAttribute: { attributeInstance } },
  });
  eventBus.publish("openReferenceDialog", { attributeInstance });
}

beforeEach(() => {
  vi.clearAllMocks();
  cleanup();
  Object.assign(mocks.globalObject, {
    role_instances: [],
    current_class_instance: { uuid: "ci-1", uuid_class: "class-1" },
    current_port_instance: undefined,
  });
  mocks.metaUtility.getMetaClass.mockResolvedValue(metaClassWithReferenceAttribute());
  mocks.metaUtility.getMetaPort.mockResolvedValue(undefined);
  mocks.metaUtility.getMetaAttribute.mockResolvedValue(undefined);
  mocks.instanceUtility.getAllClassInstances.mockResolvedValue([]);
  mocks.instanceUtility.getAllRelationClassInstances.mockResolvedValue([]);
  mocks.instanceUtility.getAllPortInstances.mockResolvedValue([]);
  mocks.instanceUtility.getAllSceneInstancesFromLocal.mockResolvedValue([]);
  mocks.instanceUtility.getTabContextSceneInstance.mockResolvedValue(model("scene-open", "Bestellabwicklung"));
  mocks.globalObject.sceneTypes = [{ uuid: "st-bpmn", name: "BPMN 2.0" }, { uuid: "st-petri", name: "Petri Net" }];
  mocks.expressionUtility.attrvalByInst.mockResolvedValue("Referenced Task");
  useLogStore.setState({ snackbar: { open: false, message: "", severity: "info" } });
  useUiStore.setState({
    dialogs: Object.fromEntries(
      Object.keys(useUiStore.getState().dialogs).map((n) => [n, false]),
    ) as never,
    dialogPayloads: {},
  });
});

describe("ReferenceAttributeDialog", () => {
  it("offers only the class instances the Role allows", async () => {
    const target = allowedClassInstance();
    const notAllowed = ClassInstance.fromJS({
      uuid: "ci-other",
      uuid_class: "class-other",
      name: "Other",
      attribute_instance: [],
    }) as ClassInstance;
    openModelHolds(target, notAllowed);

    render(<ReferenceAttributeDialog />);
    openDialogWith(referenceAttributeInstance());

    await waitFor(() => expect(screen.getByText("Select Referenced ClassInstance")).toBeTruthy());
    fireEvent.mouseDown(classPicker());

    expect(await screen.findByRole("option", { name: /Referenced Task \| Bestellabwicklung \| ci-target/ })).toBeTruthy();
    expect(screen.queryByRole("option", { name: /ci-other/ })).toBeNull();
  });

  it("resolves the Role through the meta attribute for a scene-owned reference attribute", async () => {
    // Nothing selected (the attribute window is showing the open scene instance), so
    // there is no current class or port to read the Role off — metaUtility resolves it
    // from the scene type instead.
    mocks.globalObject.current_class_instance = undefined;
    mocks.metaUtility.getMetaAttribute.mockResolvedValue(metaClassWithReferenceAttribute().attributes[0]);
    openModelHolds(allowedClassInstance());

    render(<ReferenceAttributeDialog />);
    openDialogWith(referenceAttributeInstance());

    await waitFor(() => expect(screen.getByText("Select Referenced ClassInstance")).toBeTruthy());
    fireEvent.mouseDown(classPicker());
    expect(await screen.findByRole("option", { name: /Referenced Task \| Bestellabwicklung \| ci-target/ })).toBeTruthy();
  });

  it("sets the reference: creates a role instance pointing at the picked class instance", async () => {
    const target = allowedClassInstance();
    openModelHolds(target);
    mocks.instanceUtility.getClassInstance.mockResolvedValue(target);
    mocks.instanceCreationHandler.createRoleInstance.mockImplementation(
      async (uuid: string) => RoleInstance.fromJS({ uuid, uuid_role: ROLE_UUID, name: "name_placeholder" }) as RoleInstance,
    );
    const attributeInstance = referenceAttributeInstance();

    render(<ReferenceAttributeDialog />);
    openDialogWith(attributeInstance);

    await waitFor(() => expect(screen.getByText("Select Referenced ClassInstance")).toBeTruthy());
    fireEvent.mouseDown(classPicker());
    fireEvent.click(await screen.findByRole("option", { name: /Referenced Task/ }));
    fireEvent.click(screen.getByRole("button", { name: "add" }));

    await waitFor(() => expect(attributeInstance.role_instance_from).toBeTruthy());
    expect(attributeInstance.role_instance_from.uuid_has_reference_class_instance).toBe("ci-target");
    // the role instance is created for the reference (not a relation from/to)
    expect(mocks.instanceCreationHandler.createRoleInstance).toHaveBeenCalledWith(
      expect.any(String),
      null,
      null,
      "attribute_reference",
      null,
      "name_placeholder",
      ROLE_UUID,
    );
    // and the attribute value becomes the resolved reference name
    expect(attributeInstance.value).toBe("Referenced Task");

    // P12 un-stub: setting a reference must run the Statechange hybrid algorithm, which
    // is what makes a Reference instance adopt the referenced object's mesh. Dropping
    // this call leaves the reference set but the model visually unchanged.
    await waitFor(() =>
      expect(mocks.hybridAlgorithmsService.checkHybridAlgorithms).toHaveBeenCalledWith(attributeInstance),
    );
  });

  // Every metamodel names its elements through the standard Name attribute. A class that
  // does not use it is a fault of the metamodel: the user is told, and the reference is
  // left without a name rather than showing the role instance's placeholder.
  it("reports a referenced class without the standard Name attribute instead of saving a placeholder", async () => {
    const unnamed = ClassInstance.fromJS({
      uuid: "ci-target",
      uuid_class: ALLOWED_CLASS_UUID,
      name: "Sub-Process",
      attribute_instance: [{ uuid: "ai-title", uuid_attribute: "some-other-name", value: "Titled", table_attributes: [] }],
    }) as ClassInstance;
    openModelHolds(unnamed);
    mocks.instanceUtility.getClassInstance.mockResolvedValue(unnamed);
    mocks.expressionUtility.attrvalByInst.mockResolvedValue(undefined);
    mocks.instanceCreationHandler.createRoleInstance.mockImplementation(
      async (uuid: string) => RoleInstance.fromJS({ uuid, uuid_role: ROLE_UUID, name: "name_placeholder" }) as RoleInstance,
    );
    const attributeInstance = referenceAttributeInstance();

    render(<ReferenceAttributeDialog />);
    openDialogWith(attributeInstance);

    await waitFor(() => expect(screen.getByText("Select Referenced ClassInstance")).toBeTruthy());
    // Already while offering it: the picker has no name to label it by.
    expect(useLogStore.getState().snackbar).toEqual({
      open: true,
      severity: "error",
      message: 'The class "Sub-Process" does not use the standard Name attribute, so its instances have no name to show.',
    });
    useLogStore.setState({ snackbar: { open: false, message: "", severity: "info" } });

    fireEvent.mouseDown(classPicker());
    fireEvent.click(await screen.findByRole("option", { name: /ci-target/ }));
    fireEvent.click(screen.getByRole("button", { name: "add" }));

    await waitFor(() => expect(attributeInstance.role_instance_from).toBeTruthy());
    expect(attributeInstance.value).toBe("");
    expect(attributeInstance.role_instance_from.name).toBe("");
    expect(useLogStore.getState().snackbar.open).toBe(true);
    expect(useLogStore.getState().snackbar.message).toContain('The class "Sub-Process" does not use the standard Name attribute');
  });

  it("unsets the reference: clears role_instance_from, drops the role instance and resets the value", async () => {
    const roleInstance = RoleInstance.fromJS({
      uuid: "ri-1",
      uuid_role: ROLE_UUID,
      name: "old name",
      uuid_has_reference_class_instance: "ci-target",
    }) as RoleInstance;
    const attributeInstance = referenceAttributeInstance({
      value: "Referenced Task",
      role_instance_from: {
        uuid: "ri-1",
        uuid_role: ROLE_UUID,
        name: "old name",
        uuid_has_reference_class_instance: "ci-target",
      },
    });
    mocks.globalObject.role_instances = [roleInstance, RoleInstance.fromJS({ uuid: "ri-keep", uuid_role: "other" })];
    mocks.instanceUtility.getClassInstance.mockResolvedValue(allowedClassInstance());

    render(<ReferenceAttributeDialog />);
    openDialogWith(attributeInstance);

    // With a reference set, the dialog shows it plus a delete button (no pickers).
    await waitFor(() => expect(screen.getByRole("button", { name: "delete" })).toBeTruthy());
    expect(screen.queryByText("Select Referenced ClassInstance")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "delete" }));

    await waitFor(() => expect(attributeInstance.role_instance_from).toBeNull());
    expect(attributeInstance.value).toBe("...");
    expect(mocks.globalObject.role_instances.map((r: RoleInstance) => r.uuid)).toEqual(["ri-keep"]);
  });

  describe("announcing a change like any other edit", () => {
    /** Renders the dialog on a fresh attribute and waits for the picker. */
    async function pickTarget() {
      const target = allowedClassInstance();
      openModelHolds(target);
      mocks.instanceUtility.getClassInstance.mockResolvedValue(target);
      mocks.instanceCreationHandler.createRoleInstance.mockImplementation(
        async (uuid: string) => RoleInstance.fromJS({ uuid, uuid_role: ROLE_UUID, name: "name_placeholder" }) as RoleInstance,
      );
      const attributeInstance = referenceAttributeInstance();
      render(<ReferenceAttributeDialog />);
      openDialogWith(attributeInstance);
      await waitFor(() => expect(screen.getByText("Select Referenced ClassInstance")).toBeTruthy());
      fireEvent.mouseDown(classPicker());
      fireEvent.click(await screen.findByRole("option", { name: /Referenced Task/ }));
      return attributeInstance;
    }

    it("redraws, saves and records an undo step when a reference is set", async () => {
      const redraw = vi.fn();
      const subscription = eventBus.subscribe("checkForVizRepUpdateByAttributeInstance", redraw);
      const attributeInstance = await pickTarget();
      const revision = useSelectionStore.getState().revision;

      fireEvent.click(screen.getByRole("button", { name: "add" }));

      await waitFor(() => expect(mocks.markActiveSceneDirty).toHaveBeenCalledTimes(1));
      expect(redraw).toHaveBeenCalledWith(attributeInstance);
      expect(mocks.historyService.record).toHaveBeenCalledWith("set reference");
      expect(useSelectionStore.getState().revision).toBeGreaterThan(revision);
      subscription.dispose();
    });

    it("redraws, saves and records an undo step when a reference is removed", async () => {
      const redraw = vi.fn();
      const subscription = eventBus.subscribe("checkForVizRepUpdateByAttributeInstance", redraw);
      const attributeInstance = referenceAttributeInstance({
        value: "Referenced Task",
        role_instance_from: { uuid: "ri-1", uuid_role: ROLE_UUID, name: "old", uuid_has_reference_class_instance: "ci-target" },
      });
      mocks.instanceUtility.getClassInstance.mockResolvedValue(allowedClassInstance());
      render(<ReferenceAttributeDialog />);
      openDialogWith(attributeInstance);
      await waitFor(() => expect(screen.getByRole("button", { name: "delete" })).toBeTruthy());

      fireEvent.click(screen.getByRole("button", { name: "delete" }));

      await waitFor(() => expect(mocks.markActiveSceneDirty).toHaveBeenCalledTimes(1));
      expect(redraw).toHaveBeenCalledWith(attributeInstance);
      expect(mocks.historyService.record).toHaveBeenCalledWith("remove reference");
      subscription.dispose();
    });
  });

  it("reads a table cell's Role off the column attribute it was opened with", async () => {
    // The column's attribute is on no class or scene type, so the usual lookups find nothing.
    mocks.metaUtility.getMetaClass.mockResolvedValue({ attributes: [] });
    mocks.metaUtility.getMetaAttribute.mockResolvedValue(undefined);
    openModelHolds(allowedClassInstance());
    const cell = referenceAttributeInstance();

    render(<ReferenceAttributeDialog />);
    eventBus.publish("openReferenceDialog", {
      attributeInstance: cell,
      metaAttribute: metaClassWithReferenceAttribute().attributes[0] as never,
    });
    useUiStore.setState({ dialogs: { ...useUiStore.getState().dialogs, referenceAttribute: true } });

    await waitFor(() => expect(screen.getByText("Select Referenced ClassInstance")).toBeTruthy());
  });

  describe("choosing the models whose elements are offered", () => {
    /** A variable named `name` in some model. */
    const variable = (uuid: string, name: string) =>
      ClassInstance.fromJS({ uuid, uuid_class: ALLOWED_CLASS_UUID, name: "Variable", attribute_instance: [{ uuid: `${uuid}-name`, uuid_attribute: NAME_ATTRIBUTE_UUID, value: name, table_attributes: [] }] }) as ClassInstance;

    /** Opens the dialog on the open model "Bestellabwicklung" (lager), with Testmodell 1 (lager), Testmodell 2 (kunde) and the Petri net Netz A (menge) loaded. */
    async function openWithThreeModels() {
      openModelHolds(variable("v-open", "lager"));
      mocks.instanceUtility.getAllSceneInstancesFromLocal.mockResolvedValue([
        model("scene-open", "Bestellabwicklung (saved copy)", []), // the scene tree's copy of the open model, without its newest variable
        model("scene-1", "Testmodell 1", [variable("v-1", "lager")]),
        model("scene-2", "Testmodell 2", [variable("v-2", "kunde")]),
        model("scene-3", "Grundriss", []), // nothing the Role allows: not listed
        model("scene-4", "Netz A", [variable("v-4", "menge")], "st-petri"), // another scene type
      ]);
      render(<ReferenceAttributeDialog />);
      openDialogWith(referenceAttributeInstance());
      await waitFor(() => expect(screen.getByText("Select Referenced ClassInstance")).toBeTruthy());
    }
    const optionNames = () => screen.getAllByRole("option").map((option) => option.textContent);

    it("offers only the elements of the open model at first, from its live copy, each named with its model", async () => {
      await openWithThreeModels();
      fireEvent.mouseDown(classPicker());
      expect(optionNames()).toEqual(["lager | Bestellabwicklung | v-open"]); // not the tree's stale copy, not the other models
    });

    /** The rows of "Show elements from" as they read: types with their count, then the listed models. */
    const filterRows = () => screen.getAllByRole("checkbox").map((box) => box.closest("label")?.textContent);

    it("lists the models that hold an element the Role allows under their scene types, only the current type unfolded", async () => {
      await openWithThreeModels();
      expect(filterRows()).toEqual(["BPMN 2.0 (3)", "Bestellabwicklung – current model", "Testmodell 1", "Testmodell 2", "Petri Net (1)"]); // Petri Net folded; Grundriss holds nothing to reference
      fireEvent.click(screen.getByRole("button", { name: "Fold BPMN 2.0" }));
      fireEvent.click(screen.getByRole("button", { name: "Unfold Petri Net" }));
      await waitFor(() => expect(filterRows()).toEqual(["BPMN 2.0 (3)", "Petri Net (1)", "Netz A"])); // straight to the Petri nets, nothing to scroll past; folding is animated, so the BPMN models leave after it
    });

    it("adds the elements of a ticked model", async () => {
      await openWithThreeModels();
      fireEvent.click(screen.getByRole("checkbox", { name: "Testmodell 1" }));
      fireEvent.mouseDown(classPicker());
      expect(optionNames()).toEqual(["lager | Bestellabwicklung | v-open", "lager | Testmodell 1 | v-1"]); // two variables called lager, told apart by their model
    });

    it("ticks all models of a scene type with the type's box, and unticks them with a second click", async () => {
      await openWithThreeModels();
      fireEvent.click(screen.getByRole("checkbox", { name: "BPMN 2.0 (3)" })); // the current model was ticked, the other two follow
      fireEvent.mouseDown(classPicker());
      expect(optionNames()).toEqual(["lager | Bestellabwicklung | v-open", "lager | Testmodell 1 | v-1", "kunde | Testmodell 2 | v-2"]); // not Netz A: another type
      fireEvent.keyDown(screen.getByRole("listbox"), { key: "Escape" });

      fireEvent.click(screen.getByRole("checkbox", { name: "BPMN 2.0 (3)" })); // all were ticked: all are unticked
      expect(screen.getByText("No element of the chosen models can be referenced here. Choose more models above.")).toBeTruthy();
    });

    it("says so when no ticked model holds an element to reference", async () => {
      await openWithThreeModels();
      fireEvent.click(screen.getByRole("checkbox", { name: "Bestellabwicklung – current model" })); // untick the only ticked one
      expect(screen.getByText("No element of the chosen models can be referenced here. Choose more models above.")).toBeTruthy();
      expect(screen.queryByText("Select Referenced ClassInstance")).toBeNull();
    });
  });
});
