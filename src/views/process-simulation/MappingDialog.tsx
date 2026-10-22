/**
 * The concept-mapping popup of the process simulation (plan 5.2): one row per element
 * of the open model, where the user chooses the element's simulation concept and, for
 * the concepts that read data, which of the element's attributes holds that data.
 *
 * Used by: AppLayout, which mounts it closed; the "Process Simulation" menu opens it
 * through uiStore ("processSimulationMapping").
 *
 * Deliberately NOT here:
 * - It never changes the model. It only changes the mapping, which lives apart from the
 *   model in the browser's localStorage and can be exported and imported as a file.
 * - No mapping rules. What a valid mapping is, and how it is saved, exported and
 *   imported, lives in mapping.ts; this file only shows it and passes the user's choices on.
 * - No concept is proposed or derived: every concept is chosen by the user (plan 0).
 *
 * Source: spec 2.2 (a data concept is chosen together with its element concept),
 * spec 3 (the mapping is made per model element; unmapped elements are ignored).
 */
import { useEffect, useState, type ChangeEvent, type ReactElement } from "react";
import {
  Alert,
  Box,
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  MenuItem,
  Select,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableRow,
  TextField,
  Tooltip,
  Typography,
} from "@mui/material";
import type { ClassInstance, RoleInstance, SceneInstance, SceneType } from "@gds";
import { globalClassObject, globalObject } from "@/engine";
import { NAME_ATTRIBUTE_UUID } from "@/constants";
import { logger } from "@/resources/services/logger";
import { describeError } from "@/resources/util/describe-error";
import { useUiStore } from "@/resources/store/uiStore";
import {
  createEmptyMapping,
  loadMapping,
  readMapping,
  saveMapping,
  setElementConcept,
  setElementData,
  writeMapping,
  type ElementMapping,
  type MappableModel,
  type ProcessSimulationMapping,
} from "@/resources/process-simulation/mapping";
import {
  DATA_CONCEPT_MEANINGS,
  DATA_CONCEPT_OWNERS,
  DATA_CONCEPTS,
  ELEMENT_CONCEPT_MEANINGS,
  ELEMENT_CONCEPTS,
  type ElementConcept,
} from "@/resources/process-simulation/vocabulary";

/** One row of the popup: an element and what the user needs to recognise it. */
interface ElementRow {
  id: string; // uuid of the element, and the key of its entry in the mapping
  label: string; // its name; for a relation also "source → target", since flows are rarely named
  metaclassId: string; // the icon belongs to the metaclass, so rows of one metaclass share it
  metaclassName: string; // e.g. "Task 2.0", shown next to the name
  attributes: { id: string; name: string }[]; // its own attribute instances, offered by name as the data attribute
}

/** The open model as the popup needs it. */
interface ModelView {
  sceneName: string; // shown in the title and used for the export file name
  rows: ElementRow[]; // the elements, in display order
  model: MappableModel; // what mapping.ts checks a mapping against
}

/** A message about the last load or import, shown above the table. */
interface Notice {
  severity: "success" | "warning" | "error"; // decides the colour of the MUI Alert
  lines: string[]; // one line per message, so a list of left-out entries stays readable
}

const DIALOG = "processSimulationMapping"; // the uiStore name, written once so open and close cannot disagree

/**
 * Turns the open model into the rows of the popup: one row per element the user can map.
 *
 * Example. A BPMN 2.0 model with the tasks "Check stock" and "Ship" and an unnamed
 * sequence flow between them becomes three rows:
 *
 *   label                              metaclassName        attributes
 *   "(unnamed) (Check stock → Ship)"   "Sequence Flow 2.0"  Name, Transition Condition Table 2.0
 *   "Check stock"                      "Task 2.0"           Name
 *   "Ship"                             "Task 2.0"           Name
 *
 * It also returns the same elements as a `MappableModel`: the plain list
 * "element uuid -> uuids of its attribute instances" that mapping.ts checks a mapping
 * against.
 *
 * Bendpoints are left out. When a line is drawn with kinks, MMAR stores every kink as a
 * class instance of its own. Such a kink is not a model element anyone would map, and
 * the model tree hides them for the same reason.
 */
