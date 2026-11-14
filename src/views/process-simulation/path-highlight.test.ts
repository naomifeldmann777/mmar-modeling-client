// Tests for path-highlight.ts on a real three.js scene: an orange outline around every node of
// the path, an orange line over every flow it took (not over a skipped one), the flows keeping
// their own colour, and everything removed again. `@/engine` is mocked, since the real barrel
// builds a WebGLRenderer at module scope. Ids are invented.
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as THREE from "three";
import { Line2 } from "three/examples/jsm/lines/Line2.js";
import { LineGeometry } from "three/examples/jsm/lines/LineGeometry.js";
import { LineMaterial } from "three/examples/jsm/lines/LineMaterial.js";
import type { SimulationGraph } from "@/resources/process-simulation/graph";
import type { AnalysedPath } from "@/resources/process-simulation/path-analysis";

const mocks = vi.hoisted(() => ({ globalObject: { scene: null as unknown, render: false } }));
vi.mock("@/engine", () => ({ globalObject: mocks.globalObject }));

import { clearPathHighlight, showPath } from "./path-highlight";

/** A drawn box with the uuid of its element. */
function box(scene: THREE.Scene, uuid: string, x: number): void {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial());
  mesh.uuid = uuid;
  mesh.position.x = x;
  scene.add(mesh);
}

/** A drawn black line with the uuid of its element. */
function line(scene: THREE.Scene, uuid: string): void {
  const geometry = new LineGeometry();
  geometry.setPositions([0, 0, 0, 2, 0, 0]);
  const drawn = new Line2(geometry, new LineMaterial({ color: 0x000000, linewidth: 0.03 }));
  drawn.uuid = uuid;
  scene.add(drawn);
}

// Start → OR-Split → Task 1 (entered) → Join; Task 2 skipped. The path ran start, or, t1, join.
const graph = { flows: { f0: {}, e1: {}, x1: {}, e2: {}, x2: {} } } as unknown as SimulationGraph; // only the flows are read
const path = {
  nodes: ["start", "or", "t1", "join"],
  trace: [
    { node: "start", consumes: [], produces: ["f0"], draws: [] },
    { node: "or", consumes: ["f0"], produces: ["e1"], draws: [] }, // e2 skipped: its end x2 got a skip token, not listed here
    { node: "t1", consumes: ["e1"], produces: ["x1"], draws: [] },
    { node: "join", consumes: ["x1", "x2"], produces: [], draws: [] },
  ],
} as unknown as AnalysedPath;

const lines = (scene: THREE.Scene) => scene.children.filter((child): child is Line2 => child instanceof Line2);
const outlines = (scene: THREE.Scene) => scene.children.filter((child): child is THREE.Mesh<THREE.ShapeGeometry, THREE.MeshBasicMaterial> => child instanceof THREE.Mesh && child.geometry instanceof THREE.ShapeGeometry);
const orange = (line: Line2) => `#${(line.material as LineMaterial).color.getHexString()}` === "#ff9800";

let scene: THREE.Scene;

beforeEach(() => {
  scene = new THREE.Scene();
  mocks.globalObject.scene = scene;
  ["start", "or", "t1", "t2", "join"].forEach((id, index) => box(scene, id, index * 3));
  ["f0", "e1", "x1", "e2", "x2"].forEach((id) => line(scene, id));
  clearPathHighlight();
});

describe("path-highlight", () => {
  it("outlines every node of the path in orange, and draws over every flow it took", () => {
    showPath(graph, path);
    expect(outlines(scene).map((o) => `#${o.material.color.getHexString()}`)).toEqual(Array(4).fill("#ff9800")); // start, or, t1, join; not t2
    expect(lines(scene).filter(orange)).toHaveLength(3); // f0, e1, x1; not the skipped e2 or x2
    expect(lines(scene).filter((l) => !orange(l)).every((l) => `#${(l.material as LineMaterial).color.getHexString()}` === "#000000")).toBe(true); // the flows keep their own colour
    expect(mocks.globalObject.render).toBe(true);
  });

  it("shows one path at a time, and removes everything again", () => {
    showPath(graph, path);
    showPath(graph, path); // e.g. another path clicked
    expect(outlines(scene)).toHaveLength(4); // not 8
    clearPathHighlight();
    expect(outlines(scene)).toHaveLength(0);
    expect(lines(scene).filter(orange)).toHaveLength(0);
    expect(lines(scene)).toHaveLength(5); // the model's own flows stay
  });
});
