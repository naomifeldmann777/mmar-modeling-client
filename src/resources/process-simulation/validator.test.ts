/**
 * Tests for validator.ts.
 *
 * First the test models of the OCPN Build Guide as simulation graphs: the correct ones must
 * pass without a problem, and model I ("no condition holds") must be stopped. Then one test
 * per check of spec 10, each building the smallest graph that breaks it. Graphs are built
 * directly (no model, no transformer), with ids invented for the test.
 */
import { describe, expect, it } from "vitest";
import type { ConditionRow, GraphFlow, GraphGenerator, GraphNode, GraphVariable, SimulationGraph } from "./graph";
import { validateGraph, type ValidationProblem } from "./validator";
import type { NodeConcept } from "./vocabulary";

// ---------------------------------------------------------------------------------
// Builders
// ---------------------------------------------------------------------------------

const node = (id: string, concept: NodeConcept): GraphNode => ({ id, label: id, concept, incoming: [], outgoing: [] }); // flows are wired by graph()
const row = (variableName: string, operator: string, value: string, link: string | null = null): ConditionRow => ({ variableName, operator, value, logicalOperator: link }); // one condition row
const flow = (id: string, source: string | null, target: string | null, ...rows: ConditionRow[]): GraphFlow => ({ id, label: id, source, target, condition: rows }); // [] when no rows: no condition
const draw = (id: string, at: string, variable: string, entries: [string, number | null][] | null): GraphGenerator => ({
  id, // the generator
  label: id, // its name
  node: at, // where it draws
  variable, // into which variable
  distribution: entries && entries.map(([value, probability]) => ({ value, probability })), // value / probability pairs
});
const variable = (id: string, name: string | null = id): GraphVariable => ({ id, label: id, name }); // name defaults to the id

/** A graph from its parts; incoming and outgoing are wired from the flows, as the transformer does. */
function graph(parts: { nodes: GraphNode[]; flows?: GraphFlow[]; generators?: GraphGenerator[]; variables?: GraphVariable[]; issues?: SimulationGraph["issues"] }): SimulationGraph {
  const result: SimulationGraph = {
    nodes: Object.fromEntries(parts.nodes.map((n) => [n.id, n])), // keyed by id
    flows: Object.fromEntries((parts.flows ?? []).map((f) => [f.id, f])),
    generators: Object.fromEntries((parts.generators ?? []).map((g) => [g.id, g])),
    variables: Object.fromEntries((parts.variables ?? []).map((v) => [v.id, v])),
    issues: parts.issues ?? [],
  };
  for (const f of parts.flows ?? []) {
    if (f.source && result.nodes[f.source]) result.nodes[f.source].outgoing.push(f.id); // as in transformer pass 2
    if (f.target && result.nodes[f.target]) result.nodes[f.target].incoming.push(f.id);
  }
  return result;
}

const checks = (problems: ValidationProblem[]) => problems.map((problem) => problem.check); // the numbers of the failed checks
const LAGER: [string, number][] = [["ja", 0.8], ["nein", 0.2]]; // the distribution used throughout the Build Guide

/** Start → check (draws lager) → dec → endja | endnein: test model A, with the conditions given. */
function modelA(yes: ConditionRow[] = [row("lager", "==", "ja")], no: ConditionRow[] = [row("lager", "==", "nein")]) {
  return graph({
    nodes: [node("start", "Start"), node("check", "Activity"), node("dec", "Decision"), node("endja", "End"), node("endnein", "End")],
    flows: [flow("f1", "start", "check"), flow("f2", "check", "dec"), flow("f3", "dec", "endja", ...yes), flow("f4", "dec", "endnein", ...no)],
    generators: [draw("g", "check", "lager", LAGER)],
    variables: [variable("lager")],
  });
}

// ---------------------------------------------------------------------------------
// The test models of the OCPN Build Guide
// ---------------------------------------------------------------------------------

