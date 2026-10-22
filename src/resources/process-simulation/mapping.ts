/**
 * The mapping of one model onto the simulation concepts: which concept each model
 * element plays, and which of the element's attributes holds the data that concept
 * needs. It is the "configuration file" of plan 5.1, kept in the browser and
 * exportable as a JSON file.
 *
 * Used by: the mapping dialog (it changes a mapping through `setElementConcept` and
 * `setElementData`, and exports and imports it), whatever keeps the mapping in
 * localStorage (`saveMapping` / `loadMapping`), and later the transformer, which reads
 * a mapping together with the model.
 *
 * Deliberately NOT here:
 * - No gds classes and no access to the open model. Callers describe the model as a
 *   plain `MappableModel`, so this file can move into a library with the algorithm
 *   (plan 1.5).
 * - No browser API. The storage is passed in, and choosing, reading or downloading a
 *   file is the dialog's job; this file only turns a mapping into text and back.
 * - No judgement about whether the mapping describes a sensible process. An element
 *   without a concept is simply ignored (spec 3), and checks such as "exactly one
 *   Start" or "every outgoing flow of a Decision has a condition" belong to the
 *   validator (spec 10).
 * - No format version. Text that does not have the shape below is discarded whole.
 *
 * Source: spec 2.2 (a data concept is mapped together with its element concept, by
 * naming the attribute that holds it) and spec 3 (the mapping is made per model
 * element; elements that are not mapped are ignored).
 */
import { DATA_CONCEPT_OWNERS, DATA_CONCEPTS, ELEMENT_CONCEPTS } from "./vocabulary"; // the only names a mapping may contain
import type { DataConcept, ElementConcept } from "./vocabulary"; // relative import keeps the folder free of app aliases, for a later library

// ---------------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------------

/** The concept one model element plays, and where its data is. */
export interface ElementMapping {
  concept: ElementConcept; // exactly one concept per element (spec 3)
  data?: Partial<Record<DataConcept, string>>; // data concept -> uuid of this element's own attribute instance; absent until one is chosen
}

/** The mapping of one model. */
export interface ProcessSimulationMapping {
  sceneInstanceId: string; // the model it belongs to, so a mapping of another model can be refused
  elements: Record<string, ElementMapping>; // element uuid -> its mapping; an element missing here is ignored by the simulation (spec 3)
}

/** The open model, reduced to what a mapping may refer to. Built by the caller from the loaded scene. */
export interface MappableModel {
  sceneInstanceId: string; // compared with a mapping's own, to refuse a mapping of another model
  elementAttributes: Record<string, readonly string[]>; // element uuid -> uuids of that element's own attribute instances
}

/** Something left out of a mapping because it does not fit the model. */
export interface DroppedEntry {
  elementId: string; // the element it concerned, so the dialog can name it instead of showing a uuid
  reason: string; // shown to the user, so it speaks about the model and not about this file's structures
}

/** The outcome of reading a mapping from text. */
export type MappingReadResult =
  | { ok: true; mapping: ProcessSimulationMapping; dropped: DroppedEntry[] } // usable; `dropped` lists what did not fit
  | { ok: false; reason: string }; // nothing usable: the caller keeps its current mapping or starts an empty one

/** The part of the Web Storage API this file uses. `window.localStorage` is one; tests pass a fake. */
export type MappingStorage = Pick<Storage, "getItem" | "setItem">;

// ---------------------------------------------------------------------------------
// Creating and changing a mapping
// ---------------------------------------------------------------------------------

/** A mapping in which no element has a concept yet, so the simulation ignores them all (spec 3). */
export function createEmptyMapping(sceneInstanceId: string): ProcessSimulationMapping {
  return { sceneInstanceId, elements: {} }; // nothing is mapped until the user maps it: concepts are never derived (plan 0)
}

/**
 * Gives an element a concept, or takes its concept away with `undefined`.
 *
 * Returns a new mapping and leaves the given one untouched, so a store holding the old
 * one notices the change. Data chosen for the previous concept is kept only where it
 * belongs to the new one (spec 2.2): a condition attribute means nothing once the
 * element is an Activity.
 */
