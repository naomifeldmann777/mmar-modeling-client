/**
 * The validator: checks a simulation graph before a run starts, so that a problem is
 * reported on the element it concerns instead of showing up as a run that gets stuck
 * (spec 10).
 *
 * Used by: the stepper (and later the path analysis), after the transformer and before the
 * first step. If it returns any problem, the run does not start (spec 8, step 1). The checks
 * are the same for both algorithms (spec 10).
 *
 * Deliberately NOT here:
 * - No access to the model or the mapping: everything is checked on the graph (graph.ts),
 *   so the validator moves into a library together with the algorithms.
 * - No repair: the validator only reports.
 *
 * Decisions taken in Phase 5:
 * - All 22 checks of spec 10 are implemented, and every failed check is an error.
 * - Check 2 also covers what the transformer could not translate (graph.issues).
 * - Check 14 (only supported distribution types) needs no code: the attribute mapped as
 *   Distribution is read as a table "value | probability", which is a discrete distribution
 *   by its format.
 * - Check 17 also requires the operator to be one of ==, !=, <, <=, >, >= and the logical
 *   operator of every row after the first to be AND or OR, since the run could not evaluate
 *   anything else.
 * - Check 16: where alternative paths meet (the sides of a Decision coming together, or an
 *   OR-Join, where a branch may have been skipped), a variable counts as drawn only if it is
 *   drawn on every incoming path. At an AND-Join or SynchronizedActivity every incoming branch
 *   has run, so a variable drawn on any of them counts (one value store per run, Phase 6).
 * - Checks 20 to 22 evaluate the conditions for every combination of the values the variables
 *   can be drawn with. This may report a combination that never occurs in a real run, but it
 *   never misses one that does.
 * - A check that depends on another is skipped for an element on which that other check
 *   already failed, so one mistake gives one message, not three.
 *
 * Three checks beyond spec 10, added in Phase 6 because of decisions on the firing rule:
 * - Check 23: no variable is drawn in two parallel branches, nor by two random generators at
 *   the same node. The values are kept once per run, so the value would otherwise depend on
 *   the order in which the branches are advanced or the generators are read, which spec 7
 *   rules out.
 * - Check 24: splits and joins form matching pairs (OR-Split with OR-Join; AND-Split or
 *   ForkActivity with AND-Join or SynchronizedActivity). Every path of every branch leads to
 *   exactly one input of the pair's join, every input of a join is the end of a branch of one
 *   and the same split, and no flow leads into a branch from outside the pair.
 *   This gives the skip tokens of spec 5.2 their place, and makes sure every join receives
 *   exactly one token per input: no join waits forever, no node runs once per parallel
 *   branch, and no branch ends the run while another one is still under way.
 *
 * - Check 25: only an outgoing flow of a Decision or an OR-Split carries a transition
 *   condition; anywhere else it would be ignored by the firing rule.
 *
 * Added in Phase 7:
 * - Check 26: every loop can be left. Inside every loop, at least one variable that the loop's
 *   conditions read is drawn again; otherwise the token takes the same way in every round
 *   and, with some values, never leaves the loop.
 *
 * Added to check 9 in Phase 6 (and to the specification text): Start, Activity, AND-Join,
 * OR-Join and SynchronizedActivity have exactly one outgoing flow, so that only the split
 * concepts split the flow.
 *
 * Source: spec 10 (the checks), spec 8 (a failed check stops the run), spec 6.1 (a
 * condition on a variable that has not been drawn is false).
 */
import { COMPARISON_OPERATORS, evaluateCondition, LOGICAL_OPERATORS, type VariableValues } from "./condition";
import type { GraphFlow, GraphGenerator, GraphNode, GraphVariable, SimulationGraph } from "./graph";
import { parseDecimal } from "./numbers"; // checks 12 and 19 read numbers the same way as the run
import { branchEnds, OR_PAIR, PARALLEL_PAIR } from "./pairs"; // check 24 uses the same branch ends as the firing rule
import { WAITING_CONCEPTS, type NodeConcept } from "./vocabulary";

/** One problem found by the validator. */
export interface ValidationProblem {
  severity: "error" | "warning"; // always "error" in this version (decided in Phase 5); the field leaves room for warnings
  check: number; // the number of the check in spec 10, so a message can be traced to the specification
  message: string; // for the user: names the element and what is wrong with it
  elementId: string | null; // uuid of the element to show the problem on; null when it concerns the whole model, e.g. "no Start"
}

const DECIDING: readonly NodeConcept[] = ["Decision", "OR-Split"]; // the nodes whose outgoing flows follow from conditions (spec 7)
const SPLITTING: readonly NodeConcept[] = ["AND-Split", "OR-Split", "ForkActivity"]; // need at least two outgoing flows (spec 10, check 9)
const SINGLE_OUTGOING: readonly NodeConcept[] = ["Start", "Activity", "AND-Join", "OR-Join", "SynchronizedActivity"]; // exactly one outgoing flow (check 9, part 2)
const NUMERIC_OPERATORS: readonly string[] = ["<", "<=", ">", ">="]; // only for numbers (spec 10, check 19)
const TOLERANCE = 1e-6; // "within a small tolerance" (spec 10, check 12): 0.1 + 0.2 is not exactly 0.3 in a computer

/** What every group of checks needs: the graph, its parts as lists, and the way to report. */
interface Context {
  graph: SimulationGraph; // for lookups by uuid
  nodes: GraphNode[]; // the parts as lists, for going through them
  flows: GraphFlow[];
  generators: GraphGenerator[];
  variables: GraphVariable[];
  withIssue: Set<string>; // elements the transformer already reported: their dependent checks are skipped
  report: (check: number, elementId: string | null, message: string) => void; // records one problem
  labelOf: (id: string | null) => string; // the name of a node or variable, "?" for an end that is neither
  describeFlow: (flow: GraphFlow) => string; // e.g. sequence flow "Name" (lager? → End ja): flows are rarely named
}

/** Checks the graph. An empty list means the run may start. */
export function validateGraph(graph: SimulationGraph): ValidationProblem[] {
  const problems: ValidationProblem[] = []; // filled by every group of checks
  const labelOf = (id: string | null) => (id ? (graph.nodes[id]?.label ?? graph.variables[id]?.label) : undefined) ?? "?"; // ends of flows and draws
  const context: Context = {
    graph, // the graph itself
    nodes: Object.values(graph.nodes), // as lists, once
    flows: Object.values(graph.flows),
    generators: Object.values(graph.generators),
    variables: Object.values(graph.variables),
    withIssue: new Set(graph.issues.map((issue) => issue.elementId)), // already reported by the transformer
    report: (check, elementId, message) => problems.push({ severity: "error", check, message, elementId }), // every failed check is an error (Phase 5)
    labelOf, // shared by all messages
    describeFlow: (flow) => `sequence flow "${flow.label}" (${labelOf(flow.source)} → ${labelOf(flow.target)})`, // as in the mapping popup
  };

  checkMapping(context); // checks 1 to 3
  const reachable = checkStructure(context); // checks 4 to 9; returns the nodes reachable from the Start, which check 16 needs
  checkVariables(context); // checks 10 to 14
  checkConditions(context, reachable); // checks 15 to 22, and check 25 (beyond spec)
  checkParallelDraws(context); // check 23, beyond spec 10
  checkPairs(context); // check 24, beyond spec 10
  checkLoops(context, reachable); // check 26, beyond spec 10; only loops a run can reach

  return problems.sort((a, b) => a.check - b.check); // in the order of spec 10; sort keeps the order within a check
}

