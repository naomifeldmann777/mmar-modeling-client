import { useCallback, useEffect, useState } from "react";
import ChevronRightIcon from "@mui/icons-material/ChevronRight"; // a folded scene type in "Show elements from"
import ExpandMoreIcon from "@mui/icons-material/ExpandMore"; // an unfolded one
import { v4 as uuidv4 } from "uuid";
import {
  Box,
  Button,
  Checkbox,
  Collapse,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  FormControl,
  FormControlLabel,
  IconButton,
  InputLabel,
  MenuItem,
  Select,
  Stack,
  TextField,
  Typography,
} from "@mui/material";
import type {
  Attribute,
  AttributeInstance,
  ClassInstance,
  PortInstance,
  RelationclassInstance,
  Role,
  RoleInstance,
  SceneInstance,
} from "@gds";
import { globalObject, instanceCreationHandler } from "@/engine";
import { hybridAlgorithmsService } from "@/engine/hybrid-algorithms/hybrid-algorithms-service";
import { markActiveSceneDirty } from "@/resources/collaboration/local-change-publisher";
import { historyService } from "@/resources/services/history-service";
import { instanceUtility } from "@/resources/services/instance-utility";
import { metaUtility } from "@/resources/services/meta-utility";
import { expressionUtility } from "@/resources/services/expression-utility";
import { loadAllSceneInstances } from "@/resources/services/scene-tree-service";
import { eventBus, type OpenReferenceDialogPayload } from "@/resources/services/event-bus";
import { logger } from "@/resources/services/logger";
import { describeError } from "@/resources/util/describe-error";
import { useSelectionStore } from "@/resources/store/selectionStore";
import { useUiStore } from "@/resources/store/uiStore";
import { NAME_ATTRIBUTE_UUID } from "@/constants";

/**
 * Lets the user point a reference attribute at another instance — a scene, class,
 * relation class or port — constrained to what the attribute type's Role allows.
 *
 * ONE dialog is shared by every reference button in the attribute window: the clicked
 * attribute arrives as context on the `openReferenceDialog` channel, while uiStore's
 * `referenceAttribute` flag controls visibility.
 *
 * Choosing a target creates the role instance that records the reference and writes its
 * name into the attribute's value, then runs the hybrid algorithms — which is what makes
 * a Statechange Reference adopt the mesh of what it now points at.
 *
 * Which models the class, relation class and port pickers draw from: "Show elements from"
 * lists every loaded model that holds an element the Role allows, grouped under its scene
 * type, and the user ticks the ones to show: single models, or all models of a type with the
 * type's box. It is a list in the dialog, not a popup, so there is nothing to close; each type
 * folds in or out with its arrow. Only the model open in the current tab is ticked when the
 * dialog opens, and only its type unfolded, so a condition's variable is picked from its own
 * model unless the user asks for another one.
 * Each entry names its model ("lager | Bestellabwicklung | <uuid>"), so two variables called
 * "lager" in two models can be told apart. The scene instance picker (a reference to a whole
 * model) is not filtered: there the other models are the point.
 */
interface AllowedScene {
  sceneInstance: SceneInstance;
  parentRole: Role;
}
interface AllowedClass {
  classInstance: ClassInstance;
  parentRole: Role;
  scene: SceneInstance; // the model it belongs to, for the filter and its label
}
interface AllowedRelationclass {
  relationclassInstance: RelationclassInstance;
  parentRole: Role;
  scene: SceneInstance; // likewise
}
interface AllowedPort {
  portInstance: PortInstance;
  parentRole: Role;
  scene: SceneInstance; // likewise
}

/** A model the user can show the elements of, e.g. "Bestellabwicklung – current model". */
interface ModelOption {
  uuid: string; // the scene instance's uuid
  label: string; // its name, marked when it is the current model
}

/** The models of one scene type, listed under the type's name. */
interface ModelGroup {
  uuid: string; // the scene type's uuid
  name: string; // e.g. "BPMN 2.0"
  models: ModelOption[]; // in the order of the loaded models, the current one first
}


/** Same shape as the bus channel's payload (uiStore carries it too, for reopening). */
type Payload = OpenReferenceDialogPayload;

interface ReferenceAttributeDialogProps {
  /** Ask the attribute window to rebuild after the reference changed. */
  onChanged?: () => void;
}

