// Unit tests for the report-definition validator (#43 Slice 0). Pure — validates a raw definition
// against a hand-built ClientReportObject (the viewer's permission-filtered field set), which is the
// field-level security floor. No DB, no registry. Ported from the SC Shop report-builder suite.

import { describe, it, expect } from "vitest";
import { validateDefinition, parseFilterLogic, isNumericType, type ClientReportObject } from "./definition.js";

const OBJ: ClientReportObject = {
  key: "truck",
  label: "Trucks",
  fields: [
    { key: "sf_name", label: "Unit #", type: "string", filterable: true, groupable: false, summable: false },
    { key: "status", label: "Status", type: "enum", filterable: true, groupable: true, summable: false, enumValues: ["Awaiting Pickup", "In Repair", "Ready"] },
    { key: "total_sales", label: "Total sales", type: "money", filterable: true, groupable: false, summable: true },
    { key: "notify_date", label: "Notified", type: "date", filterable: true, groupable: true, summable: false },
    { key: "pickup_driver", label: "Pickup driver", type: "string", filterable: true, groupable: true, summable: false },
  ],
};

const base = { object: "truck", columns: ["sf_name", "total_sales"], filters: [], summaries: [] };

describe("validateDefinition — happy paths", () => {
  it("accepts a minimal tabular definition", () => {
    expect(validateDefinition(base, OBJ).ok).toBe(true);
  });

  it("accepts a summary definition (group + aggregates)", () => {
    const r = validateDefinition(
      { object: "truck", columns: [], filters: [], groupBy: { field: "status" }, summaries: [{ field: "total_sales", agg: "sum" }, { field: "*", agg: "count" }] },
      OBJ,
    );
    expect(r.ok).toBe(true);
  });

  it("accepts a date group-by with a bucket", () => {
    const r = validateDefinition(
      { object: "truck", columns: [], filters: [], groupBy: { field: "notify_date", bucket: "month" }, summaries: [{ field: "*", agg: "count" }] },
      OBJ,
    );
    expect(r.ok).toBe(true);
  });
});

describe("validateDefinition — the security floor + shape rules", () => {
  it("rejects a field not in the offered set (the sensitive / unknown-field floor)", () => {
    const r = validateDefinition({ ...base, columns: ["sf_name", "finalized_total_sales"] }, OBJ);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.join()).toMatch(/unknown column: finalized_total_sales/);
  });

  it("rejects an object mismatch", () => {
    expect(validateDefinition({ ...base, object: "trailer" }, OBJ).ok).toBe(false);
  });

  it("requires at least one column in tabular mode", () => {
    expect(validateDefinition({ ...base, columns: [] }, OBJ).ok).toBe(false);
  });

  it("rejects an operator illegal for the field type (contains on money)", () => {
    const r = validateDefinition({ ...base, filters: [{ field: "total_sales", op: "contains", value: "5" }] }, OBJ);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.join()).toMatch(/not allowed on total_sales/);
  });

  it("rejects an enum value outside the offered set", () => {
    const r = validateDefinition({ ...base, filters: [{ field: "status", op: "eq", value: "NOPE" }] }, OBJ);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.join()).toMatch(/not a valid value/);
  });

  it("requires a value for a value-taking operator", () => {
    expect(validateDefinition({ ...base, filters: [{ field: "total_sales", op: "gt" }] }, OBJ).ok).toBe(false);
  });

  it("allows a valueless operator with no value", () => {
    expect(validateDefinition({ ...base, filters: [{ field: "notify_date", op: "notNull" }] }, OBJ).ok).toBe(true);
  });

  it("rejects summaries without a group-by", () => {
    const r = validateDefinition({ ...base, columns: [], summaries: [{ field: "total_sales", agg: "sum" }] }, OBJ);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.join()).toMatch(/needs a group-by/);
  });

  it("rejects sum on a non-numeric field", () => {
    const r = validateDefinition(
      { object: "truck", columns: [], filters: [], groupBy: { field: "status" }, summaries: [{ field: "sf_name", agg: "sum" }] },
      OBJ,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.join()).toMatch(/needs a numeric field/);
  });

  it("rejects grouping by a non-groupable field", () => {
    const r = validateDefinition(
      { object: "truck", columns: [], filters: [], groupBy: { field: "total_sales" }, summaries: [{ field: "*", agg: "count" }] },
      OBJ,
    );
    expect(r.ok).toBe(false);
  });

  it("rejects unexpected top-level keys (strict schema)", () => {
    expect(validateDefinition({ ...base, evil: true }, OBJ).ok).toBe(false);
  });

  it("rejects an unexpected key inside a filter (strict schema)", () => {
    expect(validateDefinition({ ...base, filters: [{ field: "status", op: "eq", value: "Ready", evil: 1 }] }, OBJ).ok).toBe(false);
  });

  it("rejects an oversized columns array (DoS guard)", () => {
    const many = Array.from({ length: 200 }, () => "sf_name");
    expect(validateDefinition({ ...base, columns: many }, OBJ).ok).toBe(false);
  });

  it("dedupes repeated columns in the returned definition", () => {
    const r = validateDefinition({ ...base, columns: ["sf_name", "total_sales", "sf_name"] }, OBJ);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.def.columns).toEqual(["sf_name", "total_sales"]);
  });

  it("rejects an unparseable date filter value (else the runner throws building the WHERE)", () => {
    for (const bad of ["2026-13-45", "garbage", "not-a-date"]) {
      const r = validateDefinition({ ...base, filters: [{ field: "notify_date", op: "eq", value: bad }] }, OBJ);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.errors.join()).toMatch(/not a valid date/);
    }
  });

  it("dedupes identical summaries to one aggregate column", () => {
    const r = validateDefinition(
      { object: "truck", columns: [], filters: [], groupBy: { field: "status" }, summaries: [{ field: "*", agg: "count" }, { field: "*", agg: "count" }] },
      OBJ,
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.def.summaries).toHaveLength(1);
  });
});

