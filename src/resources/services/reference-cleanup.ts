import { remove_table_row } from "@gds";
import type { AttributeInstance, RoleInstance, SceneInstance, UUID } from "@gds";
import { globalObject } from "@/engine/global-definition";
import { expressionUtility } from "./expression-utility";

/**
 * Keeps the open scenes in step with references the database has removed.
 *
 * When an object is deleted, the database clears every reference to it in every scene,
 * and removes a table row that held nothing else (`clear_attribute_reference()` in
 * init.sql). An open tab holds its own copy of the scene, so the same happens here:
 * otherwise the tab keeps showing the reference and writes it back on the next save.
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

/** Every attribute of the scene, its classes, relations and ports. Table cells are not listed. */
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

/** What the attributes of `scene` reference, table cells included. */
export function referencedTargets(scene: SceneInstance): Set<UUID> {
  const targets = new Set<UUID>();
  for (const attribute of attributesOf(scene)) collectTargets(attribute, targets);
  return targets;
}

function clearReference(attribute: AttributeInstance): void {
  attribute.role_instance_from = null as unknown as RoleInstance;
  attribute.value = "";
}

function isEmpty(cell: AttributeInstance): boolean {
  return !cell.value && !cell.role_instance_from && !cell.table_attributes?.length;
}

function clearInTable(table: AttributeInstance, deleted: Set<UUID>): void {
  const cells = table.table_attributes ?? [];
  const rows = new Set<number>();
  for (const cell of cells) {
    clearInTable(cell, deleted);
    const target = referenceTarget(cell.role_instance_from);
    if (target && deleted.has(target)) {
      clearReference(cell);
      rows.add(cell.table_row);
    }
  }
  // Bottom up: removing a row renumbers the rows below it.
  for (const row of [...rows].sort((a, b) => b - a)) {
    if (cells.filter((cell) => cell.table_row === row).every(isEmpty)) remove_table_row(table, row);
  }
}

/**
 * Remove the references to `deleted` from every open tab.
 * @param deleted The uuids of everything the delete took with it, as the server lists them.
 */
export async function removeReferencesTo(deleted: Iterable<UUID>): Promise<void> {
  const deletedUuids = new Set(deleted);
  if (deletedUuids.size === 0) return;

  const activeScene = globalObject.tabContext[globalObject.selectedTab]?.sceneInstance;
  for (const { sceneInstance } of globalObject.tabContext) {
    if (!sceneInstance) continue;
    for (const attribute of attributesOf(sceneInstance)) {
      clearInTable(attribute, deletedUuids);

      const target = referenceTarget(attribute.role_instance_from);
      if (!target || !deletedUuids.has(target)) continue;
      clearReference(attribute);

      const owner = attribute.assigned_uuid_class_instance ?? attribute.assigned_uuid_port_instance;
      if (sceneInstance === activeScene && owner) {
        await expressionUtility.checkForVisualizationUpdateByAttributeUUID(owner, attribute.uuid_attribute);
      }
    }
  }
}

/**
 * A copy of a scene read before something it references was deleted is corrected by the
 * server when it is saved: the reference is left out of the answer. Follow that here,
 * which is how another window or collaborator's tab catches up with a delete it never saw.
 * @param sent What the saved copy referenced, read before it was sent.
 * @param saved The scene the server answered with.
 */
export async function removeReferencesDroppedBySave(sent: Set<UUID>, saved: SceneInstance): Promise<void> {
  const kept = referencedTargets(saved);
  await removeReferencesTo([...sent].filter((target) => !kept.has(target)));
}
