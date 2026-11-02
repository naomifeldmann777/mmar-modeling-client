/**
 * Highlighting a run of the process simulation in the 3D model (plan Phase 8: "the active node
 * is highlighted in the model").
 *
 * What is shown (decided in Phase 8):
 * - a bright, luminous green glow around every node that has a possible step: where the run
 *   goes on now;
 * - a pale, matte green glow around the node executed last: where the run has just been.
 *   Both green, so they read as one path: first the pale one, now the bright one;
 * - every token as a black dot with a white rim on its sequence flow, just in front of the
 *   element it waits for, as tokens are drawn in Petri nets; with a number when several
 *   tokens lie on one flow;
 * - next to every variable that has a value, a label "variable = value".
 *
 * The glow, like a highlighter: a thin box line is hard to see, and WebGL draws plain lines
 * one pixel wide whatever width is asked for. So the glow is one see-through band with rounded
 * corners around the element. The middle is left open, so the element itself is not painted
 * over. It lies in the drawing plane (x and y, the camera looks along z) and is drawn on top
 * of everything, so no other element hides it.
 *
 * The label sits to the right of the variable, since it shows the variable's value. At the
 * random generator it would lie on the line and on the node the line starts at. A variable
 * drawn by several generators gets one label.
 *
 * The token: the dot sits on the last piece of the flow's line, where the line meets the
 * element it leads to, moved back far enough to keep clear of the arrow head. Its size follows
 * that element, so it looks the same at every zoom of the model. Like the glow it is drawn on
 * top of everything.
 *
 * How: the client draws every element as a three.js object whose uuid is the element's uuid,
 * so an element is found in the scene by its uuid. Lines are THREE Line2 objects; labels are
 * the name tags the collaboration features use (label-sprite). Nothing of the model itself is
 * changed: glows, tokens and labels are extra objects that are removed again.
 *
 * Used by: StepperPanel, which calls `showHighlights` after every step and `clearHighlights`
 * when it closes. A label keeps the size it gets when it is drawn, so it grows or shrinks when
 * the user zooms until the next step redraws it.
 */
import * as THREE from "three"; // shapes, colours, bounding boxes
import { Line2 } from "three/examples/jsm/lines/Line2.js"; // how the client draws lines: a token sits on one
import { globalObject } from "@/engine"; // the active scene and camera, and the render flag
import { createNameTag, disposeLabelSprite, scaleLabel } from "@/resources/collaboration/label-sprite"; // camera-facing text labels
import type { Run } from "@/resources/process-simulation/stepper"; // what is shown

const POSSIBLE = { colour: "#00e676", opacity: 0.6 }; // bright, luminous green: this node can run now
const LAST = { colour: "#a5d6a7", opacity: 0.4 }; // pale, matte green: this node ran last
const TOKEN = { core: "#212121", rim: "#ffffff" }; // a black dot with a white rim: visible on lines and on the white canvas
const VALUE = "#6a1b9a"; // purple: the label of a drawn value

const GLOW_WIDTH = 0.2; // how far the glow reaches beyond the element, as a share of the element's shorter side
const LABEL_SIZE = 0.75; // the label at three quarters of the client's name-tag size, so it does not crowd the model
const TOKEN_SIZE = 0.125; // the token's radius, as a share of the shorter side of the element it waits for: the dot is a quarter of that side across
const TOKEN_DISTANCE = 0.45; // how far the token stays from where the line meets the element, as a share of the same side: clear of the arrow head

let helpers: THREE.Object3D[] = []; // the glows, tokens and labels added to the scene, removed by clearHighlights