describe("filter logic (Salesforce-style)", () => {
  const twoFilters = [
    { field: "status", op: "eq" as const, value: "Ready" },
    { field: "total_sales", op: "gt" as const, value: "1000" },
  ];

  it("parseFilterLogic parses a nested expression", () => {
    const r = parseFilterLogic("1 AND (2 OR 3)", 3);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.ast).toEqual({ op: "and", left: { op: "num", n: 1 }, right: { op: "or", left: { op: "num", n: 2 }, right: { op: "num", n: 3 } } });
  });

  it("parseFilterLogic rejects out-of-range, unbalanced, empty, and garbage", () => {
    expect(parseFilterLogic("1 AND 4", 3).ok).toBe(false); // 4 > count
    expect(parseFilterLogic("1 AND (2", 2).ok).toBe(false); // unbalanced
    expect(parseFilterLogic("", 2).ok).toBe(false); // empty
    expect(parseFilterLogic("1 AND AND 2", 2).ok).toBe(false); // double operator
    expect(parseFilterLogic("1 OR bogus", 2).ok).toBe(false); // bad token
  });

  it("validateDefinition accepts valid logic over the filters", () => {
    const r = validateDefinition({ ...base, filters: twoFilters, filterLogic: "1 OR 2" }, OBJ);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.def.filterLogic).toBe("1 OR 2");
  });

  it("validateDefinition rejects logic referencing a non-existent filter", () => {
    const r = validateDefinition({ ...base, filters: twoFilters, filterLogic: "1 AND 3" }, OBJ);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.join()).toMatch(/filter logic/);
  });

  it("validateDefinition rejects logic with no filters", () => {
    expect(validateDefinition({ ...base, filters: [], filterLogic: "1" }, OBJ).ok).toBe(false);
  });
});

describe("sort validation", () => {
  const summary = { object: "truck", columns: [], filters: [], groupBy: { field: "status" }, summaries: [{ field: "*", agg: "count" as const }] };

  it("tabular: accepts a selected column, rejects an unselected/unknown one", () => {
    expect(validateDefinition({ ...base, sort: { field: "total_sales", dir: "asc" } }, OBJ).ok).toBe(true); // in columns
    expect(validateDefinition({ ...base, sort: { field: "status", dir: "asc" } }, OBJ).ok).toBe(false); // real field, not selected
    expect(validateDefinition({ ...base, sort: { field: "nope", dir: "asc" } }, OBJ).ok).toBe(false); // unknown field
  });

  it("summary: accepts sorting by the group field or a summary key", () => {
    expect(validateDefinition({ ...summary, sort: { field: "status", dir: "desc" } }, OBJ).ok).toBe(true); // group field
    expect(validateDefinition({ ...summary, sort: { field: "count", dir: "desc" } }, OBJ).ok).toBe(true); // summary key
  });

  it("summary: REJECTS sorting by a real field that is neither the group nor a summary (#103 defect 2)", () => {
    // pickup_driver is a valid registry field, but with groupBy:status + count it has no column in the
    // grouped result — the runner would silently ignore the sort. Before the fix this passed validation.
    const r = validateDefinition({ ...summary, sort: { field: "pickup_driver", dir: "asc" } }, OBJ);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.join()).toMatch(/summary sort/);
  });
});

describe("isNumericType — single source of truth (#103 defect 3)", () => {
  it("is true for number/money and false for everything else", () => {
    expect(isNumericType("number")).toBe(true);
    expect(isNumericType("money")).toBe(true);
    for (const t of ["string", "date", "boolean", "enum"] as const) expect(isNumericType(t)).toBe(false);
  });
});
