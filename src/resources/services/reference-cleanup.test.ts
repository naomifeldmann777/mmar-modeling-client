import { describe, it, expect, beforeEach, vi } from "vitest";
import { SceneInstance } from "@gds";

const mocks = vi.hoisted(() => ({
  globalObject: { tabContext: [] as unknown[], selectedTab: 0 },
  expressionUtility: { checkForVisualizationUpdateByAttributeUUID: vi.fn(async () => {}) },
}));

vi.mock("@/engine/global-definition", () => ({ globalObject: mocks.globalObject }));
vi.mock("./expression-utility", () => ({ expressionUtility: mocks.expressionUtility }));

import { referencedTargets, removeReferencesDroppedBySave, removeReferencesTo } from "./reference-cleanup";

const role = (target: string) => ({ uuid: `role-${target}`, uuid_has_reference_class_instance: target });

const referenceCell = (table: string, row: number, target: string) => ({
  uuid: `cell-${table}-${row}`,
  uuid_attribute: "column-reference",
  table_attribute_reference: table,
  table_row: row,
  value: `name of ${target}`,
  role_instance_from: role(target),
});

const noteCell = (table: string, row: number, value: string) => ({
  uuid: `note-${table}-${row}`,
  uuid_attribute: "column-note",
  table_attribute_reference: table,
  table_row: row,
  value,
});

function sceneWith(attributes: object[]): SceneInstance {
  return SceneInstance.fromJS({
    uuid: "flow",
    name: "Flow",
    uuid_scene_type: "scene-type",
    class_instances: [{ uuid: "task", uuid_class: "task-class", attribute_instance: attributes }],
    relationclasses_instances: [],
    role_instances: [],
    attribute_instances: [],
    port_instances: [],
  }) as SceneInstance;
}

const tableOf = (scene: SceneInstance) => scene.class_instances[0].attribute_instance[0];
const openTabs = (...scenes: SceneInstance[]) => {
  mocks.globalObject.tabContext = scenes.map((sceneInstance) => ({ sceneInstance }));
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.globalObject.selectedTab = 0;
  mocks.globalObject.tabContext = [];
});

describe("removeReferencesTo", () => {
  it("removes a table row that held nothing else, and moves the rows below it up", async () => {
    const scene = sceneWith([
      {
        uuid: "table",
        table_attributes: [
          referenceCell("table", 0, "kept-1"),
          referenceCell("table", 1, "gone"),
          referenceCell("table", 2, "kept-2"),
        ],
      },
    ]);
    openTabs(scene);

    await removeReferencesTo(["gone"]);

    expect(tableOf(scene).table_attributes.map((cell) => [cell.table_row, cell.value])).toEqual([
      [0, "name of kept-1"],
      [1, "name of kept-2"],
    ]);
  });

  it("keeps a row that holds something else, and clears the reference in it", async () => {
    const scene = sceneWith([
      { uuid: "table", table_attributes: [referenceCell("table", 0, "gone"), noteCell("table", 0, "a note")] },
    ]);
    openTabs(scene);

    await removeReferencesTo(["gone"]);

    const [reference, note] = tableOf(scene).table_attributes;
    expect(reference.value).toBe("");
    expect(reference.role_instance_from).toBeNull();
    expect(note.value).toBe("a note");
  });

  it("reaches every open tab, not just the one the delete happened in", async () => {
    const hierarchy = sceneWith([]);
    const flow = sceneWith([{ uuid: "table", table_attributes: [referenceCell("table", 0, "gone")] }]);
    openTabs(hierarchy, flow);

    await removeReferencesTo(["gone"]);

    expect(tableOf(flow).table_attributes).toEqual([]);
  });

  it("removes a reference from a table nested in a table", async () => {
    const nested = {
      uuid: "details",
      uuid_attribute: "column-details",
      table_attribute_reference: "table",
      table_row: 0,
      value: "",
      table_attributes: [referenceCell("details", 0, "gone")],
    };
    const scene = sceneWith([{ uuid: "table", table_attributes: [nested, noteCell("table", 0, "a note")] }]);
    openTabs(scene);

    await removeReferencesTo(["gone"]);

    expect(tableOf(scene).table_attributes[0].table_attributes).toEqual([]);
    expect(referencedTargets(scene).size).toBe(0);
  });

  it("clears a reference outside a table, and redraws it on the active tab", async () => {
    const attribute = {
      uuid: "plain",
      uuid_attribute: "meta-plain",
      assigned_uuid_class_instance: "task",
      value: "name of gone",
      role_instance_from: role("gone"),
    };
    const scene = sceneWith([attribute]);
    openTabs(scene);

    await removeReferencesTo(["gone"]);

    expect(tableOf(scene).value).toBe("");
    expect(tableOf(scene).role_instance_from).toBeNull();
    expect(mocks.expressionUtility.checkForVisualizationUpdateByAttributeUUID).toHaveBeenCalledWith(
      "task",
      "meta-plain",
    );
  });

  it("leaves references to anything else alone", async () => {
    const scene = sceneWith([{ uuid: "table", table_attributes: [referenceCell("table", 0, "kept")] }]);
    openTabs(scene);

    await removeReferencesTo(["gone"]);

    expect(referencedTargets(scene)).toEqual(new Set(["kept"]));
  });
});

describe("removeReferencesDroppedBySave", () => {
  it("removes what the server left out of its answer, and nothing else", async () => {
    const cells = [referenceCell("table", 0, "gone"), referenceCell("table", 1, "kept")];
    const scene = sceneWith([{ uuid: "table", table_attributes: cells }]);
    openTabs(scene);
    const sent = referencedTargets(scene);
    const saved = sceneWith([{ uuid: "table", table_attributes: [referenceCell("table", 0, "kept")] }]);

    await removeReferencesDroppedBySave(sent, saved);

    expect(referencedTargets(scene)).toEqual(new Set(["kept"]));
  });
});
