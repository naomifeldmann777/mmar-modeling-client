/**
 * Splits and joins that belong together ("pairs"), and where the branches of a split end.
 *
 * A split opens branches, and its join collects them again: an OR-Split with its OR-Join, and
 * an AND-Split or ForkActivity with its AND-Join or SynchronizedActivity. This file walks along
 * the branches of every split to find the flow on which each branch enters its join.
 *
 * Used by:
 * - the firing rule (firing.ts): a branch of an OR-Split that is not taken gets a skip token
 *   on the flow where it ends (spec 5.2);
 * - the validator (validator.ts, check 24): every branch must end at exactly one input of its
 *   join, on every path.
 * Both use this one function, so the validator checks exactly what the firing rule relies on.
 *
 * Part of the library: it works on the simulation graph only. It used to sit in firing.ts, but
 * it analyses the structure of the model and has nothing to do with firing; the validator,
 * which runs before any step, should not depend on the firing rule.
 *
 * Source: spec 5.2 (the OR-Split and OR-Join modules), spec 10 / Phase 6 (check 24).
 */
import type { SimulationGraph } from "./graph"; // only the graph is read
import type { NodeConcept } from "./vocabulary"; // splits and joins are named by their concepts

/** The concepts that open and close the two kinds of pairs (spec 10, check 24). */
export const OR_PAIR = { splits: ["OR-Split"], joins: ["OR-Join"] } as const; // branches that may be skipped
export const PARALLEL_PAIR = { splits: ["AND-Split", "ForkActivity"], joins: ["AND-Join", "SynchronizedActivity"] } as const; // branches that all run

/** One kind of pair: the concepts of its splits and of its joins. */
export interface PairKind {
  splits: readonly NodeConcept[]; // e.g. AND-Split and ForkActivity
  joins: readonly NodeConcept[]; // e.g. AND-Join and SynchronizedActivity
}

/**
 * For every outgoing flow of every OR-Split: the flow at which that branch ends, i.e. the flow
 * through which it enters its OR-Join; null when there is no single such flow. This is where
 * the skip token of a branch that is not taken is put (spec 5.2).
 */
export function orBranchEnds(graph: SimulationGraph): Map<string, string | null> {
  const ends = branchEnds(graph, OR_PAIR); // the firing rule only needs the OR pairs; the validator checks both kinds
  return new Map([...ends].map(([branch, result]) => [branch, result.end])); // the firing rule only needs where each branch ends
}

/** What the walk along one branch found out (see branchEnd). */
export interface BranchEnd {
  end: string | null; // the flow through which the branch enters its join; null when there is not exactly one, or a path escapes
  entryFlows: string[]; // every flow on which the walk arrived at the join: exactly one is expected
  reachesEnd: boolean; // true when some path of the branch reaches an End element before the join: it "jumps out" of the pair
}

/**
 * For every outgoing flow of every split of `kind`: what the walk along that branch found, most
 * importantly the flow through which it enters its join. Used for the skip tokens (OR pairs)
 * and by the validator for both kinds of pairs (check 24).
 *
 * The result is a lookup table. Example, for an OR-Split with the branches b1 and b2 that enter
 * the OR-Join on d1 and d2:   b1 -> { end: d1, entryFlows: [d1], reachesEnd: false },   b2 -> { end: d2, … }.
 */
export function branchEnds(graph: SimulationGraph, kind: PairKind): Map<string, BranchEnd> {
  const ends = new Map<string, BranchEnd>(); // first flow of a branch -> what its walk found
  for (const split of Object.values(graph.nodes)) {
    if (!kind.splits.includes(split.concept)) continue; // only the splits of this kind start branches here
    for (const branch of split.outgoing) ends.set(branch, branchEnd(graph, branch, kind)); // one entry per branch
  }
  return ends;
}

