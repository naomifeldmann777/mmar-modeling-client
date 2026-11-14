/**
 * Shows one path of the path analysis in the 3D model, as BEE-UP colours a path: an orange
 * outline around every node of the path, and every sequence flow it took drawn over in orange.
 *
 * Which flows: those a step of the path put a token on (TraceEntry.produces). A skipped OR
 * branch is not taken, so its flow is not coloured (spec 5.2). A node that ran several times,
 * e.g. in a loop, is outlined once.
 *
 * How: like stepper-highlight, nothing of the model is changed. The outlines and the orange
 * lines are extra objects in the scene, removed again by `clearPathHighlight`. A line is drawn
 * over with a copy of its own route and look in orange, so the original keeps its colour.
 *
 * Used by: the path-analysis panel, whenever the selected path changes, and when it closes.
 * The session clears the selection when the model changes, since the copies would then sit
 * where the elements were.
 */
import * as THREE from "three"; // the scene and its objects
import { Line2 } from "three/examples/jsm/lines/Line2.js"; // how the client draws lines
import type { LineMaterial } from "three/examples/jsm/lines/LineMaterial.js"; // a line's look, copied for the orange line
import { globalObject } from "@/engine"; // the active scene and the render flag
import type { SimulationGraph } from "@/resources/process-simulation/graph"; // the flows of the model
import type { AnalysedPath } from "@/resources/process-simulation/path-analysis"; // what is shown
import { ringAround } from "./stepper-highlight"; // the same band the stepper uses, narrower

export const PATH_COLOUR = "#ff9800"; // orange: a path of the analysis, apart from the stepper's greens; the panel marks the selected path in it too
const OUTLINE_WIDTH = 0.06; // a narrow band, as an outline: a share of the element's shorter side
const LINE_WIDTH = 1.6; // the orange line is a little wider than the flow, so it covers it

let helpers: THREE.Object3D[] = []; // the outlines and lines added to the scene

/** Shows `path` in the active 3D model, replacing a path shown before. */
export function showPath(graph: SimulationGraph, path: AnalysedPath): void {
  clearPathHighlight(); // only one path at a time
  const scene = globalObject.scene; // the scene of the active tab: the analysis belongs to it
  const find = (id: string) => scene.getObjectByProperty("uuid", id); // an element's object carries the element's uuid

  for (const nodeId of new Set(path.nodes)) {
    const outline = ringAround(find(nodeId), PATH_COLOUR, 0.9, OUTLINE_WIDTH); // once per node, also when it ran several times
    if (outline) add(scene, outline);
  }

  for (const flowId of new Set(path.trace.flatMap((entry) => entry.produces))) {
    const line = find(flowId); // the flow's line
    if (line instanceof Line2 && graph.flows[flowId]) add(scene, orangeCopy(line)); // only sequence flows, as the graph has them
  }

  globalObject.render = true; // the scene is only redrawn when asked
}

/** Removes the shown path. */
export function clearPathHighlight(): void {
  for (const helper of helpers) {
    helper.removeFromParent(); // out of the scene
    if (helper instanceof THREE.Mesh || helper instanceof Line2) {
      helper.geometry.dispose(); // each owns its geometry and material: the line's are copies
      (helper.material as THREE.Material).dispose();
    }
  }
  helpers = [];
  globalObject.render = true; // show the model without the path
}

/** Adds `object` to the scene and remembers it for removal. */
function add(scene: THREE.Scene, object: THREE.Object3D): void {
  scene.add(object);
  helpers.push(object);
}

/** An orange line over `line`: the same route and look, wider, on top of everything. */
function orangeCopy(line: Line2): Line2 {
  const material = (line.material as LineMaterial).clone(); // its look: width, world units, dashes
  material.color.set(PATH_COLOUR); // in orange
  material.linewidth *= LINE_WIDTH; // a little wider, so the flow underneath does not show at the edges
  material.depthTest = false; // never hidden behind an element
  const copy = new Line2(line.geometry.clone(), material); // its own copy of the route, so disposing it leaves the flow alone
  copy.applyMatrix4(line.matrixWorld); // where the flow is
  copy.renderOrder = 9; // on top of the model, under the outlines
  return copy;
}