function describeModel(sceneType: SceneType, sceneInstance: SceneInstance): ModelView {
  // All metaclasses of the open scene type in one list. A Relationclass extends Class,
  // so classes ("Task 2.0") and relation classes ("Sequence Flow 2.0") fit into one
  // array. Below it is used to find an element's metaclass name and attribute names.
  const metaclasses = [...sceneType.classes, ...sceneType.relationclasses];

  // The uuids of the bendpoint classes. Every relation class names the class of its
  // kinks in `bendpoint`; it is undefined when its lines have none, as in BPMN 2.0.
  const bendpointClasses = new Set(sceneType.relationclasses.map((relationclass) => relationclass.bendpoint));

  // The class instances that are real elements: every class instance except the kinks.
  const classInstances = sceneInstance.class_instances.filter((instance) => !bendpointClasses.has(instance.uuid_class));

  // An element's name is the value of its standard Name attribute, which every
  // metamodel has (NAME_ATTRIBUTE_UUID; the model tree reads names the same way). An
  // empty value is shown as "(unnamed)", so no row is ever blank.
  const nameOf = (instance: ClassInstance) =>
    instance.attribute_instance?.find((attribute) => attribute.uuid_attribute === NAME_ATTRIBUTE_UUID)?.value || "(unnamed)";

  // Element uuid -> name, built once up front, so the two ends of every relation can be
  // named without searching all class instances again for each relation.
  const names = new Map(classInstances.map((instance) => [instance.uuid, nameOf(instance)]));

  // The name of one end of a relation. A relation does not point at its ends directly
  // but through a role instance, whose `uuid_has_reference_class_instance` holds the
  // uuid of the connected element (see NOTES.md, question 5). "?" when the end is not a
  // class instance, e.g. a port.
  const endOf = (role: RoleInstance | undefined) => names.get(role?.uuid_has_reference_class_instance ?? "") ?? "?";

  // Builds one row (an ElementRow). The caller passes the metaclass uuid and the label, because class
  // instances and relations differ in both: a class instance keeps its metaclass in
  // `uuid_class`, a relation in `uuid_relationclass`, and only relations show their ends.
  const buildRow = (instance: ClassInstance, metaclassId: string, label: string): ElementRow => {
    // The element's metaclass, for its display name and for the names of its attributes.
    const metaclass = metaclasses.find((candidate) => candidate.uuid === metaclassId);
    return {
      id: instance.uuid, // the element's uuid: the key of its entry in the mapping
      label, // what the user reads in the "Element" column
      metaclassId, // the icon belongs to the metaclass, so it is looked up by this uuid
      metaclassName: metaclass?.name ?? "", // e.g. "Task 2.0"; empty rather than failing if the metamodel lacks it
      // The element's own attribute instances, offered in the second dropdown. An
      // attribute instance only carries the uuid of its meta attribute (`uuid_attribute`);
      // the readable name, e.g. "Transition Condition Table 2.0", is on the meta attribute.
      attributes: (instance.attribute_instance ?? []).map((attribute) => ({
        id: attribute.uuid, // what the mapping stores: this element's own attribute instance (decided in Phase 3)
        name: metaclass?.attributes.find((meta) => meta.uuid === attribute.uuid_attribute)?.name ?? attribute.uuid_attribute, // shown to the user; the uuid only if no name is found
      })),
    };
  };

  // One row per class instance: tasks, gateways, events, variables.
  const classRows = classInstances.map((instance) => buildRow(instance, instance.uuid_class, nameOf(instance)));

  // One row per relation: sequence flows and draws. They are labelled
  // "name (source → target)", because flows are rarely renamed: they would otherwise all
  // show the same default name (in BPMN 2.0 the Name default is "Name"), or "(unnamed)"
  // when the name is empty.
  const relationRows = sceneInstance.relationclasses_instances.map((relation) => {
    const ends = `${endOf(relation.role_instance_from)} → ${endOf(relation.role_instance_to)}`; // e.g. "Check stock → Ship"
    return buildRow(relation, relation.uuid_relationclass, `${nameOf(relation)} (${ends})`);
  });

  // Sorted by metaclass, then by label: all tasks stand together, all flows together,
  // so the elements of one kind can be mapped one after another.
  const rows = [...classRows, ...relationRows].sort(
    (a, b) => a.metaclassName.localeCompare(b.metaclassName) || a.label.localeCompare(b.label),
  );

  return {
    sceneName: sceneInstance.name ?? "", // shown in the title and used in the export file name; a new scene may have none
    rows, // the content of the table
    // The same elements as the plain list mapping.ts checks against. Only elements with a
    // row are in it, so a bendpoint can never end up in a mapping.
    model: {
      sceneInstanceId: sceneInstance.uuid, // an imported mapping file of another model is refused against this
      elementAttributes: Object.fromEntries(rows.map((r) => [r.id, r.attributes.map((attribute) => attribute.id)])), // element uuid -> its attribute instance uuids
    },
  };
}

