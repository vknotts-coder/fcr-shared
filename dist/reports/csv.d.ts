import type { CellValue, ReportResult, SummaryCell } from "./runner.js";
type Field = CellValue | SummaryCell;
/** One CSV cell: formula-guard, then RFC-4180 quote-wrap if it contains a quote, comma, or newline. */
export declare function csvCell(v: Field): string;
/** Serialize a header + rows of already-CSV-ready fields. LF line endings; header first. */
export declare function toCsv(header: string[], rows: Field[][]): string;
/**
 * Serialize a report result to CSV. Tabular → column labels + rows. Summary → group column + aggregate
 * columns + a grand-total row (a null aggregate exports blank, never a fabricated 0). If the result was
 * truncated at the row cap, a trailing NOTE discloses that the figures are partial — the exported file
 * self-describes, since a shared CSV outlives the on-screen truncation banner.
 */
export declare function reportToCsv(result: ReportResult): string;
/** A safe download filename from a report name: slugified, always ".csv". */
export declare function csvFilename(name: string): string;
export {};
//# sourceMappingURL=csv.d.ts.map