export default function ReferenceAttributeDialog({ onChanged }: ReferenceAttributeDialogProps) {
  const open = useUiStore((s) => s.dialogs.referenceAttribute);
  const closeDialog = useUiStore((s) => s.closeDialog);

  const [attributeInstance, setAttributeInstance] = useState<AttributeInstance | null>(null);
  const [referenceRoleInstance, setReferenceRoleInstance] = useState<RoleInstance | null>(null);
  const [isLoading, setIsLoading] = useState(false);

  const [allowedSceneInstances, setAllowedSceneInstances] = useState<AllowedScene[]>([]);
  const [allowedClassInstances, setAllowedClassInstances] = useState<AllowedClass[]>([]);
  const [allowedRelationclassInstances, setAllowedRelationclassInstances] = useState<AllowedRelationclass[]>([]);
  const [allowedPortInstances, setAllowedPortInstances] = useState<AllowedPort[]>([]);

  const [selectedSceneUuid, setSelectedSceneUuid] = useState("");
  const [selectedClassUuid, setSelectedClassUuid] = useState("");
  const [selectedRelationclassUuid, setSelectedRelationclassUuid] = useState("");
  const [selectedPortUuid, setSelectedPortUuid] = useState("");

  const [modelGroups, setModelGroups] = useState<ModelGroup[]>([]); // the models with an element the Role allows, by scene type, the current one's type first
  const [shownModels, setShownModels] = useState<string[]>([]); // uuids of the ticked models: their elements are offered
  const [unfoldedTypes, setUnfoldedTypes] = useState<string[]>([]); // uuids of the scene types whose models are listed

  //reset all variables for new load
  const reset = useCallback(() => {
    setAttributeInstance(null);
    setReferenceRoleInstance(null);
    setAllowedSceneInstances([]);
    setAllowedClassInstances([]);
    setAllowedRelationclassInstances([]);
    setAllowedPortInstances([]);
    setSelectedSceneUuid("");
    setSelectedClassUuid("");
    setSelectedRelationclassUuid("");
    setSelectedPortUuid("");
    setModelGroups([]);
    setShownModels([]);
    setUnfoldedTypes([]);
  }, []);

  const load = useCallback(
    async (payload: Payload) => {
      setIsLoading(true);
      reset();

      // A reference may point at an instance in ANY scene, and the scene tree is lazy
      // now (scene-tree-service) — it only holds the SceneTypes the user expanded. The
      // collectAllowed* helpers below, and resolveReferenceName, walk
      // getAllSceneInstancesFromLocal, so without this the pickers would silently omit
      // whole scenes and an existing reference would render as its raw fallback name.
      await loadAllSceneInstances();

      const instance = payload.attributeInstance;
      setAttributeInstance(instance);

      const role = await resolveAttributeRole(instance, payload.metaAttribute);
      const roleInstance = instance.role_instance_from ?? null;
      if (roleInstance) {
        roleInstance.name = await resolveReferenceName(roleInstance);
      }
      setReferenceRoleInstance(roleInstance);

      if (role) {
        const { models, current } = await loadedModels(); // every loaded model, the open one in its live copy
        const classes = collectAllowedClassInstances(role, models); // each with the model it belongs to
        const relationclasses = collectAllowedRelationclassInstances(role, models);
        const ports = collectAllowedPortInstances(role, models);
        setAllowedSceneInstances(await collectAllowedSceneInstances(role)); // not filtered by model (see the top of the file)
        setAllowedClassInstances(classes);
        setAllowedRelationclassInstances(relationclasses);
        setAllowedPortInstances(ports);
        const holding = new Set([...classes, ...relationclasses, ...ports].map((entry) => entry.scene.uuid)); // models with something to offer
        const offered = models.filter((scene) => scene === current || holding.has(scene.uuid)); // the current model is always listed, even when it holds nothing
        const groups = groupByType(offered, current); // the current model's type first
        setModelGroups(groups);
        setUnfoldedTypes(current ? [current.uuid_scene_type] : groups.map((group) => group.uuid)); // the other types folded, so they are reached without scrolling; without an open model, all unfolded
        setShownModels(current ? [current.uuid] : offered.map((scene) => scene.uuid)); // only the current model at first; without an open model, all
      }
      setIsLoading(false);
    },
    [reset],
  );

  useEffect(() => {
    const sub = eventBus.subscribe("openReferenceDialog", (payload) => {
      void load(payload).catch((err) => {
        setIsLoading(false);
        logger.log("reference dialog failed to load: " + describeError(err), "error");
      });
    });
    return () => sub.dispose();
  }, [load]);

  /**
   * What every edit owes the rest of the app (see `applyFieldChange`). A reference needs
   * it as much as a typed value: without it a vizRep showing the reference stayed stale,
   * and the reference reached the server only if some later edit flagged the scene.
   */
  function announceChange(changed: AttributeInstance, label: string) {
    eventBus.publish("checkForVizRepUpdateByAttributeInstance", changed);
    markActiveSceneDirty();
    useSelectionStore.getState().bump();
    historyService.record(label);
  }

  // dialog-reference-attribute.ts:221
  async function deleteReferenceRoleInstance() {
    if (!attributeInstance || !referenceRoleInstance) return;
    const copyToLog = attributeInstance.role_instance_from;
    attributeInstance.role_instance_from = null as unknown as RoleInstance;

    //find role in globalObjectInstance.role_instances and delete it
    globalObject.role_instances = globalObject.role_instances.filter(
      (roleInstance) => roleInstance.uuid !== referenceRoleInstance.uuid,
    );

    setReferenceRoleInstance(null);

    //delete attributeInstance value
    attributeInstance.value = "...";

    //push to log file
    logger.log("RoleInstance Instance " + copyToLog.uuid + " deleted", "done");
    announceChange(attributeInstance, "remove reference");
    onChanged?.();
  }

  // dialog-reference-attribute.ts:238
  async function addReferenceRoleInstance(
    referencedInstance: { uuid: string } | undefined,
    parentRole: Role | undefined,
    instanceType: "sceneInstance" | "classInstance" | "relationclassInstance" | "portInstance",
  ) {
    if (!attributeInstance || !referencedInstance || !parentRole) return;

    // create the role instance
    const roleInstanceFrom = await instanceCreationHandler.createRoleInstance(
      uuidv4(),
      null as unknown as ClassInstance,
      null as unknown as PortInstance,
      "attribute_reference",
      null as unknown as string,
      "name_placeholder",
      parentRole.uuid,
    );

    // add the reference based on instanceType
    const referencedInstanceUUID = referencedInstance.uuid;
    if (instanceType === "sceneInstance") {
      roleInstanceFrom.uuid_has_reference_scene_instance = referencedInstanceUUID;
    } else if (instanceType === "classInstance") {
      roleInstanceFrom.uuid_has_reference_class_instance = referencedInstanceUUID;
    } else if (instanceType === "relationclassInstance") {
      roleInstanceFrom.uuid_has_reference_relationclass_instance = referencedInstanceUUID;
    } else if (instanceType === "portInstance") {
      roleInstanceFrom.uuid_has_reference_port_instance = referencedInstanceUUID;
    }

    // add reference...
    attributeInstance.role_instance_from = roleInstanceFrom;

    //refresh metadata
    roleInstanceFrom.name = await resolveReferenceName(roleInstanceFrom);
    setReferenceRoleInstance(roleInstanceFrom);

    // set attributeInstance value to the role_instance_from.name
    attributeInstance.value = roleInstanceFrom.name;

    // A Statechange Reference adopts the mesh of whatever it now points at.
    await hybridAlgorithmsService.checkHybridAlgorithms(attributeInstance);

    announceChange(attributeInstance, "set reference");
    onChanged?.();
  }

  function close() {
    closeDialog("referenceAttribute");
  }

  const showGroup = (length: number) => !isLoading && length > 0 && !referenceRoleInstance;

  // The pickers offer only the elements of the ticked models.
  const isShown = (entry: { scene: SceneInstance }) => shownModels.includes(entry.scene.uuid); // ticked in "Show elements from"
  const shownClasses = allowedClassInstances.filter(isShown);
  const shownRelationclasses = allowedRelationclassInstances.filter(isShown);
  const shownPorts = allowedPortInstances.filter(isShown);
  const elementCount = allowedClassInstances.length + allowedRelationclassInstances.length + allowedPortInstances.length; // before the filter: is there anything to filter?

  /** Shows the elements of the models `uuids`; a picked element may now be hidden, so the picks start over. */
  function showModels(uuids: string[]) {
    setShownModels(uuids);
    setSelectedClassUuid(""); // a pick from a model no longer shown would stay selected but invisible
    setSelectedRelationclassUuid("");
    setSelectedPortUuid("");
  }

  /** A model's box: ticks or unticks that model. */
  function toggleModel(uuid: string) {
    showModels(shownModels.includes(uuid) ? shownModels.filter((shown) => shown !== uuid) : [...shownModels, uuid]);
  }

  /** A scene type's box: ticks all its models, or unticks them all when they all are ticked. */
  function toggleType(group: ModelGroup) {
    const ofType = group.models.map((model) => model.uuid); // its models
    const allTicked = ofType.every((uuid) => shownModels.includes(uuid)); // then the click unticks them
    showModels(allTicked ? shownModels.filter((uuid) => !ofType.includes(uuid)) : [...new Set([...shownModels, ...ofType])]);
  }

  /** A scene type's arrow: lists its models, or hides them. */
  function toggleFold(typeUuid: string) {
    setUnfoldedTypes(unfoldedTypes.includes(typeUuid) ? unfoldedTypes.filter((uuid) => uuid !== typeUuid) : [...unfoldedTypes, typeUuid]);
  }

  return (
    <Dialog open={open} onClose={close} maxWidth="md" fullWidth>
      <DialogTitle>Reference Attribute: {attributeInstance?.name ?? ""}</DialogTitle>
      <DialogContent sx={{ minHeight: 500 }}>
        <Stack spacing={2} sx={{ mt: 1 }}>
          {referenceRoleInstance && (
            <Box sx={{ display: "flex", gap: 1 }}>
              <TextField
                sx={{ flex: 1 }}
                size="small"
                label={attributeInstance?.name ?? ""}
                value={referenceRoleInstance.name ?? ""}
                disabled
              />
              <Button variant="outlined" onClick={() => void deleteReferenceRoleInstance()}>
                delete
              </Button>
            </Box>
          )}

          {showGroup(allowedSceneInstances.length) && (
            <AllowedGroup
              label="Select Referenced SceneInstance"
              value={selectedSceneUuid}
              onChange={setSelectedSceneUuid}
              options={allowedSceneInstances.map((o) => ({
                uuid: o.sceneInstance.uuid,
                label: `${o.sceneInstance.name} | ${o.sceneInstance.uuid}`,
              }))}
              onAdd={() => {
                const picked = allowedSceneInstances.find((o) => o.sceneInstance.uuid === selectedSceneUuid);
                void addReferenceRoleInstance(picked?.sceneInstance, picked?.parentRole, "sceneInstance");
              }}
            />
          )}

          {showGroup(elementCount) && (
            <Box>
              <Typography variant="subtitle2">Show elements from</Typography>
              <Box sx={{ maxHeight: 220, overflowY: "auto", border: 1, borderColor: "divider", borderRadius: 1, px: 0.5 }} /* about six rows; more models scroll inside, the pickers stay in view */>
                {modelGroups.map((group) => {
                  const ticked = group.models.filter((model) => shownModels.includes(model.uuid)).length; // how many of its models are shown
                  const unfolded = unfoldedTypes.includes(group.uuid); // its models listed
                  return (
                    <Box key={group.uuid}>
                      <Box sx={{ display: "flex", alignItems: "center" }}>
                        <IconButton size="small" aria-label={`${unfolded ? "Fold" : "Unfold"} ${group.name}`} aria-expanded={unfolded} onClick={() => toggleFold(group.uuid)}>
                          {unfolded ? <ExpandMoreIcon fontSize="small" /> : <ChevronRightIcon fontSize="small" />}
                        </IconButton>
                        <FormControlLabel
                          control={<Checkbox size="small" checked={ticked === group.models.length} indeterminate={ticked > 0 && ticked < group.models.length} onChange={() => toggleType(group)} />} // a dash when only some are ticked
                          label={`${group.name} (${group.models.length})`} // the count tells what a folded type holds
                          slotProps={{ typography: { sx: { fontWeight: 600 } } }}
                        />
                      </Box>
                      <Collapse in={unfolded} unmountOnExit /* a folded type's models are gone, not just hidden */>
                        {group.models.map((model) => (
                          <Box key={model.uuid} sx={{ pl: 5 }} /* under the type's box */>
                            <FormControlLabel control={<Checkbox size="small" checked={shownModels.includes(model.uuid)} onChange={() => toggleModel(model.uuid)} />} label={model.label} />
                          </Box>
                        ))}
                      </Collapse>
                    </Box>
                  );
                })}
              </Box>
            </Box>
          )}

          {showGroup(elementCount) && shownClasses.length + shownRelationclasses.length + shownPorts.length === 0 && (
            <Typography variant="body2">No element of the chosen models can be referenced here. Choose more models above.</Typography> // otherwise the pickers would just vanish
          )}

          {showGroup(shownClasses.length) && (
            <AllowedGroup
              label="Select Referenced ClassInstance"
              value={selectedClassUuid}
              onChange={setSelectedClassUuid}
              options={shownClasses.map((o) => ({
                uuid: o.classInstance.uuid,
                label: `${getClassInstanceName(o.classInstance)} | ${o.scene.name} | ${o.classInstance.uuid}`, // the model tells apart elements of the same name
              }))}
              onAdd={() => {
                const picked = allowedClassInstances.find((o) => o.classInstance.uuid === selectedClassUuid);
                void addReferenceRoleInstance(picked?.classInstance, picked?.parentRole, "classInstance");
              }}
            />
          )}

          {showGroup(shownRelationclasses.length) && (
            <AllowedGroup
              label="Select Referenced RelationclassInstance"
              value={selectedRelationclassUuid}
              onChange={setSelectedRelationclassUuid}
              options={shownRelationclasses.map((o) => ({
                uuid: o.relationclassInstance.uuid,
                label: `${o.relationclassInstance.name} | ${o.scene.name} | ${o.relationclassInstance.uuid}`, // with its model, as for classes
              }))}
              onAdd={() => {
                const picked = allowedRelationclassInstances.find(
                  (o) => o.relationclassInstance.uuid === selectedRelationclassUuid,
                );
                void addReferenceRoleInstance(
                  picked?.relationclassInstance,
                  picked?.parentRole,
                  "relationclassInstance",
                );
              }}
            />
          )}

          {showGroup(shownPorts.length) && (
            <AllowedGroup
              label="Select Referenced PortInstance"
              value={selectedPortUuid}
              onChange={setSelectedPortUuid}
              options={shownPorts.map((o) => ({
                uuid: o.portInstance.uuid,
                label: `${o.portInstance.name} | ${o.scene.name} | ${o.portInstance.uuid}`, // with its model, as for classes
              }))}
              onAdd={() => {
                const picked = allowedPortInstances.find((o) => o.portInstance.uuid === selectedPortUuid);
                void addReferenceRoleInstance(picked?.portInstance, picked?.parentRole, "portInstance");
              }}
            />
          )}
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={close}>Close</Button>
      </DialogActions>
    </Dialog>
  );
}

