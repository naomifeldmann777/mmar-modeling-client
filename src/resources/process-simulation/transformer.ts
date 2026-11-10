/**
 * The transformer: turns an MMAR model and the mapping of its modelling language into the
 * simulation graph (graph.ts), the plain data every later step works on.
 *
 * Used by: the stepper (and later the path analysis), once per run, before the validator.
 * It is the MMAR adapter of the simulation: the one place that knows how MMAR stores a
 * model (instances, metaclasses, attribute instances, table cells, relations with roles).
 * So when a run starts: mappingFor(scene type name) → transformModel → startRun.
 *
 * How an element gets its concept (Plan2 A3): from the mapping of its METACLASS, looked up
 * by the metaclass's name (mappings.ts). A class with two roles (e.g. a Parallel Gateway)
 * becomes a join where several sequence flows lead into the element, a split otherwise
 * (resolveConcept). A data concept is the element's attribute instance of the meta
 * attribute the mapping names for its class.
 *
 * Deliberately NOT here:
 * - Nothing of a modelling language. No metaclass name, no attribute name and no uuid of a
 *   metamodel appears in this file: they all come from the mapping, so BPMN and Petri net
 *   models go through the same code.
 * - No judgement about the process. Missing names, empty conditions or an unreadable
 *   probability are written into the graph as they are; the validator decides whether
 *   they prevent a run (plan 4). Only what cannot be translated at all becomes an issue.
 * - Elements of a class the mapping does not name are skipped (spec 3), bendpoints included.
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
 * A cell may be a reference instead of typed text (in the BPMN 2.0 metamodel, the variable
 * column of a condition has the attribute type "Variable Reference 2.0"). Such a cell is
 * read as the CURRENT name of the element it points at, provided that element is mapped to
 * Variable; the text MMAR stored in the cell is the name at the time it was chosen and goes
 * stale when the variable is renamed. A reference to an element of another model (the
 * reference dialog offers the variables of every loaded model) becomes an issue. So
 * conditions still refer to variables by name (spec 2.2), and nothing after the transformer
 * knows whether a name was typed or picked.
 *
 * Source: spec 3 (unmapped elements are ignored), spec 6.2 (a draw belongs to the node at
 * which it occurs, whatever the metamodel looks like), spec 7 (nodes, flows, variables and
 * random generators), plan 4, Plan2 A3 (mapping per class).
 */
import { table_rows, type Attribute, type AttributeInstance, type ClassInstance, type SceneInstance, type SceneType } from "@gds";
import { NAME_ATTRIBUTE_UUID } from "@/constants";
import type { ConditionRow, DistributionEntry, SimulationGraph } from "./graph";
import { resolveConcept, type LanguageMapping } from "./mappings"; // the mapping of the model's language, and the split-or-join rule
import { parseDecimal } from "./numbers"; // probabilities may be written with a comma or a dot
import { NODE_CONCEPTS, type DataConcept, type ElementConcept, type NodeConcept } from "./vocabulary";

const CONDITION_COLUMNS = ["variable", "operator", "value", "logical operator"]; // the format rule for a TransitionCondition table
const DISTRIBUTION_COLUMNS = ["value", "probability"]; // the format rule for a Distribution table

/** What the mapping makes of one element of the model. */
interface MappedElement {
  concept: ElementConcept; // its concept, with the role of a split-or-join class already settled
  data: Partial<Record<DataConcept, string>>; // data concept -> uuid of the META attribute that holds it, found by the name the mapping gives
}

/**
 * Builds the simulation graph of a model.
 *
 * `sceneType` is the model's metamodel: it gives every element's metaclass and its name, the
 * meta attributes the mapping names, and the order of a table's columns, which a cell does
 * not know itself. `mapping` is the mapping of that metamodel (mappingFor in mappings.ts).
 */
