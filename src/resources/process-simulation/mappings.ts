/**
 * The mappings of the modelling languages onto the simulation concepts: for each
 * metamodel (scene type), which concept each of its classes plays, and which of its
 * attributes holds the data that concept needs.
 *
 * Used by: the stepper session, which picks the mapping of the open model's scene type
 * with `mappingFor`, and the transformer, which applies it to every element and settles
 * the role of a split-or-join class with `resolveConcept`.
 *
 * Deliberately NOT here:
 * - No uuid. Classes and attributes are named by their NAMES, which a person can read and
 *   check against the metamodeling client; uuids differ between installations.
 * - No access to MMAR or to the model. Whether a named class or attribute really exists is
 *   checked by the transformer against the open metamodel, which reports a missing one.
 * - No judgement about the model. Counting flows only settles the role of a gateway; whether
 *   the result is a sound process (e.g. a join with two outgoing flows) is the validator's.
 *
 * Why per class and not per element: the mapping
 * belongs to the modelling language, not to one model, so it is written once and holds for
 * every model of that language. This replaces the per-element popup of spec 3.
 *
 * Classes with two roles (Plan2 section 2, point 3): BPMN has one Parallel and one Inclusive
 * Gateway class, used both to split and to join the flow. BPMN 2.0, chapter 13 ("BPMN
 * Execution Semantics") tells the two uses apart by the sequence flows: a gateway is
 * "converging" when several flows lead into it and "diverging" when several lead out of it.
 * So the role is settled when a run starts, by counting the incoming sequence flows: more
 * than one makes it a join, otherwise it is a split. A gateway that is both (several in AND
 * several out) becomes a join, and the validator refuses it (spec 10, check 9: a join has
 * exactly one outgoing flow), naming the gateway; our concepts cannot express both in one node.
 *
 * The Exclusive Gateway needs no such rule: it is a Decision both ways (spec 3). Merging,
 * it lets every arriving token pass on its own (spec 5.3: a Decision does not wait), and its
 * single outgoing flow carries no condition, so it is always taken.
 *
 * Source: spec 2.1 and 2.2 (the concepts), spec 3 (the BPMN rows of the mapping table),
 * spec 5.3 (waiting depends on the concept alone), Plan2 A1 and A2.
 */
import type { DataConcept, ElementConcept, NodeConcept } from "./vocabulary"; // a mapping speaks only in concepts

// ---------------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------------

/** A class whose elements split the flow in one place and join it in another (e.g. a BPMN Parallel Gateway). */
export interface SplitOrJoin {
  split: NodeConcept; // its concept where at most one sequence flow leads into it
  join: NodeConcept; // its concept where several sequence flows lead into it
}

/** What one class of a metamodel plays in the simulation. */
export interface ClassMapping {
  concept: ElementConcept | SplitOrJoin; // one concept, or two to choose from by the flows
  data?: Partial<Record<DataConcept, string>>; // data concept -> NAME of the class's attribute that holds it (spec 2.2)
}

/** The mapping of one modelling language: metaclass name -> its mapping. A class missing here is ignored by the simulation (spec 3). */
export type LanguageMapping = Readonly<Record<string, ClassMapping>>;

// ---------------------------------------------------------------------------------
// The mappings, one per scene type
// ---------------------------------------------------------------------------------

/*
 * The names come from NOTES.md (Phase 1). A name must match exactly, with the same
 * spaces and capital letters. A wrong CLASS name or ATTRIBUTE name is reported when the
 * stepper starts ("The simulation mapping names the class ..."), so a typo shows up at once.
 */
export const MAPPINGS: Readonly<Record<string, LanguageMapping>> = {
  "BPMN 2.0": { // CHECK: THE NAME OF THE SCENE TYPE (METAMODEL) AS THE METAMODELING CLIENT SHOWS IT
    "Start Event 2.0": { concept: "Start" }, // CHECK: CLASS NAME
    "End Event 2.0": { concept: "End" }, // CHECK: CLASS NAME
    "Task 2.0": {
      concept: "Activity", // CHECK: CLASS NAME (the key above)
      data: { ExecutionTime: "Execution Time (s) 2.0" }, // CHECK: ATTRIBUTE NAME of the time in whole seconds
    },
    "Exclusive Gateway 2.0": { concept: "Decision" }, // CHECK: CLASS NAME. A Decision both to split and to merge, see the header
    "Parallel Gateway 2.0": { concept: { split: "AND-Split", join: "AND-Join" } }, // CHECK: CLASS NAME. Role by its incoming flows, see the header
    "Inclusive Gateway 2.0": { concept: { split: "OR-Split", join: "OR-Join" } }, // CHECK: CLASS NAME. Role by its incoming flows, see the header
    "Variable 2.0": {
      concept: "Variable", // CHECK: CLASS NAME (the key above)
      data: { VariableName: "Name" }, // CHECK: ATTRIBUTE NAME. The standard Name attribute holds the name conditions use
    },
    "Sequence Flow 2.0": {
      concept: "SequenceFlow", // CHECK: RELATION CLASS NAME (the key above)
      data: { TransitionCondition: "Transition Condition Table 2.0" }, // CHECK: ATTRIBUTE NAME of the condition table
    },
    "Random Generator 2.0": {
      concept: "RandomGenerator", // CHECK: RELATION CLASS NAME (the key above; the plan calls this relation "Triggers")
      data: { Distribution: "Discrete Distribution Table 2.0" }, // CHECK: ATTRIBUTE NAME of the distribution table
    },
  },
};

// ---------------------------------------------------------------------------------
// Using a mapping
// ---------------------------------------------------------------------------------

/**
 * The mapping of a scene type, by its name, or null when there is none: then the model's
 * language is not supported yet, which the caller tells the user.
 */
export function mappingFor(sceneTypeName: string): LanguageMapping | null {
  return Object.hasOwn(MAPPINGS, sceneTypeName) ? MAPPINGS[sceneTypeName] : null; // hasOwn, so a name such as "toString" finds nothing
}

/**
 * The concept of one element of a class, given how many sequence flows lead into it.
 *
 * Examples with the Parallel Gateway { split: "AND-Split", join: "AND-Join" }:
 *   1 incoming flow   -> "AND-Split"   (diverging)
 *   2 incoming flows  -> "AND-Join"    (converging)
 *   0 incoming flows  -> "AND-Split"   (the validator reports the missing flow, check 6)
 * A class with a single concept keeps it, whatever the flows.
 */
export function resolveConcept(concept: ClassMapping["concept"], incomingFlows: number): ElementConcept {
  if (typeof concept === "string") return concept; // one role only
  return incomingFlows > 1 ? concept.join : concept.split; // BPMN 13: converging when several flows lead in
}