/** One "pick an instance, then add it" row. */
function AllowedGroup({
  label,
  value,
  onChange,
  options,
  onAdd,
}: {
  label: string;
  value: string;
  onChange: (uuid: string) => void;
  options: { uuid: string; label: string }[];
  onAdd: () => void;
}) {
  const labelId = `ref-${label.replace(/\s+/g, "-")}`; // an id holds no spaces: aria-labelledby would read "ref-Select Referenced ClassInstance" as three ids, and the picker would have no name
  return (
    <Box sx={{ display: "flex", gap: 1 }}>
      <FormControl sx={{ flex: 1 }} required size="small">
        <InputLabel id={labelId}>{label}</InputLabel>
        <Select
          labelId={labelId}
          label={label}
          value={value}
          onChange={(e) => onChange(e.target.value)}
        >
          {options.map((option) => (
            <MenuItem key={option.uuid} value={option.uuid}>
              {option.label}
            </MenuItem>
          ))}
        </Select>
      </FormControl>
      <Button variant="outlined" onClick={onAdd} disabled={!value}>
        add
      </Button>
    </Box>
  );
}

// dialog-reference-attribute.ts:299 — the display name of a referenced class instance.
function getClassInstanceName(classInstance: ClassInstance): string {
  return standardNameAttribute(classInstance)?.value || "Unknown";
}

