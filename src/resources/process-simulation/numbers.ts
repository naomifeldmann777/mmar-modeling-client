/**
 * Numbers and text: the one place where the simulation turns a text such as "0,8" into a
 * number, and a number back into a text.
 *
 * Used by: the transformer (probabilities of a distribution), condition.ts (comparing values
 * with <, <=, > and >=), the validator (checks 12 and 19, and the test values of checks 20 to
 * 22), distributions.ts (a drawn number becomes the variable's value), the stepper (a value
 * the user types in) and the stepper panel and highlighting (showing a value). Keeping the
 * rules in one place makes all of them read and write numbers the same way.
 *
 * Part of the library: no MMAR, no model, no language. It used to sit in transformer.ts, but
 * the transformer is the MMAR adapter and does not move into the library, so the files that do
 * would have depended on it.
 *
 * Deliberately NOT here: no rounding of a value that is kept. `displayValue` rounds only what
 * is shown; the run keeps every digit, so a condition compares the value that was drawn.
 */

/**
 * A number written with a comma or a dot as decimal separator: "0,8"
 * and "0.8" both read as 0.8. null when the text is not such a number.
 */
export function parseDecimal(text: string): number | null {
  const normalized = text.trim().replace(",", "."); // one decimal comma becomes a dot
  return /^[+-]?(\d+(\.\d*)?|\.\d+)$/.test(normalized) ? Number(normalized) : null; // plain decimals only; Number alone would also accept "1e3" or "0x10"
}

/**
 * A number as a text that parseDecimal reads back: never in exponent notation, which String()
 * uses for very small and very large numbers. Examples:
 *   87.31243   -> "87.31243"
 *   0.0000001  -> "0.0000001"     (String() gives "1e-7", which parseDecimal refuses)
 *   -0         -> "0"
 * Digits beyond the 20th decimal are dropped; a condition would have to compare with a number
 * that close for it to matter.
 */
export function writeDecimal(value: number): string {
  const text = value.toLocaleString("en-US", { useGrouping: false, maximumFractionDigits: 20 }); // en-US: a dot as decimal separator; no grouping: "1000", not "1,000"; the shortest digits that give the number back
  return text === "-0" ? "0" : text; // -0, or a negative number too small for 20 decimals, is 0 for the user
}

/**
 * A value as it is shown to the user: a number with more than two decimals is rounded to two,
 * any other value is shown as it is. Examples:
 *   "87.31243"  -> "87.31"
 *   "100"       -> "100"
 *   "0,8"       -> "0,8"       (two decimals or fewer: as written)
 *   "ja"        -> "ja"
 */
export function displayValue(value: string): string {
  const number = parseDecimal(value); // only numbers are rounded
  if (number === null || !/[.,]\d{3,}/.test(value)) return value; // not a number, or at most two decimals: shown as written
  return writeDecimal(Math.round(number * 100) / 100); // two decimals, as agreed for continuous values
}
