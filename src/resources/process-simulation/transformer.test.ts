/**
 * Tests for transformer.ts. The main test is test model A of the OCPN Build Guide (draw
 * and decision), built the way it is drawn with the BPMN 2.0 metamodel; the others pin
 * one rule each.
 *
 * Models and metamodels are plain objects in the shape of the gds classes, which is all
 * the transformer reads. Every id is invented for the test (plan 3: no real uuids in
 * code); NAME_ATTRIBUTE_UUID is the client's own constant for the standard Name attribute.
 */
import { describe, expect, it } from "vitest";
import type { SceneInstance, SceneType } from "@gds";
import { NAME_ATTRIBUTE_UUID } from "@/constants";
import { parseDecimal, transformModel } from "./transformer";
import type { ProcessSimulationMapping } from "./mapping";

// ---------------------------------------------------------------------------------
// A small metamodel: boxes, flows with a condition table, draws with a distribution table
// ---------------------------------------------------------------------------------

const column = (uuid: string, sequence: number) => ({ attribute: { uuid, name: uuid }, sequence }); // a table column as the metamodel defines it
const nameAttribute = { uuid: NAME_ATTRIBUTE_UUID, name: "Name", attribute_type: { has_table_attribute: [] } }; // the standard Name attribute, no table
const CONDITION = ["c-variable", "c-operator", "c-value", "c-logical"]; // the condition columns, in the order of the format rule
const DISTRIBUTION = ["d-value", "d-probability"]; // the distribution columns, in the order of the format rule

const sceneType = {
  classes: [{ uuid: "m-box", name: "Box", attributes: [nameAttribute] }], // every node and variable is a "Box"; the mapping decides what it is
  relationclasses: [
    {
      uuid: "m-flow", // the line that is mapped to SequenceFlow
      name: "Flow", // never read by the transformer
      attributes: [nameAttribute, { uuid: "m-condition", name: "Condition", attribute_type: { has_table_attribute: CONDITION.map((id, i) => column(id, i + 1)) } }],
    },
    {
      uuid: "m-draw", // the line that is mapped to RandomGenerator
      name: "Draw", // never read by the transformer
      attributes: [nameAttribute, { uuid: "m-distribution", name: "Distribution", attribute_type: { has_table_attribute: DISTRIBUTION.map((id, i) => column(id, i + 1)) } }],
    },
  ],
} as unknown as SceneType; // only the fields the transformer reads

// ---------------------------------------------------------------------------------
// Builders for model elements
// ---------------------------------------------------------------------------------

const name = (id: string, value: string) => ({ uuid: `${id}-name`, uuid_attribute: NAME_ATTRIBUTE_UUID, value, table_attributes: [] }); // an element's Name attribute instance

/** A table attribute instance holding `rows`. Its cells are stored in reverse, so the test proves the column order comes from the metamodel. */
const table = (uuid: string, uuidAttribute: string, columns: string[], rows: string[][]) => ({
  uuid, // the table's own uuid, which the mapping refers to
  uuid_attribute: uuidAttribute, // its meta attribute, which lists the columns
  value: "", // a table has no value of its own
  table_attributes: rows
    .flatMap((row, r) => row.map((value, c) => ({ uuid: `${uuid}-${r}-${c}`, uuid_attribute: columns[c], table_row: r, table_attribute_reference: uuid, value }))) // one cell per position
    .reverse(), // stored out of order on purpose
});

const box = (id: string, label: string) => ({ uuid: id, uuid_class: "m-box", attribute_instance: [name(id, label)] }); // a node or variable

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

const scene = (classInstances: object[], relations: object[]) =>
  ({ uuid: "scene-1", class_instances: classInstances, relationclasses_instances: relations }) as unknown as SceneInstance; // only the fields the transformer reads

const mapped = (elements: ProcessSimulationMapping["elements"]): ProcessSimulationMapping => ({ sceneInstanceId: "scene-1", elements }); // a mapping of scene-1

