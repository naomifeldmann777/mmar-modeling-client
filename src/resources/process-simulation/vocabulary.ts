/**
 * The vocabulary of the generic process simulation: the simulation concepts a model
 * element can be mapped to, and the data concepts that are mapped together with them.
 *
 * Used by: the mapping (which concept an element has), the mapping dialog (which
 * concepts it offers), and the transformer, the validator and the firing rule (which
 * concepts are nodes, and which of those wait).
 *
 * Deliberately NOT here: any behaviour (what a concept does when executed lives in
 * firing.ts), any modelling language (no BPMN or Petri net names: the algorithm only
 * ever sees concepts), and any uuid (every uuid comes from the loaded model).
 *
 * Source: "A Generic Simulation Algorithm Described with Coloured Petri Nets",
 * section 2.1 (element concepts and their meaning) and 2.2 (data concepts), both
 * copied verbatim; section 5.3 (waiting depends on the concept alone); section 7
 * (nodes, sequence flows, variables and random generators play three different roles).
 */

// ---------------------------------------------------------------------------------
// Concepts for elements (spec 2.1)
// ---------------------------------------------------------------------------------

/** Every concept a model element can be mapped to, in the order of spec 2.1. */
export const ELEMENT_CONCEPTS = [
  "Activity", // spelled exactly as in the spec, because exported mapping files store these strings
  "Start", // the run begins here, so the validator needs to find exactly one (spec 10, check 4)
  "End", // the run is over once a token reaches one of these (spec 8, step 5)
  "Decision", // listed separately from OR-Split because exactly one, not at least one, branch is taken
  "AND-Split", // the hyphen is part of the name in the spec and must survive a round trip through JSON
  "AND-Join", // one of the three concepts that wait (spec 5.3)
  "OR-Split", // at least one branch is taken, decided by the transition conditions
  "OR-Join", // one of the three concepts that wait (spec 5.3)
  "ForkActivity", // kept as its own concept so it counts as an executed activity, unlike an AND-Split
  "SynchronizedActivity", // the concept a Petri net transition is mapped to (spec 3), and it waits
  "RandomGenerator", // not a node: it only says that a value is drawn when a node executes (spec 7)
  "Variable", // not a node: it is one component of the value a token carries (spec 7)
  "SequenceFlow", // not a node: it carries the tokens, so the state of a run lives on it (spec 5.1)
] as const; // `as const` keeps each entry as its own literal type, so a typo elsewhere fails to compile

/** One of the element concepts above; anything else is not a concept. */
export type ElementConcept = (typeof ELEMENT_CONCEPTS)[number]; // derived from the list so the two can never drift apart

/** The meaning of each element concept, word for word from spec 2.1. */
export const ELEMENT_CONCEPT_MEANINGS: Readonly<Record<ElementConcept, string>> = {
  // Record over ElementConcept makes the compiler insist on one meaning per concept, no more, no less
  Activity: "An activity that is executed during the process.", // shown to the user when choosing a concept
  Start: "The element at which the process starts.", // verbatim, so the dialog and the thesis say the same thing
  End: "An element at which the process ends.", // "An", not "The": a model may have several End elements
  Decision: "Exactly one of the outgoing flows is taken.", // the word "exactly" is what separates it from OR-Split
  "AND-Split": "All outgoing flows are taken at once.", // quoted key because of the hyphen in the concept name
  "AND-Join": "Waits until all incoming flows have arrived, then continues on the outgoing flow.", // "waits" matches WAITING_CONCEPTS
  "OR-Split": "At least one of the outgoing flows is taken.", // quoted key because of the hyphen in the concept name
  "OR-Join": "Waits until all activated incoming flows have arrived, then continues on the outgoing flow.", // "activated" is the difference to AND-Join
  ForkActivity: "Acts as an Activity followed by an AND-Split.", // explains why it needs no AND-Split behind it
  SynchronizedActivity: "Acts as an AND-Join followed by an Activity.", // explains why it waits although it is an activity
  RandomGenerator: "Draws a value from a distribution and assigns it to a variable.", // the draw happens at the node it is attached to
  Variable: "Stores the value produced by a random generator.", // conditions read it, only random generators write it
  SequenceFlow: "Indicates the direction of the control flow between two elements.", // the only concept with a source and a target
};