/** Shows `run` in the active 3D model, replacing what was shown before. */
export function showHighlights(run: Run): void {
  clearHighlights(); // only the current state is shown
  const scene = globalObject.scene; // the scene of the active tab: the run belongs to it (a tab change stops the run)
  const find = (id: string) => scene.getObjectByProperty("uuid", id); // an element's three.js object has the element's uuid

  for (const nodeId of new Set(run.steps.map((step) => step.node))) addGlow(scene, find(nodeId), POSSIBLE); // once per node, even with several steps (values)
  const last = run.state.trace[run.state.trace.length - 1]; // the node executed last, if any
  if (last) addGlow(scene, find(last), LAST);

  for (const [flowId, count] of Object.entries(run.state.tokens)) {
    const line = find(flowId); // the flow's line
    const target = find(run.graph.flows[flowId]?.target ?? ""); // the element the token waits for
    if (line instanceof Line2) addToken(scene, line, target, count);
  }

  for (const variable of Object.values(run.graph.variables)) {
    const name = variable.name; // the name conditions use, and under which the value is kept
    if (name && Object.hasOwn(run.state.values, name)) addLabel(scene, find(variable.id), `${name} = ${run.state.values[name]}`); // only once a value is drawn
  }

  globalObject.render = true; // the scene is only redrawn when asked
}

/** Removes every glow, token and label. */
export function clearHighlights(): void {
  for (const helper of helpers) {
    helper.removeFromParent(); // out of the scene, whichever scene holds it
    if (helper instanceof THREE.Sprite) disposeLabelSprite(helper); // a label owns a texture
    else if (helper instanceof THREE.Mesh) {
      helper.geometry.dispose(); // a glow or token owns its geometry and material
      (helper.material as THREE.Material).dispose();
    }
  }
  helpers = [];
  globalObject.render = true; // show the model without highlighting
}

/** A glow in `look` (colour and strength) around `object` (see the top of the file); nothing when the element is not drawn. */
function addGlow(scene: THREE.Scene, object: THREE.Object3D | undefined, look: { colour: string; opacity: number }): void {
  if (!object) return; // e.g. an element of another tab: nothing to highlight
  const bounds = new THREE.Box3().setFromObject(object); // the space the element takes
  if (bounds.isEmpty()) return; // nothing to put a glow around
  const width = bounds.max.x - bounds.min.x; // the element's size in the drawing plane
  const height = bounds.max.y - bounds.min.y;
  const side = Math.min(width, height) || Math.max(width, height); // the shorter side, so a long task does not get a huge glow
  const centre = bounds.getCenter(new THREE.Vector3()); // the glow is centred on the element
  const gap = side * GLOW_WIDTH; // how far the glow reaches beyond the element

  const ring = new THREE.Shape(); // the outer edge: the element's rectangle, enlarged, with round corners
  roundedRectangle(ring, width + 2 * gap, height + 2 * gap, gap);
  const hole = new THREE.Path(); // the element's own rectangle, left open so the element stays visible
  roundedRectangle(hole, width, height, side * 0.05);
  ring.holes.push(hole);

  const glow = new THREE.Mesh(
    new THREE.ShapeGeometry(ring, 12), // 12 segments per corner: smoothly rounded
    new THREE.MeshBasicMaterial({ color: look.colour, transparent: true, opacity: look.opacity, depthTest: false, depthWrite: false, side: THREE.DoubleSide }), // see-through like a highlighter, never hidden behind another element, visible from both sides in the 3D view
  );
  glow.position.set(centre.x, centre.y, bounds.max.z); // at the front of the element
  glow.renderOrder = 10; // after the model, so the glow lies on top
  scene.add(glow);
  helpers.push(glow);
}

/** Draws a rectangle of `width` × `height` around (0, 0) with corners rounded by `radius` into `path`. */
function roundedRectangle(path: THREE.Path, width: number, height: number, radius: number): void {
  const x = width / 2; // half the width and height: the rectangle is centred on (0, 0)
  const y = height / 2;
  const r = Math.min(radius, x, y); // a corner cannot be rounder than half the shorter side
  path.moveTo(-x + r, -y); // bottom edge, from left to right, then counter-clockwise round the corners
  path.lineTo(x - r, -y);
  path.quadraticCurveTo(x, -y, x, -y + r);
  path.lineTo(x, y - r);
  path.quadraticCurveTo(x, y, x - r, y);
  path.lineTo(-x + r, y);
  path.quadraticCurveTo(-x, y, -x, y - r);
  path.lineTo(-x, -y + r);
  path.quadraticCurveTo(-x, -y, -x + r, -y);
}

/**
 * A token on `line`, just in front of `target`, the element it waits for; with the number of
 * tokens next to it when there is more than one.
 */