export function setElementConcept(
  mapping: ProcessSimulationMapping, // the mapping to start from; it is not modified
  elementId: string, // uuid of the model element
  concept: ElementConcept | undefined, // undefined unmaps the element
): ProcessSimulationMapping {
  const elements = { ...mapping.elements }; // a copy, because callers may still hold the old object
  if (concept === undefined) {
    delete elements[elementId]; // unmapped means absent, so a saved mapping lists only mapped elements
    return { ...mapping, elements }; // a new object, so a store sees the change
  }
  const data = keepOwnedData(mapping.elements[elementId]?.data, concept); // carry over only what still fits the new concept
  elements[elementId] = data ? { concept, data } : { concept }; // no empty `data`, so equal mappings write equal text
  return { ...mapping, elements }; // a new object, so a store sees the change
}

/**
 * Names the attribute instance that holds a data concept of an element, or clears it
 * with `undefined`.
 *
 * Returns the mapping unchanged when the element's concept is not the one the data
 * concept belongs to (spec 2.2). The dialog only offers the data concept of the chosen
 * concept, so this only guards against a wrong call writing an entry the simulation
 * could never use.
 */
export function setElementData(
  mapping: ProcessSimulationMapping, // the mapping to start from; it is not modified
  elementId: string, // uuid of the model element
  dataConcept: DataConcept, // which data the attribute holds
  attributeId: string | undefined, // uuid of one of the element's own attribute instances; undefined clears the choice
): ProcessSimulationMapping {
  const current = mapping.elements[elementId]; // the data can only be set on an element that already has a concept
  if (!current || DATA_CONCEPT_OWNERS[dataConcept] !== current.concept) return mapping; // wrong owner: nothing sensible to write
  const data = { ...current.data }; // a copy, for the same reason as in setElementConcept
  if (attributeId === undefined) delete data[dataConcept]; // clearing removes the key rather than storing an empty value
  else data[dataConcept] = attributeId; // one attribute per data concept: a new choice replaces the old one
  const entry: ElementMapping = Object.keys(data).length > 0 ? { concept: current.concept, data } : { concept: current.concept }; // no empty `data`
  return { ...mapping, elements: { ...mapping.elements, [elementId]: entry } }; // new objects on every level that changed
}

// ---------------------------------------------------------------------------------
// Fitting a mapping to the model
// ---------------------------------------------------------------------------------

/**
 * Fits a mapping to the model as it is now: drops every entry that refers to an
 * element, concept or attribute the model or the vocabulary does not have, and
 * reports each drop.
 *
 * Models change after a mapping was made (an element or attribute is deleted), so
 * this runs on every mapping that is read. It checks only what plan 5.1 asks of the
 * mapping itself: known concepts and uuids that exist in the model. It assumes the
 * mapping belongs to this model; `readMapping` checks that first.
 */
export function validateMapping(
  mapping: ProcessSimulationMapping, // the mapping to check; it is not modified
  model: MappableModel, // the open model
): { mapping: ProcessSimulationMapping; dropped: DroppedEntry[] } {
  const { elements, dropped } = fitElements(mapping.elements, model); // the same checks an imported file goes through
  return { mapping: { sceneInstanceId: mapping.sceneInstanceId, elements }, dropped }; // a new mapping, the input stays as it was
}

// ---------------------------------------------------------------------------------
// Export and import as text
// ---------------------------------------------------------------------------------

/** The mapping as JSON text, for an exported file or for localStorage. */
export function writeMapping(mapping: ProcessSimulationMapping): string {
  const content = { sceneInstanceId: mapping.sceneInstanceId, elements: mapping.elements }; // only the two fields of the format, so nothing else on the object leaks out
  return JSON.stringify(content, null, 2); // indented, because people open exported files to look at them
}

/**
 * Reads a mapping from JSON text, such as an imported file.
 *
 * Refused whole: text that is not JSON, JSON without the shape of a mapping, and a
 * mapping of another model (its elements have other uuids, so none would fit).
 * Otherwise every entry goes through `validateMapping`'s checks, and what does not fit
 * is left out and listed in `dropped`.
 */
