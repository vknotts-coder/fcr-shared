import type { FormField } from "./types.js";
/** True for null/undefined or an all-whitespace string — one definition of "empty field". */
export declare function isBlank(v: unknown): boolean;
/** Max VIN length — the fcr_core truck.vin / trailer.full_vin columns are varchar(17). A longer
 *  value would overflow the column and 500 the create; the specs reject it as a friendly error. */
export declare const VIN_MAX_LENGTH = 17;
export declare const US_STATES: string[];
/** Map a Yes/No (or true/false/1/0) select value to a real boolean, or null when it is neither.
 *  A boolean fcr_core column (e.g. trailer.rework) is edited via a Yes/No `select`, so the raw
 *  submission is a string the DB driver would otherwise bind as text into a boolean column. */
export declare function coerceBool(s: string): boolean | null;
/**
 * Coerce a raw string to the typed value for its column. Blank → null. Numeric columns →
 * finite number or null; date columns → a valid 'YYYY-MM-DD' or null; boolean columns →
 * true/false/null (Yes/No select); a `*_state` column → upper-cased 2-letter code. Everything
 * else → trimmed string. `boolCols` is optional so existing specs (truck) need no change.
 */
export declare function coerceField(column: string, raw: string | null, numericCols: Set<string>, dateCols: Set<string>, boolCols?: Set<string>): unknown;
/**
 * Parse the editable fields out of a submitted form into a typed column map. Only fields
 * PRESENT in the submission are included — an absent field is left untouched (not written as
 * null), so a partial update can't wipe columns it didn't send. An empty input IS present, so
 * clearing a field to blank still works (present → coerced to null).
 */
export declare function parseEdits(formData: FormData, fields: FormField[], numericCols: Set<string>, dateCols: Set<string>, boolCols?: Set<string>): Record<string, unknown>;
//# sourceMappingURL=coerce.d.ts.map