/**
 * The transformer: turns an MMAR model and its concept mapping into the simulation
 * graph (graph.ts), the plain data every later step works on.
 *
 * Used by: the stepper (and later the path analysis), once per run, before the
 * validator. It is the MMAR adapter of the simulation: the one place that knows how MMAR
 * stores a model (instances, attribute instances, table cells, relations with roles).
 *
 * Deliberately NOT here:
 * - Nothing of a modelling language. No metaclass name, no attribute name and no uuid of a
 *   metamodel appears in this file: what an element is comes from the mapping, never from
 *   its metaclass, so BPMN and Petri net models go through the same code.
 * - No judgement about the process. Missing names, empty conditions or an unreadable
 *   probability are written into the graph as they are; the validator decides whether
 *   they prevent a run (plan 4). Only what cannot be translated at all becomes an issue.
 * - Elements without a concept are skipped (spec 3).
 *
 * The format rule for data held in tables (decided in Phase 4): the attribute mapped as
 *   TransitionCondition is a table whose columns are, in this order:
 *     1 variable, 2 operator, 3 value, 4 logical operator (links a row to the previous one);
 *   the attribute mapped as Distribution is a table whose columns are, in this order:
 *     1 value, 2 probability.
 * The order is the column order defined in the metamodel; further columns are ignored. A
 * row whose variable and value (or value and probability) are both empty is skipped: MMAR
 * gives every new table one such row. A half-filled row is kept, so the validator can
 * report it (spec 10, check 17).
 *
 * Source: spec 3 (mapping per element; unmapped elements are ignored), spec 6.2 (a draw
 * belongs to the node at which it occurs, whatever the metamodel looks like), spec 7
 * (nodes, flows, variables and random generators), plan 4.
 */
import { table_rows, type Attribute, type ClassInstance, type SceneInstance, type SceneType } from "@gds";
import { NAME_ATTRIBUTE_UUID } from "@/constants";
import type { ConditionRow, DistributionEntry, SimulationGraph } from "./graph";
import type { ProcessSimulationMapping } from "./mapping";
import { NODE_CONCEPTS, type DataConcept, type ElementConcept, type NodeConcept } from "./vocabulary";

const CONDITION_COLUMNS = ["variable", "operator", "value", "logical operator"]; // the format rule for a TransitionCondition table
const DISTRIBUTION_COLUMNS = ["value", "probability"]; // the format rule for a Distribution table

/**
 * Builds the simulation graph of a model.
 *
 * `sceneType` is the model's metamodel: it is needed for the order of a table's columns,
 * which a cell does not know itself. `mapping` must come from loadMapping (mapping.ts),
 * which has already dropped every entry for an element or attribute the model lacks.
 */