describe("validateGraph: test models of the OCPN Build Guide", () => {
  it("A, draw and decision: passes", () => {
    expect(validateGraph(modelA())).toEqual([]);
  });

  it("B, two decisions on the same variable: passes", () => {
    const g = graph({
      nodes: [node("start", "Start"), node("check", "Activity"), node("d1", "Decision"), node("ship", "Activity"), node("reorder", "Activity"), node("d2", "Decision"), node("e1", "End"), node("e2", "End")],
      flows: [
        flow("f1", "start", "check"), flow("f2", "check", "d1"),
        flow("f3", "d1", "ship", row("lager", "==", "ja")), flow("f4", "d1", "reorder", row("lager", "==", "nein")),
        flow("f5", "ship", "d2"), flow("f6", "reorder", "d2"), // d2 has two incoming flows but does not wait (spec 5.3)
        flow("f7", "d2", "e1", row("lager", "==", "ja")), flow("f8", "d2", "e2", row("lager", "==", "nein")),
      ],
      generators: [draw("g", "check", "lager", LAGER)],
      variables: [variable("lager")],
    });
    expect(validateGraph(g)).toEqual([]);
  });

  it("C, draw at the gateway itself: passes, the gateway's own draw counts as drawn before its conditions", () => {
    const g = graph({
      nodes: [node("start", "Start"), node("gw", "Decision"), node("endja", "End"), node("endnein", "End")],
      flows: [flow("f1", "start", "gw"), flow("f2", "gw", "endja", row("lager", "==", "ja")), flow("f3", "gw", "endnein", row("lager", "==", "nein"))],
      generators: [draw("g", "gw", "lager", LAGER)],
      variables: [variable("lager")],
    });
    expect(validateGraph(g)).toEqual([]);
  });

  it("D, parallel branches with a draw in one of them: passes", () => {
    const g = graph({
      nodes: [node("start", "Start"), node("split", "AND-Split"), node("check", "Activity"), node("prepare", "Activity"), node("join", "AND-Join"), node("end", "End")],
      flows: [flow("f1", "start", "split"), flow("fa", "split", "check"), flow("fb", "split", "prepare"), flow("fa2", "check", "join"), flow("fb2", "prepare", "join"), flow("f2", "join", "end")],
      generators: [draw("g", "check", "lager", LAGER)],
      variables: [variable("lager")],
    });
    expect(validateGraph(g)).toEqual([]);
  });

  it("F, loop with two distributions: passes, the value is drawn before the decision on every pass", () => {
    const g = graph({
      nodes: [node("start", "Start"), node("check", "Activity"), node("dec", "Decision"), node("again", "Activity"), node("end", "End")],
      flows: [
        flow("f1", "start", "check"), flow("f2", "check", "dec"),
        flow("fja", "dec", "end", row("lager", "==", "ja")), flow("fnein", "dec", "again", row("lager", "==", "nein")),
        flow("back", "again", "check"), // the loop back into Check stock
      ],
      generators: [draw("g1", "check", "lager", LAGER), draw("g2", "again", "lager", [["ja", 0.4], ["nein", 0.6]])],
      variables: [variable("lager")],
    });
    expect(validateGraph(g)).toEqual([]);
  });

  it("G, Petri net style with a SynchronizedActivity: passes", () => {
    const g = graph({
      nodes: [node("start", "Start"), node("split", "AND-Split"), node("inspect", "SynchronizedActivity"), node("end", "End")],
      flows: [flow("f1", "start", "split"), flow("pa", "split", "inspect"), flow("pb", "split", "inspect"), flow("f2", "inspect", "end")],
    });
    expect(validateGraph(g)).toEqual([]);
  });

  it("H, condition on two variables: passes, the two conditions exclude each other and cover every case", () => {
    const g = graph({
      nodes: [node("start", "Start"), node("customer", "Activity"), node("check", "Activity"), node("dec", "Decision"), node("e1", "End"), node("e2", "End")],
      flows: [
        flow("f1", "start", "customer"), flow("f2", "customer", "check"), flow("f3", "check", "dec"),
        flow("t1", "dec", "e1", row("lager", "==", "ja"), row("kunde", "==", "premium", "AND")),
        flow("t2", "dec", "e2", row("lager", "!=", "ja"), row("kunde", "!=", "premium", "OR")),
      ],
      generators: [draw("gk", "customer", "kunde", [["premium", 0.3], ["standard", 0.7]]), draw("gl", "check", "lager", LAGER)],
      variables: [variable("lager"), variable("kunde")],
    });
    expect(validateGraph(g)).toEqual([]);
  });

  it("I, no condition holds: stopped by checks 18 and 21", () => {
    const problems = validateGraph(modelA([row("lager", "==", "ja")], [row("lager", "==", "vielleicht")])); // T2 [l = vielleicht]
    expect(checks(problems)).toEqual([18, 21]); // "vielleicht" cannot be drawn, and with "nein" the run would get stuck
    expect(problems[1].message).toContain("when lager = nein"); // the message names the combination
    expect(problems[1].elementId).toBe("dec"); // shown on the decision
  });
});

// ---------------------------------------------------------------------------------
// One test per check of spec 10
// ---------------------------------------------------------------------------------

describe("validateGraph: mapping (checks 1 to 3)", () => {
  it("1: a sequence flow must connect two elements mapped to a node concept", () => {
    const g = graph({ nodes: [node("start", "Start"), node("end", "End")], flows: [flow("f1", "start", "end"), flow("f2", "end", "note")] }); // "note" is unmapped
    const problems = validateGraph(g);
    expect(problems.filter((p) => p.check === 1).map((p) => p.elementId)).toEqual(["f2"]);
  });

  it("2: what the transformer could not translate is reported", () => {
    const g = graph({ nodes: [node("start", "Start"), node("end", "End")], flows: [flow("f", "start", "end")], issues: [{ elementId: "x", message: "\"x\" is a line, so it cannot be executed as Activity." }] });
    expect(validateGraph(g)).toEqual([{ severity: "error", check: 2, message: "\"x\" is a line, so it cannot be executed as Activity.", elementId: "x" }]);
  });

  it("3: Distribution, VariableName and the conditions after a Decision must be assigned", () => {
    const g = modelA();
    g.flows.f3.condition = null; // no TransitionCondition mapped on a flow leaving the decision
    g.generators.g.distribution = null; // no Distribution mapped
    g.variables.lager.name = null; // no VariableName mapped
    expect(validateGraph(g).filter((p) => p.check === 3).map((p) => p.elementId)).toEqual(["g", "lager", "f3"]);
  });
});

