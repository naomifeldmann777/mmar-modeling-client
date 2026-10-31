/**
 * The firing rule: the two operations that both the stepper and the path analysis are built
 * on (spec 7). Operation 1, `possibleSteps`, lists the steps possible in a state without
 * changing it; operation 2, `executeStep`, carries one of them out.
 *
 * Used by: the stepper and later the path analysis. Both pick one of the possible steps
 * whenever there is more than one (spec 7, 8). That happens in two situations:
 * - A value is drawn at a node: there is one step per value of the distribution, so picking a
 *   step means picking the value. The path at a Decision or OR-Split is never picked; it
 *   follows from the values and the conditions ("the user chooses a value, not a path").
 * - Several branches are active at once: there is one step per node that can fire, so picking
 *   a step means picking which branch to advance. This only changes the order, not the result.
 * In the stepper the user picks; in the path analysis the system draws by the probabilities.
 * Nothing here knows who picks, so nothing here assumes a user (plan 11).
 *
 * Deliberately NOT here:
 * - No Petri net is built. The coloured Petri net only defines what each concept does; these
 *   operations work directly on the simulation graph (spec 7).
 * - No checking: the graph has passed the validator. Where the validator would have refused
 *   the model (e.g. no condition holds at a Decision), there is simply no step.
 * - No decision about when a run is over or what to show: that is the stepper's job.
 *
 * Decisions taken in Phase 6:
 * - The values are kept once per run, not per token, since exactly one instance runs (plan 6).
 *   A draw therefore is visible everywhere at once, and an AND-Join has nothing to merge.
 *   Drawing the same variable in two parallel branches is refused by the validator (check 23).
 * - OR-Split and OR-Join follow spec 5.2 literally: for every branch whose condition does not
 *   hold, the OR-Split puts a "skip token" directly on the flow at which that branch ends,
 *   i.e. on an input of the OR-Join. Every branch thus delivers exactly one token, and the
 *   OR-Join waits like an AND-Join. Where a branch ends is found by following it forward to
 *   its OR-Join (`orBranchEnds` in pairs.ts); the validator makes sure this is unambiguous (check 24).
 * - Elements take no time (spec 5.1), and exactly one step is carried out at a time (spec 7).
 *
 * Source: spec 7 (the two operations), spec 5.2 (the modules of the concepts), spec 5.3
 * (only AND-Join, OR-Join and SynchronizedActivity wait), spec 6 (draws and conditions).
 */
import { evaluateCondition, type VariableValues } from "./condition"; // the conditions on the outgoing flows decide where a Decision or OR-Split sends its token
import type { GraphNode, SimulationGraph } from "./graph"; // the steps are computed on the simulation graph, not on the MMAR model
import { orBranchEnds } from "./pairs"; // where each OR-Split branch ends, for the skip tokens
import { WAITING_CONCEPTS } from "./vocabulary"; // the nodes that wait for a token on every incoming flow (spec 5.3)

/** The state of a run: the marking of the net (spec 7), the drawn values and the trace. */
export interface RunState {
  sourceToken: boolean; // the token on the source place in front of the Start (spec 5.2): true until the Start has run
  tokens: Readonly<Record<string, number>>; // flow uuid -> number of tokens on it; flows without a token are absent
  values: VariableValues; // variable name -> drawn value, one store for the whole run (Phase 6)
  trace: readonly string[]; // uuids of the nodes executed so far, in order (spec 7)
}

/** A value drawn in a step (spec 6.2). */
export interface Draw {
  generator: string; // uuid of the random generator, so the drawn value can be shown on it
  variableName: string; // the variable it is written to, by name as conditions use it
  value: string; // the value drawn if this step is chosen; the other values are other steps
  probability: number | null; // shown to the user for information only (spec 8); used by the path analysis
}

/** One possible step: one node, with the binding it would fire with (spec 7). */
export interface Step {
  node: string; // uuid of the node that would be executed
  fromSource: boolean; // true only for the Start: it takes the token from the source place
  consumes: string[]; // flows it would take a token from
  draws: Draw[]; // values it would draw; empty when nothing is drawn at the node
  produces: string[]; // flows it would put a token on: the branches that are entered
  skips: string[]; // OR-Split only: flows that would get a skip token, i.e. the ends of the branches not taken (spec 5.2)
}