// ---------------------------------------------------------------------------------
// Mapping (checks 1 to 3)
// ---------------------------------------------------------------------------------

function checkMapping({ graph, flows, generators, variables, nodes, withIssue, report, describeFlow }: Context) {
  // Check 1: both ends of every sequence flow are elements mapped to a node concept.
  for (const flow of flows) {
    for (const end of ["source", "target"] as const) {
      const id = flow[end]; // the element at this end, if any
      if (id === null) report(1, flow.id, `The ${describeFlow(flow)} has no ${end} element.`); // e.g. it ends at a port
      else if (!graph.nodes[id]) report(1, flow.id, `The ${end} of the ${describeFlow(flow)} is not mapped to a node concept.`); // unmapped, or mapped to Variable
    }
  }

  // Check 2: each concept is assigned to an element that can carry it. The transformer finds
  // these cases while it reads the model, so its issues are reported here.
  for (const issue of graph.issues) report(2, issue.elementId, issue.message);

  // Check 3: where a concept carries a data concept, the attribute is assigned too.
  for (const generator of generators) {
    if (generator.distribution === null && !withIssue.has(generator.id)) {
      report(3, generator.id, `Random generator "${generator.label}" has no Distribution assigned in the concept mapping.`);
    }
  }
  for (const variable of variables) {
    if (variable.name === null) report(3, variable.id, `Variable "${variable.label}" has no VariableName assigned in the concept mapping.`);
  }
  for (const node of nodes.filter((candidate) => DECIDING.includes(candidate.concept))) {
    for (const flow of node.outgoing.map((id) => graph.flows[id])) {
      if (flow.condition === null && !withIssue.has(flow.id)) {
        report(3, flow.id, `The ${describeFlow(flow)} leaves ${node.concept} "${node.label}" but has no TransitionCondition assigned in the concept mapping.`);
      }
    }
  }
}

// ---------------------------------------------------------------------------------
// Structure (checks 4 to 9)
// ---------------------------------------------------------------------------------

/** Runs checks 4 to 9 and returns the uuids of the nodes reachable from the Start element. */
function checkStructure({ graph, nodes, report }: Context): Set<string> {
  const starts = nodes.filter((node) => node.concept === "Start"); // check 4 wants exactly one
  const ends = nodes.filter((node) => node.concept === "End"); // and at least one of these

  // Check 4: exactly one Start element and at least one End element.
  if (starts.length === 0) report(4, null, "The model has no element mapped to Start."); // concerns the whole model
  if (starts.length > 1) {
    for (const start of starts) report(4, start.id, `"${start.label}" is one of ${starts.length} Start elements; there must be exactly one.`); // each one is shown
  }
  if (ends.length === 0) report(4, null, "The model has no element mapped to End.");

  // Check 5: the Start element has no incoming flow, and no End element has an outgoing flow.
  for (const start of starts) if (start.incoming.length > 0) report(5, start.id, `Start "${start.label}" has an incoming flow.`);
  for (const end of ends) if (end.outgoing.length > 0) report(5, end.id, `End "${end.label}" has an outgoing flow.`);

  // Check 6: every other node has at least one incoming and at least one outgoing flow.
  for (const node of nodes.filter((candidate) => candidate.concept !== "Start" && candidate.concept !== "End")) {
    if (node.incoming.length === 0) report(6, node.id, `${node.concept} "${node.label}" has no incoming flow.`);
    if (node.outgoing.length === 0) report(6, node.id, `${node.concept} "${node.label}" has no outgoing flow.`);
  }

  // Check 9, part 1 (spec 10): joins have at least two incoming flows, splits at least two
  // outgoing flows. Zero flows were already reported by check 6, so only a single flow is
  // reported here: one mistake, one message.
  //
  // Check 9, part 2 (added to the specification in Phase 6): Start, Activity, AND-Join,
  // OR-Join and SynchronizedActivity have exactly ONE outgoing flow. Why: the specification
  // describes each of them as continuing on "the" outgoing flow (spec 2.1, 5.2), and the
  // firing rule puts a token on every outgoing flow of a node that is not a Decision or an
  // OR-Split. An Activity with two outgoing flows would therefore secretly behave like an
  // AND-Split, without being visible as one in the model. Splitting is said explicitly, with
  // an AND-Split, ForkActivity, Decision or OR-Split. Thanks to this rule, the only parallel
  // splits are AND-Split and ForkActivity, which check 24 relies on.
  for (const node of nodes) {
    if (WAITING_CONCEPTS.some((concept) => concept === node.concept) && node.incoming.length === 1) {
      report(9, node.id, `${node.concept} "${node.label}" has only one incoming flow; it needs at least two.`);
    }
    if (SPLITTING.includes(node.concept) && node.outgoing.length === 1) {
      report(9, node.id, `${node.concept} "${node.label}" has only one outgoing flow; it needs at least two.`);
    }
    if (SINGLE_OUTGOING.includes(node.concept) && node.outgoing.length > 1) {
      report(9, node.id, `${node.concept} "${node.label}" has ${node.outgoing.length} outgoing flows; it may have only one. Use an AND-Split, ForkActivity, Decision or OR-Split to split the flow.`);
    }
  }

  // The neighbours of a node along the flows, for the two searches below. A flow end that is
  // not a node was reported by check 1 and is not followed.
  const next = (node: GraphNode) => node.outgoing.map((id) => graph.flows[id].target).filter((id): id is string => id !== null && !!graph.nodes[id]);
  const previous = (node: GraphNode) => node.incoming.map((id) => graph.flows[id].source).filter((id): id is string => id !== null && !!graph.nodes[id]);

  // Check 7: every node can be reached from the Start element. Only meaningful with exactly one Start (check 4).
  const reachable = starts.length === 1 ? search(graph, [starts[0].id], next) : new Set<string>(); // forwards from the Start
  if (starts.length === 1) {
    for (const node of nodes) if (!reachable.has(node.id)) report(7, node.id, `${node.concept} "${node.label}" cannot be reached from the Start element.`);
  }

  // Check 8: from every node an End element can be reached. Searching backwards from all Ends
  // finds every node that leads to one. Without an End, check 4 has already said everything.
  if (ends.length > 0) {
    const leadsToEnd = search(graph, ends.map((end) => end.id), previous); // backwards from every End
    for (const node of nodes) if (!leadsToEnd.has(node.id)) report(8, node.id, `From ${node.concept} "${node.label}" no End element can be reached.`);
  }

  return reachable; // check 16 only follows paths that a run can take
}

/** All nodes reachable from `from` by repeatedly following `step` (breadth-first search). */
function search(graph: SimulationGraph, from: string[], step: (node: GraphNode) => string[]): Set<string> {
  const found = new Set(from); // the nodes reached so far
  const queue = [...from]; // the nodes whose neighbours have not been looked at yet
  while (queue.length > 0) {
    for (const id of step(graph.nodes[queue.shift()!])) {
      if (!found.has(id)) {
        found.add(id); // reached for the first time
        queue.push(id); // so look at its neighbours later; loops end here, since a node is added only once
      }
    }
  }
  return found;
}

// ---------------------------------------------------------------------------------
// Variables and random generators (checks 10 to 14)
// ---------------------------------------------------------------------------------