/** The instance's standard Name attribute (`NAME_ATTRIBUTE_UUID`), if its class uses it. */
function standardNameAttribute(classInstance: ClassInstance): AttributeInstance | undefined {
  return classInstance.attribute_instance.find((attribute) => attribute.uuid_attribute === NAME_ATTRIBUTE_UUID);
}

/**
 * Every metamodel names its elements through the standard Name attribute
 * (`NAME_ATTRIBUTE_UUID`), so an element without it has no name to show a reference by.
 * That is a fault of the metamodel, reported to the user rather than papered over.
 * `metaName` is the element's class, relationclass or port (its instance's `name`).
 */
function reportMissingStandardName(kind: "class" | "relationclass" | "port", metaName: string | undefined): void {
  logger.log(
    `The ${kind} "${metaName ?? "?"}" does not use the standard Name attribute, so its instances have no name to show.`,
    "error",
  );
}

/** The referenced instance's standard Name, or "" — reported — when its class lacks the attribute. */
async function referencedName(
  instanceUuid: string,
  kind: "class" | "relationclass" | "port",
  metaName: string | undefined,
): Promise<string> {
  const name = await expressionUtility.attrvalByInst(NAME_ATTRIBUTE_UUID, instanceUuid);
  if (name !== undefined) return name;
  reportMissingStandardName(kind, metaName);
  return "";
}

