/**
 * Tests for pairs.ts: where the branches of a split end, including nested pairs, a branch that
 * enters its join on two flows, and a branch that jumps out to an End. Graphs are built
 * directly, with ids invented for the test.
 */
import { describe, expect, it } from "vitest";
import type { GraphFlow, GraphNode, SimulationGraph } from "./graph";
import { orBranchEnds } from "./pairs";
import type { NodeConcept } from "./vocabulary";

const node = (id: string, concept: NodeConcept): GraphNode => ({ id, label: id, concept, incoming: [], outgoing: [] }); // wired by graph()
const flow = (id: string, source: string, target: string): GraphFlow => ({ id, label: id, source, target, condition: [] }); // conditions play no part here

/** A graph from nodes and flows; incoming and outgoing are wired as the transformer does. */
function graph(nodes: GraphNode[], flows: GraphFlow[]): SimulationGraph {
  const result: SimulationGraph = {
    nodes: Object.fromEntries(nodes.map((n) => [n.id, n])),
    flows: Object.fromEntries(flows.map((f) => [f.id, f])),
    generators: {},
    variables: {},
    issues: [],
  };
  for (const f of flows) {
    result.nodes[f.source!].outgoing.push(f.id);
    result.nodes[f.target!].incoming.push(f.id);
  }
  return result;
}

describe("orBranchEnds", () => {
  it("finds the end of a branch behind a nested OR-Split and OR-Join", () => {
    const g = graph(
      [node("or", "OR-Split"), node("inner", "OR-Split"), node("x", "Activity"), node("y", "Activity"), node("innerJoin", "OR-Join"), node("z", "Activity"), node("join", "OR-Join")],
      [
        flow("b1", "or", "inner"), flow("i1", "inner", "x"), flow("i2", "inner", "y"), flow("x2", "x", "innerJoin"), flow("y2", "y", "innerJoin"), flow("e1", "innerJoin", "join"), // branch 1 holds a nested OR block
        flow("b2", "or", "z"), flow("e2", "z", "join"), // branch 2
      ],
    );
    const ends = orBranchEnds(g);
    expect(ends.get("b1")).toBe("e1"); // not x2 or y2: those end the nested branches
    expect(ends.get("b2")).toBe("e2");
    expect(ends.get("i1")).toBe("x2"); // the nested OR-Split's own branches
  });

  it("gives null when a branch can enter its OR-Join on two different flows", () => {
    const g = graph(
      [node("or", "OR-Split"), node("dec", "Decision"), node("other", "Activity"), node("join", "OR-Join")],
      [flow("b1", "or", "dec"), flow("p", "dec", "join"), flow("q", "dec", "join"), flow("b2", "or", "other"), flow("e2", "other", "join")], // branch 1 splits again and enters twice
    );
    expect(orBranchEnds(g).get("b1")).toBeNull(); // ambiguous: the validator refuses it (check 24)
  });
});

describe("branchEnds: every path must reach the join", () => {
  it("gives null for a branch with a path that reaches an End first", () => {
    const g = graph(
      [node("or", "OR-Split"), node("dec", "Decision"), node("a", "Activity"), node("early", "End"), node("b", "Activity"), node("join", "OR-Join")],
      [flow("b1", "or", "dec"), flow("p", "dec", "a"), flow("q", "dec", "early"), flow("a2", "a", "join"), flow("b2", "or", "b"), flow("e2", "b", "join")], // one side of the decision leaves the branch
    );
    const ends = orBranchEnds(g);
    expect(ends.get("b1")).toBeNull(); // the skip token would have a place, but the branch could end the run
    expect(ends.get("b2")).toBe("e2"); // the other branch is fine
  });
});
