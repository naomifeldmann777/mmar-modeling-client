import { AttributeInstance, ClassInstance, PortInstance, RelationclassInstance, SceneInstance, UUID } from "@gds";
import { globalObject } from "@/engine/global-definition";
import { graphicContext } from "@/engine/graphic-context";
import { instanceUtility } from "@/resources/services/instance-utility";
import { metaUtility } from "@/resources/services/meta-utility";
import { eventBus } from "@/resources/services/event-bus";
import { runExclusive } from "@/resources/services/draw-lock";
import { logger } from "@/resources/services/logger";
import { describeError } from "@/resources/util/describe-error";
import { enclosingTables, referenceTarget } from "@/resources/util/scene-walk";

/** An instance whose vizRep is re-run, with the vizRep source it is re-run with. */
interface RedrawTarget {
  instance: ClassInstance | RelationclassInstance | PortInstance | SceneInstance;
  geometry: string;
}

/**
 * Re-runs a concept's vizRep when something it may draw from changes.
 *
 * The entry points are bus channels, subscribed in the constructor — which is why
 * importing this module is load-bearing:
 * - `checkForVizRepUpdate` re-evaluates every instance of the open scene;
 * - `checkForVizRepUpdateByAttributeInstance` the instance owning one attribute. A table
 *   cell counts as an attribute of the instance owning its table;
 * - `checkForVizRepUpdateByRelationInstance` the instances at the two ends of a relation
 *   that was added or removed.
 *
 * An attribute change only redraws when the meta attribute's NAME or uuid actually
 * appears in the concept's vizRep code string, so editing a value nothing draws costs
 * nothing. For a cell, the attributes of the tables around it count too, since a vizRep
 * reaches a cell through its table. A relation change always redraws both ends. Custom
 * variables that are not `user_locked` are dropped first so the re-run recomputes them,
 * while anything the user positioned by hand survives.
 *
 * Serialisation is the DRAW LANE (`runExclusive`), not `globalObject.readyForVizRepUpdate`
 * — that flag is only a "an update is in flight" signal for the request side, which
 * expression-utility waits on before asking for another; nothing waits on it before
 * STARTING one. It is still released in a `finally`, because leaving it set would wedge
 * every later request in a spin.
 */
export class VizrepUpdateChecker {
  private instanceUtility = instanceUtility;
  private metaUtility = metaUtility;
  private gc = graphicContext;
  private globalObjectInstance = globalObject;
  private eventAggregator = eventBus;

  /**
   * Instances whose redraw by uuid is queued on the lane and has not started yet. A
   * redraw reads the model when it starts, so one queued redraw covers every request
   * made before it starts: deleting an instance with many relations asks for its
   * neighbours once per relation.
   */
  private queuedInstanceRedraws = new Set<UUID>();

  constructor() {
    //event listener for the vizrep update
    //it is not ideal since we loose the synchronization between the event and the function call
    this.eventAggregator.subscribe("checkForVizRepUpdate", () => {
      void this.checkForVisualizationUpdate().catch((err) => logger.log("vizrep update failed: " + describeError(err), "error"));
    });

    //event listener for the vizrep update for specific attribute instances
    this.eventAggregator.subscribe("checkForVizRepUpdateByAttributeInstance", (payload) => {
      void this.checkForVizRepUpdate(payload as AttributeInstance).catch((err) => logger.log("vizrep update failed: " + describeError(err), "error"));
    });

    // a relation was added or removed: the instances it connects may draw from it
    this.eventAggregator.subscribe("checkForVizRepUpdateByRelationInstance", (payload) => {
      void this.checkForVizRepUpdateOfRelationEnds(payload).catch((err) => logger.log("vizrep update failed: " + describeError(err), "error"));
    });
  }