function checkVariables({ variables, generators, withIssue, report, labelOf }: Context) {
  const describe = (generator: GraphGenerator) => `Random generator "${generator.label}" (${labelOf(generator.node)} → ${labelOf(generator.variable)})`; // draws are rarely named either

  // Check 10: every variable has a name, no name is empty, and no two variables share one.
  const byName = new Map<string, GraphVariable[]>(); // name -> the variables that have it
  for (const variable of variables) {
    if (variable.name === "") report(10, variable.id, `Variable "${variable.label}" has an empty name.`); // a missing name (null) is check 3
    else if (variable.name !== null) byName.set(variable.name, [...(byName.get(variable.name) ?? []), variable]);
  }
  for (const [name, sharing] of byName) {
    if (sharing.length > 1) {
      for (const variable of sharing) report(10, variable.id, `Variable "${variable.label}" has the name "${name}", which ${sharing.length - 1} other variable(s) have too.`);
    }
  }

  for (const generator of generators) {
    // Check 11: every random generator refers to exactly one variable and lists at least one value.
    if (generator.variable === null && !withIssue.has(generator.id)) report(11, generator.id, `${describe(generator)} sets no variable.`);
    if (generator.distribution?.length === 0) report(11, generator.id, `${describe(generator)} lists no value to draw.`);
    const entries = generator.distribution ?? []; // the checks below need the values

    // Check 12: the probabilities add up to one, within a small tolerance, and none is negative.
    for (const entry of entries) {
      if (entry.probability === null) report(12, generator.id, `${describe(generator)}: the probability of "${entry.value}" is not a number.`);
      else if (entry.probability < 0) report(12, generator.id, `${describe(generator)}: the probability of "${entry.value}" is negative.`);
    }
    if (entries.length > 0 && entries.every((entry) => entry.probability !== null)) {
      const sum = entries.reduce((total, entry) => total + entry.probability!, 0); // only meaningful when every probability is a number
      if (Math.abs(sum - 1) > TOLERANCE) report(12, generator.id, `${describe(generator)}: the probabilities add up to ${Number(sum.toFixed(6))}, not 1.`);
    }

    // Check 13: no value appears twice within the same distribution.
    const seen = new Set<string>(); // the values met so far
    const reported = new Set<string>(); // each duplicate is reported once
    for (const entry of entries) {
      if (seen.has(entry.value) && !reported.has(entry.value)) {
        report(13, generator.id, `${describe(generator)} lists the value "${entry.value}" more than once.`);
        reported.add(entry.value);
      }
      seen.add(entry.value);
    }
  }

  // Check 14: needs no code (decided in Phase 5): a Distribution is read as a table
  // "value | probability", which is a discrete distribution by its format.
}

// ---------------------------------------------------------------------------------
// Conditions (checks 15 to 22)
// ---------------------------------------------------------------------------------

function checkConditions({ graph, nodes, flows, generators, variables, report, describeFlow, labelOf }: Context, reachable: Set<string>) {
  const nameOf = (variableId: string | null) => (variableId ? (graph.variables[variableId]?.name ?? null) : null); // the name a draw writes to
  const names = new Set(variables.map((variable) => variable.name).filter((name): name is string => !!name)); // the names conditions may use

  // The values a variable can take: every value of every distribution that draws into it.
  // A name is in this map exactly when some random generator draws into it.
  const domains = new Map<string, Set<string>>();
  for (const generator of generators) {
    const name = nameOf(generator.variable); // the variable this draw writes to
    if (!name) continue; // no variable, or one without a name: reported by checks 3, 10 or 11
    const domain = domains.get(name) ?? new Set<string>(); // shared by all draws into the same variable (e.g. test model F)
    for (const entry of generator.distribution ?? []) domain.add(entry.value);
    domains.set(name, domain);
  }

  const broken = new Set<string>(); // flows whose condition cannot be evaluated; checks 20 to 22 skip their node

  // Check 25 (added in Phase 6): only an outgoing flow of a Decision or an OR-Split carries a
  // condition. Only there does a condition decide where the flow continues (spec 7); the firing
  // rule does not evaluate it anywhere else, although in the coloured Petri net it would become
  // a guard that could block the transition. Rather than ignoring such a condition silently,
  // it is reported. An empty condition table (no filled row) is no condition: the transformer
  // has already turned it into [], so the default row of every new flow is never reported.
  // A misplaced condition is not checked any further (checks 15 to 19 and 16 skip it): one
  // mistake, one message.
  const misplaced = new Set<string>(); // flows with a condition that is not evaluated
  for (const flow of flows) {
    const source = flow.source ? graph.nodes[flow.source] : undefined; // the node the flow leaves
    if (!source || !flow.condition || flow.condition.length === 0 || DECIDING.includes(source.concept)) continue; // no condition, a source that is no node (check 1), or a place where conditions belong
    misplaced.add(flow.id);
    report(25, flow.id, `The ${describeFlow(flow)} has a transition condition, but it leaves ${source.concept} "${source.label}", where conditions are not evaluated, so it would be ignored. Remove the condition, or decide with a Decision or an OR-Split.`);
  }

  for (const flow of flows) {
    if (misplaced.has(flow.id)) continue; // already reported by check 25
    for (const [index, row] of (flow.condition ?? []).entries()) {
      const where = `Row ${index + 1} of the condition of the ${describeFlow(flow)}`; // every message names the row and the flow

      // Check 17: every row names a variable, an operator and a value, and every row after the
      // first also names a logical operator (here: known ones, see the header).
      const hasVariable = row.variableName !== ""; // column 1 filled
      const knownOperator = COMPARISON_OPERATORS.some((operator) => operator === row.operator); // column 2 is one of the six
      const hasValue = row.value !== ""; // column 3 filled
      const linked = index === 0 || LOGICAL_OPERATORS.some((operator) => operator === row.logicalOperator); // column 4 is AND / OR, except in the first row
      if (!hasVariable) report(17, flow.id, `${where} names no variable.`);
      if (row.operator === "") report(17, flow.id, `${where} names no operator.`);
      else if (!knownOperator) report(17, flow.id, `${where} uses the operator "${row.operator}"; allowed are ${COMPARISON_OPERATORS.join(" ")}.`);
      if (!hasValue) report(17, flow.id, `${where} names no value.`);
      if (!linked) report(17, flow.id, `${where} is not linked to the previous row with AND or OR.`);
      if (!(hasVariable && knownOperator && hasValue && linked)) {
        broken.add(flow.id); // incomplete: the condition cannot be evaluated
        continue; // the checks below need a complete row
      }

      // Check 15: the variable exists in the model, and a value is drawn for it at some element.
      if (!names.has(row.variableName)) {
        report(15, flow.id, `${where} refers to the variable "${row.variableName}", which does not exist.`);
        broken.add(flow.id);
        continue;
      }
      const domain = domains.get(row.variableName); // its possible values
      if (!domain) {
        report(15, flow.id, `${where} refers to the variable "${row.variableName}", but no value is drawn for it anywhere.`);
        broken.add(flow.id);
        continue;
      }

      // Check 18: with == or !=, the compared value appears in the variable's distribution.
      if ((row.operator === "==" || row.operator === "!=") && !domain.has(row.value)) {
        report(18, flow.id, `${where} compares "${row.variableName}" with "${row.value}", which is not one of its values (${[...domain].join(", ")}).`);
      }

      // Check 19: <, <=, > and >= only on variables all of whose values are numbers.
      if (NUMERIC_OPERATORS.includes(row.operator)) {
        const notNumbers = [...domain].filter((value) => parseDecimal(value) === null); // values that cannot be compared as numbers
        if (notNumbers.length > 0) {
          report(19, flow.id, `${where} uses ${row.operator} on "${row.variableName}", whose values are not all numbers ("${notNumbers[0]}").`);
          broken.add(flow.id);
        } else if (parseDecimal(row.value) === null) {
          report(19, flow.id, `${where} compares "${row.variableName}" with "${row.value}" using ${row.operator}, but "${row.value}" is not a number.`);
          broken.add(flow.id);
        }
      }
    }
  }

  // Check 16: on every path from the Start to a condition, its variable has been drawn before.
  const drawn = drawnOnEveryPath(graph, generators, reachable, nameOf); // node uuid -> names surely drawn once the node has run
  for (const flow of flows) {
    if (!flow.condition || !flow.source || !reachable.has(flow.source) || broken.has(flow.id) || misplaced.has(flow.id)) continue; // unreachable or already reported
    const available = drawn.get(flow.source)!; // the condition is evaluated when its source node runs, after the node's own draw
    for (const name of new Set(flow.condition.map((row) => row.variableName))) {
      if (!available.has(name)) {
        report(16, flow.id, `On some path to the ${describeFlow(flow)}, no value is drawn for "${name}" before the condition is evaluated, so the condition would be false there.`);
      }
    }
  }

  // Checks 20 to 22: at a Decision no two conditions hold at once and at least one holds; at
  // an OR-Split at least one holds. Tried for every combination of the variables' values.
  for (const node of nodes.filter((candidate) => DECIDING.includes(candidate.concept))) {
    const outgoing = node.outgoing.map((id) => graph.flows[id]); // the branches
    if (outgoing.length === 0 || outgoing.some((flow) => flow.condition === null || broken.has(flow.id))) continue; // reported by checks 3, 6, 15, 17 or 19
    const read = [...new Set(outgoing.flatMap((flow) => flow.condition!.map((row) => row.variableName)))]; // the variables the conditions read
    const reportedChecks = new Set<number>(); // one message per check and node is enough

    for (const values of combinations(read, domains)) {
      const holding = outgoing.filter((flow) => evaluateCondition(flow.condition, values)); // the branches whose condition holds
      const when = read.length === 0 ? "in every case" : `when ${read.map((name) => `${name} = ${values[name]}`).join(", ")}`; // the combination, for the message
      const targets = (branches: GraphFlow[]) => branches.map((flow) => `"${labelOf(flow.target)}"`).join(" and "); // branches named by where they lead

      if (node.concept === "Decision" && holding.length > 1 && !reportedChecks.has(20)) {
        report(20, node.id, `At Decision "${node.label}", the conditions of the flows to ${targets(holding)} hold at the same time ${when}.`);
        reportedChecks.add(20);
      }
      if (node.concept === "Decision" && holding.length === 0 && !reportedChecks.has(21)) {
        report(21, node.id, `At Decision "${node.label}", none of the outgoing conditions holds ${when}, so the run would get stuck.`);
        reportedChecks.add(21);
      }
      if (node.concept === "OR-Split" && holding.length === 0 && !reportedChecks.has(22)) {
        report(22, node.id, `At OR-Split "${node.label}", none of the outgoing conditions holds ${when}.`);
        reportedChecks.add(22);
      }
    }
  }
}