describe("validateGraph: structure (checks 4 to 9)", () => {
  it("4: no Start and no End are reported on the model as a whole", () => {
    const problems = validateGraph(graph({ nodes: [node("a", "Activity")] }));
    expect(problems.filter((p) => p.check === 4)).toEqual([
      { severity: "error", check: 4, message: "The model has no element mapped to Start.", elementId: null },
      { severity: "error", check: 4, message: "The model has no element mapped to End.", elementId: null },
    ]);
  });

  it("4: more than one Start is reported on each of them", () => {
    const g = graph({ nodes: [node("s1", "Start"), node("s2", "Start"), node("end", "End")], flows: [flow("f1", "s1", "end"), flow("f2", "s2", "end")] });
    expect(validateGraph(g).filter((p) => p.check === 4).map((p) => p.elementId)).toEqual(["s1", "s2"]);
  });

  it("5: the Start has no incoming and an End no outgoing flow", () => {
    const g = graph({ nodes: [node("start", "Start"), node("end", "End")], flows: [flow("f1", "start", "end"), flow("f2", "end", "start")] }); // a loop through both
    expect(checks(validateGraph(g))).toEqual([5, 5]);
  });

  it("6: every other node has an incoming and an outgoing flow", () => {
    const g = graph({ nodes: [node("start", "Start"), node("a", "Activity"), node("end", "End")], flows: [flow("f1", "start", "a")] }); // a leads nowhere
    expect(validateGraph(g).filter((p) => p.check === 6)).toEqual([{ severity: "error", check: 6, message: 'Activity "a" has no outgoing flow.', elementId: "a" }]);
  });

  it("7 and 8: every node is reachable from the Start, and an End is reachable from every node", () => {
    const g = graph({
      nodes: [node("start", "Start"), node("a", "Activity"), node("b", "Activity"), node("end", "End"), node("lost", "Activity")],
      flows: [flow("f1", "start", "a"), flow("f2", "a", "b"), flow("f3", "b", "a"), flow("f4", "lost", "end"), flow("f5", "end", "lost")], // a and b loop forever; lost is cut off
    });
    const problems = validateGraph(g);
    expect(problems.filter((p) => p.check === 7).map((p) => p.elementId)).toEqual(["end", "lost"]); // not reachable from the Start
    expect(problems.filter((p) => p.check === 8).map((p) => p.elementId)).toEqual(["start", "a", "b"]); // no End reachable from them
  });

  it("9: a join needs two incoming flows and a split two outgoing flows", () => {
    const g = graph({
      nodes: [node("start", "Start"), node("split", "AND-Split"), node("join", "AND-Join"), node("end", "End")],
      flows: [flow("f1", "start", "split"), flow("f2", "split", "join"), flow("f3", "join", "end")], // one flow each
    });
    expect(validateGraph(g).filter((p) => p.check === 9).map((p) => p.elementId)).toEqual(["split", "join"]);
  });
});

describe("validateGraph: variables and random generators (checks 10 to 13)", () => {
  it("10: a variable needs a non-empty name that no other variable has", () => {
    const g = modelA();
    g.variables.empty = variable("empty", ""); // an empty name
    g.variables.twin = variable("twin", "lager"); // the same name as lager
    expect(validateGraph(g).filter((p) => p.check === 10).map((p) => p.elementId)).toEqual(["empty", "lager", "twin"]);
  });

  it("11: a random generator lists at least one value", () => {
    const g = modelA();
    g.generators.g.distribution = []; // a table without a filled row
    expect(checks(validateGraph(g))).toContain(11);
  });

  it("12: probabilities are numbers, not negative, and add up to one", () => {
    const g = modelA();
    g.generators.g.distribution = [{ value: "ja", probability: 0.7 }, { value: "nein", probability: 0.2 }]; // 0.9 in total
    expect(validateGraph(g).find((p) => p.check === 12)?.message).toContain("add up to 0.9, not 1");
    g.generators.g.distribution = [{ value: "ja", probability: 1.2 }, { value: "nein", probability: -0.2 }]; // 1 in total, but negative
    expect(validateGraph(g).find((p) => p.check === 12)?.message).toContain('"nein" is negative');
    g.generators.g.distribution = [{ value: "ja", probability: null }, { value: "nein", probability: 0.2 }]; // "abc" in the table
    expect(validateGraph(g).find((p) => p.check === 12)?.message).toContain('"ja" is not a number');
  });

  it("12: a small rounding error is tolerated", () => {
    const g = modelA();
    g.generators.g.distribution = [{ value: "ja", probability: 0.1 }, { value: "nein", probability: 0.2 }, { value: "x", probability: 0.7 }]; // 0.1 + 0.2 + 0.7 is not exactly 1 in a computer
    expect(checks(validateGraph(g))).not.toContain(12);
  });

  it("13: no value appears twice in one distribution", () => {
    const g = modelA();
    g.generators.g.distribution = [{ value: "ja", probability: 0.5 }, { value: "ja", probability: 0.3 }, { value: "nein", probability: 0.2 }];
    expect(validateGraph(g).filter((p) => p.check === 13)).toHaveLength(1);
  });
});

