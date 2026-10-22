/**
 * Tests for mapping.ts: changing a mapping, fitting it to the model, export and import
 * as text, and keeping it in browser storage.
 *
 * Runs in the node environment: mapping.ts uses no DOM and no engine, so nothing has
 * to be mocked. Every id here is invented for the test (plan 3: no real uuids in code).
 */
import { describe, expect, it } from "vitest";
import {
  createEmptyMapping,
  loadMapping,
  readMapping,
  saveMapping,
  setElementConcept,
  setElementData,
  storageKey,
  validateMapping,
  writeMapping,
  type MappableModel,
  type MappingStorage,
  type ProcessSimulationMapping,
} from "./mapping";

// A small model: a Start, a Task, a flow with a condition table, a draw and a variable.
const model: MappableModel = {
  sceneInstanceId: "scene-1", // the model every mapping in these tests belongs to
  elementAttributes: {
    "i-start": ["a-start-name"], // only a name, like every class of the test metamodel
    "i-task": ["a-task-name"], // a node that can carry no data
    "i-flow": ["a-flow-name", "a-flow-condition"], // a sequence flow with its condition table
    "i-gen": ["a-gen-name", "a-gen-distribution"], // a relation that draws, with its distribution table
    "i-var": ["a-var-name"], // a variable, whose name attribute holds its VariableName
  },
};

/** An in-memory stand-in for localStorage, so the tests need no browser. */
function memoryStorage(): MappingStorage & { items: Map<string, string> } {
  const items = new Map<string, string>(); // exposed so a test can look at what was written
  return {
    items, // the raw entries
    getItem: (key) => items.get(key) ?? null, // null for a missing key, like the real Storage API
    setItem: (key, value) => void items.set(key, value), // void: setItem returns nothing
  };
}

/** A storage that throws on every call, like localStorage in a blocked private window. */
const brokenStorage: MappingStorage = {
  getItem: () => {
    throw new Error("blocked"); // what browsers do when storage is disabled
  },
  setItem: () => {
    throw new Error("quota exceeded"); // what browsers do when storage is full
  },
};

/** A mapping with one flow and its condition, used by several tests. */
function mappedFlow(): ProcessSimulationMapping {
  const withConcept = setElementConcept(createEmptyMapping("scene-1"), "i-flow", "SequenceFlow"); // a flow first needs its concept
  return setElementData(withConcept, "i-flow", "TransitionCondition", "a-flow-condition"); // then the attribute holding its condition
}

describe("createEmptyMapping", () => {
  it("maps no element, so the simulation ignores them all", () => {
    expect(createEmptyMapping("scene-1")).toEqual({ sceneInstanceId: "scene-1", elements: {} }); // spec 3: unmapped means ignored
  });
});

describe("setElementConcept", () => {
  it("gives an element its concept without touching the old mapping", () => {
    const before = createEmptyMapping("scene-1"); // kept to check it is not modified
    const after = setElementConcept(before, "i-task", "Activity"); // the change under test
    expect(after.elements["i-task"]).toEqual({ concept: "Activity" }); // the concept is set, with no empty data
    expect(before.elements).toEqual({}); // a store relies on the old object staying as it was
  });

  it("unmaps an element with undefined", () => {
    const mapped = setElementConcept(createEmptyMapping("scene-1"), "i-task", "Activity"); // start from a mapped element
    expect(setElementConcept(mapped, "i-task", undefined).elements).toEqual({}); // absent, not a placeholder
  });

  it("drops data that does not belong to the new concept", () => {
    const changed = setElementConcept(mappedFlow(), "i-flow", "Activity"); // a condition means nothing on an Activity (spec 2.2)
    expect(changed.elements["i-flow"]).toEqual({ concept: "Activity" }); // the condition attribute is gone
  });

  it("keeps data that still belongs to the concept", () => {
    const same = setElementConcept(mappedFlow(), "i-flow", "SequenceFlow"); // choosing the same concept again
    expect(same.elements["i-flow"].data).toEqual({ TransitionCondition: "a-flow-condition" }); // the choice survives
  });
});

describe("setElementData", () => {
  it("records which attribute holds the data concept", () => {
    expect(mappedFlow().elements["i-flow"]).toEqual({
      concept: "SequenceFlow", // the element concept
      data: { TransitionCondition: "a-flow-condition" }, // the attribute instance of this flow (decided in Phase 3)
    });
  });

  it("clears the choice with undefined", () => {
    const cleared = setElementData(mappedFlow(), "i-flow", "TransitionCondition", undefined); // the user unselects it
    expect(cleared.elements["i-flow"]).toEqual({ concept: "SequenceFlow" }); // no empty data object is left behind
  });

  it("ignores a data concept that belongs to another concept", () => {
    const task = setElementConcept(createEmptyMapping("scene-1"), "i-task", "Activity"); // an Activity carries no data
    expect(setElementData(task, "i-task", "Distribution", "a-task-name")).toBe(task); // unchanged, the very same object
  });

  it("ignores an element without a concept", () => {
    const empty = createEmptyMapping("scene-1"); // nothing mapped yet
    expect(setElementData(empty, "i-flow", "TransitionCondition", "a-flow-condition")).toBe(empty); // data needs a concept first
  });
});

