import { describe, it, expect } from "vitest";
import type { Queryable } from "../rbac/index.js";
import {
  coerceTruckPartField,
  parseTruckParts,
  isEmptyTruckPartRecord,
  validateTruckPartLengths,
  TRUCK_PART_EDITABLE_COLUMNS,
} from "./fields.js";
import { createTruckBackorderPart, updateTruckBackorderPart } from "./index.js";

const ACTOR = { username: "fred", name: "Fred Wright" };
const TRUCK_ID = "11111111-1111-4111-8111-111111111111";
const TRUCK_SF = "a0X000000TRUCK01";
const PART_ID = "22222222-2222-4222-8222-222222222222";

function fd(obj: Record<string, string>): FormData {
  const f = new FormData();
  for (const [k, v] of Object.entries(obj)) f.set(k, v);
  return f;
}

interface Call { text: string; params: unknown[]; }

// Fake Queryable routed by SQL text: truck lookup, part before-image, and the gated write.
function fakeDb(opts: {
  truck?: { sf_id: string | null } | null;
  before?: Record<string, unknown> | null;
  writeAffectsRow?: boolean;
} = {}) {
  const { truck = { sf_id: TRUCK_SF }, before = null, writeAffectsRow = true } = opts;
  const calls: Call[] = [];
  const db: Queryable = {
    async query<T>(text: string, params: unknown[] = []) {
      calls.push({ text, params });
      if (text.includes("FROM fcr_core.truck WHERE id")) {
        return { rows: (truck ? [{ id: TRUCK_ID, sf_id: truck.sf_id, sf_name: "Truck 01" }] : []) as T[] };
      }
      if (text.includes("FROM fcr_core.truck_backorder_part")) { // the before-image SELECT
        return { rows: (before ? [{ id: PART_ID, __guard: "2026-11-17T00:00:00.000Z", unit_number: TRUCK_SF, ...before }] : []) as T[] };
      }
      // the gated INSERT/UPDATE wrapped by commitWithEvent → event rows exist iff the mutation hit a row
      return { rows: (writeAffectsRow ? [{ "?column?": 1 }] : []) as T[] };
    },
  };
  return { db, calls };
}

describe("truck parts — field coercion", () => {
  it("dates accept YYYY-MM-DD only, else null; blank → null", () => {
    expect(coerceTruckPartField("estimated_arrival_date", "2026-12-01")).toBe("2026-12-01");
    expect(coerceTruckPartField("estimated_arrival_date", "12/01/2026")).toBeNull();
    expect(coerceTruckPartField("all_parts_received_date", "")).toBeNull();
  });
  it("rejects a format-valid but CALENDAR-INVALID date (no raw Postgres 22007/22008)", () => {
    expect(coerceTruckPartField("estimated_arrival_date", "2026-02-30")).toBeNull(); // Feb 30 — JS would roll over
    expect(coerceTruckPartField("estimated_arrival_date", "2026-13-01")).toBeNull(); // month out of range
    expect(coerceTruckPartField("estimated_arrival_date", "2026-00-10")).toBeNull(); // month 0
    expect(coerceTruckPartField("all_parts_received_date", "2026-02-28")).toBe("2026-02-28"); // real date still passes
  });
  it("parts_in_stock_yes_no is restricted to {Yes,No}, else null (no off-domain reverse-sync)", () => {
    expect(coerceTruckPartField("parts_in_stock_yes_no", "Yes")).toBe("Yes");
    expect(coerceTruckPartField("parts_in_stock_yes_no", "No")).toBe("No");
    expect(coerceTruckPartField("parts_in_stock_yes_no", "maybe")).toBeNull();
    expect(coerceTruckPartField("parts_in_stock_yes_no", "")).toBeNull();
  });
  it("plain fields trim; blank → null", () => {
    expect(coerceTruckPartField("po_number", "  P123  ")).toBe("P123");
    expect(coerceTruckPartField("part_1", "")).toBeNull();
  });
  it("parseTruckParts includes only PRESENT fields; present-empty coerces to null", () => {
    const parsed = parseTruckParts(fd({ part_1: "ALT-1", po_number: "" }));
    expect(parsed).toEqual({ part_1: "ALT-1", po_number: null });
    expect("estimated_arrival_date" in parsed).toBe(false); // absent stays untouched
  });
  it("isEmptyTruckPartRecord true only when no part and no PO", () => {
    expect(isEmptyTruckPartRecord({})).toBe(true);
    expect(isEmptyTruckPartRecord({ paragon_number: "X" })).toBe(true); // paragon alone is still empty
    expect(isEmptyTruckPartRecord({ part_1: "ALT-1" })).toBe(false);
    expect(isEmptyTruckPartRecord({ po_number: "P1" })).toBe(false);
  });
  it("validateTruckPartLengths catches over-long values before they hit Postgres (the varchar(16) 22001 trap)", () => {
    expect(validateTruckPartLengths({ part_1: "ALT-1" })).toEqual([]);
    expect(validateTruckPartLengths({ part_1: "X".repeat(16) })).toEqual([]); // exactly at the cap is fine
    const errs = validateTruckPartLengths({ part_1: "X".repeat(17), po_number: "Y".repeat(21) });
    expect(errs.map((e) => e.field).sort()).toEqual(["part_1", "po_number"]);
    expect(errs[0].message).toMatch(/too long \(max \d+/);
  });
});

describe("createTruckBackorderPart — length guard", () => {
  it("rejects an over-long part number with a friendly field error (no raw 22001)", async () => {
    const { db, calls } = fakeDb({});
    const r = await createTruckBackorderPart(db, TRUCK_ID, fd({ part_1: "X".repeat(20) }), ACTOR);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.errors[0].field).toBe("part_1");
      expect(r.errors[0].message).toMatch(/too long/);
    }
    expect(calls.some((c) => c.text.includes("INSERT INTO fcr_core.truck_backorder_part"))).toBe(false);
  });
});