  /**
   * A concept without a vizRep function (`geometry` is nullable, and EVERY example
   * metamodel's SceneType has it null) has nothing to re-run — dereferencing it anyway
   * meant editing a scene-instance attribute threw
   * "Cannot read properties of null (reading 'toString')" before it could do anything.
   * Both the null geometry and a missing owner instance now short-circuit the update.
   */
  private geometryOf(concept: { geometry?: unknown } | undefined | null): string {
    const geometry = concept?.geometry;
    return geometry ? geometry.toString() : "";
  }

  /**
   * On the draw lane, because this re-runs a vizRep through the SHARED graphic context —
   * the same one a click, a peer's arriving change and every other vizRep update draw
   * into. `readyForVizRepUpdate` never provided that: nothing WAITS on it before
   * starting (it only gates expression-utility's request-side spin), so two updates
   * launched back to back from the same remote batch used to run at once, merge each
   * other's half-built meshes into one instance, and leave the other with the empty map
   * the first one's `resetInstance()` left behind — an instance that simply vanished
   * from the canvas, with nothing logged.
   */
  async checkForVizRepUpdate(attributeInstance: AttributeInstance) {
    return runExclusive(() => this.redrawExclusive(() => this.targetOfAttributeChange(attributeInstance)));
  }

  /**
   * Redraw the instances at the two ends of a relation that was just added or removed.
   * Nothing about the ends themselves changed, so no attribute names them, but a vizRep
   * that walks its relations draws differently now. A relation from an instance back to
   * itself (through a bendpoint) redraws that instance once.
   */
  async checkForVizRepUpdateOfRelationEnds(relationclassInstance: RelationclassInstance) {
    const ends = new Set<UUID>();
    for (const role of [relationclassInstance.role_instance_from, relationclassInstance.role_instance_to]) {
      const end = referenceTarget(role);
      if (end) ends.add(end);
    }
    await Promise.all([...ends].map((end) => this.checkForVizRepUpdateByInstance(end)));
  }

  /**
   * Redraw one class, relation or port instance of the open scene, whatever its vizRep
   * reads. An instance that is gone by the time the lane gets to it (a delete cascade
   * took it) is skipped. A request for an instance whose redraw is already queued joins
   * that redraw and returns at once.
   */
  async checkForVizRepUpdateByInstance(instanceUuid: UUID) {
    if (this.queuedInstanceRedraws.has(instanceUuid)) return;
    this.queuedInstanceRedraws.add(instanceUuid);
    return runExclusive(() => {
      this.queuedInstanceRedraws.delete(instanceUuid);
      return this.redrawExclusive(() => this.targetOfInstance(instanceUuid));
    });
  }

  /**
   * Borrow the "instance being drawn" pointers, re-run the vizRep `resolve` names (if
   * any), and give everything back.
   */
  private async redrawExclusive(resolve: () => Promise<RedrawTarget | undefined>) {
    //if not set yet lock the vizrep update until the current update is finished
    this.globalObjectInstance.readyForVizRepUpdate = false;

    // The pipeline learns WHICH instance it is drawing from `current_class_instance` /
    // `current_port_instance`, so the update below borrows those fields — and has to
    // give them back. `current_class_instance` is also what a Delete keypress acts on
    // (`deletionHandler.onPressDelete` reads it and nothing else, with no cross-check
    // against the actual selection), so an attribute a PEER edited used to leave the
    // local user's next Delete aimed at the peer's element — no timing coincidence
    // required, and no selection visible on screen to explain it.
    const previousClassInstance = this.globalObjectInstance.current_class_instance;
    const previousPortInstance = this.globalObjectInstance.current_port_instance;

    // All are released in `finally`, including on the early returns below: the flag
    // gates expression-utility's wait loop, so leaving it set wedges every later refresh
    // in a spin, and leaving a borrowed instance behind is the delete bug above.
    try {
      this.gc.current_instance_object = undefined as any;
      this.gc.resetInstance();

      const target = await resolve();
      if (!target) return;
      await this.rerun(target);
    } finally {
      // hand the borrowed instances back to whatever the local user had selected
      this.globalObjectInstance.current_class_instance = previousClassInstance;
      this.globalObjectInstance.current_port_instance = previousPortInstance;
      // unlock the vizrep update
      this.globalObjectInstance.readyForVizRepUpdate = true;
    }
  }