// ---------------------------------------------------------------------------------
// Beyond spec 10 (checks 23 and 24, added in Phase 6)
// ---------------------------------------------------------------------------------

/**
 * Check 23: no variable is drawn in two branches that can run at the same time.
 *
 * Why: the values are kept once per run (Phase 6). If two parallel branches both draw
 * "lager", the value that remains is the one drawn last, and which branch the user advances
 * last is up to them. Spec 7 says that this order must not change the result.
 *
 * How, step by step:
 * 1. Make a table "which variables are drawn at which node" (drawsAt), e.g.
 *    Check stock -> [lager].
 * 2. Look at every node after which several branches can run at the same time: an AND-Split
 *    and a ForkActivity always put a token on every outgoing flow, an OR-Split may put tokens
 *    on several. A Decision is not looked at: only one of its branches ever runs.
 * 3. For every outgoing flow of such a node, collect the variables drawn in that branch
 *    (drawnInBranch, below, explains how a branch is delimited).
 * 4. Count in how many branches each variable is drawn. More than one: report it.
 *
 * Example:
 *              ┌─▶ Check stock (draws lager) ─┐
 *    AND-Split ┤                               ├─▶ AND-Join
 *              └─▶ Recheck (draws lager) ──────┘
 *    branch 1 draws {lager}, branch 2 draws {lager}: lager counted twice, so check 23 fails.
 *
 * The same problem inside one node: two random generators at the same node that both draw
 * "lager". Both draws happen in one step, and the value written second overwrites the first.
 * Which one is second follows the order of the generators in the graph, which comes from the
 * mapping and means nothing. So a variable may be drawn by at most one generator per node.
 */
function checkParallelDraws({ graph, nodes, generators, report }: Context) {
  const drawsAt = new Map<string, string[]>(); // node uuid -> names of the variables drawn there
  for (const generator of generators) {
    const name = generator.variable ? graph.variables[generator.variable]?.name : null; // the variable written to
    if (generator.node && name) drawsAt.set(generator.node, [...(drawsAt.get(generator.node) ?? []), name]);
  }

  // At one node: a variable drawn by two generators there.
  for (const [nodeId, names] of drawsAt) {
    for (const name of new Set(names)) { // each variable once, even if three generators draw it
      const count = names.filter((candidate) => candidate === name).length; // how many generators at this node draw it
      const at = graph.nodes[nodeId]; // the node, for the message
      if (count > 1) report(23, nodeId, `${at.concept} "${at.label}" draws the variable "${name}" with ${count} random generators. Only one value can be kept, and which one would depend on the order of the generators. Keep one generator.`);
    }
  }

  // The branches of an AND-Split or ForkActivity always run in parallel, those of an OR-Split may.
  for (const split of nodes.filter((node) => node.concept === "AND-Split" || node.concept === "ForkActivity" || node.concept === "OR-Split")) {
    const counts = new Map<string, number>(); // variable name -> in how many branches it is drawn
    for (const branch of split.outgoing) {
      for (const name of drawnInBranch(graph, branch, drawsAt)) counts.set(name, (counts.get(name) ?? 0) + 1); // once per branch
    }
    for (const [name, count] of counts) {
      if (count > 1) report(23, split.id, `At ${split.concept} "${split.label}", the variable "${name}" is drawn in more than one parallel branch, so its value would depend on the order of the steps.`);
    }
  }
}

