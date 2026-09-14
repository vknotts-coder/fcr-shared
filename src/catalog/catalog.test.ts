import { describe, it, expect } from "vitest";
import { truckObject, truckFields } from "./truck.js";
import { trailerObject, trailerFields } from "./trailer.js";
import { LIST_VIEWS, getListView, listViewsForObject, resolveSort, resolveStatus, listViewDefinition } from "./listviews.js";
import { toClientObject } from "../reports/registry-core.js";
import { validateDefinition } from "../reports/definition.js";
import type { Principal } from "../contracts/index.js";

// Faithfulness pins for the catalog lifted from fcr-dispatch (#107 Slice 1). If a future edit changes the
// fcr_core schema coupling, these fail loudly rather than silently drifting a shared source of truth.

const allow = (_p: Principal) => true;
const deny = (_p: Principal) => false;
const p = {} as Principal;

// An all-access principal so toClientObject offers every field (sensitive included) — used to validate that
// each list view's definition is actually RUNNABLE for a viewer, not just shaped right.
const admin: Principal = {
  username: "admin",
  accountId: "00000000-0000-0000-0000-0000000000ad",
  grants: [
    { roleId: "", resourceType: "*", action: "admin", section: null, field: null, scope: "all", effect: "allow", departmentId: null, shopId: null },
    { roleId: "", resourceType: "*", action: "view", section: null, field: null, scope: "all", effect: "allow", departmentId: null, shopId: null },
  ],
};

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

  it("adds the repair-pipeline parity fields, incl. the computed day-counts (expr, no path)", () => {
    const byKey = new Map(trailerFields.map((f) => [f.key, f]));
    expect(byKey.get("type")?.path).toBe("type");
    expect(byKey.get("invoice_1")?.path).toBe("invoice_1");
    expect(byKey.get("fcr_collision_account")?.path).toBe("fcr_collision_account");
    // computed: expr set, path absent, number type, filterable (past_due filters on it), not summable
    const dpd = byKey.get("days_past_due")!;
    expect(dpd.expr).toContain("invoice_paid_date IS NULL");
    expect(dpd.path).toBeUndefined();
    expect(dpd.type).toBe("number");
    expect(dpd.filterable).toBe(true);
    expect(dpd.summable).toBe(false);
    expect(byKey.get("days_in_status")?.expr).toContain("status_date");
    expect(byKey.get("days_in_status")?.path).toBeUndefined();
  });

  it("surfaces the SF report-parity columns (#26) with correct types", () => {
    const byKey = new Map(trailerFields.map((f) => [f.key, f]));
    // A representative sample across the added set — existence + type/backing.
    for (const k of [
      "estimate_start_date", "estimate_completed_date", "estimate_finalized", "actual_hours",
      "anticipated_arrival_date", "invoice_2", "invoice_notes", "po",
      "delivery_address", "delivery_zip_code", "delivery_dispatch_date", "delivery_date",
      "pickup_address", "pickup_zip_code", "rework", "rework_date", "rework_end_date",
      "rework_notes", "total_loss_decided_at", "fcr_collision_contact",
    ]) {
      expect(byKey.has(k), `missing catalog field ${k}`).toBe(true);
    }
    expect(byKey.get("actual_hours")?.type).toBe("number");
    expect(byKey.get("rework")?.type).toBe("boolean");
    // total_loss_decided_at is a timestamptz surfaced as a local-date field (dateTz), like created_at.
    expect(byKey.get("total_loss_decided_at")?.type).toBe("date");
    expect(byKey.get("total_loss_decided_at")?.dateTz).toBe(true);
    // plain date columns are NOT dateTz
    expect(byKey.get("delivery_date")?.dateTz).toBeUndefined();
    // each is a real column (path defaults to key), not a computed expr
    expect(byKey.get("invoice_2")?.path).toBe("invoice_2");
    expect(byKey.get("delivery_date")?.expr).toBeUndefined();
  });

  it("adds the computed turn-time durations (#26 Ship 3) — expr, no path, number; only the completed-only span is summable", () => {
    const byKey = new Map(trailerFields.map((f) => [f.key, f]));
    for (const k of [
      "notification_to_arrival_duration", "approved_to_complete_duration", "repair_in_progress_duration",
      "repair_completion_to_delivery_duration", "pickup_to_delivery", "estimate_start_to_complete_duration",
    ]) {
      const f = byKey.get(k)!;
      expect(f, `missing ${k}`).toBeDefined();
      expect(f.type).toBe("number");
      expect(f.expr, `${k} should be a computed expr`).toBeTruthy();
      expect(f.path, `${k} is computed, no path`).toBeUndefined();
    }
    // Only the completed-only span is summable — the five open-inclusive (COALESCE-to-today) durations are
    // display-only, so an AVG can't silently blend in-progress rows / drift daily.
    for (const k of ["notification_to_arrival_duration", "approved_to_complete_duration", "repair_in_progress_duration", "repair_completion_to_delivery_duration", "pickup_to_delivery"]) {
      expect(byKey.get(k)!.summable, `${k} open-inclusive → NOT summable`).toBe(false);
      expect(byKey.get(k)!.expr, `${k} is now()-relative`).toContain("now()");
    }
    expect(byKey.get("estimate_start_to_complete_duration")!.summable, "completed-only span is summable").toBe(true);
    // faithfulness pins: the SF `IF(ISBLANK(end), TODAY()-start, end-start)` shape → COALESCE(end, tz-today) - start
    expect(byKey.get("repair_in_progress_duration")!.expr).toContain("COALESCE(trailer.repair_completion_date");
    expect(byKey.get("repair_in_progress_duration")!.expr).toContain("- trailer.repair_start_date");
    // pickup_to_delivery is NULL when there is no arrival (SF returns NULL, not an elapsed count)
    expect(byKey.get("pickup_to_delivery")!.expr).toContain("WHEN trailer.arrival_date IS NULL THEN NULL");
    // estimate_start_to_complete has no TODAY() branch — a plain span
    expect(byKey.get("estimate_start_to_complete_duration")!.expr).not.toContain("now()");
  });

  it("a definition referencing the new fields VALIDATES for a viewer", () => {
    const client = toClientObject(trailerObject({ capability: allow }), admin);
    const def = {
      object: "trailer",
      columns: ["sf_name", "status", "delivery_date", "actual_hours", "invoice_2", "rework"],
      filters: [
        { field: "delivery_date", op: "gte", value: "2026-01-01" },
        { field: "delivery_date", op: "lt", value: "2027-01-01" },
        { field: "rework", op: "eq", value: "true" },
      ],
      filterLogic: "1 AND 2 AND 3",
      summaries: [],
      sort: { field: "delivery_date", dir: "desc" },
    };
    const res = validateDefinition(def, client);
    expect(res.ok, res.ok ? "" : res.errors.join("; ")).toBe(true);
  });
});