/** The palette icon of every metaclass, by metaclass uuid. Read from the vizRep code, as the palette does. */
async function loadIcons(sceneType: SceneType): Promise<Record<string, string>> {
  const metaclasses = [...sceneType.classes, ...sceneType.relationclasses]; // relations have icons in the palette too
  const icons = await Promise.all(metaclasses.map((metaclass) => globalClassObject.getIcon(String(metaclass.geometry ?? "")))); // geometry is a string at runtime
  return Object.fromEntries(metaclasses.map((metaclass, index) => [metaclass.uuid, icons[index]])); // Promise.all keeps the order
}

/**
 * The hover tooltip of a dropdown field, explaining its current choice. It hides while the
 * dropdown's own list is open: the list items explain themselves there, and two
 * explanations at once would only confuse.
 */
function DropdownHint({ title, listOpen, children }: { title: string; listOpen: boolean; children: ReactElement }) {
  // Whether the pointer is over the field. Kept here and not in the dialog, so moving the
  // pointer re-renders only this tooltip and not the whole table.
  const [hovered, setHovered] = useState(false);
  return (
    <Tooltip
      title={title} // an empty title shows no tooltip at all, e.g. before a concept is chosen
      placement="top" // above the field, so it covers no neighbouring column
      describeChild // the field keeps its own accessible name; the hint only describes it
      open={hovered && !listOpen} // shown while hovered, except while the list is open
      onOpen={() => setHovered(true)} // MUI asks to open on hover; remember it
      onClose={() => setHovered(false)} // MUI asks to close when the pointer leaves
    >
      {children}
    </Tooltip>
  );
}