describe("createTruckBackorderPart", () => {
  it("rejects a missing truck", async () => {
    const { db } = fakeDb({ truck: null });
    const r = await createTruckBackorderPart(db, TRUCK_ID, fd({ part_1: "ALT-1" }), ACTOR);
    expect(r).toEqual({ ok: false, errors: [{ field: null, message: "Truck not found." }] });
  });
  it("rejects a truck with no sf_id (can't link an unsynced parent)", async () => {
    const { db } = fakeDb({ truck: { sf_id: null } });
    const r = await createTruckBackorderPart(db, TRUCK_ID, fd({ part_1: "ALT-1" }), ACTOR);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors[0].message).toMatch(/hasn't synced to Salesforce/);
  });
  it("rejects an empty shell (no part, no PO)", async () => {
    const { db } = fakeDb({});
    const r = await createTruckBackorderPart(db, TRUCK_ID, fd({ paragon_number: "P9" }), ACTOR);
    expect(r.ok).toBe(false);
  });
  it("inserts linked to the truck sf_id, sets created_by, and does NOT set sf_name (SF-assigned)", async () => {
    const { db, calls } = fakeDb({});
    const r = await createTruckBackorderPart(db, TRUCK_ID, fd({ part_1: "ALT-1", po_number: "P123" }), ACTOR);
    expect(r).toEqual({ ok: true, id: expect.any(String) });
    const write = calls.find((c) => c.text.includes("INSERT INTO fcr_core.truck_backorder_part"))!;
    expect(write.text).toContain("unit_number");
    expect(write.text).not.toContain("sf_name"); // left for SF to assign
    expect(write.params).toContain(TRUCK_SF);   // unit_number = parent truck sf_id
    expect(write.params).toContain("fred");     // created_by = actor.username
  });
});

describe("updateTruckBackorderPart", () => {
  const before = { part_1: "ALT-1", part_1_description: "Alternator", part_2: null, part_2_description: null, po_number: "P-OLD", fcr_order_tolas: null, paragon_number: null, parts_in_stock_yes_no: null, estimated_arrival_date: null, all_parts_received_date: null };

  it("IDOR guard: a part not under this truck is 'not found'", async () => {
    const { db } = fakeDb({ before: null }); // loadPartForTruck returns nothing
    const r = await updateTruckBackorderPart(db, PART_ID, TRUCK_ID, fd({ po_number: "P-NEW" }), ACTOR);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors[0].message).toMatch(/not found/);
  });

  it("no-op edit (no changed fields) writes nothing and returns ok", async () => {
    const { db, calls } = fakeDb({ before });
    const r = await updateTruckBackorderPart(db, PART_ID, TRUCK_ID, fd({ po_number: "P-OLD" }), ACTOR);
    expect(r).toEqual({ ok: true, id: PART_ID });
    expect(calls.some((c) => c.text.includes("UPDATE fcr_core.truck_backorder_part"))).toBe(false);
  });

  it("stamps local_edit_at + only the changed column into dispatch_dirty_cols", async () => {
    const { db, calls } = fakeDb({ before });
    const r = await updateTruckBackorderPart(db, PART_ID, TRUCK_ID, fd({ po_number: "P-NEW" }), ACTOR);
    expect(r).toEqual({ ok: true, id: PART_ID });
    const write = calls.find((c) => c.text.includes("UPDATE fcr_core.truck_backorder_part"))!;
    expect(write.text).toContain("local_edit_at = NOW()");
    expect(write.text).toContain("dispatch_dirty_cols = ARRAY(SELECT DISTINCT unnest");
    expect(write.params).toContainEqual(["po_number"]); // the dirty-cols text[] param = only what changed
  });

  it("rejects an edit that would EMPTY the record (clears every part + PO) → no reverse-synced empty shell", async () => {
    const { db, calls } = fakeDb({ before });
    // before = { part_1: "ALT-1", part_2: null, po_number: "P-OLD", ... }; clear all three.
    const r = await updateTruckBackorderPart(db, PART_ID, TRUCK_ID, fd({ part_1: "", part_2: "", po_number: "" }), ACTOR);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors[0].message).toMatch(/at least one part number or a PO/);
    expect(calls.some((c) => c.text.includes("UPDATE fcr_core.truck_backorder_part"))).toBe(false);
  });

  it("optimistic conflict: zero-row write → 'changed by someone else'", async () => {
    const { db } = fakeDb({ before, writeAffectsRow: false });
    const r = await updateTruckBackorderPart(db, PART_ID, TRUCK_ID, fd({ po_number: "P-NEW" }), ACTOR);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors[0].message).toMatch(/changed by someone else/);
  });
});

it("TRUCK_PART_EDITABLE_COLUMNS matches the fcr-dispatch PARTS_EDIT_COLS[truck_backorder_part] set", () => {
  // Guard against drift: the app-side editable set MUST equal the reverse-sync field-scoped set, or an edit
  // either won't push (missing from reverse-sync) or will dirty a column the push ignores.
  expect([...TRUCK_PART_EDITABLE_COLUMNS].sort()).toEqual([
    "all_parts_received_date", "estimated_arrival_date", "fcr_order_tolas",
    "paragon_number", "part_1", "part_1_description", "part_2", "part_2_description",
    "parts_in_stock_yes_no", "po_number",
  ]);
});
