/**
 * Tests for mappings.ts: looking up a mapping by scene type, settling the role of a
 * split-or-join class, and keeping the written mappings consistent with the vocabulary,
 * so a mistake made while editing MAPPINGS fails here and not in a run.
 */
import { describe, expect, it } from "vitest";
import { MAPPINGS, mappingFor, resolveConcept } from "./mappings";
import { DATA_CONCEPT_OWNERS, ELEMENT_CONCEPTS, NODE_CONCEPTS, type DataConcept } from "./vocabulary";

describe("mappingFor", () => {
  it("returns the mapping of a known scene type", () => {
    const name = Object.keys(MAPPINGS)[0]; // whatever the first scene type is called, so the test survives a renaming
    expect(mappingFor(name)).toBe(MAPPINGS[name]);
  });

  it("returns null for a scene type without a mapping, also for names of object properties", () => {
    expect(mappingFor("Robotic System")).toBeNull(); // a language the simulation does not know
    expect(mappingFor("toString")).toBeNull(); // not mistaken for an inherited property
  });
});

describe("resolveConcept", () => {
  const parallel = { split: "AND-Split", join: "AND-Join" } as const; // as for a BPMN Parallel Gateway

  it("keeps the concept of a class with one role", () => {
    expect(resolveConcept("Decision", 3)).toBe("Decision"); // an Exclusive Gateway merging three flows is still a Decision
  });

  it("makes an element a join when several sequence flows lead into it, otherwise a split", () => {
    expect(resolveConcept(parallel, 0)).toBe("AND-Split"); // no flow: the validator reports it (check 6)
    expect(resolveConcept(parallel, 1)).toBe("AND-Split"); // diverging
    expect(resolveConcept(parallel, 2)).toBe("AND-Join"); // converging
  });
});

describe("MAPPINGS", () => {
  const entries = Object.values(MAPPINGS).flatMap((language) => Object.entries(language)); // every class of every language

  it("uses only concepts of the vocabulary, and node concepts for a split or join", () => {
    for (const [className, { concept }] of entries) {
      const concepts = typeof concept === "string" ? [concept] : [concept.split, concept.join]; // the one or two concepts of the class
      for (const each of concepts) expect(ELEMENT_CONCEPTS, className).toContain(each); // spelled as in the spec
      if (typeof concept !== "string") expect(NODE_CONCEPTS, className).toEqual(expect.arrayContaining([concept.split, concept.join])); // only nodes split or join
    }
  });

  it("gives a data concept only to a class of a concept it belongs to (spec 2.2)", () => {
    for (const [className, { concept, data }] of entries) {
      const concepts = typeof concept === "string" ? [concept] : [concept.split, concept.join]; // every role the class can play
      for (const dataConcept of Object.keys(data ?? {}) as DataConcept[]) {
        for (const each of concepts) expect(DATA_CONCEPT_OWNERS[dataConcept], className).toContain(each); // e.g. TransitionCondition only on SequenceFlow
      }
    }
  });
});