/** The state at the beginning of a run: the single token lies in front of the Start, nothing is drawn (spec 8, step 1). */
export function initialState(): RunState {
  return { sourceToken: true, tokens: {}, values: {}, trace: [] }; // the Start is then the only possible step
}

// ---------------------------------------------------------------------------------
// Operation 1: possible steps
// ---------------------------------------------------------------------------------

/**
 * Every step that is possible in `state`, without changing it (spec 7, operation 1).
 *
 * A step is one node running once, in one particular way: which tokens it takes, which
 * values it draws, and on which flows it puts tokens. Several nodes can have steps at the
 * same time, e.g. after an AND-Split one per branch; the user picks which one runs next.
 * A node can also offer several steps itself:
 * - it draws a value: one step per value of the distribution;
 * - it is a Decision or OR-Split that draws: the steps also differ in where the token goes,
 *   because the drawn value decides which conditions hold.
 * A node that cannot run (no token, or a waiting node still missing one) offers no step.
 */
export function possibleSteps(graph: SimulationGraph, state: RunState): Step[] {
  const branchEnds = orBranchEnds(graph); // where each OR-Split branch ends, for the skip tokens
  const hasToken = (flowId: string) => (state.tokens[flowId] ?? 0) > 0; // is there a token on this flow?
  const steps: Step[] = []; // collected over all nodes

  // Four questions, one after the other; every combination of the answers is one step.
  for (const node of Object.values(graph.nodes)) { // 1. every node of the model
    const consumes = tokensToConsume(node, state, hasToken); // 2. can it run, and which tokens does it take?
    if (!consumes) continue; // it cannot run now: no step for this node
    for (const draws of drawOptions(graph, node.id)) { // 3. which values can it draw? No generator: exactly one way, drawing nothing
      const values = { ...state.values, ...Object.fromEntries(draws.map((draw) => [draw.variableName, draw.value])) }; // the values after this draw; a draw replaces the old value (spec 6.2)
      for (const { produces, skips } of outgoingOptions(graph, node, values, branchEnds)) { // 4. where do its tokens go with these values? One way, except at a Decision or OR-Split
        steps.push({ node: node.id, fromSource: node.concept === "Start", consumes, draws, produces, skips }); // one step for this combination
      }
    }
  }
  return steps; // empty when no node can run: the run is over or stuck
}

/**
 * Can `node` run in `state`, and if so, which tokens does it take? The answer is the list of
 * flows that lose a token when the node runs, or null when it cannot run. It becomes
 * `Step.consumes`, so `executeStep` knows which tokens to remove.
 *
 * The rule depends on the kind of node (spec 5.2, 5.3):
 * - A node that does not wait (Activity, Decision, AND-Split, ...) runs as soon as one of its
 *   inputs carries a token, and takes that token.
 * - A waiting node (AND-Join, OR-Join, SynchronizedActivity) needs a token on every input and
 *   takes them all at once.
 * - The Start takes the token on the source place in front of it, which lies on no flow.
 *
 * Examples:
 *   Activity A, inputs f1 and f2, a token on f2      -> [f2]       take the token from f2
 *   Activity A, no token on any input                -> null       cannot run: no step
 *   AND-Join, inputs d1 and d2, a token only on d1   -> null       still waiting
 *   AND-Join, tokens on d1 and d2                    -> [d1, d2]   take both
 *   Start, the run has just begun                    -> []         runs, but takes from no flow
 *   Start, after it has run                          -> null       cannot run again
 */
function tokensToConsume(node: GraphNode, state: RunState, hasToken: (flowId: string) => boolean): string[] | null {
  if (node.concept === "Start") return state.sourceToken ? [] : null; // its token lies on no flow, so it empties no flow; once the Start has run, it cannot run again
  if (WAITING_CONCEPTS.some((concept) => concept === node.concept)) { // an AND-Join, OR-Join or SynchronizedActivity
    return node.incoming.length > 0 && node.incoming.every(hasToken) ? node.incoming : null; // a token on EVERY incoming flow: it waits (spec 5.3); without the length test, a node with no incoming flow would count as complete
  }
  const input = node.incoming.find(hasToken); // the input the token arrived on
  return input === undefined ? null : [input]; // takes only that token (spec 5.3)
}

