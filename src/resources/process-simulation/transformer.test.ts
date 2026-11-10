/**
 * Tests for transformer.ts. The main test is test model A of the OCPN Build Guide (draw
 * and decision); the others pin one rule each.
 *
 * Models and metamodels are plain objects in the shape of the gds classes, which is all
 * the transformer reads. The mapping is a small one of its own, with invented class names
 * ("Task", "XOR", ...), not the BPMN 2.0 mapping: it shows that the transformer knows no
 * modelling language. Every id is invented for the test (plan 3: no real uuids in code);
 * NAME_ATTRIBUTE_UUID is the client's own constant for the standard Name attribute.
 */
import { describe, expect, it } from "vitest";
import type { SceneInstance, SceneType } from "@gds";
import { NAME_ATTRIBUTE_UUID } from "@/constants";
import { transformModel } from "./transformer";
import type { LanguageMapping } from "./mappings";

// ---------------------------------------------------------------------------------
// A small metamodel: boxes, flows with a condition table, draws with a distribution table
// ---------------------------------------------------------------------------------

const column = (uuid: string, sequence: number) => ({ attribute: { uuid, name: uuid }, sequence }); // a table column as the metamodel defines it
const nameAttribute = { uuid: NAME_ATTRIBUTE_UUID, name: "Name", attribute_type: { has_table_attribute: [] } }; // the standard Name attribute, no table
const timeAttribute = { uuid: "m-time", name: "Time", attribute_type: { has_table_attribute: [] } }; // a task's execution time in seconds
const CONDITION = ["c-variable", "c-operator", "c-value", "c-logical"]; // the condition columns, in the order of the format rule
const DISTRIBUTION = ["d-value", "d-probability"]; // the distribution columns, in the order of the format rule

const BOX_CLASSES = ["Start", "Task", "XOR", "AND", "End", "Var", "Note", "Kink"]; // one metaclass per kind of box; "Note" and "Kink" are not mapped
const sceneType = {
  name: "Test language", // named in messages about the mapping
  classes: BOX_CLASSES.map((name) => ({ uuid: `m-${name}`, name, attributes: name === "Task" ? [nameAttribute, timeAttribute] : [nameAttribute] })), // e.g. { uuid: "m-Task", name: "Task" }; only a Task has a time
  relationclasses: [
    {
      uuid: "m-flow", // the line mapped to SequenceFlow
      name: "Flow",
      attributes: [nameAttribute, { uuid: "m-condition", name: "Condition", attribute_type: { has_table_attribute: CONDITION.map((id, i) => column(id, i + 1)) } }],
    },
    {
      uuid: "m-draw", // the line mapped to RandomGenerator
      name: "Draw",
      attributes: [nameAttribute, { uuid: "m-distribution", name: "Distribution", attribute_type: { has_table_attribute: DISTRIBUTION.map((id, i) => column(id, i + 1)) } }],
    },
  ],
} as unknown as SceneType; // only the fields the transformer reads

/** The mapping of the test language, by class name, as mappings.ts writes one. */
const MAPPING: LanguageMapping = {
  Start: { concept: "Start" },
  Task: { concept: "Activity", data: { ExecutionTime: "Time" } },
  XOR: { concept: "Decision" },
  AND: { concept: { split: "AND-Split", join: "AND-Join" } }, // the role follows from the incoming flows
  End: { concept: "End" },
  Var: { concept: "Variable", data: { VariableName: "Name" } },
  Flow: { concept: "SequenceFlow", data: { TransitionCondition: "Condition" } },
  Draw: { concept: "RandomGenerator", data: { Distribution: "Distribution" } },
};

// ---------------------------------------------------------------------------------
// Builders for model elements
// ---------------------------------------------------------------------------------

const name = (id: string, value: string) => ({ uuid: `${id}-name`, uuid_attribute: NAME_ATTRIBUTE_UUID, value, table_attributes: [] }); // an element's Name attribute instance

/** A table attribute instance holding `rows`. Its cells are stored in reverse, so the test proves the column order comes from the metamodel. */
const table = (uuid: string, uuidAttribute: string, columns: string[], rows: string[][]) => ({
  uuid, // the table's own uuid
  uuid_attribute: uuidAttribute, // its meta attribute, which lists the columns and which the mapping names
  value: "", // a table has no value of its own
  table_attributes: rows
    .flatMap((row, r) => row.map((value, c) => ({ uuid: `${uuid}-${r}-${c}`, uuid_attribute: columns[c], table_row: r, table_attribute_reference: uuid, value }))) // one cell per position
    .reverse(), // stored out of order on purpose
});