describe("validateGraph: conditions (checks 15 to 22)", () => {
  it("15: a condition's variable exists, and a value is drawn for it somewhere", () => {
    const unknown = validateGraph(modelA([row("lagr", "==", "ja")])); // a typo
    expect(unknown.find((p) => p.check === 15)?.message).toContain('"lagr", which does not exist');
    const g = modelA([row("kunde", "==", "premium")]);
    g.variables.kunde = variable("kunde"); // exists, but nothing draws it (test model E's kunde)
    expect(validateGraph(g).find((p) => p.check === 15)?.message).toContain("no value is drawn for it anywhere");
  });

  it("16: on every path to a condition its variable has been drawn before", () => {
    // Parallel branches; lager is drawn only in one of them, and a decision after the join reads it.
    const g = graph({
      nodes: [node("start", "Start"), node("split", "AND-Split"), node("check", "Activity"), node("prepare", "Activity"), node("join", "OR-Join"), node("dec", "Decision"), node("e1", "End"), node("e2", "End")],
      flows: [
        flow("f1", "start", "split"), flow("fa", "split", "check"), flow("fb", "split", "prepare"), flow("fa2", "check", "join"), flow("fb2", "prepare", "join"), flow("f2", "join", "dec"),
        flow("y", "dec", "e1", row("lager", "==", "ja")), flow("n", "dec", "e2", row("lager", "==", "nein")),
      ],
      generators: [draw("g", "check", "lager", LAGER)],
      variables: [variable("lager")],
    });
    expect(validateGraph(g).filter((p) => p.check === 16).map((p) => p.elementId)).toEqual(["y", "n"]); // drawn on one incoming path of the join only
  });

  it("17: every row names a variable, a known operator and a value, and is linked to the previous row", () => {
    const problems = validateGraph(modelA([row("lager", "=>", "ja"), row("lager", "==", "ja", "-")], [row("lager", "==", "")])); // your metamodel's "=>", a missing link, a missing value
    expect(checks(problems)).toEqual([17, 17, 17]); // and nothing else: an incomplete condition is not checked further
  });

  it("18: a value compared with == or != must be one of the variable's values", () => {
    expect(checks(validateGraph(modelA([row("lager", "==", "ja")], [row("lager", "!=", "Ja")])))).toContain(18); // "Ja" with a capital J is a different value
  });

  it("19: <, <=, > and >= only on variables whose values are all numbers", () => {
    expect(checks(validateGraph(modelA([row("lager", "<", "1")], [row("lager", ">=", "1")])))).toContain(19); // lager is ja / nein
    const g = modelA([row("menge", "<", "2")], [row("menge", ">=", "2")]); // numbers, one with a decimal comma
    g.generators.g = draw("g", "check", "menge", [["1,5", 0.5], ["3", 0.5]]);
    g.variables = { menge: variable("menge") };
    expect(validateGraph(g)).toEqual([]); // fine: 1,5 < 2 and 3 >= 2
  });

  it("20: at a Decision no two conditions hold at the same time", () => {
    const problems = validateGraph(modelA([row("lager", "==", "ja"), row("lager", "==", "nein", "OR")], [row("lager", "==", "nein")])); // "ja or nein" against "nein": both hold for nein
    expect(problems).toEqual([{ severity: "error", check: 20, elementId: "dec", message: 'At Decision "dec", the conditions of the flows to "endja" and "endnein" hold at the same time when lager = nein.' }]);
  });

  it("20: two flows without any condition always hold at the same time", () => {
    expect(checks(validateGraph(modelA([], [])))).toEqual([20]); // the case of a Petri net place with two outgoing arcs
  });

  it("22: at an OR-Split at least one condition holds", () => {
    const g = graph({
      nodes: [node("start", "Start"), node("check", "Activity"), node("or", "OR-Split"), node("a", "Activity"), node("b", "Activity"), node("join", "OR-Join"), node("end", "End")],
      flows: [
        flow("f1", "start", "check"), flow("f2", "check", "or"),
        flow("fa", "or", "a", row("lager", "==", "ja")), flow("fb", "or", "b", row("lager", "==", "ja")), // nothing for nein
        flow("fa2", "a", "join"), flow("fb2", "b", "join"), flow("f3", "join", "end"),
      ],
      generators: [draw("g", "check", "lager", LAGER)],
      variables: [variable("lager")],
    });
    expect(validateGraph(g).map((p) => [p.check, p.elementId])).toEqual([[22, "or"]]); // two branches may both be taken at an OR-Split, so no check 20
  });
});

describe("validateGraph: beyond spec 10 (checks 23 and 24, added in Phase 6)", () => {
  it("23: a variable is not drawn in two parallel branches", () => {
    const g = graph({
      nodes: [node("start", "Start"), node("split", "AND-Split"), node("a", "Activity"), node("b", "Activity"), node("join", "AND-Join"), node("end", "End")],
      flows: [flow("f1", "start", "split"), flow("fa", "split", "a"), flow("fb", "split", "b"), flow("fa2", "a", "join"), flow("fb2", "b", "join"), flow("f2", "join", "end")],
      generators: [draw("ga", "a", "lager", LAGER), draw("gb", "b", "lager", LAGER)], // lager drawn in both branches
      variables: [variable("lager")],
    });
    expect(validateGraph(g).map((p) => [p.check, p.elementId])).toEqual([[23, "split"]]); // its value would depend on the order of the steps
  });

  it("24: an OR-Join used as a merge after a Decision has no OR-Split to send it skip tokens", () => {
    const g = graph({
      nodes: [node("start", "Start"), node("check", "Activity"), node("dec", "Decision"), node("x", "Activity"), node("y", "Activity"), node("join", "OR-Join"), node("end", "End")],
      flows: [
        flow("f1", "start", "check"), flow("f2", "check", "dec"),
        flow("fx", "dec", "x", row("lager", "==", "ja")), flow("fy", "dec", "y", row("lager", "==", "nein")),
        flow("x2", "x", "join"), flow("y2", "y", "join"), flow("f3", "join", "end"), // only one token ever arrives: the join would wait forever
      ],
      generators: [draw("g", "check", "lager", LAGER)],
      variables: [variable("lager")],
    });
    expect(validateGraph(g).map((p) => [p.check, p.elementId])).toEqual([[24, "join"], [24, "join"]]); // both inputs are reported
  });
});

