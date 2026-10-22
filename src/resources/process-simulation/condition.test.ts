/**
 * Tests for condition.ts: one test per rule of the header comment there.
 */
import { describe, expect, it } from "vitest";
import { evaluateCondition } from "./condition";
import type { ConditionRow } from "./graph";

/** A condition row; `link` is the logical operator to the previous row (null in the first row). */
const row = (variableName: string, operator: string, value: string, link: string | null = null): ConditionRow => ({
  variableName, // the variable's name
  operator, // the comparison
  value, // what it is compared with
  logicalOperator: link, // AND / OR to the previous row
});

describe("evaluateCondition", () => {
  it("holds for a flow without condition rows, like a transition without a guard", () => {
    expect(evaluateCondition([], {})).toBe(true); // a condition table with no filled row
    expect(evaluateCondition(null, {})).toBe(true); // no condition attribute mapped
  });

  it("compares == and != as text", () => {
    const values = { lager: "ja" }; // lager was drawn as "ja"
    expect(evaluateCondition([row("lager", "==", "ja")], values)).toBe(true); // equal
    expect(evaluateCondition([row("lager", "==", "nein")], values)).toBe(false); // different
    expect(evaluateCondition([row("lager", "!=", "nein")], values)).toBe(true); // different, so != holds
  });

  it("is false for a variable that has not been drawn yet, whatever the operator (spec 6.1)", () => {
    expect(evaluateCondition([row("lager", "==", "ja")], {})).toBe(false); // nothing drawn
    expect(evaluateCondition([row("lager", "!=", "ja")], {})).toBe(false); // != too: a condition never triggers a draw
  });

  it("compares <, <=, > and >= as numbers, with a comma or a dot", () => {
    const values = { menge: "0,5" }; // drawn with a decimal comma
    expect(evaluateCondition([row("menge", "<", "1")], values)).toBe(true); // 0.5 < 1
    expect(evaluateCondition([row("menge", ">=", "0.5")], values)).toBe(true); // 0.5 >= 0.5, the condition written with a dot
    expect(evaluateCondition([row("menge", ">", "0,5")], values)).toBe(false); // 0.5 > 0.5 does not hold
    expect(evaluateCondition([row("menge", "<", "viel")], values)).toBe(false); // not a number: false
  });

  it("evaluates AND before OR: A, B (AND), C (OR), D (AND) means (A and B) or (C and D)", () => {
    const rows = [row("a", "==", "1"), row("b", "==", "1", "AND"), row("c", "==", "1", "OR"), row("d", "==", "1", "AND")]; // the example of plan 6
    const holds = (a: string, b: string, c: string, d: string) => evaluateCondition(rows, { a, b, c, d }); // evaluate one combination
    expect(holds("1", "1", "0", "0")).toBe(true); // A and B hold. Left to right, ((A and B) or C) and D, would give false here, since D is false: this is the case that tells the two readings apart
    expect(holds("0", "0", "1", "1")).toBe(true); // C and D hold
    expect(holds("1", "0", "1", "0")).toBe(false); // neither group holds completely
    expect(holds("1", "0", "1", "1")).toBe(true); // C and D hold, although B does not
  });
});