/**
 * Which Role does this reference
 * attribute's attribute type carry? Resolved from the currently selected class or
 * port instance, with one fallback: a reference
 * attribute of the open SCENE INSTANCE (shown when nothing is selected) belongs to
 * neither, and `current_class_instance` may still hold the last selected element, which
 * does not carry this attribute either. metaUtility searches the scene type first, so it
 * covers both — without it the pickers stay empty because no Role is found.
 */
async function resolveAttributeRole(
  attributeInstance: AttributeInstance,
  metaAttribute?: Attribute,
): Promise<Role | undefined> {
  // A table cell: its column's attribute is on no class, port or scene type.
  if (metaAttribute?.attribute_type?.role) return metaAttribute.attribute_type.role;

  const attributeUUID = attributeInstance.uuid_attribute;
  const currentClass = globalObject.current_class_instance
    ? await metaUtility.getMetaClass(globalObject.current_class_instance.uuid_class)
    : undefined;
  const currentPort = globalObject.current_port_instance
    ? await metaUtility.getMetaPort(globalObject.current_port_instance.uuid_port)
    : undefined;

  let currentAttribute = currentClass?.attributes.find((attribute) => attribute.uuid === attributeUUID);
  if (currentPort) {
    currentAttribute = currentPort.attributes.find((attribute) => attribute.uuid === attributeUUID) ?? currentAttribute;
  }
  if (!currentAttribute) {
    currentAttribute = await metaUtility.getMetaAttribute(attributeUUID);
  }
  return currentAttribute?.attribute_type?.role;
}