/**
 * The variables drawn in one branch: in every node from the branch's first node up to the
 * point where the parallel branches meet again.
 *
 * Where does a branch end? Parallel branches meet again at a node that WAITS for all of them:
 * an AND-Join, OR-Join or SynchronizedActivity (spec 5.3). After that node only one token goes
 * on, so nothing behind it is parallel any more. So the search walks forward from the first
 * node of the branch, along every outgoing flow of every node it meets, and stops at that
 * waiting node. It also stops at an End, where the run is over.
 *
 * Nesting: a branch may contain its own inner split and inner join. The inner join is NOT
 * where our branch ends, so it must be walked through. The walk therefore counts: passing a
 * splitting node (AND-Split, ForkActivity, OR-Split) adds 1, meaning "an inner split has
 * opened"; reaching a waiting node with a count above 0 subtracts 1, meaning "it has closed
 * again", and the walk goes on behind it. Only a waiting node reached with count 0 closes OUR
 * branches, and the walk stops there.
 *
 * Example:
 *              ┌─▶ X ─▶ inner AND-Split ─▶ p ─┐                         ┐
 *              │                 └──────▶ q ─┴▶ inner AND-Join ─▶ Y ─┐  │ branch 1:
 *    AND-Split ┤                                                     ├─▶ AND-Join
 *              └─▶ Z ────────────────────────────────────────────────┘    branch 2: Z
 *    Walking branch 1: X (count 0) → inner AND-Split (count becomes 1) → p, q → inner AND-Join
 *    (reached with count 1, so it becomes 0 and the walk goes on) → Y → AND-Join (reached with
 *    count 0: stop). Branch 1 is X, inner AND-Split, p, q, inner AND-Join, Y.
 *
 * A Decision inside a branch is walked through on all of its sides: whichever side a run
 * takes, it still belongs to this branch. Loops end because every node is visited only once
 * per count, and a count larger than the number of nodes is not followed.
 *
 * How the code works:
 * The search keeps a to-do list (`queue`) of the nodes still to look at, each together with the
 * count it is reached with. It starts with the branch's first node and count 0. Then, again and
 * again, it takes the node at the FRONT of the list (`shift`), decides what to do with it (steps
 * 1 to 6 in the code), and puts the nodes behind it at the BACK of the list (`push`). It is done
 * when the list is empty. A node already handled with the same count is skipped (`seen`), which
 * is what makes loops end and what keeps a node reached on two ways from being handled twice.
 *
 * Step by step for branch 1 of the example above, supposing that Y draws "lager":
 *
 *   to-do list before          taken out          what happens                                   put at the back
 *   [X,0]                      X, 0               belongs to the branch                          [inner split,0]
 *   [inner split,0]            inner split, 0     belongs to the branch; a split: count 0 → 1     [p,1] [q,1]
 *   [p,1] [q,1]                p, 1               belongs to the branch                          [inner join,1]
 *   [q,1] [inner join,1]       q, 1               belongs to the branch                          [inner join,1]
 *   [inner join,1] [i. join,1] inner join, 1      a join reached with count 1: an INNER join,    [Y,0]
 *                                                 count 1 → 0, it belongs to the branch
 *   [inner join,1] [Y,0]       inner join, 1      already handled with count 1: skipped          –
 *   [Y,0]                      Y, 0               belongs to the branch; draws lager             [AND-Join,0]
 *                                                 → names = {lager}
 *   [AND-Join,0]               AND-Join, 0        a join reached with count 0: OUR branches      –
 *                                                 meet here; the branch ends before it
 *   []                         –                  the list is empty: done, the result is {lager}
 */
function drawnInBranch(graph: SimulationGraph, branch: string, drawsAt: Map<string, string[]>): Set<string> {
  const names = new Set<string>(); // the result: every variable drawn somewhere in this branch
  const seen = new Set<string>(); // "node|count" pairs already handled, so a loop is not walked forever
  const limit = Object.keys(graph.nodes).length; // more inner splits open at once than there are nodes is only possible in a loop

  // The to-do list: nodes still to look at, each with the count it is reached with. It starts
  // with the branch's first node (where the branch's first flow leads to) and count 0.
  const queue: [string | null | undefined, number][] = [[graph.flows[branch]?.target, 0]];

  while (queue.length > 0) {
    // Step 1: take the next node from the front of the to-do list.
    const [id, count] = queue.shift()!; // safe: the loop only runs while the list is not empty
    const node = graph.nodes[id ?? ""]; // the node itself; undefined when the flow leads to no node

    // Step 2: skip what needs no walking.
    if (!node) continue; // the flow led to no node (check 1 reports that)
    if (node.concept === "End") continue; // the run ends here, nothing behind it (check 24 reports a branch that does this)
    if (count > limit) continue; // running away in a loop of splits
    const key = `${node.id}|${count}`; // the same node may be met again with another count
    if (seen.has(key)) continue; // already handled: this is what ends loops
    seen.add(key); // remember it for next time

    // Step 3: a waiting node is either the end of OUR branch or an inner join to walk through.
    let inner = count; // the count for the nodes behind this one
    if (WAITING_CONCEPTS.some((concept) => concept === node.concept)) {
      if (count === 0) continue; // our parallel branches meet here: the branch ends BEFORE this node, so it is not collected
      inner = count - 1; // an inner join: the inner split has closed again, walk on behind it
    }

    // Step 4: the node belongs to the branch: collect the variables drawn at it.
    for (const name of drawsAt.get(node.id) ?? []) names.add(name);

    // Step 5: an inner split opens: the next join reached belongs to it, not to our branches.
    if (node.concept === "AND-Split" || node.concept === "ForkActivity" || node.concept === "OR-Split") inner += 1;

    // Step 6: put every node behind this one at the back of the to-do list, with the new count.
    for (const next of node.outgoing) queue.push([graph.flows[next]?.target, inner]);
  }
  return names; // the to-do list is empty: every node of the branch has been looked at
}