  /**
   * The instance to redraw for a changed attribute, or undefined when there is none or
   * its vizRep names neither the attribute nor — for a cell — any table around it.
   */
  private async targetOfAttributeChange(attributeInstance: AttributeInstance): Promise<RedrawTarget | undefined> {
    // A cell names only its table, never the instance owning the table, so its update is
    // the update of the table that instance owns.
    const tables = await this.tablesAround(attributeInstance);
    if (!tables) return undefined;
    const owned = tables.at(-1) ?? attributeInstance;

    let target: RedrawTarget | undefined;
    if (owned.assigned_uuid_class_instance) {
      target = await this.targetOfClassOrRelation(owned.assigned_uuid_class_instance);
    }
    //if it was not a class instance or relationclass instance, check if it is a port instance
    else if (owned.assigned_uuid_port_instance) {
      target = await this.targetOfPort(owned.assigned_uuid_port_instance);
    }
    //if it was not a port instance, check if it is a scene instance
    else if (owned.assigned_uuid_scene_instance) {
      const sceneInstance = await this.instanceUtility.getSceneInstance(owned.assigned_uuid_scene_instance);
      if (sceneInstance) {
        target = { instance: sceneInstance, geometry: this.geometryOf(await this.metaUtility.getSceneTypeByUUID(sceneInstance.uuid_scene_type)) };
      }
    }

    // nothing to re-run: the concept draws nothing (a SceneType normally has no vizRep
    // of its own), so the value change cannot affect any geometry
    if (!target?.geometry) return undefined;

    // we only update the vizrep if the meta attribute — or a table the cell sits in —
    // is referenced in the geometry attribute
    if (!(await this.namesAnyOf(target.geometry, [attributeInstance, ...tables]))) return undefined;
    return target;
  }

  /**
   * The tables `attributeInstance` sits in, innermost first; empty for an attribute that
   * is not a cell, undefined for a cell whose table is not in the open scene.
   */
  private async tablesAround(attributeInstance: AttributeInstance): Promise<AttributeInstance[] | undefined> {
    if (!attributeInstance.table_attribute_reference) return [];
    const sceneInstance = await this.instanceUtility.getTabContextSceneInstance();
    if (!sceneInstance) return undefined;
    return enclosingTables(attributeInstance, sceneInstance);
  }

  /** Whether `geometry` names any of these attributes' meta attributes, by name or uuid. */
  private async namesAnyOf(geometry: string, attributeInstances: AttributeInstance[]): Promise<boolean> {
    for (const attributeInstance of attributeInstances) {
      const metaAttributeUUID = attributeInstance.uuid_attribute;
      if (metaAttributeUUID && geometry.includes(metaAttributeUUID)) return true;
      const metaAttribute = await this.metaUtility.getMetaAttribute(metaAttributeUUID);
      if (metaAttribute?.name && geometry.includes(metaAttribute.name)) return true;
    }
    return false;
  }

  /** A class, relation or port instance of the open scene, with its vizRep. */
  private async targetOfInstance(instanceUuid: UUID): Promise<RedrawTarget | undefined> {
    const target = (await this.targetOfClassOrRelation(instanceUuid)) ?? (await this.targetOfPort(instanceUuid));
    return target?.geometry ? target : undefined;
  }