/**
 * The naming half of `setMetaInformation()`: resolve the referenced instance's display
 * name through the standard Name attribute, or the scene instance's own name. A
 * reference whose target is no longer loaded keeps the name it was saved with.
 */
async function resolveReferenceName(roleInstance: RoleInstance): Promise<string> {
  // If the reference role instance has a reference class instance, then get the name of
  // the referenced class instance (likewise for relationclass / port / scene).
  if (roleInstance.uuid_has_reference_class_instance != undefined) {
    const referenced = await instanceUtility.getClassInstance(roleInstance.uuid_has_reference_class_instance);
    if (referenced) {
      return await referencedName(referenced.uuid, "class", referenced.name);
    }
  } else if (roleInstance.uuid_has_reference_relationclass_instance != undefined) {
    const referenced = await instanceUtility.getClassInstance(
      roleInstance.uuid_has_reference_relationclass_instance,
    );
    if (referenced) {
      return await referencedName(referenced.uuid, "relationclass", referenced.name);
    }
  } else if (roleInstance.uuid_has_reference_port_instance != undefined) {
    const referenced = await instanceUtility.getPortInstance(roleInstance.uuid_has_reference_port_instance);
    if (referenced) {
      return await referencedName(referenced.uuid, "port", referenced.name);
    }
  } else if (roleInstance.uuid_has_reference_scene_instance != undefined) {
    const referenced = await instanceUtility.getSceneInstance(roleInstance.uuid_has_reference_scene_instance);
    if (referenced) {
      return referenced.name;
    }
  } else {
    return "Reference to: ?";
  }
  return roleInstance.name;
}

/**
 * Every loaded model, the one open in the current tab first. That one is taken from the tab,
 * not from the scene tree: the tab holds its live copy, with elements not saved yet and the
 * state after an undo, which replaces the tab's copy.
 */
