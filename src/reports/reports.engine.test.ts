// Package-level coverage for the app-agnostic engine (#99 Slice B): runner + registry-core exercised
// over a FIXTURE catalog (not any app's truck/trailer), proving the injected-catalog seam + the field
// floor + the SQL injection floor without depending on a consuming app. The real truck/trailer catalog
// is covered by fcr-dispatch's own suite once it consumes this package (Slice C).

import { describe, it, expect } from "vitest";
import type { Principal } from "../contracts/index.js";
import {
  getObjectDef,
  toClientObject,
  validateReport,
  buildTabularQuery,
  type RegistryObject,
  type RegistryField,
} from "./index.js";

const widget: RegistryObject = {
  key: "widget",
  label: "Widget",
  table: "app.widget",
  baseWhere: "deleted_at IS NULL AND is_test = false",
  capability: () => true,
  fields: [
    { key: "name", label: "Name", type: "string", section: "identity", path: "name", filterable: true, groupable: true, summable: false },
    { key: "status", label: "Status", type: "enum", section: "identity", path: "status", filterable: true, groupable: true, summable: false, enumValues: ["open", "closed"] },
    { key: "cost", label: "Cost", type: "money", section: "financials", path: "cost", filterable: true, groupable: false, summable: true, sensitive: true },
  ],
};
const catalog: RegistryObject[] = [widget];

// Admin holds the coarse wildcard grants (admin + view) — covers every field (sensitive included).
const admin: Principal = {
  username: "admin",
  accountId: "00000000-0000-0000-0000-0000000000ad",
  grants: [
    { roleId: "", resourceType: "*", action: "admin", section: null, field: null, scope: "all", effect: "allow", departmentId: null, shopId: null },
    { roleId: "", resourceType: "*", action: "view", section: null, field: null, scope: "all", effect: "allow", departmentId: null, shopId: null },
  ],
};
const nobody: Principal = { username: "nobody", accountId: null, grants: [] };

// A catalog with a COMPUTED (expr) field — the #107 Slice A capability.
const gadget: RegistryObject = {
  key: "gadget",
  label: "Gadget",
  table: "app.gadget",
  baseWhere: "deleted_at IS NULL",
  capability: () => true,
  fields: [
    { key: "name", label: "Name", type: "string", section: "identity", path: "name", filterable: true, groupable: true, summable: false },
    // computed: registry-authored BARE SQL (the engine parenthesizes it), no `path`. Qualified with the object alias.
    { key: "age_days", label: "Age (days)", type: "number", section: "identity", expr: "now()::date - gadget.created_at", filterable: true, groupable: false, summable: false },
    // computed DATE field: still gets the calendar-date + TZ normalization a plain date column would.
    { key: "due", label: "Due", type: "date", section: "identity", expr: "gadget.created_at + interval '30 days'", filterable: true, groupable: true, summable: false, dateTz: true },
  ],
};
const gcatalog: RegistryObject[] = [gadget];

describe("computed (expr) fields (#107 Slice A)", () => {
  const EXPR = "(now()::date - gadget.created_at)"; // the engine wraps the bare expr once
  const build = (def: object) => {
    const v = validateReport(def, admin, gcatalog);
    expect(v.ok).toBe(true);
    if (!v.ok) throw new Error(v.errors.join("; "));
    const fieldsByKey = new Map(v.obj.fields.map((f) => [f.key, f] as [string, RegistryField]));
    return buildTabularQuery(v.obj, v.def, fieldsByKey, admin);
  };

  it("emits the expr verbatim (parenthesized) in SELECT, aliased by key", () => {
    const q = build({ object: "gadget", columns: ["name", "age_days"], filters: [], summaries: [] });
    expect(q.sql).toContain(`${EXPR} AS "age_days"`);
  });

  it("filters a computed field with the VALUE bound as a param (injection floor holds)", () => {
    const q = build({
      object: "gadget",
      columns: ["age_days"],
      filters: [{ field: "age_days", op: "gte", value: "30" }],
      summaries: [],
    });
    expect(q.sql).toContain(`${EXPR} >= $1`); // expr on the identifier side
    expect(q.params).toEqual([30]); // the user value is bound + coerced, never in the SQL text
    expect(q.sql).not.toContain("30");
  });

  it("sorts by a computed field (ORDER BY the expr)", () => {
    const q = build({ object: "gadget", columns: ["age_days"], filters: [], sort: { field: "age_days", dir: "desc" }, summaries: [] });
    expect(q.sql).toContain(`ORDER BY ${EXPR} DESC`);
  });

  it("a computed DATE field gets the same ::date + timezone normalization as a plain date column", () => {
    const q = build({ object: "gadget", columns: ["due"], filters: [], summaries: [] });
    // dateExpr wraps the (expr) with AT TIME ZONE (dateTz) + ::date, so it buckets in the report's tz.
    expect(q.sql).toContain("gadget.created_at + interval '30 days'");
    expect(q.sql).toContain("AT TIME ZONE 'America/Chicago'");
    expect(q.sql).toMatch(/\)::date AS "due"/);
  });

  it("defence-in-depth: a field with neither path nor expr throws (registry bug), not silent bad SQL", () => {
    // The discriminated union makes this a COMPILE error too — cast through to exercise the runtime guard.
    const oops = { key: "oops", label: "Oops", type: "string", section: "identity", filterable: true, groupable: false, summable: false } as unknown as RegistryField;
    const broken: RegistryObject = { ...gadget, fields: [oops] };
    const fieldsByKey = new Map(broken.fields.map((f) => [f.key, f] as [string, RegistryField]));
    expect(() => buildTabularQuery(broken, { object: "gadget", columns: ["oops"], filters: [], summaries: [], filterLogic: null, groupBy: null, sort: null } as never, fieldsByKey, admin)).toThrow(/neither path nor expr/);
  });
});