/** A box of metaclass `className` ("Task", "XOR", ...), with the text of its time attribute if `time` is given. */
const box = (id: string, className: string, label: string, time?: string) => ({
  uuid: id, // the element's uuid
  uuid_class: `m-${className}`, // its metaclass, which the mapping names
  attribute_instance: [name(id, label), ...(time === undefined ? [] : [{ uuid: `${id}-time`, uuid_attribute: "m-time", value: time, table_attributes: [] }])], // its Name, and its time if it has one
});

/** A line from `from` to `to`, with its tables. */
const line = (id: string, metaclass: string, from: string, to: string, tables: object[] = []) => ({
  uuid: id, // the line's uuid
  uuid_class: metaclass, // a relation instance carries its metaclass here too
  uuid_relationclass: metaclass, // and here
  attribute_instance: [name(id, "Name"), ...tables], // the default name MMAR gives new elements
  role_instance_from: { uuid_has_reference_class_instance: from }, // source end
  role_instance_to: { uuid_has_reference_class_instance: to }, // target end
});

const EMPTY_ROW = ["", "==", "", "-"]; // the row MMAR puts into every new condition table
const condition = (id: string, ...rows: string[][]) => table(`${id}-cond`, "m-condition", CONDITION, rows); // a flow's condition table
const flow = (id: string, from: string, to: string, ...rows: string[][]) => line(id, "m-flow", from, to, [condition(id, ...rows)]); // a flow with its condition table

/** Turns the variable cell of `row` in the condition table of `flowLine` into a reference to `variableId`, as the reference dialog does. */
const refer = (flowLine: ReturnType<typeof flow>, row: number, variableId: string) => {
  const cell = (flowLine.attribute_instance[1] as ReturnType<typeof table>).table_attributes.find((c) => c.table_row === row && c.uuid_attribute === "c-variable"); // the condition table follows the Name attribute
  Object.assign(cell!, { role_instance_from: { uuid_has_reference_class_instance: variableId } }); // the role instance that records the reference; the cell keeps its text
};

const scene = (classInstances: object[], relations: object[]) =>
  ({ uuid: "scene-1", class_instances: classInstances, relationclasses_instances: relations }) as unknown as SceneInstance; // only the fields the transformer reads

// ---------------------------------------------------------------------------------
// Test model A: draw and decision
// ---------------------------------------------------------------------------------

describe("transformModel: test model A (draw and decision)", () => {
  // Start → Check stock → lager? → End ja | End nein, with lager drawn at Check stock.
  const model = scene(
    [
      box("start", "Start", "Start"),
      box("check", "Task", "Check stock"),
      box("dec", "XOR", "lager?"),
      box("endja", "End", "End ja"),
      box("endnein", "End", "End nein"),
      box("lager", "Var", "lager"),
      box("kink", "Kink", ""), // a bendpoint: its class is not mapped, so it is skipped
    ],
    [
      flow("f1", "start", "check", EMPTY_ROW), // unconditional: only the default row
      flow("f2", "check", "dec", EMPTY_ROW), // unconditional
      flow("f3", "dec", "endja", ["lager", "==", "ja", "-"]), // lager = ja
      flow("f4", "dec", "endnein", ["lager", "==", "nein", "-"]), // lager = nein
      line("g", "m-draw", "check", "lager", [table("g-dist", "m-distribution", DISTRIBUTION, [["ja", "0,8"], ["nein", "0.2"], ["", ""]])]), // 80/20, with a comma and a dot
    ],
  );

  it("builds the expected graph", () => {
    expect(transformModel(sceneType, model, MAPPING)).toEqual({
      nodes: {
        start: { id: "start", label: "Start", concept: "Start", executionTime: 0, incoming: [], outgoing: ["f1"] },
        check: { id: "check", label: "Check stock", concept: "Activity", executionTime: 0, incoming: ["f1"], outgoing: ["f2"] },
        dec: { id: "dec", label: "lager?", concept: "Decision", executionTime: 0, incoming: ["f2"], outgoing: ["f3", "f4"] },
        endja: { id: "endja", label: "End ja", concept: "End", executionTime: 0, incoming: ["f3"], outgoing: [] },
        endnein: { id: "endnein", label: "End nein", concept: "End", executionTime: 0, incoming: ["f4"], outgoing: [] },
      },
      flows: {
        f1: { id: "f1", label: "Name", source: "start", target: "check", condition: [] }, // the default row is skipped
        f2: { id: "f2", label: "Name", source: "check", target: "dec", condition: [] },
        f3: { id: "f3", label: "Name", source: "dec", target: "endja", condition: [{ variableName: "lager", operator: "==", value: "ja", logicalOperator: null }] },
        f4: { id: "f4", label: "Name", source: "dec", target: "endnein", condition: [{ variableName: "lager", operator: "==", value: "nein", logicalOperator: null }] },
      },
      generators: {
        g: {
          id: "g", // the draw
          label: "Name", // its default name
          node: "check", // drawn at Check stock
          variable: "lager", // into lager
          distribution: [{ value: "ja", probability: 0.8 }, { value: "nein", probability: 0.2 }], // "0,8" read like "0.2"; the empty row skipped
        },
      },
      variables: { lager: { id: "lager", label: "lager", name: "lager" } },
      issues: [], // everything could be translated
    });
  });
});

