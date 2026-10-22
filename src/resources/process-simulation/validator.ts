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
 * - Check 16 counts a variable as drawn before a join only if it is drawn on every incoming
 *   path. This holds whichever values the token keeps at an AND-Join (open question 6).
 * - Checks 20 to 22 evaluate the conditions for every combination of the values the variables
 *   can be drawn with. This may report a combination that never occurs in a real run, but it
 *   never misses one that does.
 * - A check that depends on another is skipped for an element on which that other check
 *   already failed, so one mistake gives one message, not three.
 *
 * Source: spec 10 (the checks), spec 8 (a failed check stops the run), spec 6.1 (a
 * condition on a variable that has not been drawn is false).
 */
import { COMPARISON_OPERATORS, evaluateCondition, LOGICAL_OPERATORS, type VariableValues } from "./condition";
import type { GraphFlow, GraphGenerator, GraphNode, GraphVariable, SimulationGraph } from "./graph";
import { parseDecimal } from "./transformer";
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
  checkConditions(context, reachable); // checks 15 to 22

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

  // Check 9: joins have at least two incoming flows, splits at least two outgoing flows.
  // Zero flows were already reported by check 6, so only a single flow is reported here.
  for (const node of nodes) {
    if (WAITING_CONCEPTS.some((concept) => concept === node.concept) && node.incoming.length === 1) {
      report(9, node.id, `${node.concept} "${node.label}" has only one incoming flow; it needs at least two.`);
    }
    if (SPLITTING.includes(node.concept) && node.outgoing.length === 1) {
      report(9, node.id, `${node.concept} "${node.label}" has only one outgoing flow; it needs at least two.`);
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

  for (const flow of flows) {
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
    if (!flow.condition || !flow.source || !reachable.has(flow.source) || broken.has(flow.id)) continue; // unreachable or already reported
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

/**
 * For every node reachable from the Start: the names of the variables that are surely drawn
 * once the node has run, on every path that leads to it (for check 16).
 *
 * A node passes on what is drawn on ALL its incoming paths (the intersection), plus what it
 * draws itself. Loops make the answer depend on itself, so it is computed by starting with
 * "everything is drawn" everywhere except at the Start and shrinking the sets until nothing
 * changes any more.
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
      const before = sources.length === 0 ? new Set<string>() : sources.map((source) => drawn.get(source)!).reduce((a, b) => new Set([...a].filter((name) => b.has(name)))); // drawn on every incoming path
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