/**
 * Check 24: splits and joins form matching pairs. There are two kinds of pairs:
 * - OR pairs: an OR-Split and the OR-Join that collects its branches;
 * - parallel pairs: an AND-Split or ForkActivity and the AND-Join or SynchronizedActivity that
 *   collects its branches.
 * (Thanks to check 9, part 2, no other node can split into parallel branches.)
 *
 * Why the check is needed: a join waits for a token on EVERY incoming flow (spec 5.3). The run
 * only works if every join receives exactly one token per incoming flow, and every path
 * carries exactly one token:
 * - For OR pairs, a branch that is not taken sends a "skip token" to the flow where it enters
 *   the OR-Join (spec 5.2, firing.ts, pairs.ts). That flow must be known and unique.
 * - For parallel pairs, all branches run, and each must arrive at the join on its own input.
 *   Otherwise a node where parallel branches meet without waiting would run once per branch,
 *   or a branch ending at its own End would end the run while the others still run.
 *
 * How the check works, step by step (done once for each kind of pair):
 * 1. branchEnds (pairs.ts) gives a lookup table "first flow of a branch -> what the walk along
 *    that branch found". It walks along EVERY path of every branch, through nodes of every
 *    type (both sides of a Decision, all sides of an inner split), until it reaches the
 *    branch's own join; its comment explains how it handles nested pairs. For each branch it
 *    tells: the flow where the branch enters its join (`end`), on how many different flows the
 *    walk arrived at the join (`entryFlows`), and whether some path reached an End before the join
 *    (`reachesEnd`).
 * 2. For every split of this kind, collect the ends of its branches and check:
 *    a) every branch has exactly one end, reached on every path. There are three ways to fail,
 *       each with its own message:
 *       - the branch "jumps out" of the pair (`reachesEnd`): some path of it reaches an End
 *         before the join. It does not matter how: one side of a Decision inside the branch
 *         leading to an End, the whole branch running into an End of its own (parallel
 *         branches with separate Ends), or a flow that bypasses the join and runs to an End
 *         behind it. The run is over as soon as a token reaches an End (spec 8), so whether
 *         the elements of the other branches have run by then would depend on the order in
 *         which the user advanced them, which spec 7 rules out. The fix is to decide before the
 *         split or after the join. ADONIS and Bee-Up have the same rule ("each opened
 *         parallelism must be closed by its own merge");
 *       - the branch enters the join on several flows (more than one `entryFlows`), e.g. a Decision inside
 *         the branch whose two sides go into the join separately. Then only one of those inputs
 *         ever gets a token, and the join waits forever;
 *       - the branch never reaches a join of this kind (no `entryFlows`);
 *    b) all its branches end at the SAME join. That is what "pair" means;
 *    c) no two of its branches end on the same flow. Each branch must fill its own input;
 *       otherwise one input would get two tokens and another none.
 * 3. Gather the ends of all splits of this kind in one set (allEnds), remembering for each end
 *    which split it belongs to (splitOf). Then check for every join of this kind:
 *    d) every incoming flow of every join of this kind is in that set. An input that no branch
 *       ends at is fed by nothing the join can rely on, so the join may wait for it forever.
 *       This catches, for example, an AND-Join or OR-Join used to merge the branches of a
 *       Decision: only one of those branches is ever taken.
 *       An input on which a branch arrives that step 2 has already reported is left out here.
 *       It is the same mistake seen from the join's side, and one mistake gets one message
 *       (see the bypass example below).
 *    f) the inputs of the join are the ends of ONE split. Rules a) to d) look at a split and at
 *       a join separately, so two splits can share one join without breaking any of them (see
 *       the shared-join example below). A pair is one split and one join, in both directions.
 *       A join with an input that step 2 already reported is left out, as in d).
 * 4. For every split that passed step 2: collect the nodes on its branches, i.e. every node
 *    between the split and its join. Then check:
 *    e) every incoming flow of those nodes comes from the split or from another node on the
 *       branches. A flow from outside the pair brings a token that has not come through the
 *       split, so the join waits forever for its other inputs (see the loop example below).
 *       A correct loop goes back to a point before the split, so all branches run again.
 *
 * Example of a clean pair:
 *               ┌─ b1 ─▶ A1 ── d1 ─┐
 *    OR-Split ──┤                   ├─▶ OR-Join
 *               └─ b2 ─▶ A2 ── d2 ─┘
 *    Step 1: b1 -> d1, b2 -> d2. Step 2: (a) both ends found; (b) d1 and d2 lead into the same
 *    OR-Join; (c) d1 and d2 differ. Step 3: allEnds = {d1, d2}; (d) the OR-Join's inputs d1
 *    and d2 are both in it. The pair passes. A parallel pair is checked the same way.
 *
 * Example of a model that fails: an AND-Split whose two branches both run into one Activity X
 * (which does not wait) and from there to the End. Every path of both branches reaches the
 * End before any AND-Join, so step 1 finds `reachesEnd` for both branches, and (a) reports
 * that each of them jumps out of the pair.
 *
 * Example of one mistake that must not be reported twice: in the upper branch, a Decision sends
 * "nein" past the AND-Join straight to the element C behind it.
 *
 *                ┌─ fa ─▶ A ─▶ Decision ─┬─ ja ───────▶ AND-Join ─▶ C ─▶ End
 *    AND-Split ──┤                        └─ nein ────────────────────▶ C       (bypasses the join)
 *                └─ fb ─▶ B ─── fb2 ─────────────▶ AND-Join
 *
 *    Step 1: the walk along fa arrives at the join on "ja" (entryFlows = [ja]), but on the
 *            "nein" path it passes C and reaches the End (reachesEnd), so this branch has no
 *            end. The walk along fb ends at fb2.
 *    Step 2: (a) reports that the branch along fa jumps out of the pair. Its input "ja" is
 *            remembered as already reported.
 *    Step 3: allEnds = {fb2}. The input "ja" is not in it, which (d) would report as "not the
 *            end of a branch" — but "ja" was remembered in step 2, so it is left out. The user
 *            gets one message, the one that says what to do.
 *
 * Example of a loop that leads into a branch (step 4): behind the AND-Join, the Decision D
 * sends the token back to A through the flow "back".
 *
 *                ┌─ b1 ─▶ A ── d1 ─┐
 *    AND-Split ──┤        ▲         ├─▶ AND-Join ─▶ D ─▶ End
 *                └─ b2 ─▶ B ── d2 ─┘                │
 *                         └────────── back ─────────┘
 *
 *    Steps 1 to 3 find nothing: the walks only look forward from the split to the join, and
 *    "back" starts behind the join. In a run, A and B both run, the AND-Join runs, D sends the
 *    token back to A, and A puts it on d1. Now the AND-Join waits for d2, but B never runs
 *    again: the token did not go back through the AND-Split. The run is stuck.
 *    Step 4: the nodes on the branches are A and B. A has the incoming flow "back", whose
 *    source D is neither the AND-Split nor A or B, so (e) reports "back".
 *
 * Example of two splits that share one join (step 3, f):
 *
 *                ┌ ja   ─▶ AND-Split P1 ─┬─▶ A ── a2 ─┐
 *    Decision ───┤                       └─▶ B ── b2 ─┤
 *                │                                     ├─▶ AND-Join J ─▶ End
 *                └ nein ─▶ AND-Split P2 ─┬─▶ C ── c2 ─┤
 *                                        └─▶ E ── e2 ─┘
 *
 *    Step 2: P1 ends at J on a2 and b2, P2 at J on c2 and e2: both pass. Step 3: every input of
 *    J is the end of a branch, so (d) passes. But (f) finds the ends of two splits, P1 and P2.
 *    In a run the Decision lets only one of them run, so J gets two of its four tokens and
 *    waits forever.
 */
