// Field coercion + tiny predicates shared by the pipeline and the specs. One definition of
// "blank" and one of how a raw FormData string becomes a typed column value, so the parse,
// the status engine and the validators can never drift.

import type { FormField } from "./types.js";

/** True for null/undefined or an all-whitespace string — one definition of "empty field". */
export function isBlank(v: unknown): boolean {
  return v == null || (typeof v === "string" && v.trim() === "");
}

/** Max VIN length — the fcr_core truck.vin / trailer.full_vin columns are varchar(17). A longer
 *  value would overflow the column and 500 the create; the specs reject it as a friendly error. */
export const VIN_MAX_LENGTH = 17;

export const US_STATES = [
  "AL","AK","AZ","AR","CA","CO","CT","DE","FL","GA","HI","ID","IL","IN","IA","KS","KY","LA","ME","MD","MA","MI","MN","MS","MO","MT","NE","NV","NH","NJ","NM","NY","NC","ND","OH","OK","OR","PA","RI","SC","SD","TN","TX","UT","VT","VA","WA","WV","WI","WY","DC",
];

/**
 * Coerce a raw string to the typed value for its column. Blank → null. Numeric columns →
 * finite number or null; date columns → a valid 'YYYY-MM-DD' or null; a `*_state` column →
 * upper-cased 2-letter code. Everything else → trimmed string.
 */
export function coerceField(
  column: string,
  raw: string | null,
  numericCols: Set<string>,
  dateCols: Set<string>,
): unknown {
  const s = (raw ?? "").trim();
  if (s === "") return null;
  if (numericCols.has(column)) {
    const n = Number(s.replace(/[^0-9.\-]/g, ""));
    return Number.isFinite(n) ? n : null;
  }
  if (dateCols.has(column)) return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null;
  if (column.endsWith("_state")) return s.toUpperCase().slice(0, 2);
  return s;
}

/**
 * Parse the editable fields out of a submitted form into a typed column map. Only fields
 * PRESENT in the submission are included — an absent field is left untouched (not written as
 * null), so a partial update can't wipe columns it didn't send. An empty input IS present, so
 * clearing a field to blank still works (present → coerced to null).
 */
export function parseEdits(
  formData: FormData,
  fields: FormField[],
  numericCols: Set<string>,
  dateCols: Set<string>,
): Record<string, unknown> {
  const edits: Record<string, unknown> = {};
  for (const f of fields) {
    if (!formData.has(f.column)) continue;
    edits[f.column] = coerceField(f.column, String(formData.get(f.column)), numericCols, dateCols);
  }
  return edits;
}