describe("validateGraph: check 23 with nested parallel branches", () => {
  it("finds a draw behind an inner AND-Split / AND-Join pair inside a branch", () => {
    const g = graph({
      nodes: [
        node("start", "Start"), node("split", "AND-Split"), node("x", "Activity"), node("inner", "AND-Split"), node("p", "Activity"), node("q", "Activity"),
        node("innerJoin", "AND-Join"), node("y", "Activity"), node("z", "Activity"), node("join", "AND-Join"), node("end", "End"),
      ],
      flows: [
        flow("f1", "start", "split"), flow("b1", "split", "x"), flow("f2", "x", "inner"), flow("fp", "inner", "p"), flow("fq", "inner", "q"),
        flow("fp2", "p", "innerJoin"), flow("fq2", "q", "innerJoin"), flow("f3", "innerJoin", "y"), flow("f4", "y", "join"), // branch 1, with an inner pair, then y
        flow("b2", "split", "z"), flow("f5", "z", "join"), flow("f6", "join", "end"), // branch 2
      ],
      generators: [draw("gy", "y", "lager", LAGER), draw("gz", "z", "lager", LAGER)], // y (behind the inner join) and z both draw lager
      variables: [variable("lager")],
    });
    expect(validateGraph(g).map((p) => [p.check, p.elementId])).toEqual([[23, "split"]]); // the walk passes the inner join and still sees y
  });
});

describe("validateGraph: check 24 with a nested OR pair", () => {
  it("accepts an OR-Split / OR-Join pair nested inside a branch of another one", () => {
    //                ┌─ b1 [ja] ─▶ inner OR-Split ─┬─▶ x ─ x2 ─┐
    //                │                              └─▶ y ─ y2 ─┴▶ inner OR-Join ─ e1 ─┐
    //   outer OR-Split ┤                                                               ├─▶ outer OR-Join ─▶ end
    //                └─ b2 [nein] ─▶ z ───────────────────────────────────── e2 ───────┘
    const g = graph({
      nodes: [
        node("start", "Start"), node("check", "Activity"), node("outer", "OR-Split"), node("inner", "OR-Split"), node("x", "Activity"), node("y", "Activity"),
        node("innerJoin", "OR-Join"), node("z", "Activity"), node("outerJoin", "OR-Join"), node("end", "End"),
      ],
      flows: [
        flow("f1", "start", "check"), flow("f2", "check", "outer"),
        flow("b1", "outer", "inner", row("lager", "==", "ja")), flow("b2", "outer", "z", row("lager", "==", "nein")), // the outer branches
        flow("i1", "inner", "x"), flow("i2", "inner", "y"), // the inner branches, without conditions: both are always entered
        flow("x2", "x", "innerJoin"), flow("y2", "y", "innerJoin"), flow("e1", "innerJoin", "outerJoin"), // the inner pair closes, then branch 1 ends at e1
        flow("e2", "z", "outerJoin"), flow("f3", "outerJoin", "end"), // branch 2 ends at e2
      ],
      generators: [draw("g", "check", "lager", LAGER)],
      variables: [variable("lager")],
    });
    expect(validateGraph(g)).toEqual([]); // both pairs are clean: inner ends x2 and y2, outer ends e1 and e2
  });
});

describe("validateGraph: check 9, part 2 (exactly one outgoing flow)", () => {
  it("refuses an Activity with two outgoing flows: splitting needs a split concept", () => {
    const g = graph({ nodes: [node("start", "Start"), node("a", "Activity"), node("e1", "End"), node("e2", "End")], flows: [flow("f1", "start", "a"), flow("f2", "a", "e1"), flow("f3", "a", "e2")] });
    const problems = validateGraph(g);
    expect(problems.map((p) => [p.check, p.elementId])).toEqual([[9, "a"]]);
    expect(problems[0].message).toContain("it may have only one");
  });
});

describe("validateGraph: check 24 for parallel pairs", () => {
  it("refuses parallel branches that meet at a node that does not wait (multi-merge)", () => {
    const g = graph({
      nodes: [node("start", "Start"), node("split", "AND-Split"), node("a", "Activity"), node("b", "Activity"), node("x", "Activity"), node("end", "End")],
      flows: [flow("f1", "start", "split"), flow("fa", "split", "a"), flow("fb", "split", "b"), flow("fa2", "a", "x"), flow("fb2", "b", "x"), flow("f2", "x", "end")], // x would run twice
    });
    expect(validateGraph(g).map((p) => [p.check, p.elementId])).toEqual([[24, "split"], [24, "split"]]); // both branches reach the End without an AND-Join
  });

  it("refuses parallel branches that end at separate End elements", () => {
    const g = graph({
      nodes: [node("start", "Start"), node("split", "AND-Split"), node("a", "Activity"), node("b", "Activity"), node("e1", "End"), node("e2", "End")],
      flows: [flow("f1", "start", "split"), flow("fa", "split", "a"), flow("fb", "split", "b"), flow("fa2", "a", "e1"), flow("fb2", "b", "e2")], // the run would end at the first End
    });
    expect(validateGraph(g).map((p) => [p.check, p.elementId])).toEqual([[24, "split"], [24, "split"]]);
  });

  it("refuses an AND-Join that merges the branches of a Decision", () => {
    const g = graph({
      nodes: [node("start", "Start"), node("check", "Activity"), node("dec", "Decision"), node("x", "Activity"), node("y", "Activity"), node("join", "AND-Join"), node("end", "End")],
      flows: [
        flow("f1", "start", "check"), flow("f2", "check", "dec"), flow("fx", "dec", "x", row("lager", "==", "ja")), flow("fy", "dec", "y", row("lager", "==", "nein")),
        flow("x2", "x", "join"), flow("y2", "y", "join"), flow("f3", "join", "end"), // only one branch is ever taken: the join would wait forever
      ],
      generators: [draw("g", "check", "lager", LAGER)],
      variables: [variable("lager")],
    });
    expect(validateGraph(g).map((p) => [p.check, p.elementId])).toEqual([[24, "join"], [24, "join"]]); // both inputs are reported
  });

  it("refuses a branch with a path that reaches an End before the join", () => {
    // AND-Split → A → Decision → [ja] B → AND-Join; [nein] → End; and C → AND-Join.
    const g = graph({
      nodes: [node("start", "Start"), node("check", "Activity"), node("split", "AND-Split"), node("dec", "Decision"), node("b", "Activity"), node("early", "End"), node("c", "Activity"), node("join", "AND-Join"), node("end", "End")],
      flows: [
        flow("f1", "start", "check"), flow("f2", "check", "split"), flow("fa", "split", "dec"), flow("fja", "dec", "b", row("lager", "==", "ja")), flow("fnein", "dec", "early", row("lager", "==", "nein")),
        flow("b2", "b", "join"), flow("fc", "split", "c"), flow("c2", "c", "join"), flow("f3", "join", "end"),
      ],
      generators: [draw("g", "check", "lager", LAGER)],
      variables: [variable("lager")],
    });
    const problems = validateGraph(g).map((p) => [p.check, p.elementId]);
    expect(problems).toContainEqual([24, "split"]); // with nein, the run would end while C is still under way
  });
});

