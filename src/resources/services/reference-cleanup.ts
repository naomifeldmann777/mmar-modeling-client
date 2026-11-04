import type { AttributeInstance, RoleInstance, SceneInstance, UUID } from "@gds";
import { globalObject } from "@/engine/global-definition";
import { expressionUtility } from "./expression-utility";

/**
 * Keeps the open scenes in step with references the database has cleared.
 *
 * When an object is deleted, the database clears every reference to it in every scene
 * instance, table cells included, and their rows stay (`clear_attribute_reference()` in
 * init.sql). An open tab holds its own copy of the scene instance, so the same happens
 * here: otherwise the tab keeps showing the reference and writes it back on the next save.
 *
 * Tables need nothing more to be redrawn: the scene's mechanisms run every second on
 * the active tab, and on a tab as soon as it is selected.
 */

function referenceTarget(role: RoleInstance | null | undefined): UUID | undefined {
  if (!role) return undefined;
  return (
    role.uuid_has_reference_class_instance ??
    role.uuid_has_reference_relationclass_instance ??
    role.uuid_has_reference_port_instance ??
    role.uuid_has_reference_scene_instance ??
    role.uuid_has_reference_attribute_instance ??
    undefined
  );
}

/** Every attribute instance of the scene, its classes, relations and ports. Table cells are not listed. */
function attributesOf(scene: SceneInstance): AttributeInstance[] {
  const classes = [...(scene.class_instances ?? []), ...(scene.relationclasses_instances ?? [])];
  const ports = [...(scene.port_instances ?? []), ...classes.flatMap((instance) => instance.port_instance ?? [])];
  return [
    ...(scene.attribute_instances ?? []),
    ...classes.flatMap((instance) => instance.attribute_instance ?? []),
    ...ports.flatMap((port) => port.attribute_instances ?? []),
  ];
}

function collectTargets(attribute: AttributeInstance, targets: Set<UUID>): void {
  const target = referenceTarget(attribute.role_instance_from);
  if (target) targets.add(target);
  for (const cell of attribute.table_attributes ?? []) collectTargets(cell, targets);
}

/** What the attribute instances of `scene` reference, table cells included. */
export function referencedTargets(scene: SceneInstance): Set<UUID> {
  const targets = new Set<UUID>();
  for (const attribute of attributesOf(scene)) collectTargets(attribute, targets);
  return targets;
}

/**
 * Clear the references to `deleted` held by `attribute` and by the cells of its table,
 * nested tables included.
 * @returns Whether `attribute` itself held one.
 */
function clearReferences(attribute: AttributeInstance, deleted: Set<UUID>): boolean {
  for (const cell of attribute.table_attributes ?? []) clearReferences(cell, deleted);

  const target = referenceTarget(attribute.role_instance_from);
  if (!target || !deleted.has(target)) return false;
  attribute.role_instance_from = null as unknown as RoleInstance;
  attribute.value = "";
  return true;
}

/**
 * Clear the references to `deleted` in every open tab.
 * @param deleted The uuids of everything the delete took with it, as the server lists them.
 */
export async function removeReferencesTo(deleted: Iterable<UUID>): Promise<void> {
  const deletedUuids = new Set(deleted);
  if (deletedUuids.size === 0) return;

  const activeScene = globalObject.tabContext[globalObject.selectedTab]?.sceneInstance;
  for (const { sceneInstance } of globalObject.tabContext) {
    if (!sceneInstance) continue;
    for (const attribute of attributesOf(sceneInstance)) {
      if (!clearReferences(attribute, deletedUuids)) continue;

      const owner = attribute.assigned_uuid_class_instance ?? attribute.assigned_uuid_port_instance;
      if (sceneInstance === activeScene && owner) {
        await expressionUtility.checkForVisualizationUpdateByAttributeUUID(owner, attribute.uuid_attribute);
      }
    }
  }
}

/**
 * A copy of a scene instance read before something it references was deleted is
 * corrected by the server when it is saved: the reference comes back cleared. Follow that
 * here, which is how another window or collaborator's tab catches up with a delete it
 * never saw.
 * @param sent What the saved copy referenced, read before it was sent.
 * @param saved The scene instance the server answered with.
 */
export async function removeReferencesDroppedBySave(sent: Set<UUID>, saved: SceneInstance): Promise<void> {
  const kept = referencedTargets(saved);
  await removeReferencesTo([...sent].filter((target) => !kept.has(target)));
}