describe("list views", () => {
  it("has the truck + trailer views", () => {
    expect(listViewsForObject("truck").map((v) => v.slug)).toEqual(["all", "livingston", "sparta"]);
    expect(listViewsForObject("trailer").map((v) => v.slug)).toEqual(["trailers", "scheduling", "wip", "to_invoice", "past_due"]);
    expect(LIST_VIEWS).toHaveLength(8);
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

  it("the new trailer preset views build the right static filters (OR'd eq — the engine has no `in`)", () => {
    const pd = listViewDefinition(getListView("trailer", "past_due")!, getListView("trailer", "past_due")!.defaultSort);
    expect(pd.filters).toEqual([{ field: "days_past_due", op: "gte", value: "30" }]);

    const ti = getListView("trailer", "to_invoice")!;
    const tidef = listViewDefinition(ti, ti.defaultSort);
    expect(tidef.filters).toEqual([
      { field: "status", op: "eq", value: "Delivered" },
      { field: "status", op: "eq", value: "Total Loss" },
      { field: "status", op: "eq", value: "Do Not Repair" },
      { field: "invoice_1", op: "isNull" },
    ]);
    expect(tidef.filterLogic).toBe("(1 OR 2 OR 3) AND 4");

    const sc = getListView("trailer", "scheduling")!;
    const scdef = listViewDefinition(sc, sc.defaultSort);
    expect(scdef.filters).toEqual([
      { field: "status", op: "eq", value: "Approved" },
      { field: "status", op: "eq", value: "Awaiting Parts" },
      { field: "status", op: "eq", value: "Parts Received" },
    ]);
    expect(scdef.filterLogic).toBe("(1 OR 2 OR 3)");
  });

  // The contract that actually matters: every list view's definition must VALIDATE for a viewer (offered
  // fields, legal operators, sort ∈ columns) — this is the gate that catches an illegal op / off-catalog
  // field, which a raw `.filters` deep-equal does NOT. (The `in`-operator break shipped past shape tests.)
  it("EVERY list view produces a definition that validateDefinition accepts", () => {
    const objFor = (o: string) => (o === "truck" ? truckObject({ capability: allow }) : trailerObject({ capability: allow }));
    for (const view of LIST_VIEWS) {
      const client = toClientObject(objFor(view.object), admin);
      const modes = view.statusSelect
        ? [null, view.statusSelect.options[0] ?? null] // default 'active' AND a picked status
        : [null];
      for (const status of modes) {
        const def = listViewDefinition(view, view.defaultSort, status);
        const res = validateDefinition(def, client);
        expect(res.ok, `${view.object}/${view.slug} (status=${status ?? "active"}): ${res.ok ? "" : res.errors.join("; ")}`).toBe(true);
      }
    }
  });
});
