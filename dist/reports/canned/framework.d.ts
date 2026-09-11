import { type FieldType } from "../definition.js";
import type { CellValue, TabularResult } from "../runner.js";
/** Format a date/timestamp CellValue to its yyyy-mm-dd head (shared by the readers). Null/empty → "". */
export declare const toDateOnly: (v: string | Date | null) => string;
/** Coerce a numeric-or-numeric-string (Postgres numerics arrive as strings) to a number CellValue; null → null. */
export declare const toNumber: (v: string | number | null) => CellValue;
/** Round a numeric-or-numeric-string to a whole number CellValue, PRESERVING null (→ null). Callers that
 *  want null→0 do `roundOrNull(v) ?? 0`. */
export declare const roundOrNull: (v: string | number | null) => CellValue;
/** A canned-report column spec; `numeric` defaults from the field type (money/number → right-aligned). */
export type CannedColumn = {
    key: string;
    label: string;
    type: FieldType;
    numeric?: boolean;
};
/** Build a TabularResult from a column spec + already-shaped rows. No row cap / truncation (canned reports
 *  are pre-scoped and pre-aggregated), no record links. `object` is the report's stable identity in the
 *  result (mirrors the runner's TabularResult.object). */
export declare function tabular(object: string, cols: CannedColumn[], rows: Record<string, CellValue>[]): TabularResult;
/** One prebuilt report. `run` executes it (reads live data) and returns a rendered-ready TabularResult. */
export type CannedReport = {
    slug: string;
    title: string;
    description: string;
    section: string;
    run: () => Promise<TabularResult>;
};
//# sourceMappingURL=framework.d.ts.map