async function loadedModels(): Promise<{ models: SceneInstance[]; current: SceneInstance | undefined }> {
  const current = await instanceUtility.getTabContextSceneInstance(); // undefined when no model is open
  const others = (await instanceUtility.getAllSceneInstancesFromLocal()).filter((scene) => scene.uuid !== current?.uuid); // the tree's copy of the open model would be stale
  return { models: current ? [current, ...others] : others, current };
}

/**
 * The models under their scene types, as "Show elements from" lists them. Example:
 *   BPMN 2.0:  Bestellabwicklung – current model, Testmodell 1, Testmodell 2
 *   Petri Net: Netz A
 * The types follow the order of their first model, so the current model's type comes first.
 */
function groupByType(models: SceneInstance[], current: SceneInstance | undefined): ModelGroup[] {
  const groups = new Map<string, ModelGroup>(); // scene type uuid -> its group; a Map keeps the order of insertion
  for (const scene of models) {
    const typeUuid = scene.uuid_scene_type; // the type it is an instance of
    if (!groups.has(typeUuid)) {
      const sceneType = globalObject.sceneTypes?.find((type: { uuid: string }) => type.uuid === typeUuid); // the loaded scene types, as metaUtility reads them
      groups.set(typeUuid, { uuid: typeUuid, name: sceneType?.name ?? "Unknown scene type", models: [] }); // a type not loaded would otherwise have no heading
    }
    groups.get(typeUuid)!.models.push({ uuid: scene.uuid, label: `${scene.name}${scene === current ? " – current model" : ""}` }); // `!`: set just above
  }
  return [...groups.values()];
}

// The four setAllowed*Instances methods: keep only the instances whose meta concept is
// listed in the Role's *_references. Classes, relation classes and ports are collected model
// by model, so each one knows its model.
async function collectAllowedSceneInstances(role: Role): Promise<AllowedScene[]> {
  const sceneInstances = await instanceUtility.getAllSceneInstancesFromLocal();
  const allowed: AllowedScene[] = [];
  for (const sceneInstance of sceneInstances) {
    for (const sceneTypeReference of role.scenetype_references ?? []) {
      if (sceneInstance.uuid_scene_type === sceneTypeReference.uuid) {
        logger.log(`sceneTypeReference ${sceneTypeReference.uuid} is allowed`, "done");
        allowed.push({ sceneInstance, parentRole: role });
      }
    }
  }
  return allowed;
}

function collectAllowedClassInstances(role: Role, models: SceneInstance[]): AllowedClass[] {
  const allowed: AllowedClass[] = [];
  for (const scene of models) {
    for (const classInstance of scene.class_instances ?? []) {
      for (const classReference of role.class_references ?? []) {
        if (classInstance.uuid_class === classReference.uuid) {
          logger.log(`classReference ${classReference.uuid} is allowed`, "done");
          allowed.push({ classInstance, parentRole: role, scene });
        }
      }
    }
  }
  // The picker labels them by their standard Name: report each class that lacks it, once.
  const unnamedClasses = new Set(
    allowed.filter((entry) => !standardNameAttribute(entry.classInstance)).map((entry) => entry.classInstance.name),
  );
  for (const className of unnamedClasses) reportMissingStandardName("class", className);
  return allowed;
}

function collectAllowedRelationclassInstances(role: Role, models: SceneInstance[]): AllowedRelationclass[] {
  const allowed: AllowedRelationclass[] = [];
  for (const scene of models) {
    for (const relationclassInstance of scene.relationclasses_instances ?? []) {
      for (const relationclassReference of role.relationclass_references ?? []) {
        if (relationclassInstance.uuid_relationclass === relationclassReference.uuid) {
          logger.log(`relationclassReference ${relationclassReference.uuid} is allowed`, "done");
          allowed.push({ relationclassInstance, parentRole: role, scene });
        }
      }
    }
  }
  return allowed;
}

function collectAllowedPortInstances(role: Role, models: SceneInstance[]): AllowedPort[] {
  const allowed: AllowedPort[] = [];
  for (const scene of models) {
    for (const portInstance of instanceUtility.portInstancesOf(scene)) { // the scene's own ports and those of its elements
      for (const portReference of role.port_references ?? []) {
        if (portInstance.uuid_port === portReference.uuid) {
          logger.log(`portReference ${portReference.uuid} is allowed`, "done");
          allowed.push({ portInstance, parentRole: role, scene });
        }
      }
    }
  }
  return allowed;
}
