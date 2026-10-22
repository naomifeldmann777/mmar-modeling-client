/**
 * Evaluating a transition condition: does it hold for the values the token carries?
 *
 * Used by: the validator, which evaluates the conditions at every Decision and OR-Split for
 * all values that can be drawn (spec 10, checks 20 to 22), and later the firing rule, which
 * evaluates them during a run (spec 7). Both use this one file, so the rules below exist only
 * once.
 *
 * Deliberately NOT here: no checking. This file assumes a well-formed condition (known
 * operators, AND / OR between rows); the validator guarantees that before a run starts
 * (spec 10, check 17). It also never draws a value: a condition only reads (spec 6.1).
 *
 * The rules (spec 6.1, plan 6):
 * - A condition on a variable that has not been drawn yet is false.
 * - The rows are combined with AND before OR, not from left to right: the rows
 *   A, B (AND), C (OR), D (AND) mean (A and B) or (C and D).
 * - A flow without condition rows is always taken, like a transition without a guard.
 * - == and != compare the values as text; <, <=, > and >= compare them as numbers, written
 *   with a comma or a dot (plan 4). A value that is not a number makes such a row false.
 */
import type { ConditionRow } from "./graph"; // the rows as the transformer reads them
import { parseDecimal } from "./transformer"; // the one reader for numbers with a comma or a dot

/** The comparison operators a condition row may use (spec 10, checks 17 and 19). */
export const COMPARISON_OPERATORS = ["==", "!=", "<", "<=", ">", ">="] as const; // the validator checks rows against this list

/** The logical operators that link a row to the previous one. */
export const LOGICAL_OPERATORS = ["AND", "OR"] as const; // the validator checks rows after the first against this list

/** The values a token carries: variable name -> drawn value. A variable that is missing has not been drawn yet. */
export type VariableValues = Readonly<Record<string, string>>; // keyed by name, because conditions refer to variables by name

/**
 * Whether the condition holds for `values`.
 *
 * Example: the rows `lager == ja`, `kunde == premium (AND)`, `lager == nein (OR)` mean
 * (lager is ja and kunde is premium) or (lager is nein).
 */
export function evaluateCondition(rows: ConditionRow[] | null, values: VariableValues): boolean {
  if (!rows || rows.length === 0) return true; // no condition: the flow is always taken, like a transition without a guard

  // AND before OR: cut the rows into groups at every OR. Inside a group every row must hold
  // (AND); the condition holds as soon as one whole group holds (OR).
  const groups: ConditionRow[][] = []; // e.g. [[A, B], [C, D]] for A, B (AND), C (OR), D (AND)
  for (const row of rows) {
    if (groups.length === 0 || row.logicalOperator === "OR") groups.push([row]); // the first row, and every OR, starts a new group
    else groups[groups.length - 1].push(row); // AND joins the current group
  }
  return groups.some((group) => group.every((row) => evaluateRow(row, values))); // (A and B) or (C and D)
}

/** Whether one row "variable operator value" holds for `values`. */
function evaluateRow(row: ConditionRow, values: VariableValues): boolean {
  if (!Object.hasOwn(values, row.variableName)) return false; // not drawn yet: false, whatever the operator (spec 6.1)
  const actual = values[row.variableName]; // the value the token carries for this variable
  if (row.operator === "==") return actual === row.value; // compared as text
  if (row.operator === "!=") return actual !== row.value; // compared as text

  const left = parseDecimal(actual); // the drawn value as a number
  const right = parseDecimal(row.value); // the value in the condition as a number
  if (left === null || right === null) return false; // < and > only make sense between numbers (spec 10, check 19)
  if (row.operator === "<") return left < right; // the four numeric comparisons
  if (row.operator === "<=") return left <= right;
  if (row.operator === ">") return left > right;
  if (row.operator === ">=") return left >= right;
  return false; // an unknown operator: cannot happen after the validator (spec 10, check 17)
}