// ---------------------------------------------------------------------------------
// One rule per test
// ---------------------------------------------------------------------------------

describe("transformModel: concepts from the classes", () => {
  it("skips elements of a class the mapping does not name", () => {
    const graph = transformModel(sceneType, scene([box("a", "Task", "A"), box("note", "Note", "Note")], [flow("f", "a", "note")]), MAPPING); // "Note" is not mapped
    expect(Object.keys(graph.nodes)).toEqual(["a"]); // spec 3: unmapped elements are ignored
    expect(graph.flows.f.target).toBe("note"); // the flow still names its end; the validator reports it (spec 10, check 1)
  });

  it("makes a split-or-join element a join where several sequence flows lead into it, a split otherwise", () => {
    const model = scene(
      [box("s", "Task", "S"), box("split", "AND", "Split"), box("a", "Task", "A"), box("b", "Task", "B"), box("join", "AND", "Join"), box("v", "Var", "v")],
      [
        flow("f0", "s", "split"), // one flow in: diverging
        flow("fa", "split", "a"),
        flow("fb", "split", "b"),
        flow("fa2", "a", "join"), // two flows in: converging
        flow("fb2", "b", "join"),
        line("g", "m-draw", "v", "split"), // a draw drawn towards the split is no sequence flow, so it does not count
      ],
    );
    const graph = transformModel(sceneType, model, MAPPING);
    expect(graph.nodes.split.concept).toBe("AND-Split");
    expect(graph.nodes.join.concept).toBe("AND-Join");
  });

  it("reports a class or an attribute the mapping names but the metamodel lacks, once and on no element", () => {
    const mapping: LanguageMapping = { ...MAPPING, Gateway: { concept: "Decision" }, Flow: { concept: "SequenceFlow", data: { TransitionCondition: "Guard" } } }; // a class and an attribute that do not exist
    const graph = transformModel(sceneType, scene([], [flow("f1", "a", "b"), flow("f2", "a", "b")]), mapping); // two flows, still one message
    expect(graph.issues).toEqual([
      { elementId: null, message: 'The simulation mapping names the attribute "Guard" of "Flow" as its TransitionCondition, but the class has no such attribute.' },
      { elementId: null, message: 'The simulation mapping names the class "Gateway", which the metamodel "Test language" does not have.' },
    ]);
    expect(graph.flows.f1.condition).toBeNull(); // read as not mapped; the validator adds check 3 where it matters
  });
});

