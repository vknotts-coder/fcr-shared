import type { FormField } from "./types.js";
/** True for null/undefined or an all-whitespace string — one definition of "empty field". */
export declare function isBlank(v: unknown): boolean;
export declare const US_STATES: string[];
/**
 * Coerce a raw string to the typed value for its column. Blank → null. Numeric columns →
 * finite number or null; date columns → a valid 'YYYY-MM-DD' or null; a `*_state` column →
 * upper-cased 2-letter code. Everything else → trimmed string.
 */
export declare function coerceField(column: string, raw: string | null, numericCols: Set<string>, dateCols: Set<string>): unknown;
/**
 * Parse the editable fields out of a submitted form into a typed column map. Only fields
 * PRESENT in the submission are included — an absent field is left untouched (not written as
 * null), so a partial update can't wipe columns it didn't send. An empty input IS present, so
 * clearing a field to blank still works (present → coerced to null).
 */
export declare function parseEdits(formData: FormData, fields: FormField[], numericCols: Set<string>, dateCols: Set<string>): Record<string, unknown>;
//# sourceMappingURL=coerce.d.ts.map