  private async targetOfClassOrRelation(instanceUuid: UUID): Promise<RedrawTarget | undefined> {
    const relationclassInstance = (await this.instanceUtility.getAllRelationClassInstances()).find((candidate) => candidate.uuid == instanceUuid);
    if (relationclassInstance) {
      return { instance: relationclassInstance, geometry: this.geometryOf(await this.metaUtility.getMetaRelationclass(relationclassInstance.uuid_relationclass)) };
    }
    const classInstance = await this.instanceUtility.getClassInstance(instanceUuid);
    if (!classInstance) return undefined;
    return { instance: classInstance, geometry: this.geometryOf(await this.metaUtility.getMetaClass(classInstance.uuid_class)) };
  }

  private async targetOfPort(instanceUuid: UUID): Promise<RedrawTarget | undefined> {
    const portInstance = await this.instanceUtility.getPortInstance(instanceUuid);
    if (!portInstance) return undefined;
    return { instance: portInstance, geometry: this.geometryOf(await this.metaUtility.getMetaPort(portInstance.uuid_port)) };
  }

  /** Re-run `target`'s vizRep and swap the result in. Runs inside `redrawExclusive`. */
  private async rerun({ instance, geometry }: RedrawTarget) {
    // Point the pipeline at the instance, the way selecting it would: the expression API
    // reads the drawn instance's values through these fields, and labels write their
    // custom variables to whichever one is set. A port is drawn with no class set, so it
    // reads its own attributes; a class or relation with no port set, so a port the
    // user had selected does not collect the class's labels.
    if (instance instanceof PortInstance) {
      this.globalObjectInstance.current_class_instance = undefined as any;
      this.globalObjectInstance.current_port_instance = instance;
    } else if (instance instanceof ClassInstance) {
      this.globalObjectInstance.current_class_instance = instance;
      this.globalObjectInstance.current_port_instance = undefined as any;
      this.gc.current_instance_object = instance;
    }

    // get all custom_variables
    const customVariables = instance.custom_variables as any;

    // for each custom_variable (key) in the customVariables object, check if it the value user_locked is true, if not, store it in an array to be updated
    // this is necessary because we only want to update the custom variables that are not user_locked
    // e.g. a label the user dragged must not snap back to its computed position
    const customVariablesToUpdate: string[] = [];
    for (const key in customVariables) {
      if (customVariables[key].user_locked === false) {
        customVariablesToUpdate.push(key);
      }
    }

    // remove the custom variable from the object instance if not user_locked
    // the custom_variables will then be updated in the vizrep update
    for (const key of customVariablesToUpdate) {
      delete (instance.custom_variables as any)[key];
    }

    // run the vizrep function and call the update vizrep function to update the vizrep
    await this.gc.runVizRepFunction(geometry);
    await this.gc.updateVizRep(instance);
    // A redraw can change the outline relations end on. Nothing moved, so without
    // this they would keep ending at the old outline until the next drag.
    this.globalObjectInstance.objectScaled = true;
  }

  /**
   * Checks for visualization updates.
   */
  async checkForVisualizationUpdate() {
    //get all attributeInstances that are assigned to the current sceneInstance, its classInstances, relationclassInstances and portInstances
    const sceneInstance = this.globalObjectInstance.tabContext[this.globalObjectInstance.selectedTab].sceneInstance;
    let attributeInstances: AttributeInstance[] = sceneInstance.attribute_instances;

    attributeInstances = [...attributeInstances, ...(await this.instanceUtility.getAllAttributeInstancesFromObjectInstanceRecursively(sceneInstance))];

    // Create a Set to track processed class instance UUIDs
    const processedClassInstanceUUIDs = new Set<string>();

    //for each attribute run the checkForVizRepUpdate function
    for (const attributeInstance of attributeInstances) {
      if (attributeInstance.assigned_uuid_class_instance && !processedClassInstanceUUIDs.has(attributeInstance.assigned_uuid_class_instance)) {
        await this.checkForVizRepUpdate(attributeInstance);
        processedClassInstanceUUIDs.add(attributeInstance.assigned_uuid_class_instance);
      }
    }
  }
}

// Module singleton — one shared instance.
export const vizrepUpdateChecker = new VizrepUpdateChecker();
