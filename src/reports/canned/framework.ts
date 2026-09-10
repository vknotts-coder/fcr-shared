// Canned-report framework (#43 Slice 4). A "canned" report is CODE (not a saved definition): a bespoke
// async fn that wraps an existing dispatch lib query and reshapes its output into a TabularResult — the
// SAME shape the S1 runner produces — so canned reports render through the existing <ReportResults> grid
// with no new rendering. CSV export is served by the dedicated GET /reports/canned/[slug]/export route
// (canned reports have no saved definition, so they can't use the definition-driven /reports/export path).
// Each report is registered in ./index.ts. All are admin-only + REPORTS_LIVE-gated at the route; v1 shows
// admins everything (field-gating is S5).

import type { FieldType } from "../definition.js";
import type { CellValue, ReportColumn, TabularResult } from "../runner.js";

const NUMERIC: ReadonlySet<FieldType> = new Set(["number", "money"]);

/** Format a date/timestamp CellValue to its yyyy-mm-dd head (shared by the readers). Null/empty → "". */
export const toDateOnly = (v: string | Date | null): string =>
  v == null ? "" : (typeof v === "string" ? v : v.toISOString()).slice(0, 10);

/** Coerce a numeric-or-numeric-string (Postgres numerics arrive as strings) to a number CellValue; null → null. */
export const toNumber = (v: string | number | null): CellValue => (v == null ? null : Number(v));

/** Round a numeric-or-numeric-string to a whole number CellValue, PRESERVING null (→ null). Callers that
 *  want null→0 do `roundOrNull(v) ?? 0`. */
export const roundOrNull = (v: string | number | null): CellValue => (v == null ? null : Math.round(Number(v)));

/** A canned-report column spec; `numeric` defaults from the field type (money/number → right-aligned). */
export type CannedColumn = { key: string; label: string; type: FieldType; numeric?: boolean };

/** Build a TabularResult from a column spec + already-shaped rows. No row cap / truncation (canned reports
 *  are pre-scoped and pre-aggregated), no record links. `object` is the report's stable identity in the
 *  result (mirrors the runner's TabularResult.object). */
export function tabular(object: string, cols: CannedColumn[], rows: Record<string, CellValue>[]): TabularResult {
  const columns: ReportColumn[] = cols.map((c) => ({
    key: c.key,
    label: c.label,
    type: c.type,
    numeric: c.numeric ?? NUMERIC.has(c.type),
  }));
  return {
    mode: "tabular",
    object,
    columns,
    rows,
    hrefs: rows.map(() => null),
    rowCount: rows.length,
    truncated: false,
  };
}

/** One prebuilt report. `run` executes it (reads live data) and returns a rendered-ready TabularResult. */
export type CannedReport = {
  slug: string;
  title: string;
  description: string;
  section: string; // index grouping, e.g. "Intake" | "Dispatch" | "Drivers" | "Service quality"
  run: () => Promise<TabularResult>;
};
