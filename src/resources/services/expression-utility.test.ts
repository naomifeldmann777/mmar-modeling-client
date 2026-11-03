// P3 unit tests for expression-utility (plan §7: "expression utility against
// fixture instances"). This transitively exercises instance-utility's lookups too.
//
// global-definition is faked (see snapshot-service.test.ts for why); the gds
// instances are REAL and revived via fromJS, which is the whole point — the
// modeling client's expression helpers branch on `instanceof ClassInstance /
// RelationclassInstance`, so the fixtures must carry real class identity.
import { describe, it, expect, beforeEach, vi } from "vitest";
import { SceneInstance, ClassInstance, RelationclassInstance } from "@gds";

const mocks = vi.hoisted(() => ({
  globalObject: {} as any,
  loadAllSceneInstances: vi.fn(async () => undefined),
}));

vi.mock("@/engine/global-definition", () => ({ globalObject: mocks.globalObject }));
vi.mock("./scene-tree-service", () => ({ loadAllSceneInstances: mocks.loadAllSceneInstances }));

import { expressionUtility } from "./expression-utility";
import { useLogStore } from "@/resources/store/logStore";

// A tiny model: class A --R--> class B, where A carries a "label" attribute.
function buildSceneInstance(): SceneInstance {
  return SceneInstance.fromJS({
    uuid: "scene-1",
    name: "Demo Scene",
    uuid_scene_type: "st-1",
    class_instances: [
      {
        uuid: "A",
        uuid_class: "metaA",
        attribute_instance: [
          { uuid: "ai-A", uuid_attribute: "attr-1", name: "label", value: "hello" },
        ],
        port_instance: [],
      },
      { uuid: "B", uuid_class: "metaB", attribute_instance: [], port_instance: [] },
    ],
    relationclasses_instances: [
      {
        uuid: "R",
        uuid_relationclass: "metaR",
        attribute_instance: [],
        port_instance: [],
        line_points: [],
        role_instance_from: { uuid: "rf", uuid_has_reference_class_instance: "A" },
        role_instance_to: { uuid: "rt", uuid_has_reference_class_instance: "B" },
      },
    ],
    role_instances: [],
    attribute_instances: [],
    port_instances: [],
  }) as SceneInstance;
}

beforeEach(() => {
  const sceneInstance = buildSceneInstance();
  Object.assign(mocks.globalObject, {
    selectedTab: 0,
    tabContext: [
      {
        sceneType: {},
        sceneInstance,
        threeScene: {},
        contextDragObjects: [],
        isShared: false,
      },
    ],
    // getAllSceneInstancesFromLocal walks sceneTree -> children.
    sceneTree: [{ children: [sceneInstance] }],
    current_class_instance: sceneInstance.class_instances[0], // A
    current_port_instance: undefined,
    readyForVizRepUpdate: true,
  });
});

describe("ExpressionUtility — vizrep helper API over fixture instances", () => {
  it("getClassInstancesByMetaUUID filters by meta class (instanceof ClassInstance)", async () => {
    const result = await expressionUtility.getClassInstancesByMetaUUID("metaA");
    expect(result).toHaveLength(1);
    expect(result[0].uuid).toBe("A");
    expect(result[0]).toBeInstanceOf(ClassInstance);
  });

  it("getClassInstancesByMetaUUID matches relation classes by uuid_relationclass", async () => {
    const result = await expressionUtility.getClassInstancesByMetaUUID("metaR");
    expect(result).toHaveLength(1);
    expect(result[0].uuid).toBe("R");
    expect(result[0]).toBeInstanceOf(RelationclassInstance);
  });

  it("attrval reads the attribute value from the current class instance", async () => {
    expect(await expressionUtility.attrval("attr-1")).toBe("hello");
    expect(await expressionUtility.attrvalByName("label")).toBe("hello");
  });

  it("getSource/DestinationByRelInstanceUUID resolve the relation endpoints", async () => {
    const source = await expressionUtility.getSourceByRelInstanceUUID("R");
    const destination = await expressionUtility.getDestinationByRelInstanceUUID("R");
    expect(source).toBeInstanceOf(ClassInstance);
    expect(source!.uuid).toBe("A");
    expect(destination).toBeInstanceOf(ClassInstance);
    expect(destination!.uuid).toBe("B");
  });

  it("getIncoming/OutgoingRelationsByInstanceUUID walk the role instances", async () => {
    const outgoingA = await expressionUtility.getOutgoingRelationsByInstanceUUID("A");
    const incomingB = await expressionUtility.getIncomingRelationsByInstanceUUID("B");
    expect(outgoingA).toHaveLength(1);
    expect(outgoingA[0].uuid).toBe("R");
    expect(incomingB).toHaveLength(1);
    expect(incomingB[0].uuid).toBe("R");
    // A is a source but not a destination -> not "connected" (needs both).
    expect(await expressionUtility.isConnected("A")).toBe(false);
  });
});

describe("ExpressionUtility — calls for procedures", () => {
  it("log writes to the log window, defaulting to an info line", () => {
    useLogStore.setState({ logArray: [] });
    expressionUtility.log("Project length: 12 days");
    expressionUtility.log("Unsatisfiable", "error");

    const [newest, oldest] = useLogStore.getState().logArray;
    expect(oldest).toMatchObject({ value: "Project length: 12 days", status: "info" });
    expect(newest).toMatchObject({ value: "Unsatisfiable", status: "error" });
  });

  it("loadAllSceneInstances fills the local tree on demand", async () => {
    await expressionUtility.loadAllSceneInstances();
    expect(mocks.loadAllSceneInstances).toHaveBeenCalledTimes(1);
  });

  it("getInstanceByUUID reaches an instance with no relations, class included", async () => {
    const lonely = await expressionUtility.getInstanceByUUID("B");
    expect(lonely).toBeInstanceOf(ClassInstance);
    expect((lonely as ClassInstance).uuid_class).toBe("metaB");
  });

  it("getInstanceByUUID finds nothing for an unknown uuid", async () => {
    expect(await expressionUtility.getInstanceByUUID("gone")).toBeNull();
  });
});