describe("validateGraph: check 24 messages name the reason", () => {
  it("says that a branch jumps out of the pair, and how to fix it", () => {
    const g = graph({
      nodes: [node("start", "Start"), node("split", "AND-Split"), node("a", "Activity"), node("b", "Activity"), node("e1", "End"), node("e2", "End")],
      flows: [flow("f1", "start", "split"), flow("fa", "split", "a"), flow("fb", "split", "b"), flow("fa2", "a", "e1"), flow("fb2", "b", "e2")], // separate Ends
    });
    const message = validateGraph(g)[0].message;
    expect(message).toContain("jumps out of the pair: one of its paths reaches an End element before the AND-Join or SynchronizedActivity");
    expect(message).toContain("Decide before the split or after the join.");
  });

  it("says that a branch enters the join on several flows", () => {
    // Branch 1 contains a Decision whose two sides go into the OR-Join separately.
    const g = graph({
      nodes: [node("start", "Start"), node("check", "Activity"), node("or", "OR-Split"), node("dec", "Decision"), node("z", "Activity"), node("join", "OR-Join"), node("end", "End")],
      flows: [
        flow("f1", "start", "check"), flow("f2", "check", "or"),
        flow("b1", "or", "dec", row("lager", "==", "ja")), flow("p", "dec", "join", row("lager", "==", "ja")), flow("q", "dec", "join", row("lager", "==", "nein")),
        flow("b2", "or", "z", row("lager", "==", "nein")), flow("e2", "z", "join"), flow("f3", "join", "end"),
      ],
      generators: [draw("g", "check", "lager", LAGER)],
      variables: [variable("lager")],
    });
    expect(validateGraph(g).find((p) => p.check === 24 && p.elementId === "or")?.message).toContain("enters the OR-Join on 2 different flows");
  });
});

describe("validateGraph: check 25 (conditions only after a Decision or an OR-Split)", () => {
  it("reports a condition on a flow that leaves an Activity, and nothing else about it", () => {
    const g = modelA();
    g.flows.f2.condition = [row("lagr", "==", "ja")]; // a condition after Check stock, with a typo on top
    const problems = validateGraph(g);
    expect(problems.map((p) => [p.check, p.elementId])).toEqual([[25, "f2"]]); // the typo is not reported as well: one mistake, one message
    expect(problems[0].message).toContain('leaves Activity "check", where conditions are not evaluated');
  });

  it("does not report the empty default row of a new flow", () => {
    expect(validateGraph(modelA())).toEqual([]); // f1 and f2 carry [] (the default row, skipped by the transformer)
  });
});

describe("validateGraph: check 24 for an OR pair that is jumped out of", () => {
  it("says that a branch of an OR-Split jumps out of the pair", () => {
    // OR-Split → b1 → Decision → [ja] A → OR-Join; [nein] → End. And b2 → Z → OR-Join.
    const g = graph({
      nodes: [node("start", "Start"), node("check", "Activity"), node("or", "OR-Split"), node("dec", "Decision"), node("a", "Activity"), node("early", "End"), node("z", "Activity"), node("join", "OR-Join"), node("end", "End")],
      flows: [
        flow("f1", "start", "check"), flow("f2", "check", "or"),
        flow("b1", "or", "dec", row("lager", "==", "ja")), flow("fja", "dec", "a", row("lager", "==", "ja")), flow("fnein", "dec", "early", row("lager", "==", "nein")), flow("a2", "a", "join"),
        flow("b2", "or", "z", row("lager", "==", "nein")), flow("z2", "z", "join"), flow("f3", "join", "end"),
      ],
      generators: [draw("g", "check", "lager", LAGER)],
      variables: [variable("lager")],
    });
    const message = validateGraph(g).find((p) => p.check === 24 && p.elementId === "or")?.message;
    expect(message).toContain("jumps out of the pair: one of its paths reaches an End element before the OR-Join"); // the same rule as for parallel pairs
  });
});