export function readMapping(text: string, model: MappableModel): MappingReadResult {
  let parsed: unknown; // unknown, because the text may come from any file the user picks
  try {
    parsed = JSON.parse(text); // the only step that can throw
  } catch {
    return { ok: false, reason: "The file is not a process-simulation mapping: it is not valid JSON." }; // e.g. an exported model or a picture
  }
  if (!isPlainObject(parsed) || typeof parsed.sceneInstanceId !== "string" || !isPlainObject(parsed.elements)) {
    return { ok: false, reason: "The file does not have the structure of a process-simulation mapping." }; // other or older formats are discarded whole
  }
  if (parsed.sceneInstanceId !== model.sceneInstanceId) {
    return { ok: false, reason: "The mapping belongs to another model." }; // its element uuids cannot match this model's
  }
  const { elements, dropped } = fitElements(parsed.elements, model); // check every entry against the model and the vocabulary
  return { ok: true, mapping: { sceneInstanceId: model.sceneInstanceId, elements }, dropped }; // only checked entries make it into the result
}

// ---------------------------------------------------------------------------------
// Keeping the mapping in the browser
// ---------------------------------------------------------------------------------

/*
 * FUTURE WORK: where the mapping should live in the long run.
 *
 * For now the mapping is kept in the browser's localStorage, plus an exportable file,
 * because the implementation plan rules out changes to mmar-server, mmar-database and
 * the shared data structure for this version (plan 0 and 1.4). This is a deliberate
 * stopgap, not the target design.
 *
 * Everything else in MMAR that belongs to a model is stored on the server: scene
 * instances, metamodels, procedures, files and access rights. localStorage holds only
 * the login token and the panel layout. Limits of the current choice:
 * - The mapping exists in one browser only. A supervisor or collaborator who opens the
 *   same model does not see it, and clearing the browser data loses it.
 * - It belongs to the browser, not to the user, and ignores the model's access rights.
 * - Deleting a model leaves its mapping entry behind.
 *
 * Cleaner target: a server-side store of one mapping per scene instance, read and
 * written over REST under the same access rights as the scene. The mapping stays
 * separate from the model and refers to its elements by uuid only, so the simulation
 * remains independent of the modelling language. BPSim, the simulation standard for
 * BPMN, follows the same pattern: its scenario parameters refer to model elements by id.
 *
 * How to switch: only saveMapping and loadMapping below (and their two calls in
 * views/process-simulation/MappingDialog.tsx) touch storage. The mapping format, the
 * checks in this file and the simulation algorithm stay as they are.
 */

const STORAGE_KEY_PREFIX = "process-simulation-mapping:"; // in the process-simulation namespace (plan 0), apart from the client's own keys such as "jwtToken"

/** The storage key of a model's mapping: one entry per model, so opening a model finds its own. */
export function storageKey(sceneInstanceId: string): string {
  return STORAGE_KEY_PREFIX + sceneInstanceId; // the scene uuid is unique, so two models never share an entry
}

/**
 * Stores the mapping under its model's key. Returns false when the storage refuses
 * (it may be full, or blocked in a private window); the mapping in memory is still
 * valid, so the caller only has to tell the user that it will not survive a reload.
 */
export function saveMapping(mapping: ProcessSimulationMapping, storage: MappingStorage): boolean {
  try {
    storage.setItem(storageKey(mapping.sceneInstanceId), writeMapping(mapping)); // the same text as an export, so one reader serves both
    return true; // stored
  } catch {
    return false; // storage unavailable; reported to the caller instead of thrown into a click handler
  }
}

/**
 * Reads the stored mapping of a model. With nothing stored yet the result is an empty
 * mapping. A stored mapping goes through the same checks as an imported file, because
 * the model may have changed since it was saved.
 */
export function loadMapping(model: MappableModel, storage: MappingStorage): MappingReadResult {
  let text: string | null; // null is what the Storage API returns for a missing key
  try {
    text = storage.getItem(storageKey(model.sceneInstanceId)); // may throw where storage is blocked
  } catch {
    return { ok: false, reason: "The browser storage could not be read." }; // the caller starts with an empty mapping instead
  }
  if (text === null) return { ok: true, mapping: createEmptyMapping(model.sceneInstanceId), dropped: [] }; // first visit: everything unmapped
  return readMapping(text, model); // unreadable stored text is discarded like an unreadable file
}

// ---------------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------------

/** True for one of the element concepts; the list in vocabulary.ts is the only authority. */
function isElementConcept(value: unknown): value is ElementConcept {
  return (ELEMENT_CONCEPTS as readonly unknown[]).includes(value); // widened so any value can be looked up
}