describe("validateMapping", () => {
  it("keeps everything that fits the model", () => {
    const { mapping, dropped } = validateMapping(mappedFlow(), model); // a correct mapping
    expect(mapping).toEqual(mappedFlow()); // nothing removed
    expect(dropped).toEqual([]); // nothing reported
  });

  it("drops elements that no longer exist and reports them", () => {
    const stale = setElementConcept(createEmptyMapping("scene-1"), "i-deleted", "Activity"); // an element deleted after mapping
    const { mapping, dropped } = validateMapping(stale, model); // checked against the current model
    expect(mapping.elements).toEqual({}); // the entry is gone
    expect(dropped).toEqual([{ elementId: "i-deleted", reason: "The element no longer exists in the model." }]); // and reported
  });

  it("keeps the concept but drops an attribute the element no longer has", () => {
    const stale = setElementData(mappedFlow(), "i-flow", "TransitionCondition", "a-deleted"); // attribute deleted after mapping
    const { mapping, dropped } = validateMapping(stale, model); // checked against the current model
    expect(mapping.elements["i-flow"]).toEqual({ concept: "SequenceFlow" }); // the concept is still useful
    expect(dropped).toHaveLength(1); // the lost attribute is reported
    expect(dropped[0].elementId).toBe("i-flow"); // against the element it belonged to
  });

  it("drops an attribute of another element", () => {
    const foreign = setElementData(mappedFlow(), "i-flow", "TransitionCondition", "a-gen-distribution"); // exists, but on i-gen
    expect(validateMapping(foreign, model).mapping.elements["i-flow"].data).toBeUndefined(); // only own attributes count
  });
});

describe("writeMapping and readMapping", () => {
  it("read gives back what write produced", () => {
    const text = writeMapping(mappedFlow()); // an export
    expect(readMapping(text, model)).toEqual({ ok: true, mapping: mappedFlow(), dropped: [] }); // a lossless import
  });

  it("writes only the fields of the format", () => {
    const withExtra = { ...mappedFlow(), extra: "not part of the format" }; // something else on the object
    expect(Object.keys(JSON.parse(writeMapping(withExtra)))).toEqual(["sceneInstanceId", "elements"]); // nothing leaks out
  });

  it("refuses text that is not JSON", () => {
    expect(readMapping("not json", model).ok).toBe(false); // e.g. a picture picked by mistake
  });

  it("refuses JSON without the shape of a mapping", () => {
    expect(readMapping(JSON.stringify({ uuid: "scene-1", class_instances: [] }), model).ok).toBe(false); // e.g. an exported model
    expect(readMapping("[]", model).ok).toBe(false); // arrays are JSON objects too, but not a mapping
  });

  it("refuses a mapping of another model", () => {
    const other = writeMapping({ ...mappedFlow(), sceneInstanceId: "scene-2" }); // exported from another model
    expect(readMapping(other, model)).toEqual({ ok: false, reason: "The mapping belongs to another model." }); // none of it would fit
  });

  it("drops unknown concepts and misplaced data, and reports each", () => {
    const text = JSON.stringify({
      sceneInstanceId: "scene-1", // the right model
      elements: {
        "i-task": { concept: "Task" }, // a BPMN name, not a simulation concept
        "i-gen": { concept: "RandomGenerator", data: { TransitionCondition: "a-gen-distribution" } }, // data of another concept
        "i-var": { concept: "Variable", data: { Colour: "a-var-name" } }, // not a data concept at all
      },
    });
    const result = readMapping(text, model); // the import under test
    expect(result.ok).toBe(true); // the file as a whole is usable
    if (!result.ok) return; // narrows the type for the lines below
    expect(result.mapping.elements).toEqual({ "i-gen": { concept: "RandomGenerator" }, "i-var": { concept: "Variable" } }); // the Task is unmapped
    expect(result.dropped.map((entry) => entry.elementId)).toEqual(["i-task", "i-gen", "i-var"]); // one report per problem
  });

  it("does not let a __proto__ key reach the prototype", () => {
    const text = '{"sceneInstanceId":"scene-1","elements":{"__proto__":{"concept":"Activity"}}}'; // a hand-made hostile file
    const result = readMapping(text, model); // the import under test
    expect(result.ok && Object.getPrototypeOf(result.mapping.elements)).toBe(Object.prototype); // the prototype is untouched
    expect(result.ok && result.dropped[0].elementId).toBe("__proto__"); // and the key is reported as an unknown element
  });
});

describe("saveMapping and loadMapping", () => {
  it("keeps one entry per model under its own key", () => {
    const storage = memoryStorage(); // a fresh, empty storage
    expect(saveMapping(mappedFlow(), storage)).toBe(true); // the save succeeds
    expect([...storage.items.keys()]).toEqual([storageKey("scene-1")]); // under the model's key
    expect(storageKey("scene-1")).toBe("process-simulation-mapping:scene-1"); // in the process-simulation namespace
  });

  it("loads what was saved", () => {
    const storage = memoryStorage(); // a fresh, empty storage
    saveMapping(mappedFlow(), storage); // a mapping from an earlier visit
    expect(loadMapping(model, storage)).toEqual({ ok: true, mapping: mappedFlow(), dropped: [] }); // comes back unchanged
  });

  it("starts with an empty mapping when nothing is stored", () => {
    expect(loadMapping(model, memoryStorage())).toEqual({ ok: true, mapping: createEmptyMapping("scene-1"), dropped: [] }); // first visit
  });

  it("discards a stored entry it cannot read", () => {
    const storage = memoryStorage(); // a fresh storage
    storage.setItem(storageKey("scene-1"), '{"version":1}'); // e.g. an older format
    expect(loadMapping(model, storage).ok).toBe(false); // discarded whole (decided in Phase 3)
  });

  it("reports a broken storage instead of throwing", () => {
    expect(saveMapping(mappedFlow(), brokenStorage)).toBe(false); // the caller tells the user the mapping will not survive a reload
    expect(loadMapping(model, brokenStorage).ok).toBe(false); // the caller starts with an empty mapping
  });
});