describe("validateGraph: check 24 reports one mistake once", () => {
  //                ┌─ fa ─▶ A ─▶ Decision ─┬─ ja ───────▶ AND-Join ─▶ C ─▶ End
  //    AND-Split ──┤                        └─ nein ────────────────────▶ C       (bypasses the join)
  //                └─ fb ─▶ B ─── fb2 ─────────────▶ AND-Join
  const g = () =>
    graph({
      nodes: [node("start", "Start"), node("check", "Activity"), node("split", "AND-Split"), node("a", "Activity"), node("dec", "Decision"), node("b", "Activity"), node("join", "AND-Join"), node("c", "Activity"), node("end", "End")],
      flows: [
        flow("f1", "start", "check"), flow("f2", "check", "split"), flow("fa", "split", "a"), flow("fa2", "a", "dec"),
        flow("ja", "dec", "join", row("lager", "==", "ja")), flow("nein", "dec", "c", row("lager", "==", "nein")), // "nein" skips the join
        flow("fb", "split", "b"), flow("fb2", "b", "join"), flow("fj", "join", "c"), flow("fc", "c", "end"),
      ],
      generators: [draw("g", "check", "lager", LAGER)],
      variables: [variable("lager")],
    });

  it("reports a branch that bypasses the join once, on the split, and not again on the join's input", () => {
    const problems = validateGraph(g()).filter((p) => p.check === 24);
    expect(problems.map((p) => p.elementId)).toEqual(["split"]); // no second message for the input "ja"
    expect(problems[0].message).toContain("jumps out of the pair"); // the message that says what to do
  });

  it("leaves a clean model without any message (control)", () => {
    expect(validateGraph(modelA())).toEqual([]); // the skipping in step 3 hides nothing a clean model would need
  });
});

describe("validateGraph: check 24 messages use the right article", () => {
  it("writes 'an AND-Split or ForkActivity'", () => {
    const g = graph({
      nodes: [node("start", "Start"), node("check", "Activity"), node("dec", "Decision"), node("x", "Activity"), node("y", "Activity"), node("join", "AND-Join"), node("end", "End")],
      flows: [
        flow("f1", "start", "check"), flow("f2", "check", "dec"), flow("fx", "dec", "x", row("lager", "==", "ja")), flow("fy", "dec", "y", row("lager", "==", "nein")),
        flow("x2", "x", "join"), flow("y2", "y", "join"), flow("f3", "join", "end"),
      ],
      generators: [draw("g", "check", "lager", LAGER)],
      variables: [variable("lager")],
    });
    expect(validateGraph(g)[0].message).toContain("is not the end of a branch of an AND-Split or ForkActivity");
  });
});

describe("validateGraph: check 16 behind an AND-Join", () => {
  it("counts a value drawn in one parallel branch as drawn behind the AND-Join", () => {
    // start → split → check (draws lager) | invoice → join → dec → endja | endnein
    const g = graph({
      nodes: [node("start", "Start"), node("split", "AND-Split"), node("check", "Activity"), node("invoice", "Activity"), node("join", "AND-Join"), node("dec", "Decision"), node("endja", "End"), node("endnein", "End")],
      flows: [
        flow("f1", "start", "split"), flow("fa", "split", "check"), flow("fb", "split", "invoice"), flow("fa2", "check", "join"), flow("fb2", "invoice", "join"), flow("f2", "join", "dec"),
        flow("fja", "dec", "endja", row("lager", "==", "ja")), flow("fnein", "dec", "endnein", row("lager", "==", "nein")),
      ],
      generators: [draw("g", "check", "lager", LAGER)],
      variables: [variable("lager")],
    });
    expect(validateGraph(g)).toEqual([]); // the AND-Join runs only after both branches, so lager is surely drawn at dec
  });
});

describe("validateGraph: check 24, no flow leads into a branch from outside the pair", () => {
  /** start → pre → split → a (draws lager) | b → join → dec → end, and dec → back → `loopTarget` when lager is "nein". */
  function loopModel(loopTarget: string) {
    return graph({
      nodes: [node("start", "Start"), node("pre", "Activity"), node("split", "AND-Split"), node("a", "Activity"), node("b", "Activity"), node("join", "AND-Join"), node("dec", "Decision"), node("end", "End")],
      flows: [
        flow("f1", "start", "pre"), flow("f2", "pre", "split"), flow("fa", "split", "a"), flow("fb", "split", "b"), flow("fa2", "a", "join"), flow("fb2", "b", "join"), flow("f3", "join", "dec"),
        flow("fend", "dec", "end", row("lager", "==", "ja")), flow("back", "dec", loopTarget, row("lager", "==", "nein")),
      ],
      generators: [draw("g", "a", "lager", LAGER)],
      variables: [variable("lager")],
    });
  }

  it("refuses a loop from behind the AND-Join back into a branch: the join would wait for b forever", () => {
    const problems = validateGraph(loopModel("a"));
    expect(problems.map((p) => [p.check, p.elementId])).toEqual([[24, "back"]]); // reported once, on the flow that enters from outside
    expect(problems[0].message).toContain("leads into a branch of AND-Split \"split\" from outside the pair");
  });

  it("accepts a loop back to a point before the AND-Split (control)", () => {
    expect(validateGraph(loopModel("pre"))).toEqual([]); // both branches run again in every round
  });
});