describe("transformModel: data", () => {
  it("reads a task's execution time in whole seconds: empty is 0, anything else unreadable is null", () => {
    const model = scene([box("a", "Task", "A", "30"), box("b", "Task", "B", ""), box("c", "Task", "C"), box("d", "Task", "D", "2.5"), box("e", "Task", "E", "-3")], []);
    const times = Object.fromEntries(Object.values(transformModel(sceneType, model, MAPPING).nodes).map((node) => [node.id, node.executionTime]));
    expect(times).toEqual({ a: 30, b: 0, c: 0, d: null, e: null }); // c has no instance of the attribute; d and e are reported by check 27
  });

  it("gives a concept that takes no time 0, whatever its class holds", () => {
    const mapping: LanguageMapping = { ...MAPPING, Task: { concept: "Decision", data: { ExecutionTime: "Time" } } }; // a time named on a routing concept by mistake
    const graph = transformModel(sceneType, scene([box("t", "Task", "T", "30")], []), mapping);
    expect(graph.nodes.t.executionTime).toBe(0); // routing takes no time (spec 2.2)
  });

  it("gives a flow the condition null when the mapping names no condition attribute", () => {
    const mapping: LanguageMapping = { ...MAPPING, Flow: { concept: "SequenceFlow" } }; // no TransitionCondition named
    const graph = transformModel(sceneType, scene([box("a", "Task", "A"), box("b", "Task", "B")], [flow("f", "a", "b", ["x", "==", "1", "-"])]), mapping);
    expect(graph.flows.f.condition).toBeNull(); // null, not []: the validator can tell "not mapped" from "no condition"
  });

  it("reads a missing instance of the condition table as an empty table", () => {
    const graph = transformModel(sceneType, scene([], [line("f", "m-flow", "a", "b")]), MAPPING); // a flow drawn before the table was added to the metamodel
    expect(graph.flows.f.condition).toEqual([]); // no condition: always taken
  });

  it("keeps a half-filled row, and the logical operators after the first row", () => {
    const rows = [["lager", "==", "ja", "-"], ["kunde", "==", "", "AND"]]; // the second row lacks its value
    const graph = transformModel(sceneType, scene([], [flow("f", "a", "b", ...rows)]), MAPPING);
    expect(graph.flows.f.condition).toEqual([
      { variableName: "lager", operator: "==", value: "ja", logicalOperator: null }, // the first row's "-" means nothing
      { variableName: "kunde", operator: "==", value: "", logicalOperator: "AND" }, // kept, so the validator can report it (spec 10, check 17)
    ]);
  });

  it("reports a condition attribute that is not a table of the format rule", () => {
    const mapping: LanguageMapping = { ...MAPPING, Flow: { concept: "SequenceFlow", data: { TransitionCondition: "Name" } } }; // the Name attribute named by mistake
    const graph = transformModel(sceneType, scene([], [flow("f", "a", "b")]), mapping);
    expect(graph.flows.f.condition).toBeNull(); // unreadable
    expect(graph.issues[0].message).toContain("must be a table with the columns variable, operator, value, logical operator"); // says what is expected
  });

  it("reads a variable's name from its mapped attribute, and null when the mapping names none", () => {
    const withName = transformModel(sceneType, scene([box("v", "Var", "  lager  ")], []), MAPPING); // a name with spaces around it
    expect(withName.variables.v.name).toBe("lager"); // trimmed, so " lager" in a condition is not a different variable
    const withoutName = transformModel(sceneType, scene([box("v", "Var", "lager")], []), { ...MAPPING, Var: { concept: "Variable" } });
    expect(withoutName.variables.v.name).toBeNull(); // spec 10, check 3 reports it
  });

  it("reads a reference cell as the current name of the variable it points at", () => {
    const f = flow("f", "a", "b", ["Lager", "==", "ja", "-"], ["kunde", "==", "premium", "AND"]); // row 0 picked when the variable was still called "Lager"; row 1 typed
    refer(f, 0, "v"); // row 0's variable cell is a reference to v
    const graph = transformModel(sceneType, scene([box("v", "Var", "lager")], [f]), MAPPING); // v has been renamed to "lager" since
    expect(graph.flows.f.condition?.map((row) => row.variableName)).toEqual(["lager", "kunde"]); // the current name, not the stale "Lager"; typed text as before
    expect(graph.issues).toEqual([]); // nothing to report
  });

  it("reports a reference cell that points at an element of another model", () => {
    const f = flow("f", "a", "b", ["lager", "==", "ja", "-"]); // picked from the variables of another model
    refer(f, 0, "elsewhere"); // an element this model does not contain
    const graph = transformModel(sceneType, scene([], [f]), MAPPING);
    expect(graph.flows.f.condition?.[0].variableName).toBe("lager"); // the stored text is kept
    expect(graph.issues).toEqual([{ elementId: "f", message: 'A row of the TransitionCondition of "Name" refers to "lager", which belongs to another model.' }]); // reported on the flow (spec 10, check 2)
  });
});

describe("transformModel: elements that cannot carry their concept", () => {
  it("finds node and variable of a draw by their concepts, in either direction", () => {
    const reversed = line("g", "m-draw", "lager", "check"); // drawn from the variable to the node, without a distribution table
    const graph = transformModel(sceneType, scene([box("check", "Task", "Check"), box("lager", "Var", "lager")], [reversed]), MAPPING);
    expect(graph.generators.g).toMatchObject({ node: "check", variable: "lager", distribution: [] }); // direction does not matter; a missing table reads as empty
    expect(graph.issues).toEqual([]); // nothing to report
  });

  it("reports a draw that is not a line between a node and a variable", () => {
    const mapping: LanguageMapping = { ...MAPPING, Note: { concept: "RandomGenerator" } }; // a generator drawn as a box
    const graph = transformModel(sceneType, scene([box("a", "Task", "A"), box("b", "Task", "B"), box("box", "Note", "Generator box")], [line("g", "m-draw", "a", "b")]), mapping);
    expect(graph.generators.g).toMatchObject({ node: "a", variable: null }); // no end is a variable
    expect(graph.generators.box).toMatchObject({ node: null, variable: null }); // a box has no ends
    expect(graph.issues.map((issue) => issue.elementId).sort()).toEqual(["box", "g"]); // both reported (spec 10, check 2)
  });

  it("reports a line mapped to a node concept and leaves it out", () => {
    const mapping: LanguageMapping = { ...MAPPING, Flow: { concept: "Activity" } }; // flows mapped as activities
    const graph = transformModel(sceneType, scene([], [flow("f", "a", "b")]), mapping);
    expect(graph.nodes).toEqual({}); // a line cannot be executed
    expect(graph.issues).toHaveLength(1); // spec 10, check 2
  });
});
