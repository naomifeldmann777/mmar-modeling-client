/**
 * The simulation graph: a model reduced to its simulation concepts, as plain data.
 *
 * Used by: the transformer, which builds it from an MMAR model and its mapping, and
 * everything after it (validator, firing rule, stepper, path analysis), which reads
 * only this graph and never the model.
 *
 * Deliberately NOT here:
 * - No behaviour. This file only describes the shape of the data.
 * - Nothing of MMAR or of a modelling language: no gds classes, no metaclass names. A
 *   graph from a BPMN model and one from a Petri net model look alike. This file and
 *   vocabulary.ts are therefore what a later library takes along, and another platform
 *   could feed the library by building the same graph (plan 1.5).
 * - No judgement. The graph records what the model says, also where it is incomplete
 *   (a missing name, an unreadable probability); whether that prevents a run is the
 *   validator's decision (plan 6, spec 10).
 *
 * Every id is the uuid of the model element it comes from, so results and problems can
 * be shown on the element in the model.
 *
 * Source: spec 7 (nodes are executed, sequence flows carry the tokens, variables and
 * random generators are neither), spec 6 (variables, draws, conditions), spec 5.2 (a
 * TransitionCondition becomes a guard, a Distribution lists the values to draw).
 */
import type { NodeConcept } from "./vocabulary"; // the graph only ever speaks in concepts

/** The whole graph of one model. Each part is keyed by element uuid, for direct lookup. */
export interface SimulationGraph {
  nodes: Record<string, GraphNode>; // the elements that are executed (spec 7)
  flows: Record<string, GraphFlow>; // the elements that carry the tokens (spec 5.1)
  generators: Record<string, GraphGenerator>; // where a value is drawn, from what, into which variable (spec 6.2)
  variables: Record<string, GraphVariable>; // the values a token carries (spec 6.1)
  issues: GraphIssue[]; // what could not be translated; the validator reports these (plan 6)
}

/** An element mapped to a node concept: Activity, Start, Decision, AND-Join, … */
export interface GraphNode {
  id: string; // uuid of the element
  label: string; // its name, so messages and the trace can name it
  concept: NodeConcept; // decides how it is executed, and whether it waits (spec 5.3)
  incoming: string[]; // ids of the flows leading into it: the tokens it can consume
  outgoing: string[]; // ids of the flows leading out of it: where it can produce tokens
}

/** An element mapped to SequenceFlow. */
export interface GraphFlow {
  id: string; // uuid of the element
  label: string; // its name, so messages can name it
  source: string | null; // uuid of the element it comes from; null when that end is not an element (e.g. a port)
  target: string | null; // uuid of the element it leads to; null likewise
  // The rows of its TransitionCondition. null: no TransitionCondition attribute is mapped
  // (spec 10, check 3, decides whether that matters). An empty array: one is mapped but
  // holds no rows, so the flow has no condition.
  condition: ConditionRow[] | null;
}

/**
 * One row of a condition table: "variable operator value", linked to the previous row
 * by its logical operator. The rows are evaluated with AND before OR (plan 6), so the
 * rows A, B (AND), C (OR), D (AND) mean (A and B) or (C and D).
 */
export interface ConditionRow {
  variableName: string; // the variable's name as typed in the condition, not a uuid; matched against GraphVariable.name
  operator: string; // as written; the validator checks it is one of ==, !=, <, <=, >, >=
  value: string; // as written; compared as text, or as a number by <, <=, >, >= (spec 10, check 19)
  logicalOperator: string | null; // links this row to the previous one ("AND" / "OR"); null in the first row, where it means nothing
}

/** An element mapped to RandomGenerator: a draw at a node into a variable (spec 6.2). */
export interface GraphGenerator {
  id: string; // uuid of the element
  label: string; // its name, so messages can name it
  node: string | null; // uuid of the node at which the value is drawn; null when it cannot be determined
  variable: string | null; // uuid of the variable the value is written to; null likewise
  // The values that can be drawn, with their probabilities. null: no Distribution
  // attribute is mapped. Only discrete distributions exist in this version (spec 10, check 14).
  distribution: DistributionEntry[] | null;
}

/** One value of a discrete distribution. */
export interface DistributionEntry {
  value: string; // the value as written; it becomes the variable's value when drawn
  probability: number | null; // read with a comma or a dot as decimal separator; null when it is not a number
}

/** An element mapped to Variable: one component of the value every token carries (spec 6.1). */
export interface GraphVariable {
  id: string; // uuid of the element
  label: string; // its element name, so messages can name it
  // The name conditions use to refer to it: the value of its VariableName attribute.
  // null when no VariableName attribute is mapped (spec 10, checks 3 and 10).
  name: string | null;
}

/** Something the transformer could not translate, reported against the element it concerns. */
export interface GraphIssue {
  elementId: string; // uuid of the element, so the problem can be shown on it
  message: string; // for the user: names what is wrong, not a structure of this code
}