function addToken(scene: THREE.Scene, line: Line2, target: THREE.Object3D | undefined, count: number): void {
  const starts = line.geometry.attributes.instanceStart as THREE.InterleavedBufferAttribute | undefined; // a Line2 keeps its pieces as start and end points
  const ends = line.geometry.attributes.instanceEnd as THREE.InterleavedBufferAttribute | undefined;
  if (!starts || !ends || ends.count === 0) return; // a line without a piece: nowhere to put the token
  const from = new THREE.Vector3().fromBufferAttribute(starts, ends.count - 1).applyMatrix4(line.matrixWorld); // the last piece: it leads into the target
  const to = new THREE.Vector3().fromBufferAttribute(ends, ends.count - 1).applyMatrix4(line.matrixWorld);
  const length = from.distanceTo(to); // how long that piece is
  if (length === 0) return; // a piece without length has no direction
  const direction = to.clone().sub(from).normalize(); // along the flow, towards the target

  const bounds = target ? new THREE.Box3().setFromObject(target) : null; // the space the target takes
  const known = bounds !== null && !bounds.isEmpty(); // whether the target is drawn
  const side = known ? Math.min(bounds.max.x - bounds.min.x, bounds.max.y - bounds.min.y) : length / 2; // its shorter side, or half the piece when the target is unknown
  const radius = side * TOKEN_SIZE; // the token's size follows the element it waits for

  let stop = to; // where the token should touch: where the line meets the target
  if (known) {
    bounds.min.z = Math.min(bounds.min.z, from.z) - 1; // make sure the flat drawing plane of the line is inside the box
    bounds.max.z = Math.max(bounds.max.z, from.z) + 1;
    const entry = new THREE.Ray(from, direction).intersectBox(bounds, new THREE.Vector3()); // where the line enters the target
    if (entry && entry.distanceTo(from) <= length) stop = entry; // the line may end inside the target, or at its edge
  }
  const back = Math.min(side * TOKEN_DISTANCE, stop.distanceTo(from) / 2); // keep clear of the arrow head, but never move past the start of the piece
  const centre = stop.clone().addScaledVector(direction, -back); // the token's middle

  for (const [size, colour, order] of [[radius * 1.3, TOKEN.rim, 11], [radius, TOKEN.core, 12]] as const) {
    const disc = new THREE.Mesh(
      new THREE.CircleGeometry(size, 32), // 32 segments: a round dot
      new THREE.MeshBasicMaterial({ color: colour, depthTest: false, depthWrite: false, side: THREE.DoubleSide }), // never hidden behind an element
    );
    disc.position.set(centre.x, centre.y, centre.z); // on the line
    disc.renderOrder = order; // the rim first, the black dot on top of it, both above the glows
    scene.add(disc);
    helpers.push(disc);
  }

  if (count > 1) {
    const label = createNameTag(`${count}`, TOKEN.core); // how many tokens lie here
    label.center.set(0, 0.5); // starting right of the dot
    label.position.set(centre.x + radius * 1.5, centre.y, centre.z);
    scaleLabel(label, globalObject.camera);
    label.scale.multiplyScalar(LABEL_SIZE * 0.7); // small: it only adds a number
    scene.add(label);
    helpers.push(label);
  }
}

/** A label with `text` to the right of `object`; nothing when the element is not drawn. */
function addLabel(scene: THREE.Scene, object: THREE.Object3D | undefined, text: string): void {
  if (!object) return; // the variable is not drawn in this tab
  const bounds = new THREE.Box3().setFromObject(object); // the space the variable takes
  if (bounds.isEmpty()) return; // nothing to place the label at
  const label = createNameTag(text, VALUE); // a pill with the text
  label.center.set(0, 0.5); // anchored at the middle of its left edge, so it starts right of the variable
  label.position.set(bounds.max.x + (bounds.max.y - bounds.min.y) * 0.15, (bounds.min.y + bounds.max.y) / 2, bounds.max.z); // a small gap to the right, level with the middle
  scaleLabel(label, globalObject.camera); // a readable size for the current zoom
  label.scale.multiplyScalar(LABEL_SIZE); // a bit smaller than a name tag
  scene.add(label);
  helpers.push(label);
}
