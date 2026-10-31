/**
 * Reading numbers from text: the one place where the simulation turns a text such as "0,8"
 * into a number.
 *
 * Used by: the transformer (probabilities of a distribution), condition.ts (comparing values
 * with <, <=, > and >=) and the validator (checks 12 and 19). Keeping the rule in one place
 * makes all three read numbers the same way.
 *
 * Part of the library: no MMAR, no model, no language. It used to sit in transformer.ts, but
 * the transformer is the MMAR adapter and does not move into the library, so the files that do
 * would have depended on it.
 *
 */

/**
 * A number written with a comma or a dot as decimal separator, requires: "0,8"
 * and "0.8" both read as 0.8. null when the text is not such a number.
 */
export function parseDecimal(text: string): number | null {
  const normalized = text.trim().replace(",", "."); // one decimal comma becomes a dot
  return /^[+-]?(\d+(\.\d*)?|\.\d+)$/.test(normalized) ? Number(normalized) : null; // plain decimals only; Number alone would also accept "1e3" or "0x10"
}
