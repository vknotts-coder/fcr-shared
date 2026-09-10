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