/** True for one of the data concepts; the list in vocabulary.ts is the only authority. */
function isDataConcept(value: unknown): value is DataConcept {
  return (DATA_CONCEPTS as readonly unknown[]).includes(value); // widened so any value can be looked up
}

/** True for a JSON object. Arrays and null are of type "object" too and must not pass. */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value); // the three cases JSON can produce under "object"
}

/** The data of `data` that belongs to `concept` (spec 2.2), or undefined when none does. */
function keepOwnedData(
  data: Partial<Record<DataConcept, string>> | undefined, // the data chosen so far, if any
  concept: ElementConcept, // the concept the element has now
): Partial<Record<DataConcept, string>> | undefined {
  if (!data) return undefined; // nothing chosen yet, nothing to keep
  const kept: Partial<Record<DataConcept, string>> = {}; // built afresh so the result shares nothing with the input
  for (const dataConcept of DATA_CONCEPTS) {
    // walking the known data concepts, not the object's keys, so a stray key cannot slip through
    const attributeId = data[dataConcept]; // the attribute chosen for this data concept, if any
    if (attributeId !== undefined && DATA_CONCEPT_OWNERS[dataConcept] === concept) kept[dataConcept] = attributeId; // only data owned by the concept
  }
  return Object.keys(kept).length > 0 ? kept : undefined; // no empty `data`, so equal mappings write equal text
}

/**
 * Checks raw entries (from a file, or from a mapping already in memory) against the
 * model and the vocabulary. An entry that fails is dropped whole when its element or
 * concept is unknown, and loses only the failing data assignment otherwise.
 */
function fitElements(
  rawElements: Record<string, unknown>, // unknown values, because they may come straight from JSON
  model: MappableModel, // the open model
): { elements: Record<string, ElementMapping>; dropped: DroppedEntry[] } {
  const elements: Record<string, ElementMapping> = {}; // only entries that passed every check end up here
  const dropped: DroppedEntry[] = []; // every drop is reported, so nothing disappears silently
  for (const [elementId, rawEntry] of Object.entries(rawElements)) {
    // Object.hasOwn and not `in` or indexing: a key such as "__proto__" in a file must not match the prototype
    if (!Object.hasOwn(model.elementAttributes, elementId)) {
      dropped.push({ elementId, reason: "The element no longer exists in the model." }); // deleted since the mapping was made
      continue; // nothing else about this entry can be checked
    }
    const concept = isPlainObject(rawEntry) ? rawEntry.concept : undefined; // a malformed entry has no concept to read
    if (!isPlainObject(rawEntry) || !isElementConcept(concept)) {
      dropped.push({ elementId, reason: `"${String(concept)}" is not a simulation concept.` }); // e.g. a misspelt or renamed concept
      continue; // without a concept the element is unmapped, which the simulation ignores (spec 3)
    }
    const attributeIds = model.elementAttributes[elementId]; // the attributes this element really has
    const data: Partial<Record<DataConcept, string>> = {}; // the data assignments that pass
    const rawData = rawEntry.data; // optional: absent until the user chooses an attribute
    if (rawData !== undefined && !isPlainObject(rawData)) {
      dropped.push({ elementId, reason: "The attribute assignments of the element could not be read." }); // keep the concept, lose the data
    } else if (rawData !== undefined) {
      for (const [key, attributeId] of Object.entries(rawData)) {
        // each data assignment is checked on its own, so one bad choice does not cost the others
        if (!isDataConcept(key)) {
          dropped.push({ elementId, reason: `"${key}" is not a data concept.` }); // unknown key in the file
        } else if (DATA_CONCEPT_OWNERS[key] !== concept) {
          dropped.push({ elementId, reason: `${key} belongs to ${DATA_CONCEPT_OWNERS[key]}, not to ${concept}.` }); // spec 2.2
        } else if (typeof attributeId !== "string" || !attributeIds.includes(attributeId)) {
          dropped.push({ elementId, reason: `The attribute chosen as ${key} is no longer an attribute of the element.` }); // deleted or foreign attribute
        } else {
          data[key] = attributeId; // passed every check
        }
      }
    }
    elements[elementId] = Object.keys(data).length > 0 ? { concept, data } : { concept }; // the concept survives even if its data did not
  }
  return { elements, dropped }; // the caller wraps this into a mapping
}