describe("validateGraph: check 23 at one node", () => {
  it("refuses two random generators at the same node that draw the same variable", () => {
    const g = modelA(); // check draws lager once already
    g.generators.g2 = draw("g2", "check", "lager", LAGER); // a second generator at check, also drawing lager
    const problems = validateGraph(g);
    expect(problems.map((p) => [p.check, p.elementId])).toEqual([[23, "check"]]);
    expect(problems[0].message).toContain("draws the variable \"lager\" with 2 random generators");
  });

  it("accepts two generators at the same node that draw different variables (control)", () => {
    const g = modelA();
    g.generators.g2 = draw("g2", "check", "kunde", [["premium", 0.5], ["normal", 0.5]]); // a second variable, not used in any condition
    g.variables.kunde = variable("kunde");
    expect(validateGraph(g)).toEqual([]);
  });
});

describe("validateGraph: check 26 (every loop can be left)", () => {
  /** start → check (draws lager) → dec → endja when lager is "ja"; dec → order when "nein", and order → `loopTarget`. */
  function stockLoop(loopTarget: string) {
    return graph({
      nodes: [node("start", "Start"), node("check", "Activity"), node("dec", "Decision"), node("order", "Activity"), node("endja", "End")],
      flows: [
        flow("f1", "start", "check"), flow("f2", "check", "dec"),
        flow("fja", "dec", "endja", row("lager", "==", "ja")), flow("fnein", "dec", "order", row("lager", "==", "nein")),
        flow("back", "order", loopTarget),
      ],
      generators: [draw("g", "check", "lager", LAGER)],
      variables: [variable("lager")],
    });
  }

  it("refuses a loop whose condition reads a variable that is not drawn again inside it", () => {
    const problems = validateGraph(stockLoop("dec")); // order leads back to dec: lager stays "nein" forever
    expect(problems.map((p) => [p.check, p.elementId])).toEqual([[26, "dec"]]); // reported once, on the Decision
    expect(problems[0].message).toContain("its conditions only read \"lager\", which is not drawn again inside the loop");
  });

  it("accepts the loop when it leads back to the element that draws (control)", () => {
    expect(validateGraph(stockLoop("check"))).toEqual([]); // check is now inside the loop: lager is drawn again in every round
  });

  it("checks a small loop inside a bigger one on its own", () => {
    // start → check (draws lager) → dec → end | wait; wait → dec2; dec2 → wait (small loop) | check (big loop)
    const g = graph({
      nodes: [node("start", "Start"), node("check", "Activity"), node("dec", "Decision"), node("wait", "Activity"), node("dec2", "Decision"), node("end", "End")],
      flows: [
        flow("f1", "start", "check"), flow("f2", "check", "dec"),
        flow("fja", "dec", "end", row("lager", "==", "ja")), flow("fnein", "dec", "wait", row("lager", "==", "nein")),
        flow("f3", "wait", "dec2"),
        flow("again", "dec2", "wait", row("lager", "==", "nein")), flow("recheck", "dec2", "check", row("lager", "==", "ja")),
      ],
      generators: [draw("g", "check", "lager", LAGER)],
      variables: [variable("lager")],
    });
    const problems = validateGraph(g);
    expect(problems.map((p) => [p.check, p.elementId])).toEqual([[26, "dec2"]]); // only the small loop wait → dec2 → wait: the big one passes check, which draws lager
  });

  it("counts the draws of every branch when a loop passes a parallel pair (control)", () => {
    // start → pre → split → a (draws lager) | b → join → dec → end | pre: the loop through b passes the join, so a's draw counts too
    const g = graph({
      nodes: [node("start", "Start"), node("pre", "Activity"), node("split", "AND-Split"), node("a", "Activity"), node("b", "Activity"), node("join", "AND-Join"), node("dec", "Decision"), node("end", "End")],
      flows: [
        flow("f1", "start", "pre"), flow("f2", "pre", "split"), flow("fa", "split", "a"), flow("fb", "split", "b"), flow("fa2", "a", "join"), flow("fb2", "b", "join"), flow("f3", "join", "dec"),
        flow("fend", "dec", "end", row("lager", "==", "ja")), flow("back", "dec", "pre", row("lager", "==", "nein")),
      ],
      generators: [draw("g", "a", "lager", LAGER)],
      variables: [variable("lager")],
    });
    expect(validateGraph(g)).toEqual([]);
  });
});

describe("validateGraph: check 24, a join closes exactly one split", () => {
  it("refuses two AND-Splits on the two sides of a Decision that share one AND-Join", () => {
    const g = graph({
      nodes: [
        node("start", "Start"), node("check", "Activity"), node("dec", "Decision"), node("p1", "AND-Split"), node("p2", "AND-Split"),
        node("a", "Activity"), node("b", "Activity"), node("c", "Activity"), node("e", "Activity"), node("join", "AND-Join"), node("end", "End"),
      ],
      flows: [
        flow("f1", "start", "check"), flow("f2", "check", "dec"), flow("fja", "dec", "p1", row("lager", "==", "ja")), flow("fnein", "dec", "p2", row("lager", "==", "nein")),
        flow("a1", "p1", "a"), flow("b1", "p1", "b"), flow("c1", "p2", "c"), flow("e1", "p2", "e"),
        flow("a2", "a", "join"), flow("b2", "b", "join"), flow("c2", "c", "join"), flow("e2", "e", "join"), flow("f3", "join", "end"),
      ],
      generators: [draw("g", "check", "lager", LAGER)],
      variables: [variable("lager")],
    });
    const problems = validateGraph(g);
    expect(problems.map((p) => [p.check, p.elementId])).toEqual([[24, "join"]]); // one message, on the shared join
    expect(problems[0].message).toContain("closes the branches of 2 splits, AND-Split \"p1\" and AND-Split \"p2\"");
  });
});
