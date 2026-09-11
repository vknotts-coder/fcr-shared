import { describe, it, expect } from "vitest";
import { truckObject, truckFields } from "./truck.js";
import { trailerObject, trailerFields } from "./trailer.js";
import { LIST_VIEWS, getListView, listViewsForObject, resolveSort, resolveStatus, listViewDefinition } from "./listviews.js";
import type { Principal } from "../contracts/index.js";

// Faithfulness pins for the catalog lifted from fcr-dispatch (#107 Slice 1). If a future edit changes the
// fcr_core schema coupling, these fail loudly rather than silently drifting a shared source of truth.

const allow = (_p: Principal) => true;
const deny = (_p: Principal) => false;
const p = {} as Principal;

describe("truck object", () => {
  const obj = truckObject({ capability: allow });

  it("carries the fcr_core schema coupling", () => {
    expect(obj.key).toBe("truck");
    expect(obj.table).toBe("fcr_core.truck");
    expect(obj.join?.sql).toContain("truck.fcr_collision_customer = customer.sf_id");
    expect(obj.baseWhere).toBe("truck.deleted_at IS NULL AND truck.is_test = false");
    expect(obj.ownerField).toBeNull();
  });

  it("injects the gate — capability is exactly what the app passes", () => {
    expect(truckObject({ capability: allow }).capability(p)).toBe(true);
    expect(truckObject({ capability: deny }).capability(p)).toBe(false);
  });

  it("injects link + linkEnabled routing", () => {
    const withLink = truckObject({ capability: allow, link: { path: "id", href: (id) => `/records/truck/${id}` }, linkEnabled: () => false });
    expect(withLink.link?.href("A-1")).toBe("/records/truck/A-1");
    expect(withLink.linkEnabled?.()).toBe(false);
    // absent link ⇒ undefined (runner treats as no hyperlink)
    expect(obj.link).toBeUndefined();
  });

  it("pins the field key set + a few schema paths", () => {
    const keys = truckFields.map((f) => f.key);
    expect(keys).toContain("sf_name");
    expect(keys).toContain("vin");
    expect(keys).toContain("invoice_1");
    expect(keys).toContain("finalized_total_sales");
    expect(truckFields.find((f) => f.key === "contacts")?.path).toBe("fcr_collision_contacts");
    expect(truckFields.find((f) => f.key === "customer_name")?.path).toBe("customer.sf_name");
    // financials are sensitive; identity/status are not
    expect(truckFields.find((f) => f.key === "total_sales")?.sensitive).toBe(true);
    expect(truckFields.find((f) => f.key === "sf_name")?.sensitive).toBeUndefined();
  });
});

describe("trailer object", () => {
  const obj = trailerObject({ capability: allow });

  it("carries the ASYMMETRIC trailer schema coupling", () => {
    expect(obj.key).toBe("trailer");
    expect(obj.table).toBe("fcr_core.trailer");
    expect(obj.join?.sql).toContain("trailer.fcr_collision_account = customer.sf_id");
    expect(obj.baseWhere).toBe("trailer.deleted_at IS NULL AND trailer.is_test = false");
  });

  it("pins trailer-specific fields incl. the SF-synced misspelling", () => {
    const keys = trailerFields.map((f) => f.key);
    expect(keys).toContain("full_vin");
    expect(keys).toContain("completetion_percentage"); // preserves SF spelling
    expect(keys).toContain("total_repair_cost");
    expect(keys).not.toContain("total_sales"); // truck-only
    expect(keys).not.toContain("shop"); // truck-only
  });
});

describe("list views", () => {
  it("has the truck + trailer views", () => {
    expect(listViewsForObject("truck").map((v) => v.slug)).toEqual(["all", "livingston", "sparta"]);
    expect(listViewsForObject("trailer").map((v) => v.slug)).toEqual(["trailers", "wip"]);
    expect(LIST_VIEWS).toHaveLength(5);
    expect(getListView("truck", "livingston")?.locationFilter).toEqual({ field: "shop", op: "eq", value: "Livingston" });
  });

  it("resolveStatus guards a crafted param to a real option", () => {
    const all = getListView("truck", "all")!;
    expect(resolveStatus(all, "Estimating")).toBe("Estimating");
    expect(resolveStatus(all, "not-a-status")).toBeNull();
  });

  it("resolveSort falls back to the view default and guards field ∈ columns", () => {
    const all = getListView("truck", "all")!;
    expect(resolveSort(all, "status", "asc")).toEqual({ field: "status", dir: "asc" });
    expect(resolveSort(all, "not_a_column", "asc")).toEqual(all.defaultSort);
  });

  it("WIP builds its static composite filter; status view builds active-mode filters", () => {
    const wip = getListView("trailer", "wip")!;
    const wdef = listViewDefinition(wip, wip.defaultSort);
    expect(wdef.filterLogic).toBe("1 AND 2 AND (3 OR 4)");
    const all = getListView("truck", "all")!;
    const adef = listViewDefinition(all, all.defaultSort, null);
    // default "All active": neq per terminal + isNull(status), OR-grouped
    expect(adef.filters.some((f) => f.op === "isNull" && f.field === "status")).toBe(true);
    expect(adef.filterLogic).toContain("OR");
  });
});