export function transformModel(
  sceneType: SceneType, // the metamodel, for the column order of tables
  sceneInstance: SceneInstance, // the model
  mapping: ProcessSimulationMapping, // which element plays which concept
): SimulationGraph {
  const graph: SimulationGraph = { nodes: {}, flows: {}, generators: {}, variables: {}, issues: [] }; // filled below
  const issue = (elementId: string, message: string) => graph.issues.push({ elementId, message }); // one way to record a problem

  // Lookup tables, built once: element uuid -> element, relation uuid -> relation, meta attribute uuid -> meta attribute.
  const relations = new Map(sceneInstance.relationclasses_instances.map((relation) => [relation.uuid, relation])); // the lines of the model
  const elements = new Map<string, ClassInstance>([
    ...sceneInstance.class_instances.map((instance) => [instance.uuid, instance] as const), // boxes
    ...relations, // and lines: a relation instance is a class instance too
  ]);
  const metaAttributes = new Map<string, Attribute>(
    [...sceneType.classes, ...sceneType.relationclasses].flatMap((metaclass) => metaclass.attributes.map((attribute) => [attribute.uuid, attribute] as const)), // a table's columns are on its meta attribute
  );
  const conceptOf = (id: string | null) => (id ? mapping.elements[id]?.concept : undefined); // the concept of a connected element, if it has one

  // Pass 1: one graph entry per mapped element, chosen by its concept alone.
  for (const [id, entry] of Object.entries(mapping.elements)) {
    const element = elements.get(id); // the model element behind the entry
    if (!element) continue; // cannot happen: loadMapping has already dropped entries of deleted elements
    const label = nameOf(element); // for messages and the trace
    const relation = relations.get(id); // undefined when the element is a box, not a line
    const ends = relation
      ? [relation.role_instance_from?.uuid_has_reference_class_instance ?? null, relation.role_instance_to?.uuid_has_reference_class_instance ?? null] // a line's two ends, through its roles; null for an end that is no element (e.g. a port)
      : null; // a box has no ends

    // Reads the table attribute the user mapped as `dataConcept` (TransitionCondition or
    // Distribution) and returns its content as plain text: one array per row, holding the
    // cell texts in column order. Example, a condition table with two rows:
    //
    //   [ ["lager", "==", "ja",      "-"  ],
    //     ["kunde", "==", "premium", "AND"] ]
    //
    // Returns null when no attribute is mapped for this data concept (not an error here: the
    // validator decides whether it is needed, spec 10, check 3), and null with an issue when
    // the chosen attribute is not a table with enough columns: the popup offers every
    // attribute of the element, so the user may have picked e.g. "Name" by mistake.
    const readTable = (dataConcept: DataConcept, columnNames: string[]): string[][] | null => {
      const attributeId = entry.data?.[dataConcept]; // which attribute the user chose in the popup
      if (attributeId === undefined) return null; // nothing chosen
      const attribute = element.attribute_instance?.find((candidate) => candidate.uuid === attributeId); // the element's own attribute instance
      if (!attribute) return null; // cannot happen: loadMapping has already checked that the attribute belongs to the element

      // MMAR stores a table as ONE flat list of cells (attribute.table_attributes), in no fixed
      // order. A cell only knows its row (`table_row`), its column (`uuid_attribute`, the uuid of
      // the column's meta attribute) and its text (`value`). The ORDER of the columns is not in
      // the cells but in the metamodel: the table's meta attribute lists its columns, each with
      // a `sequence` number (1, 2, 3, ...).
      const columns = metaAttributes.get(attribute.uuid_attribute)?.attribute_type?.has_table_attribute ?? []; // the columns, from the metamodel
      if (columns.length < columnNames.length) {
        issue(id, `${dataConcept} of "${label}" must be a table with the columns ${columnNames.join(", ")}, in this order.`); // the format rule
        return null; // unreadable
      }

      // table_rows (a helper of the shared data structure, Instance_tables.ts) sorts the
      // columns by `sequence` and puts every cell at its place, which turns the flat list into
      // a grid: one array per row, holding the CELL OBJECTS in column order, and `undefined`
      // where a row has no cell for a column. Rows come out in order 0, 1, 2, ...
      const grid = table_rows(attribute, columns);

      // From cell objects to plain text, row by row:
      // - slice keeps only the columns the format rule knows (4 for a condition, 2 for a
      //   distribution); a metamodel may add further columns, they are ignored;
      // - `cell?.value ?? ""` takes the cell's text, or "" where the row has no cell;
      // - trim drops spaces around it, so " lager" and "lager" are the same name.
      return grid.map((row) => row.slice(0, columnNames.length).map((cell) => (cell?.value ?? "").trim()));
    };

    if (isNodeConcept(entry.concept)) {
      if (relation) {
        issue(id, `"${label}" is a line, so it cannot be executed as ${entry.concept}.`); // spec 10, check 2: nodes are what flows connect
        continue; // a line as a node could never be reached by a flow
      }
      graph.nodes[id] = { id, label, concept: entry.concept, incoming: [], outgoing: [] }; // flows are wired in pass 2
    } else if (entry.concept === "SequenceFlow") {
      if (!ends) issue(id, `"${label}" is mapped to SequenceFlow but is not a line, so it has no source and target.`); // spec 10, check 2
      const rows = readTable("TransitionCondition", CONDITION_COLUMNS); // null: no condition attribute mapped, or unreadable
      graph.flows[id] = {
        id, // the flow's uuid
        label, // its name
        source: ends?.[0] ?? null, // the element it comes from
        target: ends?.[1] ?? null, // the element it leads to
        condition: rows ? conditionRows(rows) : null, // [] when the table holds no filled row: no condition
      };
    } else if (entry.concept === "RandomGenerator") {
      // Which end is the node and which the variable follows from their concepts, not from the
      // direction of the line (decided in Phase 4), so either direction works.
      const variable = ends?.find((end) => conceptOf(end) === "Variable") ?? null; // the end mapped to Variable
      const node = ends?.find((end) => isNodeConcept(conceptOf(end))) ?? null; // the end mapped to a node concept
      if (!ends) {
        issue(id, `"${label}" is mapped to RandomGenerator but is not a line between a node and a variable. Random generators drawn as elements of their own are not read yet.`); // spec 10, check 2
      } else if (!variable || !node) {
        issue(id, `"${label}" must connect an element mapped to a node concept with an element mapped to Variable.`); // spec 10, check 2
      }
      const rows = readTable("Distribution", DISTRIBUTION_COLUMNS); // null: no distribution attribute mapped, or unreadable
      graph.generators[id] = {
        id, // the generator's uuid
        label, // its name
        node, // where the value is drawn
        variable, // where it is written to
        distribution: rows ? distributionEntries(rows) : null, // [] when the table holds no filled row
      };
    } else if (entry.concept === "Variable") {
      const attributeId = entry.data?.VariableName; // the attribute holding the name conditions use
      const attribute = attributeId === undefined ? undefined : element.attribute_instance?.find((candidate) => candidate.uuid === attributeId); // that attribute; loadMapping has checked it belongs to the element
      graph.variables[id] = { id, label, name: attribute ? (attribute.value ?? "").trim() : null }; // null: not mapped; "" is reported by the validator (spec 10, check 10)
    }
  }

  // Pass 2: tell every node which flows lead into and out of it. A flow end that is not a
  // node (unmapped, or not a node concept) is left for the validator (spec 10, check 1).
  for (const flow of Object.values(graph.flows)) {
    if (flow.source && graph.nodes[flow.source]) graph.nodes[flow.source].outgoing.push(flow.id); // a token can leave the source on this flow
    if (flow.target && graph.nodes[flow.target]) graph.nodes[flow.target].incoming.push(flow.id); // and arrive at the target on it
  }

  return graph; // plain data from here on
}