// ---------------------------------------------------------------------------------
// Test model A: draw and decision
// ---------------------------------------------------------------------------------

describe("transformModel: test model A (draw and decision)", () => {
  // Start → Check stock → lager? → End ja | End nein, with lager drawn at Check stock.
  const model = scene(
    [box("start", "Start"), box("check", "Check stock"), box("dec", "lager?"), box("endja", "End ja"), box("endnein", "End nein"), box("lager", "lager")],
    [
      flow("f1", "start", "check", EMPTY_ROW), // unconditional: only the default row
      flow("f2", "check", "dec", EMPTY_ROW), // unconditional
      flow("f3", "dec", "endja", ["lager", "==", "ja", "-"]), // lager = ja
      flow("f4", "dec", "endnein", ["lager", "==", "nein", "-"]), // lager = nein
      line("g", "m-draw", "check", "lager", [table("g-dist", "m-distribution", DISTRIBUTION, [["ja", "0,8"], ["nein", "0.2"], ["", ""]])]), // 80/20, with a comma and a dot
    ],
  );
  const cond = (id: string) => ({ concept: "SequenceFlow" as const, data: { TransitionCondition: `${id}-cond` } }); // a flow with its condition mapped
  const mapping = mapped({
    start: { concept: "Start" },
    check: { concept: "Activity" },
    dec: { concept: "Decision" },
    endja: { concept: "End" },
    endnein: { concept: "End" },
    f1: cond("f1"),
    f2: cond("f2"),
    f3: cond("f3"),
    f4: cond("f4"),
    g: { concept: "RandomGenerator", data: { Distribution: "g-dist" } },
    lager: { concept: "Variable", data: { VariableName: "lager-name" } },
  });

  it("builds the expected graph", () => {
    expect(transformModel(sceneType, model, mapping)).toEqual({
      nodes: {
        start: { id: "start", label: "Start", concept: "Start", incoming: [], outgoing: ["f1"] },
        check: { id: "check", label: "Check stock", concept: "Activity", incoming: ["f1"], outgoing: ["f2"] },
        dec: { id: "dec", label: "lager?", concept: "Decision", incoming: ["f2"], outgoing: ["f3", "f4"] },
        endja: { id: "endja", label: "End ja", concept: "End", incoming: ["f3"], outgoing: [] },
        endnein: { id: "endnein", label: "End nein", concept: "End", incoming: ["f4"], outgoing: [] },
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

describe("transformModel: rules", () => {
  it("skips elements without a concept", () => {
    const graph = transformModel(sceneType, scene([box("a", "A"), box("note", "Note")], [flow("f", "a", "note")]), mapped({ a: { concept: "Activity" }, f: { concept: "SequenceFlow" } })); // the note is unmapped
    expect(Object.keys(graph.nodes)).toEqual(["a"]); // spec 3: unmapped elements are ignored
    expect(graph.flows.f.target).toBe("note"); // the flow still names its end; the validator reports it (spec 10, check 1)
  });

  it("gives a flow without a mapped condition attribute the condition null", () => {
    const graph = transformModel(sceneType, scene([box("a", "A"), box("b", "B")], [flow("f", "a", "b", ["x", "==", "1", "-"])]), mapped({ f: { concept: "SequenceFlow" } })); // no TransitionCondition chosen
    expect(graph.flows.f.condition).toBeNull(); // null, not []: the validator can tell "not mapped" from "no condition"
  });

  it("keeps a half-filled row, and the logical operators after the first row", () => {
    const rows = [["lager", "==", "ja", "-"], ["kunde", "==", "", "AND"]]; // the second row lacks its value
    const graph = transformModel(sceneType, scene([], [flow("f", "a", "b", ...rows)]), mapped({ f: { concept: "SequenceFlow", data: { TransitionCondition: "f-cond" } } })); // condition mapped
    expect(graph.flows.f.condition).toEqual([
      { variableName: "lager", operator: "==", value: "ja", logicalOperator: null }, // the first row's "-" means nothing
      { variableName: "kunde", operator: "==", value: "", logicalOperator: "AND" }, // kept, so the validator can report it (spec 10, check 17)
    ]);
  });

  it("finds node and variable of a draw by their concepts, in either direction", () => {
    const reversed = line("g", "m-draw", "lager", "check"); // drawn from the variable to the node
    const graph = transformModel(sceneType, scene([box("check", "Check"), box("lager", "lager")], [reversed]), mapped({ check: { concept: "Activity" }, lager: { concept: "Variable" }, g: { concept: "RandomGenerator" } }));
    expect(graph.generators.g).toMatchObject({ node: "check", variable: "lager", distribution: null }); // direction does not matter; no distribution mapped
    expect(graph.issues).toEqual([]); // nothing to report
  });

  it("reports a draw that is not a line between a node and a variable", () => {
    const graph = transformModel(
      sceneType,
      scene([box("a", "A"), box("b", "B"), box("box", "Generator box")], [line("g", "m-draw", "a", "b")]), // a draw between two nodes, and a generator drawn as a box
      mapped({ a: { concept: "Activity" }, b: { concept: "Activity" }, g: { concept: "RandomGenerator" }, box: { concept: "RandomGenerator" } }),
    );
    expect(graph.generators.g).toMatchObject({ node: "a", variable: null }); // no end is a variable
    expect(graph.generators.box).toMatchObject({ node: null, variable: null }); // a box has no ends
    expect(graph.issues.map((issue) => issue.elementId)).toEqual(["g", "box"]); // both reported (spec 10, check 2)
  });

  it("reports a line mapped to a node concept and leaves it out", () => {
    const graph = transformModel(sceneType, scene([], [flow("f", "a", "b")]), mapped({ f: { concept: "Activity" } })); // a flow mapped as an activity
    expect(graph.nodes).toEqual({}); // a line cannot be executed
    expect(graph.issues).toHaveLength(1); // spec 10, check 2
  });

  it("skips a mapped element that is not in the model, without an issue", () => {
    const graph = transformModel(sceneType, scene([], []), mapped({ gone: { concept: "Activity" } })); // cannot come from loadMapping; only a safety net
    expect(graph.nodes).toEqual({}); // nothing to translate
    expect(graph.issues).toEqual([]); // and nothing a user could have caused, so nothing to report
  });

  it("reports a condition attribute that is not a table of the format rule", () => {
    const graph = transformModel(sceneType, scene([], [flow("f", "a", "b")]), mapped({ f: { concept: "SequenceFlow", data: { TransitionCondition: "f-name" } } })); // the Name attribute chosen by mistake
    expect(graph.flows.f.condition).toBeNull(); // unreadable
    expect(graph.issues[0].message).toContain("must be a table with the columns variable, operator, value, logical operator"); // says what is expected
  });

  it("reads a variable's name from its mapped attribute, and null when none is mapped", () => {
    const model = scene([box("v", "  lager  "), box("w", "kunde")], []); // a name with spaces around it
    const graph = transformModel(sceneType, model, mapped({ v: { concept: "Variable", data: { VariableName: "v-name" } }, w: { concept: "Variable" } }));
    expect(graph.variables.v.name).toBe("lager"); // trimmed, so " lager" in a condition is not a different variable
    expect(graph.variables.w.name).toBeNull(); // spec 10, check 3 reports it
  });
});

describe("parseDecimal", () => {
  it("reads a comma or a dot as decimal separator (plan 4)", () => {
    expect([parseDecimal("0,8"), parseDecimal("0.8"), parseDecimal(" 1 "), parseDecimal(".5"), parseDecimal("-2,5")]).toEqual([0.8, 0.8, 1, 0.5, -2.5]);
  });

  it("returns null for anything that is not a plain decimal", () => {
    expect([parseDecimal(""), parseDecimal("abc"), parseDecimal("1e3"), parseDecimal("0x10"), parseDecimal("1,2,3")]).toEqual([null, null, null, null, null]);
  });
});