export default function MappingDialog() {
  const open = useUiStore((s) => s.dialogs[DIALOG]); // hook form: the dialog re-renders when it is opened or closed
  const closeDialog = useUiStore((s) => s.closeDialog); // stable function from the store
  const [view, setView] = useState<ModelView | null>(null); // null when no model is open
  const [mapping, setMapping] = useState<ProcessSimulationMapping | null>(null); // the mapping being edited
  const [icons, setIcons] = useState<Record<string, string>>({}); // filled asynchronously, rows render without them meanwhile
  const [notice, setNotice] = useState<Notice | null>(null); // the message of the last load or import
  const [openList, setOpenList] = useState<string | null>(null); // which dropdown's list is open ("<element uuid>:concept" or ":data"), so its hint can hide

  // Every time the dialog opens: read the open model, and load its saved mapping.
  useEffect(() => {
    if (!open) return; // nothing to prepare while closed
    const tab = globalObject.tabContext[globalObject.selectedTab]; // "no tab open" means this entry is undefined
    setNotice(null); // a message from the last opening no longer applies
    if (!tab) {
      setView(null); // the dialog then asks for a model to be opened
      setMapping(null); // nothing to edit
      return; // and nothing to load
    }
    const described = describeModel(tab.sceneType, tab.sceneInstance); // rows and the model to check against
    const loaded = loadMapping(described.model, window.localStorage); // elements deleted since the last visit are left out silently
    setView(described); // show the rows
    setMapping(loaded.ok ? loaded.mapping : createEmptyMapping(described.model.sceneInstanceId)); // an unreadable stored mapping is discarded
    if (!loaded.ok) setNotice({ severity: "warning", lines: [loaded.reason, "Starting with an empty mapping."] }); // say why it is empty
    let current = true; // false once the dialog closed or reopened, so a slow icon load cannot overwrite newer state
    void loadIcons(tab.sceneType)
      .then((loadedIcons) => current && setIcons(loadedIcons)) // only for the opening that asked for them
      .catch((err) => logger.log("Could not load the element icons: " + describeError(err), "close")); // rows still work without icons
    return () => {
      current = false; // this opening is over
    };
  }, [open]);

  /** Shows a changed mapping and saves it at once, so it survives a reload. */
  function update(next: ProcessSimulationMapping) {
    setMapping(next); // show the change
    if (!saveMapping(next, window.localStorage)) {
      logger.log("The concept mapping could not be saved in the browser. Export it to keep it.", "error"); // "error" raises the snackbar
    }
  }

  /** Downloads the mapping as a JSON file. */
  function exportMapping(current: ProcessSimulationMapping, sceneName: string) {
    const link = document.createElement("a"); // a temporary link is how a browser is made to download text
    link.href = URL.createObjectURL(new Blob([writeMapping(current)], { type: "application/json" })); // the file's content
    link.download = `${sceneName || "model"} - concept mapping.json`; // named after the model, so files of several models stay apart
    link.click(); // starts the download
    URL.revokeObjectURL(link.href); // the download has its own copy, so the URL can be released
  }

  /** Reads a mapping file chosen by the user and reports what could not be taken over. */
  async function importMapping(event: ChangeEvent<HTMLInputElement>, current: ModelView) {
    const file = event.target.files?.[0]; // one file: a mapping belongs to one model
    event.target.value = ""; // so choosing the same file again fires onChange again
    if (!file) return; // the user cancelled the file picker
    const result = readMapping(await file.text(), current.model); // all checks live in mapping.ts
    if (!result.ok) {
      setNotice({ severity: "error", lines: [result.reason] }); // the current mapping stays as it was
      return; // nothing to take over
    }
    update(result.mapping); // take it over and save it
    // "Name (Metaclass)" for an element that still exists. A deleted element has no row any
    // more, and the file stores only uuids, so its uuid is all that can be shown.
    const labelOf = (id: string) => {
      const row = current.rows.find((candidate) => candidate.id === id); // the element's row, if it still exists
      return row ? `${row.label} (${row.metaclassName})` : id; // e.g. "Check stock (Task 2.0)"
    };
    setNotice(
      result.dropped.length === 0
        ? { severity: "success", lines: ["Mapping imported."] } // everything fitted
        : { severity: "warning", lines: ["Mapping imported. Left out:", ...result.dropped.map((d) => `${labelOf(d.elementId)}: ${d.reason}`)] }, // one line per left-out entry
    );
  }

  return (
    <Dialog open={open} onClose={() => closeDialog(DIALOG)} maxWidth="lg" fullWidth>
      <DialogTitle>Concept Mapping{view ? `: ${view.sceneName}` : ""}</DialogTitle>
      <DialogContent>
        {!view || !mapping ? (
          // without an open model there is nothing to map
          <Typography>Open a model first. The mapping belongs to the model in the active tab.</Typography>
        ) : (
          <Stack spacing={2}>
            {notice && (
              // the result of the last load or import, until the user dismisses it
              <Alert severity={notice.severity} onClose={() => setNotice(null)}>
                {notice.lines.map((line, index) => (
                  <div key={index}>{line}</div> // lines never reorder, so the index is a stable key
                ))}
              </Alert>
            )}
            <Table size="small" stickyHeader>
              <TableHead>
                <TableRow>
                  <TableCell>{/* icon column, needs no heading */}</TableCell>
                  <TableCell>Element</TableCell>
                  <TableCell>Metaclass</TableCell>
                  <TableCell>Concept</TableCell>
                  <TableCell>Attribute</TableCell>
                  <TableCell>Status</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {view.rows.map((row) => {
                  const entry: ElementMapping | undefined = mapping.elements[row.id]; // undefined while the element is unmapped
                  const dataConcept = DATA_CONCEPTS.find((data) => DATA_CONCEPT_OWNERS[data] === entry?.concept); // the data its concept reads, if any (spec 2.2)
                  return (
                    <TableRow key={row.id}>
                      <TableCell>
                        {icons[row.metaclassId] && <Box component="img" src={icons[row.metaclassId]} alt="" sx={{ width: 28, height: 28, objectFit: "contain" }} />}
                      </TableCell>
                      <TableCell>{row.label}</TableCell>
                      <TableCell>{row.metaclassName}</TableCell>
                      <TableCell>
                        {/* first dropdown: the concept; the empty entry unmaps the element.
                            Hovering the whole field explains the chosen concept (spec 2.1), like the
                            attribute dropdown; with no concept chosen there is nothing to explain. */}
                        <DropdownHint title={entry ? ELEMENT_CONCEPT_MEANINGS[entry.concept] : ""} listOpen={openList === `${row.id}:concept`}>
                          <Select
                            size="small"
                            displayEmpty
                            value={entry?.concept ?? ""}
                            inputProps={{ "aria-label": `Concept of ${row.label}` }}
                            onChange={(e) => update(setElementConcept(mapping, row.id, (e.target.value || undefined) as ElementConcept | undefined))}
                            onOpen={() => setOpenList(`${row.id}:concept`)} // hide the field's hint while the list is open
                            onClose={() => setOpenList(null)} // and allow it again once the list is closed
                            renderValue={(value) => value || <em>none</em>} // plain text in the closed field, so the list items' tooltips are not shown there a second time
                            sx={{ minWidth: 210 }}
                          >
                            <MenuItem value="">
                              <em>none</em>
                            </MenuItem>
                            {ELEMENT_CONCEPTS.map((concept) => (
                              <MenuItem key={concept} value={concept}>
                                {/* In the open list every concept explains itself while it is hovered.
                                    display: block lets the whole row, not just the word, trigger it. */}
                                <Tooltip title={ELEMENT_CONCEPT_MEANINGS[concept]} placement="right" describeChild>
                                  <Box component="span" sx={{ display: "block", width: "100%" }}>
                                    {concept}
                                  </Box>
                                </Tooltip>
                              </MenuItem>
                            ))}
                          </Select>
                        </DropdownHint>
                      </TableCell>
                      <TableCell>
                        {/* second dropdown: only for concepts that read data from the element (spec 2.2).
                            Its label names the data concept and stays visible after a choice, so the user
                            always sees what the chosen attribute stands for; the tooltip says what that
                            data concept means. No attribute is preselected: the user chooses (plan 0). */}
                        {dataConcept && (
                          <DropdownHint title={DATA_CONCEPT_MEANINGS[dataConcept]} listOpen={openList === `${row.id}:data`}>
                            <TextField
                              select
                              size="small"
                              label={dataConcept}
                              value={entry?.data?.[dataConcept] ?? ""}
                              onChange={(e) => update(setElementData(mapping, row.id, dataConcept, e.target.value || undefined))}
                              slotProps={{
                                select: {
                                  onOpen: () => setOpenList(`${row.id}:data`), // hide the field's hint while the list is open
                                  onClose: () => setOpenList(null), // and allow it again once the list is closed
                                },
                              }}
                              sx={{ minWidth: 260 }}
                            >
                              <MenuItem value="">
                                <em>none</em>
                              </MenuItem>
                              {row.attributes.map((attribute) => (
                                <MenuItem key={attribute.id} value={attribute.id}>
                                  {attribute.name}
                                </MenuItem>
                              ))}
                            </TextField>
                          </DropdownHint>
                        )}
                      </TableCell>
                      <TableCell>
                        {/* plan 5.2: show which elements still have no concept. "mapped" only means a
                            concept is chosen; whether the mapping is complete (e.g. a missing condition)
                            is the validator's verdict before a run (spec 10), not shown here. */}
                        {/* color takes a palette name ("success"), not a path ("success.main"):
                            MUI 9 silently ignores a path here and the text stays black */}
                        {entry ? (
                          <Typography variant="body2" color="success">mapped</Typography>
                        ) : (
                          <Typography variant="body2" color="warning">not mapped</Typography>
                        )}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </Stack>
        )}
      </DialogContent>
      <DialogActions>
        {view && mapping && (
          <>
            {/* a hidden file input inside a button: the same pattern as the model import dialog */}
            <Button component="label">
              Import…
              <input
                hidden
                type="file"
                accept=".json,application/json"
                onChange={(e) => void importMapping(e, view).catch((err) => logger.log("Import failed: " + describeError(err), "error"))}
              />
            </Button>
            <Button onClick={() => exportMapping(mapping, view.sceneName)}>Export</Button>
          </>
        )}
        <Button onClick={() => closeDialog(DIALOG)}>Close</Button>
      </DialogActions>
    </Dialog>
  );
}