export function transformModel(
  sceneType: SceneType, // the metamodel
  sceneInstance: SceneInstance, // the model
  mapping: LanguageMapping, // which class plays which concept
): SimulationGraph {
  const graph: SimulationGraph = { nodes: {}, flows: {}, generators: {}, variables: {}, issues: [] }; // filled below
  const issue = (elementId: string | null, message: string) => graph.issues.push({ elementId, message }); // one way to record a problem

  // Lookup tables, built once: element uuid -> element, relation uuid -> relation, meta attribute uuid -> meta attribute.
  const relations = new Map(sceneInstance.relationclasses_instances.map((relation) => [relation.uuid, relation])); // the lines of the model
  const elements = new Map<string, ClassInstance>([
    ...sceneInstance.class_instances.map((instance) => [instance.uuid, instance] as const), // boxes
    ...relations, // and lines: a relation instance is a class instance too
  ]);
  const metaclasses = [...sceneType.classes, ...sceneType.relationclasses]; // boxes and lines of the metamodel alike: the mapping names both
  const metaAttributes = new Map<string, Attribute>(
    metaclasses.flatMap((metaclass) => metaclass.attributes.map((attribute) => [attribute.uuid, attribute] as const)), // a table's columns are on its meta attribute
  );

  // Step 1: the mapping of every metaclass, by uuid, with the data attributes found by name.
  // Example: "Sequence Flow 2.0" maps TransitionCondition to "Transition Condition Table 2.0";
  // its meta attribute of that name has the uuid "m-condition", so a flow's condition is its
  // attribute instance of "m-condition". A name the metamodel lacks is a mistake in the
  // mapping (e.g. a typo, or a class renamed since), reported once, not per element.
  const classMappings = new Map<string, { concept: LanguageMapping[string]["concept"]; data: Partial<Record<DataConcept, string>> }>(); // metaclass uuid -> its mapping
  for (const [className, classMapping] of Object.entries(mapping)) {
    const metaclass = metaclasses.find((candidate) => candidate.name === className); // the class the mapping means
    if (!metaclass) {
      issue(null, `The simulation mapping names the class "${className}", which the metamodel "${sceneType.name}" does not have.`); // spec 10, check 2
      continue; // no element can be of a class that does not exist
    }
    const data: Partial<Record<DataConcept, string>> = {}; // the data attributes of this class that exist
    for (const [dataConcept, attributeName] of Object.entries(classMapping.data ?? {}) as [DataConcept, string][]) {
      const attribute = metaclass.attributes.find((candidate) => candidate.name === attributeName); // the meta attribute the mapping means
      if (attribute) data[dataConcept] = attribute.uuid; // found: read from every element of the class
      else issue(null, `The simulation mapping names the attribute "${attributeName}" of "${className}" as its ${dataConcept}, but the class has no such attribute.`); // spec 10, check 2
    }
    classMappings.set(metaclass.uuid, { concept: classMapping.concept, data }); // relation instances carry their relation class in uuid_class too
  }

  // Step 2: how many sequence flows lead into each element, which settles the role of a
  // split-or-join class. A line's own concept never depends on flows, so it is known here.
  const incomingFlows = new Map<string, number>(); // element uuid -> number of incoming sequence flows
  for (const relation of relations.values()) {
    const target = relation.role_instance_to?.uuid_has_reference_class_instance; // the element the line leads to
    if (target && classMappings.get(relation.uuid_class)?.concept === "SequenceFlow") incomingFlows.set(target, (incomingFlows.get(target) ?? 0) + 1); // count only sequence flows, not e.g. random generators
  }

  // Step 3: the concept and data of every element whose class is mapped. Example: a
  // Parallel Gateway with two incoming sequence flows -> { concept: "AND-Join", data: {} }.
  const mapped = new Map<string, MappedElement>(); // element uuid -> what it plays
  for (const element of elements.values()) {
    const classMapping = classMappings.get(element.uuid_class); // undefined for a class the mapping does not name, e.g. a bendpoint
    if (classMapping) mapped.set(element.uuid, { concept: resolveConcept(classMapping.concept, incomingFlows.get(element.uuid) ?? 0), data: classMapping.data });
  }
  const conceptOf = (id: string | null) => (id ? mapped.get(id)?.concept : undefined); // the concept of a connected element, if it has one

  // The element's attribute instance holding `dataConcept`. undefined: the mapping names no
  // attribute for it (spec 10, check 3 decides whether that matters). null: the mapping
  // names one, but this element has no instance of it, e.g. it was drawn before the
  // attribute was added to the metamodel; it is then read as empty.
  const dataOf = (elementId: string, dataConcept: DataConcept): AttributeInstance | null | undefined => {
    const metaAttributeId = mapped.get(elementId)?.data[dataConcept]; // which meta attribute holds it
    if (metaAttributeId === undefined) return undefined; // not mapped
    return elements.get(elementId)?.attribute_instance?.find((candidate) => candidate.uuid_attribute === metaAttributeId) ?? null; // the element's own instance of it
  };

  // The name conditions use for a variable: the text of its VariableName attribute, trimmed
  // so " lager" and "lager" are the same name. null when the mapping names no such attribute
  // (spec 10, check 3 reports that). Read from the model, not from graph.variables, so it
  // does not matter whether pass 1 has reached the variable yet.
  const variableNameOf = (variableId: string): string | null => {
    const attribute = dataOf(variableId, "VariableName"); // the attribute holding the name
    return attribute === undefined ? null : (attribute?.value ?? "").trim(); // "" is reported by the validator (spec 10, check 10)
  };

  // Pass 1: one graph entry per mapped element, chosen by its concept alone.
  for (const [id, entry] of mapped) {
    const element = elements.get(id)!; // `mapped` was built from `elements`, so it is there
    const label = nameOf(element); // for messages and the trace
    const relation = relations.get(id); // undefined when the element is a box, not a line
    const ends = relation
      ? [relation.role_instance_from?.uuid_has_reference_class_instance ?? null, relation.role_instance_to?.uuid_has_reference_class_instance ?? null] // a line's two ends, through its roles; null for an end that is no element (e.g. a port)
      : null; // a box has no ends

    // Reads the table attribute the mapping names as `dataConcept` (TransitionCondition or
    // Distribution) and returns its content as plain text: one array per row, holding the
    // cell texts in column order. Example, a condition table with two rows:
    //
    //   [ ["lager", "==", "ja",      "-"  ],
    //     ["kunde", "==", "premium", "AND"] ]
    //
    // Returns null when the mapping names no attribute for this data concept (not an error
    // here: the validator decides whether it is needed, spec 10, check 3), and null with an
    // issue when the named attribute is not a table with enough columns.
    const readTable = (dataConcept: DataConcept, columnNames: string[]): string[][] | null => {
      const attribute = dataOf(id, dataConcept); // the element's table, null if it has none yet
      if (attribute === undefined) return null; // the mapping names nothing

      // MMAR stores a table as ONE flat list of cells (attribute.table_attributes), in no fixed
      // order. A cell only knows its row (`table_row`), its column (`uuid_attribute`, the uuid of
      // the column's meta attribute) and its text (`value`). The ORDER of the columns is not in
      // the cells but in the metamodel: the table's meta attribute lists its columns, each with
      // a `sequence` number (1, 2, 3, ...).
      const columns = metaAttributes.get(entry.data[dataConcept]!)?.attribute_type?.has_table_attribute ?? []; // the columns, from the metamodel; `!` because dataOf found the data concept mapped
      if (columns.length < columnNames.length) {
        issue(id, `${dataConcept} of "${label}" must be a table with the columns ${columnNames.join(", ")}, in this order.`); // the format rule
        return null; // unreadable
      }
      if (attribute === null) return []; // no instance of the table yet: read as an empty table

      // table_rows (a helper of the shared data structure, Instance_tables.ts) sorts the
      // columns by `sequence` and puts every cell at its place, which turns the flat list into
      // a grid: one array per row, holding the CELL OBJECTS in column order, and `undefined`
      // where a row has no cell for a column. Rows come out in order 0, 1, 2, ...
      const grid = table_rows(attribute, columns);

      // From cell objects to plain text, row by row: slice keeps only the columns the format
      // rule knows (4 for a condition, 2 for a distribution); a metamodel may add further
      // columns, they are ignored. cellText turns each remaining cell into its text.
      return grid.map((row) => row.slice(0, columnNames.length).map((cell) => cellText(cell, dataConcept)));
    };

    // The text of one table cell. Example, a condition row whose variable cell points at the
    // variable "v-1", which was called "Lager" when it was picked and is now called "lager":
    //   cell { value: "Lager", role_instance_from: { uuid_has_reference_class_instance: "v-1" } }  ->  "lager"
    const cellText = (cell: AttributeInstance | undefined, dataConcept: DataConcept): string => {
      const text = (cell?.value ?? "").trim(); // the cell's text, "" where the row has no cell; trimmed so " lager" and "lager" are the same name
      const target = cell?.role_instance_from?.uuid_has_reference_class_instance; // set only when the cell is a reference to an element
      if (!target) return text; // every cell that is no reference (operator, value, probability, ...), or a reference that was cleared (MMAR then empties the text too)
      if (!elements.has(target)) {
        issue(id, `A row of the ${dataConcept} of "${label}" refers to "${text}", which belongs to another model.`); // the reference dialog offers the variables of every loaded model
        return text; // kept, so the message and the row show what was picked
      }
      return variableNameOf(target) ?? text; // its current name; without a mapped VariableName the text (spec 10, check 3 reports the variable)
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
      graph.variables[id] = { id, label, name: variableNameOf(id) }; // the same name a reference cell reads, so both always agree
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

/** An element's name: its standard Name attribute, as in the model tree. */
function nameOf(element: ClassInstance): string {
  return element.attribute_instance?.find((attribute) => attribute.uuid_attribute === NAME_ATTRIBUTE_UUID)?.value || "(unnamed)"; // never blank in a message
}
