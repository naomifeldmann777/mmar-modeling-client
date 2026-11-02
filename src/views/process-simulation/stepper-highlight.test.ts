// Tests for stepper-highlight.ts on a real three.js scene: a glow around the nodes that can run
// and the node that ran last, a token dot on its flow in front of the next node, a label next to
// a variable with a drawn value, and everything removed again. `@/engine` is mocked, since the real barrel builds a
// WebGLRenderer at module scope; the scene is a plain THREE.Scene. Ids are invented.
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as THREE from "three";
import { Line2 } from "three/examples/jsm/lines/Line2.js";
import { LineGeometry } from "three/examples/jsm/lines/LineGeometry.js";
import { LineMaterial } from "three/examples/jsm/lines/LineMaterial.js";
import type { Run } from "@/resources/process-simulation/stepper";

const mocks = vi.hoisted(() => ({ globalObject: { scene: null as unknown, camera: undefined, render: false } }));
vi.mock("@/engine", () => ({ globalObject: mocks.globalObject }));

import { clearHighlights, showHighlights } from "./stepper-highlight";

/** A drawn box with the uuid of its element, as the client draws class instances. */
function box(scene: THREE.Scene, uuid: string): THREE.Mesh {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial());
  mesh.uuid = uuid;
  scene.add(mesh);
  return mesh;
}

/** A drawn line with the uuid of its element, as the client draws relations. */
function line(scene: THREE.Scene, uuid: string): Line2 {
  const geometry = new LineGeometry();
  geometry.setPositions([0, 0, 0, 2, 1, 0]); // from (0,0) to (2,1)
  const drawn = new Line2(geometry, new LineMaterial({ color: 0xff0000 })); // red, its own colour
  drawn.uuid = uuid;
  scene.add(drawn);
  return drawn;
}

const count = (scene: THREE.Scene, type: new (...args: never[]) => THREE.Object3D) => scene.children.filter((child) => child instanceof type).length; // how many of a kind the scene holds
const glowLayers = (scene: THREE.Scene) => scene.children.filter((child): child is THREE.Mesh<THREE.ShapeGeometry, THREE.MeshBasicMaterial> => child instanceof THREE.Mesh && child.geometry instanceof THREE.ShapeGeometry && !(child.geometry instanceof THREE.CircleGeometry)); // the see-through rings of the glows
const tokenDiscs = (scene: THREE.Scene) => scene.children.filter((child): child is THREE.Mesh<THREE.CircleGeometry, THREE.MeshBasicMaterial> => child instanceof THREE.Mesh && child.geometry instanceof THREE.CircleGeometry); // the dot and its rim

// Check stock (just ran, drew lager = ja) → In stock? (can run next); the flow between them carries the token.
const run = {
  graph: {
    nodes: {},
    flows: { f2: { id: "f2", label: "Name", source: "check", target: "dec", condition: null } }, // the token waits on f2 for In stock?
    generators: { g: { id: "g", label: "Draw", node: "check", variable: "v", distribution: [] } },
    variables: { v: { id: "v", label: "Stock", name: "lager" } },
    issues: [],
  },
  state: { sourceToken: false, tokens: { f2: 1 }, values: { lager: "ja" }, trace: ["start", "check"] },
  steps: [{ node: "dec", fromSource: false, consumes: ["f2"], draws: [], produces: ["f3"], skips: [] }],
} as unknown as Run;

let scene: THREE.Scene;

beforeEach(() => {
  scene = new THREE.Scene();
  mocks.globalObject.scene = scene;
  box(scene, "check"); // at (0, 0)
  box(scene, "dec").position.set(2, 1, 0); // where the line f2 ends
  line(scene, "f2");
  box(scene, "v"); // the variable "lager"
});

describe("stepper-highlight", () => {
  it("puts a glow around the next and the last node, colours the token's flow and labels the drawn value", () => {
    showHighlights(run);
    const layers = glowLayers(scene);
    expect(layers.map((layer) => `#${layer.material.color.getHexString()}`).sort()).toEqual(["#00e676", "#a5d6a7"]); // one glow each: bright green around In stock? (now), pale green around Check stock (last)
    expect(layers.every((layer) => layer.material.transparent && !layer.material.depthTest)).toBe(true); // see-through, never hidden by another element
    const [rim, dot] = tokenDiscs(scene);
    expect([`#${rim.material.color.getHexString()}`, `#${dot.material.color.getHexString()}`]).toEqual(["#ffffff", "#212121"]); // a black dot on a white rim
    expect(dot.position.x).toBeGreaterThan(0.5); // on the line, past Check stock (whose box ends at x = 0.5) ...
    expect(dot.position.x).toBeLessThan(1.5); // ... and in front of In stock? (whose box starts at x = 1.5)
    expect((scene.getObjectByProperty("uuid", "f2") as Line2).material.color.getHex()).toBe(0xff0000); // the line keeps its own colour
    const label = scene.children.find((child): child is THREE.Sprite => child instanceof THREE.Sprite);
    expect(label?.position.x).toBeGreaterThan(0.5); // to the right of the variable, whose box ends at x = 0.5
    expect(label?.position.y).toBeCloseTo(0); // level with its middle
    expect(mocks.globalObject.render).toBe(true);
  });

  it("removes everything again", () => {
    showHighlights(run);
    clearHighlights();
    expect(glowLayers(scene)).toHaveLength(0);
    expect(tokenDiscs(scene)).toHaveLength(0);
    expect(count(scene, THREE.Sprite)).toBe(0);
  });

  it("shows the number of tokens when several lie on one flow", () => {
    showHighlights({ ...run, state: { ...run.state, values: {}, tokens: { f2: 2 } } }); // two tokens, no drawn value
    expect(count(scene, THREE.Sprite)).toBe(1); // the "2" next to the dot
  });

  it("replaces the previous highlighting instead of adding to it", () => {
    showHighlights(run);
    showHighlights(run);
    expect(glowLayers(scene)).toHaveLength(2); // still one glow per node
    expect(tokenDiscs(scene)).toHaveLength(2); // and one token (dot and rim)
  });
});
