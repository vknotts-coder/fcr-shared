// CSV serialization for report export (#43 Slice 3). PURE — no DB, no session; safe in any bundle. Ported
// from the SC Shop report exporter. Turns a runner ReportResult (tabular or grouped summary) into RFC-4180
// CSV text with a formula-injection guard. Cells arrive already coerced by the runner (CellValue =
// string | number | boolean | null): money/number are REAL numbers, so the guard skips them and a negative
// stays a summable number in Excel rather than becoming text.

import type { CellValue, ReportColumn, ReportResult, SummaryCell } from "./runner.js";
import type { FieldType } from "./definition.js";
import { REPORT_ROW_CAP } from "./definition.js";

// A cell value that may go into the CSV: the runner's CellValue, or an aggregate SummaryCell.
type Field = CellValue | SummaryCell;

/**
 * Formula-injection guard: a spreadsheet treats a cell beginning with = + - @ TAB or CR as a formula. A
 * NON-number string starting with one of those gets a leading apostrophe so the spreadsheet renders it as
 * text. Numbers are returned untouched — prefixing a real number would turn -1500 into the text '-1500 and
 * break summation. (RFC-4180 quoting is applied separately, after this.)
 */
function formulaGuard(v: Field): string {
  if (v == null) return "";
  if (typeof v === "number") return Number.isFinite(v) ? String(v) : "";
  const s = String(v); // boolean or string
  return /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
}

/** One CSV cell: formula-guard, then RFC-4180 quote-wrap if it contains a quote, comma, or newline. */
export function csvCell(v: Field): string {
  const s = formulaGuard(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** A date CellValue is a string; show only the calendar date (yyyy-mm-dd head), matching the on-screen grid. */
function fieldForCsv(v: CellValue, type: FieldType): Field {
  if (v == null) return null;
  if (type === "date") return String(v).slice(0, 10);
  return v; // number / boolean / string as-is (numbers stay numeric for the guard's pass-through)
}

/** Serialize a header + rows of already-CSV-ready fields. LF line endings; header first. */
export function toCsv(header: string[], rows: Field[][]): string {
  const lines = [header.map(csvCell).join(",")];
  for (const row of rows) lines.push(row.map(csvCell).join(","));
  return lines.join("\n");
}

/**
 * Serialize a report result to CSV. Tabular → column labels + rows. Summary → group column + aggregate
 * columns + a grand-total row (a null aggregate exports blank, never a fabricated 0). If the result was
 * truncated at the row cap, a trailing NOTE discloses that the figures are partial — the exported file
 * self-describes, since a shared CSV outlives the on-screen truncation banner.
 */
export function reportToCsv(result: ReportResult): string {
  let csv: string;
  if (result.mode === "tabular") {
    const cols: ReportColumn[] = result.columns;
    const header = cols.map((c) => c.label);
    const rows: Field[][] = result.rows.map((row) => cols.map((c) => fieldForCsv(row[c.key] ?? null, c.type)));
    csv = toCsv(header, rows);
  } else {
    const cols = result.columns;
    const header = [result.group.label || "Group", ...cols.map((c) => c.label)];
    const rows: Field[][] = result.rows.map((r) => [r.groupValue, ...cols.map((c) => r.values[c.key] ?? "")]);
    rows.push(["Total", ...cols.map((c) => result.total[c.key] ?? "")]);
    csv = toCsv(header, rows);
  }
  if (result.truncated) {
    // A tabular result is flagged truncated only after the runner slices to exactly REPORT_ROW_CAP, so the
    // row count here is always the cap — state that directly rather than "N of the first cap".
    csv += `\n\nNOTE: PARTIAL RESULT — capped at the first ${REPORT_ROW_CAP.toLocaleString()} rows; the report has more, so these figures are NOT complete. Narrow the filters for exact totals.`;
  }
  return csv;
}

/** A safe download filename from a report name: slugified, always ".csv". */
export function csvFilename(name: string): string {
  const slug =
    (name || "")
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "report";
  return `${slug}.csv`;
}