/**
 * Where does the branch that starts with the flow `branch` enter its join? Returns that flow,
 * or null if there is not exactly one.
 *
 * How it works: walk forward from the branch's first flow, along every outgoing flow of every
 * node met (both sides of a Decision, all sides of any split), until a join of the same kind
 * is reached. The flow on which the walk arrives at that join is the end of the branch.
 *
 * Nesting: a branch may itself contain a split of the same kind with its own join. That inner
 * join must be walked through, not taken as the end. So the walk counts: passing a split of
 * this kind adds 1, meaning "an inner pair has opened"; arriving at a join of this kind with a
 * count above 0 subtracts 1, meaning "the inner pair has closed", and the walk goes on behind
 * it. Only a join reached with count 0 is the branch's own join. Splits and joins of the other
 * kind, and Decisions, are simply walked through: a nested pair of the other kind closes again
 * before the branch ends, so all its paths come together into one flow anyway.
 *
 * Example (OR pair, from firing.test.ts):
 *   OR-Split ─ b1 ─▶ inner OR-Split ─▶ x ─▶ inner OR-Join ─ e1 ─▶ OR-Join
 *                                   └─▶ y ─┘
 *            ─ b2 ─▶ z ─ e2 ─▶ OR-Join
 *   Walking b1: the inner OR-Split makes the count 1; x and y lead into the inner OR-Join,
 *   reached with count 1, so it becomes 0 and the walk goes on; e1 reaches the OR-Join with
 *   count 0. So the end of b1 is e1. The end of b2 is e2.
 *
 * The answer must be ONE flow, and EVERY path of the branch must lead to it:
 * - If the walk arrives at the join on two different flows (e.g. a Decision inside the branch
 *   whose two sides enter the join separately), the result is null: the join would get its
 *   token on one input or the other, never on both.
 * - If one path of the branch reaches an End before the join (e.g. one side of a Decision
 *   inside the branch leads to an End), the result is null as well: on that path the run would
 *   end while the other branches are still under way, and the join would never fire.
 * - If the walk never arrives at a join of this kind, the result is null.
 * The validator reports each of these cases with its own message (check 24); `entryFlows` and
 * `reachesEnd` tell it which one it is. Loops end because every flow is followed only
 * once per count, and a count higher than the number of nodes is not followed.
 */
function branchEnd(graph: SimulationGraph, branch: string, kind: PairKind): BranchEnd {
  const found = new Set<string>(); // the flows by which the branch enters its join; exactly one is expected
  const seen = new Set<string>(); // "flow|count" pairs already followed, so loops end
  const limit = Object.keys(graph.nodes).length; // a deeper nesting than there are nodes can only come from a loop
  let escapes = false; // set when some path of the branch reaches an End before its join

  const follow = (flowId: string, count: number) => {
    const key = `${flowId}|${count}`; // the same flow can be met at different nesting counts
    if (seen.has(key) || count > limit) return; // already followed, or running away in a loop
    seen.add(key);
    const node = graph.nodes[graph.flows[flowId]?.target ?? ""]; // the node this flow leads to
    if (!node) return; // the flow leads nowhere: reported by check 1, not here
    if (node.concept === "End") {
      escapes = true; // this path ends the run inside the branch
      return;
    }
    let inner = count; // the count for the flows behind this node
    if (kind.joins.includes(node.concept)) {
      if (count === 0) {
        found.add(flowId); // the branch's own join: the branch ends on this flow
        return;
      }
      inner = count - 1; // the join of an inner pair: it closes, the walk goes on behind it
    }
    if (kind.splits.includes(node.concept)) inner += 1; // an inner pair opens
    for (const next of node.outgoing) follow(next, inner); // on along every outgoing flow
  };

  follow(branch, 0); // start at the branch's first flow, no inner pair open yet
  return {
    end: !escapes && found.size === 1 ? [...found][0] : null, // exactly one end, reached on every path; otherwise check 24 reports it
    entryFlows: [...found], // the inputs of its own join on which this branch arrives: none = it never reaches its join; more than one = it arrives on several inputs
    reachesEnd: escapes, // tells the validator that the branch jumps out of the pair
  };
}