// ---------------------------------------------------------------------------------
// The roles elements play in a run (spec 7, spec 5.3)
// ---------------------------------------------------------------------------------

/**
 * The node concepts: elements mapped to one of these are the ones that get executed
 * (spec 7). The other three element concepts are not nodes: SequenceFlow carries the
 * tokens, and Variable and RandomGenerator are neither.
 */
export const NODE_CONCEPTS = [
  "Activity", // executed, and passes each arriving token on its own
  "Start", // executed once, as the only possible step at the beginning of a run (spec 8, step 1)
  "End", // executed, and the token it produces stays in the sink place (spec 5.2)
  "Decision", // executed, and its outgoing flow follows from the transition conditions
  "AND-Split", // executed, and produces a token on every outgoing flow
  "AND-Join", // executed only once every incoming flow carries a token
  "OR-Split", // executed, and its outgoing flows follow from the transition conditions
  "OR-Join", // executed only once every incoming flow carries a token
  "ForkActivity", // executed, and counts as an activity in the trace
  "SynchronizedActivity", // executed only once every incoming flow carries a token
] as const satisfies readonly ElementConcept[]; // `satisfies` rejects any entry that is not an element concept

/** One of the node concepts above. */
export type NodeConcept = (typeof NODE_CONCEPTS)[number]; // derived so a concept added above cannot be forgotten in the type

/**
 * The node concepts that wait for a token on every incoming flow. Waiting depends on
 * the concept alone, never on how many flows lead into the element (spec 5.3); every
 * other node lets each arriving token pass on its own.
 */
export const WAITING_CONCEPTS = [
  "AND-Join", // waits for all incoming flows
  "OR-Join", // waits for all incoming flows too: skipped branches still deliver a token (spec 5.2)
  "SynchronizedActivity", // waits like an AND-Join, then counts as an executed activity
] as const satisfies readonly NodeConcept[]; // `satisfies` guarantees only nodes can wait

/** One of the waiting concepts above. */
export type WaitingConcept = (typeof WAITING_CONCEPTS)[number]; // lets later code require a waiting concept by type

// ---------------------------------------------------------------------------------
// Concepts for data (spec 2.2)
// ---------------------------------------------------------------------------------

/**
 * The data concepts: they name the attribute of an element that holds the data the
 * simulation has to read. A data concept is always mapped together with its element
 * concept, by naming which of the element's attributes holds it (spec 2.2).
 */
export const DATA_CONCEPTS = [
  "TransitionCondition", // stored as a key in the mapping file, so the spelling must match the spec
  "Distribution", // stored as a key in the mapping file, so the spelling must match the spec
  "VariableName", // stored as a key in the mapping file, so the spelling must match the spec
] as const; // `as const` keeps each entry as its own literal type

/** One of the data concepts above. */
export type DataConcept = (typeof DATA_CONCEPTS)[number]; // derived from the list so the two can never drift apart

/** The element concept each data concept belongs to (spec 2.2, column "Belongs to"). */
export const DATA_CONCEPT_OWNERS = {
  TransitionCondition: "SequenceFlow", // a condition only makes sense on a flow, where it decides whether the flow is taken
  Distribution: "RandomGenerator", // the values a generator can draw and how likely each is
  VariableName: "Variable", // the name conditions use to refer to the variable
} as const satisfies Readonly<Record<DataConcept, ElementConcept>>; // one owner per data concept, and each owner a real concept

/** The meaning of each data concept, word for word from spec 2.2. */
export const DATA_CONCEPT_MEANINGS: Readonly<Record<DataConcept, string>> = {
  // Record over DataConcept makes the compiler insist on one meaning per data concept
  TransitionCondition: "The condition under which this flow is taken.", // shown when choosing the condition attribute
  Distribution: "The values that can be drawn and their probabilities.", // shown when choosing the distribution attribute
  VariableName: "The name by which the conditions refer to this variable.", // shown when choosing the name attribute
};