describe("registry-core over an injected catalog", () => {
  it("getObjectDef resolves a known key and undefined for an unknown one", () => {
    expect(getObjectDef(catalog, "widget")?.key).toBe("widget");
    expect(getObjectDef(catalog, "nope")).toBeUndefined();
  });

  it("toClientObject drops a sensitive field for a principal without the grant, keeps it for admin", () => {
    expect(toClientObject(widget, admin).fields.map((f) => f.key)).toContain("cost");
    const forNobody = toClientObject(widget, nobody).fields.map((f) => f.key);
    expect(forNobody).toContain("name"); // non-sensitive always offered
    expect(forNobody).not.toContain("cost"); // sensitive dropped (can() default-deny)
  });
});

describe("validateReport — gate before any SQL, over the injected catalog", () => {
  it("accepts a valid def", () => {
    expect(validateReport({ object: "widget", columns: ["name", "status"], filters: [], summaries: [] }, admin, catalog).ok).toBe(true);
  });
  it("rejects an unknown object", () => {
    expect(validateReport({ object: "nope", columns: ["name"], filters: [], summaries: [] }, admin, catalog).ok).toBe(false);
  });
  it("rejects an unknown / non-offered column KEY before building SQL", () => {
    expect(validateReport({ object: "widget", columns: ["name", "status); DROP TABLE widget; --"], filters: [], summaries: [] }, admin, catalog).ok).toBe(false);
  });
});

describe("the injection floor — identifiers from the registry, values bound as params", () => {
  it("filter values are bound $N params; the SQL text carries no user literal", () => {
    const v = validateReport(
      { object: "widget", columns: ["name", "status"], filters: [{ field: "status", op: "eq", value: "open" }], summaries: [] },
      admin,
      catalog,
    );
    expect(v.ok).toBe(true);
    if (!v.ok) return;
    const fieldsByKey = new Map(v.obj.fields.map((f) => [f.key, f] as [string, RegistryField]));
    const q = buildTabularQuery(v.obj, v.def, fieldsByKey, admin);
    expect(q.sql).toContain(`"widget"."status" = $1`);
    expect(q.params).toEqual(["open"]);
    expect(q.sql).not.toContain("open"); // the literal never enters the SQL text
    expect(q.sql).toContain("deleted_at IS NULL AND is_test = false"); // baseWhere always applied
  });
});

describe("filterLogic — no orphan bind params when a filter is omitted (#103 defect 1)", () => {
  // The bind count Postgres requires is the HIGHEST $N in the SQL; supplying MORE values than that (an
  // orphan, from a filter the logic string doesn't reference) makes Postgres reject the bind and the run
  // fail generically. So the invariant is: params.length === max($N) in the emitted SQL.
  const maxPlaceholder = (sql: string) => Math.max(0, ...[...sql.matchAll(/\$(\d+)/g)].map((m) => Number(m[1])));
  const build = (def: object) => {
    const v = validateReport(def, admin, catalog);
    expect(v.ok).toBe(true);
    if (!v.ok) throw new Error(v.errors.join("; "));
    const fieldsByKey = new Map(v.obj.fields.map((f) => [f.key, f] as [string, RegistryField]));
    return buildTabularQuery(v.obj, v.def, fieldsByKey, admin);
  };

  it("omitting the TRAILING filter (3 filters, logic '1 AND 2') binds only the referenced params", () => {
    const q = build({
      object: "widget",
      columns: ["name"],
      filters: [
        { field: "name", op: "eq", value: "a" },
        { field: "status", op: "eq", value: "open" },
        { field: "cost", op: "eq", value: "5" }, // NOT referenced by the logic → must push no param
      ],
      filterLogic: "1 AND 2",
      summaries: [],
    });
    expect(q.params.length).toBe(maxPlaceholder(q.sql)); // no orphan
    expect(q.params).toEqual(["a", "open"]);
    expect(q.params).not.toContain(5); // the omitted filter's value is not bound
  });

  it("logic '1' with 2 filters binds only the first (regression on the minimal repro)", () => {
    const q = build({
      object: "widget",
      columns: ["name"],
      filters: [
        { field: "name", op: "eq", value: "a" },
        { field: "status", op: "eq", value: "open" },
      ],
      filterLogic: "1",
      summaries: [],
    });
    expect(q.params.length).toBe(maxPlaceholder(q.sql));
    expect(q.params).toEqual(["a"]);
  });

  it("a filter referenced twice ('1 AND 1') is built once — one param, one $N", () => {
    const q = build({
      object: "widget",
      columns: ["name"],
      filters: [{ field: "status", op: "eq", value: "open" }],
      filterLogic: "1 AND 1",
      summaries: [],
    });
    expect(q.params).toEqual(["open"]);
    expect(q.params.length).toBe(maxPlaceholder(q.sql));
  });

  it("no explicit logic (all filters AND'd) still binds every filter with matching placeholders", () => {
    const q = build({
      object: "widget",
      columns: ["name"],
      filters: [
        { field: "name", op: "eq", value: "a" },
        { field: "status", op: "eq", value: "open" },
      ],
      summaries: [],
    });
    expect(q.params).toEqual(["a", "open"]);
    expect(q.params.length).toBe(maxPlaceholder(q.sql));
  });
});
