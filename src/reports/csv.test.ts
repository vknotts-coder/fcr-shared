// Unit tests for the report CSV serializer (#43 Slice 3). Pure — no DB. Covers RFC-4180 escaping, the
// formula-injection guard (and its number pass-through), both result modes incl. the grand-total row, the
// partial-result note, and filename slugging.

import { describe, it, expect } from "vitest";
import { csvCell, reportToCsv, csvFilename, toCsv } from "./csv.js";
import { REPORT_ROW_CAP, EXPORT_ROW_CAP } from "./definition.js";
import type { TabularResult, SummaryResult } from "./runner.js";

describe("csvCell — escaping + formula guard", () => {
  it("passes a plain string through unquoted", () => {
    expect(csvCell("hello")).toBe("hello");
  });
  it("null/undefined → empty", () => {
    expect(csvCell(null)).toBe("");
  });
  it("quote-wraps and doubles quotes when a comma / quote / newline is present", () => {
    expect(csvCell("a,b")).toBe('"a,b"');
    expect(csvCell('he said "hi"')).toBe('"he said ""hi"""');
    expect(csvCell("line1\nline2")).toBe('"line1\nline2"');
  });
  it("formula-guards a non-number string starting with = + - @ (tab/CR too)", () => {
    expect(csvCell("=1+1")).toBe("'=1+1");
    expect(csvCell("+cmd")).toBe("'+cmd");
    expect(csvCell("@x")).toBe("'@x");
    expect(csvCell("-danger")).toBe("'-danger"); // a STRING starting with '-' is guarded
  });
  it("does NOT guard a real negative number (stays summable, not text)", () => {
    expect(csvCell(-1500)).toBe("-1500");
    expect(csvCell(0)).toBe("0");
    expect(csvCell(1234.5)).toBe("1234.5");
  });
  it("a guarded value that also needs quoting is both guarded and quoted", () => {
    expect(csvCell("=a,b")).toBe('"\'=a,b"'); // guard adds ', comma forces quote-wrap
  });
  it("booleans serialize as true/false", () => {
    expect(csvCell(true)).toBe("true");
    expect(csvCell(false)).toBe("false");
  });
});

describe("toCsv", () => {
  it("emits header first, LF-joined", () => {
    expect(toCsv(["A", "B"], [[1, "x"], [2, "y"]])).toBe("A,B\n1,x\n2,y");
  });
});

const tabular = (over: Partial<TabularResult> = {}): TabularResult => ({
  mode: "tabular",
  object: "truck",
  columns: [
    { key: "sf_name", label: "Unit #", type: "string", numeric: false },
    { key: "total_sales", label: "Total sales", type: "money", numeric: true },
    { key: "created_at", label: "Created", type: "date", numeric: false },
  ],
  rows: [
    { sf_name: "T-100", total_sales: -250.5, created_at: "2026-09-03T18:00:00.000Z" },
    { sf_name: "a,b", total_sales: null, created_at: null },
  ],
  hrefs: [null, null],
  rowCount: 2,
  truncated: false,
  rowCap: REPORT_ROW_CAP,
  ...over,
});

describe("reportToCsv — tabular", () => {
  it("uses column labels, keeps numbers numeric, slices date to yyyy-mm-dd, blanks null, escapes commas", () => {
    const csv = reportToCsv(tabular());
    expect(csv).toBe('Unit #,Total sales,Created\nT-100,-250.5,2026-09-03\n"a,b",,');
  });
  it("appends a PARTIAL RESULT note when truncated, stating the cap once (no redundant 'N of the first')", () => {
    const csv = reportToCsv(tabular({ truncated: true, rowCount: 5000 }));
    expect(csv).toContain("NOTE: PARTIAL RESULT — capped at the first 5,000 rows");
    expect(csv).not.toContain("of the first"); // the old, self-contradictory phrasing is gone
    expect(csv).not.toMatch(/\b5000 of\b/); // no raw (unformatted) count mixed in
  });
  it("does NOT append the note when not truncated", () => {
    expect(reportToCsv(tabular())).not.toContain("PARTIAL RESULT");
  });
  it("degrades (no throw) to REPORT_ROW_CAP if a truncated result arrives with rowCap absent (foreign/rehydrated)", () => {
    // reportToCsv is an exported API — a JSON-rehydrated / cross-version result could lack rowCap. It must
    // print the old constant, never throw on undefined.toLocaleString().
    const noCap = { ...tabular({ truncated: true, rowCount: 5000 }), rowCap: undefined } as unknown as TabularResult;
    let csv = "";
    expect(() => { csv = reportToCsv(noCap); }).not.toThrow();
    expect(csv).toContain(`capped at the first ${REPORT_ROW_CAP.toLocaleString()} rows`);
  });
  it("states the APPLIED cap, not a hardcoded one — a 100k export truncation reports 100,000, not 5,000", () => {
    // Guard for the #32-review finding: the NOTE used to hardcode REPORT_ROW_CAP, so an export truncated at
    // EXPORT_ROW_CAP would 20×-understate ("first 5,000 rows"). It must quote result.rowCap.
    const csv = reportToCsv(tabular({ truncated: true, rowCount: EXPORT_ROW_CAP, rowCap: EXPORT_ROW_CAP }));
    expect(csv).toContain(`capped at the first ${EXPORT_ROW_CAP.toLocaleString()} rows`); // "100,000"
    expect(csv).not.toContain("5,000"); // the old hardcoded value must NOT appear
  });
});

const summary = (over: Partial<SummaryResult> = {}): SummaryResult => ({
  mode: "summary",
  object: "truck",
  group: { key: "status", label: "Status" },
  columns: [
    { key: "count", label: "Count", type: "number", numeric: true },
    { key: "sum:total_sales", label: "Sum of Total sales", type: "money", numeric: true },
  ],
  rows: [
    { groupValue: "Open", values: { count: 3, "sum:total_sales": 900 } },
    { groupValue: "Closed", values: { count: 1, "sum:total_sales": null } },
  ],
  total: { count: 4, "sum:total_sales": 900 },
  rowCount: 2,
  truncated: false,
  ...over,
});

describe("reportToCsv — summary", () => {
  it("group label first, aggregate columns, a Total row, null aggregate → blank, real 0 kept", () => {
    const csv = reportToCsv(summary());
    expect(csv).toBe(
      "Status,Count,Sum of Total sales\n" +
        "Open,3,900\n" +
        "Closed,1,\n" + // null sum → empty, not 0
        "Total,4,900",
    );
  });
  it("falls back to 'Group' when the group has no label", () => {
    const csv = reportToCsv(summary({ group: { key: "", label: "" } }));
    expect(csv.split("\n")[0]).toBe("Group,Count,Sum of Total sales");
  });
  it("keeps a real 0 aggregate (not blanked)", () => {
    const csv = reportToCsv(
      summary({ rows: [{ groupValue: "Z", values: { count: 0, "sum:total_sales": 0 } }], total: { count: 0, "sum:total_sales": 0 } }),
    );
    expect(csv).toContain("Z,0,0");
  });
});

describe("csvFilename", () => {
  it("slugifies to lowercase dash-joined, always .csv", () => {
    expect(csvFilename("Open Trucks — Q3!")).toBe("open-trucks-q3.csv");
    expect(csvFilename("  ")).toBe("report.csv");
    expect(csvFilename("already-ok")).toBe("already-ok.csv");
  });
});