function checkPairs({ graph, nodes, report, describeFlow }: Context) {
  const enteredFromOutside = new Set<string>(); // step 4: flows already reported, so a flow into a nested pair gets one message, not one per pair
  for (const kind of [OR_PAIR, PARALLEL_PAIR]) {
    const splitNames = kind.splits.join(" or "); // e.g. "AND-Split or ForkActivity", for the messages
    const joinNames = kind.joins.join(" or "); // e.g. "AND-Join or SynchronizedActivity"
    const ends = branchEnds(graph, kind); // step 1: first flow of a branch -> flow where it enters its join (the same function the firing rule uses)
    const allEnds = new Set<string>(); // step 3: collects every branch end of every split of this kind
    const splitOf = new Map<string, GraphNode>(); // step 3 (f): branch end -> the split whose branch ends there
    const alreadyReported = new Set<string>(); // join inputs reached by a branch that step 2 reported: step 3 leaves them out
    const wellFormed = new Map<GraphNode, string>(); // step 4: the splits that passed step 2 -> the uuid of their join

    // Step 2: every split of this kind, checked on its own.
    for (const split of nodes.filter((node) => kind.splits.some((concept) => concept === node.concept))) {
      const found: string[] = []; // the ends of this split's branches
      for (const branch of split.outgoing) {
        const result = ends.get(branch); // what the walk along this branch found (always present: every outgoing flow of a split is walked)
        const which = `The branch of ${split.concept} "${split.label}" that starts with the ${describeFlow(graph.flows[branch])}`; // names the branch in every message
        if (result?.end) {
          found.push(result.end); // a clean branch: remember where it ends
          continue; // nothing to report
        }
        for (const input of result?.entryFlows ?? []) alreadyReported.add(input); // the inputs this broken branch reaches: the same mistake, seen from the join
        if (result?.reachesEnd) {
          // (a) jumps out of the pair
          report(24, split.id, `${which} jumps out of the pair: one of its paths reaches an End element before the ${joinNames}. The run would be over while the other branches are still under way. Decide before the split or after the join.`);
        } else if (result && result.entryFlows.length > 1) {
          // (a) several inputs
          report(24, split.id, `${which} enters the ${joinNames} on ${result.entryFlows.length} different flows; it must arrive on exactly one, otherwise the join never gets a token on all its inputs.`);
        } else {
          // (a) no join at all
          report(24, split.id, `${which} does not lead to an ${joinNames}.`);
        }
      }
      if (new Set(found.map((end) => graph.flows[end].target)).size > 1) report(24, split.id, `The branches of ${split.concept} "${split.label}" end at different joins.`); // (b): a pair has one join; a Set keeps each join once
      if (new Set(found).size < found.length) report(24, split.id, `Two branches of ${split.concept} "${split.label}" end on the same flow into the join.`); // (c): a Set smaller than the list means a repeated end
      for (const end of found) {
        allEnds.add(end); // remembered for step 3
        splitOf.set(end, split); // and to which split it belongs, for (f)
      }
      const passed = found.length === split.outgoing.length && new Set(found).size === found.length && new Set(found.map((end) => graph.flows[end].target)).size === 1; // every branch has an end (a), all at one join (b), each on its own flow (c)
      if (passed) wellFormed.set(split, graph.flows[found[0]].target!); // the join is the target of any branch end; `!` because a branch end always leads into its join
    }

    // Step 3: every input of every join of this kind must be the end of a branch (d), and all
    // of them of the same split (f).
    for (const join of nodes.filter((node) => kind.joins.some((concept) => concept === node.concept))) {
      for (const input of join.incoming) {
        if (!allEnds.has(input) && !alreadyReported.has(input)) {
          report(24, join.id, `The ${describeFlow(graph.flows[input])} into ${join.concept} "${join.label}" is not the end of a branch of an ${splitNames}, so the ${join.concept} could wait for it forever.`); // (d)
        }
      }
      if (join.incoming.some((input) => alreadyReported.has(input))) continue; // a mistake at this join is reported already (step 2)
      const splits = [...new Set(join.incoming.map((input) => splitOf.get(input)).filter((split) => split !== undefined))]; // the splits whose branches end here; a Set keeps each once
      if (splits.length > 1) {
        const names = splits.map((split) => `${split.concept} "${split.label}"`).join(" and "); // e.g. AND-Split "P1" and AND-Split "P2"
        report(24, join.id, `${join.concept} "${join.label}" closes the branches of ${splits.length} splits, ${names}. A join closes exactly one split; if not all of them run, it waits forever for the branches of the others. Give each split its own join.`); // (f)
      }
    }

    // Step 4: no flow leads into a branch from outside the pair. Only splits that passed step 2
    // are looked at: for the others a message exists already, and where their branches end is
    // not clear.
    for (const [split, joinId] of wellFormed) {
      const join = graph.nodes[joinId]; // named in the message
      const next = (node: GraphNode) => (node.id === joinId ? [] : node.outgoing.map((id) => graph.flows[id].target).filter((id): id is string => id !== null && !!graph.nodes[id])); // forward along the flows, but not past the join
      const inside = search(graph, next(split), next); // the nodes on the branches, plus the join itself (the same breadth-first search as checks 7 and 8)
      inside.delete(joinId); // the join's inputs were checked in step 3
      for (const id of inside) {
        for (const flowId of graph.nodes[id].incoming) {
          const source = graph.flows[flowId].source; // where a token on this flow comes from
          if (source === null || source === split.id || inside.has(source)) continue; // from the split or from the branches themselves: fine (a flow without source is check 1's)
          if (enteredFromOutside.has(flowId)) continue; // already reported for an enclosing or enclosed pair
          enteredFromOutside.add(flowId); // one message per flow
          report(24, flowId, `The ${describeFlow(graph.flows[flowId])} leads into a branch of ${split.concept} "${split.label}" from outside the pair. A token on it has not come through the split, so ${join.concept} "${join.label}" could wait forever for its other inputs. Lead the flow to a point before the split instead.`); // (e)
        }
      }
    }
  }
}

/**
 * Check 26: every loop can be left. Inside every loop, at least one variable that the loop's
 * own conditions read is drawn again.
 *
 * Why: a variable keeps its value until it is drawn again (spec 6.2). If the conditions in a
 * loop only read variables that are not drawn inside it, the token takes the same way in every
 * round. With the values that send it round once, it goes round forever, and the run never
 * ends.
 *
 * Example:
 *   Check stock (draws lager) ─▶ In stock? ─ lager == ja   ─▶ End
 *                                  ▲        └ lager == nein ─▶ Order goods ─┐
 *                                  └────────────────────────────────────────┘
 *   The loop is In stock? → Order goods → In stock?. Its condition reads lager, but lager is
 *   drawn at Check stock, outside the loop. With lager = nein the token goes round forever.
 *   Leading Order goods back to Check stock puts the draw inside the loop: the check passes.
 *
 * Every loop is checked on its own, also a small loop inside a bigger one: the bigger loop
 * drawing again does not help a small loop that goes round without passing that draw.
 *
 *   Check stock (draws lager) ─▶ In stock? ─ lager == ja ─▶ End
 *        ▲                          └ lager == nein ─▶ Wait ─▶ Still missing? ─ lager == nein ─▶ Wait
 *        └─────────────────────────────────────────────────────────────────── lager == ja ───┘
 *   The big loop Check stock → In stock? → Wait → Still missing? → Check stock draws lager: fine.
 *   The small loop Wait → Still missing? → Wait does not: with lager = nein it never ends.
 *
 * Parallel branches: when a loop passes an AND-Join or SynchronizedActivity, all branches of
 * that pair have run in this round, not only the one the loop goes through. So the draws on
 * every branch of the pair count for the loop.
 *
 * How, step by step:
 * 1. Find every loop: start at each node and follow the flows in every possible way; each time
 *    the walk comes back to its start, the path it took is one loop. Every loop is found once.
 * 2. For each loop, collect the variables read by the conditions of its Decisions and
 *    OR-Splits, and the variables drawn at its nodes (plus, for an AND-Join or
 *    SynchronizedActivity on it, on all branches of its pair).
 * 3. If none of the read variables is drawn, report the loop, on its first Decision or
 *    OR-Split that reads one. A Decision is named in one message at most, even when several
 *    loops pass it.
 * Variables that are drawn nowhere are left out: checks 15 and 16 report them already.
 *
 * Limit: like checks 20 to 22, the check does not know which values can reach the loop. A
 * loop whose conditions contradict each other (one sends the token round only with lager = ja,
 * the next one only with lager = nein) is reported although it never goes round.
 */