/**
 * A number written with a comma or a dot as decimal separator, as plan 4 requires: "0,8"
 * and "0.8" both read as 0.8. null when the text is not such a number. Exported for the
 * firing rule, which compares condition values with <, <=, > and >=.
 */
export function parseDecimal(text: string): number | null {
  const normalized = text.trim().replace(",", "."); // one decimal comma becomes a dot
  return /^[+-]?(\d+(\.\d*)?|\.\d+)$/.test(normalized) ? Number(normalized) : null; // plain decimals only; Number alone would also accept "1e3" or "0x10"
}

/**
 * Turns the plain-text rows of a condition table (from readTable) into ConditionRow objects,
 * i.e. gives the four positions their names. Example:
 *
 *   in:  [ ["",      "==", "",        "-"  ],     <- the empty row every new table starts with
 *          ["lager", "==", "ja",      "-"  ],
 *          ["kunde", "==", "premium", "AND"] ]
 *
 *   out: [ { variableName: "lager", operator: "==", value: "ja",      logicalOperator: null  },
 *          { variableName: "kunde", operator: "==", value: "premium", logicalOperator: "AND" } ]
 *
 * The brackets in `([variableName, , value]) => ...` unpack a row by position: the first
 * text is called variableName, the second is skipped (the empty slot between the commas),
 * the third is called value. Position = column of the format rule.
 */
function conditionRows(rows: string[][]): ConditionRow[] {
  return rows
    // Step 1: drop rows whose variable AND value are both empty, such as the default row
    // above (decided in Phase 4). A half-filled row stays, so the validator can report it.
    .filter(([variableName, , value]) => variableName !== "" || value !== "")
    // Step 2: name the four positions. `index` counts the rows that are left after step 1,
    // so the first real row gets index 0, even if an empty row stood before it.
    .map(([variableName, operator, value, logicalOperator], index) => ({
      variableName, // column 1: the variable's name, as typed
      operator, // column 2: ==, !=, <, <=, > or >=, as typed; the validator checks it
      value, // column 3: what the variable is compared with, as typed
      logicalOperator: index === 0 ? null : logicalOperator, // column 4: AND / OR to the previous row; the first row has no previous row (plan 1)
    }));
}

/**
 * Turns the plain-text rows of a distribution table (from readTable) into DistributionEntry
 * objects, the same way conditionRows does for conditions. Example:
 *
 *   in:  [ ["ja",   "0,8"],
 *          ["nein", "0.2"],
 *          ["",     ""   ] ]     <- the empty row every new table starts with
 *
 *   out: [ { value: "ja",   probability: 0.8 },
 *          { value: "nein", probability: 0.2 } ]
 */
function distributionEntries(rows: string[][]): DistributionEntry[] {
  return rows
    // Step 1: drop rows whose value AND probability are both empty, like the default row.
    .filter(([value, probability]) => value !== "" || probability !== "")
    // Step 2: name the two positions; the probability becomes a number, with a comma or a
    // dot as decimal separator (null when it is not a number, which the validator reports).
    .map(([value, probability]) => ({ value, probability: parseDecimal(probability) }));
}

/** True for the node concepts (spec 7); the list in vocabulary.ts is the only authority. */
function isNodeConcept(concept: ElementConcept | undefined): concept is NodeConcept {
  return (NODE_CONCEPTS as readonly (ElementConcept | undefined)[]).includes(concept); // widened so undefined can be looked up
}

/** An element's name: its standard Name attribute, as in the model tree and the mapping popup. */
function nameOf(element: ClassInstance): string {
  return element.attribute_instance?.find((attribute) => attribute.uuid_attribute === NAME_ATTRIBUTE_UUID)?.value || "(unnamed)"; // never blank in a message
}