/**
 * The ways the draws at `nodeId` can turn out: one list of draws per combination of values.
 *
 * Example: a node with two generators, lager (ja / nein) and kunde (premium / normal).
 *   start:              [ [] ]                                  one way, nothing drawn yet
 *   after lager:        [ [ja], [nein] ]                        every way so far, once per value of lager
 *   after kunde:        [ [ja, premium], [ja, normal], [nein, premium], [nein, normal] ]
 * So the node offers four steps. With one generator it is one step per value; with none, one
 * step that draws nothing.
 */
function drawOptions(graph: SimulationGraph, nodeId: string): Draw[][] {
  const generators = Object.values(graph.generators).filter((generator) => generator.node === nodeId && generator.variable); // the draws attached to this node (spec 6.2); a generator without a variable has nowhere to write, so it draws nothing
  return generators.reduce<Draw[][]>( // take the generators one by one, each time extending the ways found so far
    (partial, generator) => // partial: the ways of the generators before this one; generator: the next one
      partial.flatMap((draws) => // every way so far is extended by every value of this generator; flatMap puts all the results into one flat list
        (generator.distribution ?? []).map((entry) => [ // one new way per value in the distribution
          ...draws, // what the earlier generators of this node draw
          { generator: generator.id, variableName: graph.variables[generator.variable!]?.name ?? "", value: entry.value, probability: entry.probability }, // one value of this one; `!` because the filter above kept only generators with a variable
        ]),
      ),
    [[]], // the start: exactly one way, drawing nothing, so a node without generator gets one step
  );
}

/** Where `node` puts its tokens, given the values after its own draw. One option per possible step. */
function outgoingOptions(graph: SimulationGraph, node: GraphNode, values: VariableValues, branchEnds: Map<string, string | null>): { produces: string[]; skips: string[] }[] {
  const holds = (flowId: string) => evaluateCondition(graph.flows[flowId].condition, values); // the guard of this flow's transition (spec 6.3)

  if (node.concept === "End") return [{ produces: [], skips: [] }]; // the token goes to the sink place: the run is over there (spec 5.2)
  if (node.concept === "Decision") { // exactly one way out: the flow whose condition holds
    return node.outgoing.filter(holds).map((flowId) => ({ produces: [flowId], skips: [] })); // one transition per flow, guarded by its condition; exactly one holds after the validator
  }
  if (node.concept === "OR-Split") { // one or more ways out at once: every flow whose condition holds
    const entered = node.outgoing.filter(holds); // the branches whose condition holds
    if (entered.length === 0) return []; // refused by the validator (check 22)
    const skipped = node.outgoing.filter((flowId) => !entered.includes(flowId)); // the branches that are skipped
    return [{ produces: entered, skips: skipped.map((flowId) => branchEnds.get(flowId)).filter((end): end is string => !!end) }]; // their tokens go straight to where they end (spec 5.2); a branch without a known end is refused by the validator (check 24), the filter only satisfies TypeScript
  }
  return [{ produces: node.outgoing, skips: [] }]; // every other node: a token on every outgoing flow (one for an Activity, all for an AND-Split or ForkActivity)
}

// ---------------------------------------------------------------------------------
// Operation 2: execution
// ---------------------------------------------------------------------------------

/**
 * Carries out `step` (spec 7, operation 2): removes the tokens it consumes, writes the drawn
 * values, puts tokens on the flows it produces on (and the skip tokens), and appends the node
 * to the trace. Returns a new state and leaves the given one unchanged.
 */
export function executeStep(state: RunState, step: Step): RunState {
  const tokens = { ...state.tokens }; // a copy, so the old state stays as it was
  for (const flowId of step.consumes) { // every flow the step takes a token from: one, or all inputs of a waiting node
    tokens[flowId] = (tokens[flowId] ?? 0) - 1; // take one token
    if (tokens[flowId] <= 0) delete tokens[flowId]; // a flow without token is absent from the marking
  }
  for (const flowId of [...step.produces, ...step.skips]) tokens[flowId] = (tokens[flowId] ?? 0) + 1; // put one token; a skip token is a token like any other
  const values = { ...state.values }; // one store per run (Phase 6)
  for (const draw of step.draws) values[draw.variableName] = draw.value; // the drawn value replaces the old one (spec 6.2)
  return { // a new state object, so whoever holds the old one (e.g. the stepper's history) still sees it unchanged
    sourceToken: state.sourceToken && !step.fromSource, // the Start has taken the token in front of it
    tokens, // the new marking
    values, // the values after the draw
    trace: [...state.trace, step.node], // a skipped branch is not executed, so it never appears here (spec 5.2)
  };
}