function checkLoops({ graph, nodes, generators, report }: Context, reachable: Set<string>) {
  const next = (node: GraphNode) => node.outgoing.map((id) => graph.flows[id].target).filter((id): id is string => id !== null && reachable.has(id)); // forward along the flows, only where a run can go
  const ahead = new Map([...reachable].map((id) => [id, search(graph, next(graph.nodes[id]), next)])); // node -> the nodes it can reach in one step or more

  const drawnAt = new Map<string, string[]>(); // node uuid -> names of the variables drawn there
  for (const generator of generators) {
    const name = generator.variable ? graph.variables[generator.variable]?.name : null; // the variable written to
    if (generator.node && name) drawnAt.set(generator.node, [...(drawnAt.get(generator.node) ?? []), name]); // where it is drawn
  }
  const drawnSomewhere = new Set([...drawnAt.values()].flat()); // variables with at least one generator in the model
  const readAt = (node: GraphNode) => (DECIDING.includes(node.concept) ? node.outgoing.flatMap((flowId) => (graph.flows[flowId].condition ?? []).map((row) => row.variableName)).filter((name) => drawnSomewhere.has(name)) : []); // what its conditions read, e.g. [lager]

  // For every parallel join: the variables drawn on any branch of its pair, since all of them
  // have run when the join runs. Pairs that check 24 refused have no join here.
  const pairDraws = new Map<string, string[]>(); // join uuid -> names drawn on its branches
  const ends = branchEnds(graph, PARALLEL_PAIR); // where each branch of each AND-Split or ForkActivity enters its join
  for (const split of nodes.filter((node) => PARALLEL_PAIR.splits.some((concept) => concept === node.concept) && reachable.has(node.id))) {
    const joinId = graph.flows[ends.get(split.outgoing[0])?.end ?? ""]?.target; // the join of this pair, if its first branch has a clean end
    if (!joinId) continue; // a broken pair: check 24 reports it
    const inside = search(graph, next(split), (node) => (node.id === joinId ? [] : next(node))); // the nodes on its branches, and the join
    pairDraws.set(joinId, [...inside].flatMap((id) => drawnAt.get(id) ?? [])); // the join itself draws nothing extra here: it is on the loop and counted there
  }

  const reported = new Set<string>(); // Decisions and OR-Splits already named in a message
  const checkLoop = (loop: string[]) => {
    const deciders = loop.map((id) => graph.nodes[id]).filter((node) => readAt(node).length > 0); // the nodes on the loop whose conditions read a value
    const read = new Set(deciders.flatMap(readAt)); // e.g. {lager}
    const drawn = new Set(loop.flatMap((id) => [...(drawnAt.get(id) ?? []), ...(pairDraws.get(id) ?? [])])); // drawn in one round of this loop
    if (read.size === 0 || [...read].some((name) => drawn.has(name))) return; // no value decides here, or one is drawn again: the loop can be left
    if (reported.has(deciders[0].id)) return; // this Decision is already named in a message about another loop
    reported.add(deciders[0].id); // one message per Decision

    const where = loop.map((id) => `${graph.nodes[id].concept} "${graph.nodes[id].label}"`).join(" → "); // e.g. Activity "Wait" → Decision "Still missing?"
    const names = [...read].map((name) => `"${name}"`).join(", "); // e.g. "lager"
    report(26, deciders[0].id, `The loop ${where} may never be left: its conditions only read ${names}, which ${read.size === 1 ? "is" : "are"} not drawn again inside the loop, so the token takes the same way in every round. Draw ${read.size === 1 ? "it" : "one of them"} again inside the loop, for example by leading the loop back to the element that draws ${read.size === 1 ? "it" : "them"}.`);
  };

  // Step 1: every loop, found from its first node in this fixed order, so it is found only once.
  const order = [...reachable]; // any fixed order of the nodes
  const position = new Map(order.map((id, index) => [id, index])); // node uuid -> its place in the order
  for (const [index, start] of order.entries()) {
    const path = [start]; // the way walked so far from the start
    const walk = (id: string) => {
      for (const target of next(graph.nodes[id])) {
        if (position.get(target)! < index) continue; // a loop through an earlier node was found from that node already
        if (target === start) checkLoop([...path]); // back at the start: the path is one loop (steps 2 and 3)
        else if (!path.includes(target) && ahead.get(target)!.has(start)) { // a new node on this path, from which the start can still be reached
          path.push(target); // walk on through it
          walk(target);
          path.pop(); // and try the next way
        }
      }
    };
    walk(start);
  }
}

/**
 * For every node reachable from the Start: the names of the variables that are surely drawn
 * once the node has run, on every path that leads to it (for check 16).
 *
 * A node passes on what is surely drawn before it, plus what it draws itself. What is surely
 * drawn before it depends on how its incoming paths come together:
 * - Usually only one of them was taken: after the two sides of a Decision meet, only one side
 *   has run, and at an OR-Join a branch may have been skipped. So only what is drawn on ALL
 *   incoming paths counts (the intersection).
 * - An AND-Join or SynchronizedActivity only runs after ALL its incoming branches have run,
 *   and the values are kept once per run (Phase 6). So what is drawn on ANY of them counts
 *   (the union).
 * Example: an AND-Split with the branches "Check stock" (draws lager) and "Write invoice",
 * then an AND-Join. After the AND-Join: {lager} ∪ {} = {lager}. Were the two branches the
 * sides of a Decision instead, it would be {lager} ∩ {} = {}: lager may not have been drawn.
 *
 * Loops make the answer depend on itself, so it is computed by starting with "everything is
 * drawn" everywhere except at the Start and shrinking the sets until nothing changes any more.
 */
function drawnOnEveryPath(
  graph: SimulationGraph, // for following the flows
  generators: GraphGenerator[], // where values are drawn
  reachable: Set<string>, // the nodes a run can reach
  nameOf: (variableId: string | null) => string | null, // variable uuid -> its name
): Map<string, Set<string>> {
  const drawsAt = new Map<string, string[]>(); // node uuid -> names drawn when it runs
  for (const generator of generators) {
    const name = nameOf(generator.variable); // what is drawn
    if (generator.node && name) drawsAt.set(generator.node, [...(drawsAt.get(generator.node) ?? []), name]); // where
  }
  const everything = new Set([...drawsAt.values()].flat()); // the starting assumption for every node but the Start

  const drawn = new Map<string, Set<string>>(); // the answer, shrinking towards the truth
  for (const id of reachable) {
    drawn.set(id, graph.nodes[id].concept === "Start" ? new Set(drawsAt.get(id) ?? []) : new Set(everything)); // the Start begins with nothing drawn (spec 8)
  }

  let changed = true; // repeat until a whole round changes nothing
  while (changed) {
    changed = false;
    for (const id of reachable) {
      const node = graph.nodes[id]; // the node to update
      if (node.concept === "Start") continue; // nothing leads into it (check 5)
      const sources = node.incoming.map((flowId) => graph.flows[flowId].source).filter((source): source is string => !!source && reachable.has(source)); // where tokens come from
      const inputs = sources.map((source) => drawn.get(source)!); // what is surely drawn after each node that leads here
      const allInputsRan = node.concept === "AND-Join" || node.concept === "SynchronizedActivity"; // it runs only after every incoming branch has run
      const before = inputs.length === 0
        ? new Set<string>() // nothing leads here from the Start
        : allInputsRan
          ? new Set(inputs.flatMap((set) => [...set])) // the union: drawn on ANY incoming branch
          : inputs.reduce((a, b) => new Set([...a].filter((name) => b.has(name)))); // the intersection: drawn on EVERY incoming path
      const after = new Set([...before, ...(drawsAt.get(id) ?? [])]); // plus what this node draws
      if (after.size !== drawn.get(id)!.size) {
        drawn.set(id, after); // the sets only ever shrink, so a different size means a change
        changed = true;
      }
    }
  }
  return drawn;
}

/** Every combination of values for `names`, e.g. lager ∈ {ja, nein} × kunde ∈ {premium} → 2 combinations. */
function combinations(names: string[], domains: Map<string, Set<string>>): VariableValues[] {
  return names.reduce<VariableValues[]>(
    (partial, name) => partial.flatMap((values) => [...(domains.get(name) ?? [])].map((value) => ({ ...values, [name]: value }))), // extend every partial combination by every value of the next variable
    [{}], // start: one combination that assigns nothing
  );
}
