import { describe, it, expect } from "vitest";
import { createUnit, findDuplicates } from "./pipeline.js";
import { applyTrailerStatusEngine, trailerSpec } from "./specs/trailer.js";
import { applyTruckStatusEngine, truckSpec } from "./specs/truck.js";
import type { Queryable } from "../rbac/index.js";

// A programmable fake Queryable: hand it a handler that returns rows (+ optional rowCount) per
// call, and it records every (text, params) so a test can assert the exact SQL/params issued.
function fakeDb(handler: (text: string, params: unknown[]) => { rows: unknown[]; rowCount?: number }): {
  db: Queryable;
  calls: { text: string; params: unknown[] }[];
} {
  const calls: { text: string; params: unknown[] }[] = [];
  const db: Queryable = {
    async query<T = unknown>(text: string, params: unknown[] = []) {
      calls.push({ text, params });
      const r = handler(text, params);
      return { rows: r.rows as T[], ...(r.rowCount != null ? { rowCount: r.rowCount } : {}) } as { rows: T[] };
    },
  };
  return { db, calls };
}

const TODAY = "2026-09-15";
const form = (obj: Record<string, string>): FormData => {
  const fd = new FormData();
  for (const [k, v] of Object.entries(obj)) fd.set(k, v);
  return fd;
};

describe("trailer status engine (create seed)", () => {
  it("customer drop off → Received", () => {
    const r = applyTrailerStatusEngine({}, { pickup_driver: "CUSTOMER DROP OFF" }, { isNew: true, today: TODAY });
    expect(r.derived.status).toBe("Received");
    expect(r.derived.status_date).toBe(TODAY);
  });
  it("has a pickup address → Awaiting Pickup", () => {
    const r = applyTrailerStatusEngine({}, { pickup_city: "Sparta" }, { isNew: true, today: TODAY });
    expect(r.derived.status).toBe("Awaiting Pickup");
  });
  it("nothing → Awaiting Pickup Info, notify_date seeded", () => {
    const r = applyTrailerStatusEngine({}, {}, { isNew: true, today: TODAY });
    expect(r.derived.status).toBe("Awaiting Pickup Info");
    expect(r.derived.notify_date).toBe(TODAY);
    expect(r.emails).toContain("FCR_Trailers_Awaiting_Pickup");
  });
  it("date-driven advance wins on edit (arrival_date → Received)", () => {
    const r = applyTrailerStatusEngine({ status: "Awaiting Pickup" }, { arrival_date: TODAY }, { today: TODAY });
    expect(r.derived.status).toBe("Received");
    expect(r.derived.status_date).toBe(TODAY);
  });
  it("rework pick renames the unit and sets REWORK", () => {
    const r = applyTrailerStatusEngine({ status: "Repair Complete", sf_name: "T-100" }, { status: "REWORK" }, { today: TODAY });
    expect(r.derived.status).toBe("REWORK");
    expect(r.derived.sf_name).toBe("T-100 - REWORK");
  });
});

describe("truck status engine (create seed)", () => {
  it("customer drop off mode → Customer Drop Off", () => {
    const r = applyTruckStatusEngine({}, { pickup_tow_drive: "Customer Drop Off" }, { isNew: true, today: TODAY });
    expect(r.derived.status).toBe("Customer Drop Off");
    expect(r.derived.status_date).toBe(TODAY);
  });
  it("pickup address → Awaiting Pickup; else Awaiting Pickup Info", () => {
    expect(applyTruckStatusEngine({}, { pickup_city: "Livingston" }, { isNew: true, today: TODAY }).derived.status).toBe("Awaiting Pickup");
    expect(applyTruckStatusEngine({}, {}, { isNew: true, today: TODAY }).derived.status).toBe("Awaiting Pickup Info");
  });
  it("an explicit status pick is not overridden by the seed", () => {
    const r = applyTruckStatusEngine({}, { status: "Awaiting Pickup", pickup_city: "" }, { isNew: true, today: TODAY });
    expect(r.derived.status).toBeUndefined(); // user's pick stands; engine doesn't seed over it
  });
});

describe("dedupe guard", () => {
  it("finds a VIN match across both unit tables", async () => {
    const { db, calls } = fakeDb((text) => {
      if (text.includes("fcr_core.truck") && text.includes("vin")) return { rows: [{ id: "11111111-1111-1111-1111-111111111111", sf_name: "TRK-9" }] };
      return { rows: [] };
    });
    const hits = await findDuplicates(trailerSpec, { full_vin: "1hgcm82633a", sf_name: "NEW" }, db);
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ unitType: "truck", matchedOn: "vin", sfName: "TRK-9" });
    // VIN is matched upper-cased against both tables.
    expect(calls.some((c) => c.params[0] === "1HGCM82633A")).toBe(true);
  });
  it("no VIN and no name → no hits, no queries", async () => {
    const { db, calls } = fakeDb(() => ({ rows: [] }));
    const hits = await findDuplicates(truckSpec, {}, db);
    expect(hits).toEqual([]);
    expect(calls).toHaveLength(0);
  });
});

describe("createUnit", () => {
  it("short-circuits on a duplicate VIN (no INSERT)", async () => {
    const { db, calls } = fakeDb((text) => {
      if (text.startsWith("SELECT 1")) return { rows: [{ "?column?": 1 }] }; // reference check passes
      if (text.includes("full_vin")) return { rows: [{ id: "22222222-2222-2222-2222-222222222222", sf_name: "DUP" }] };
      return { rows: [] };
    });
    const res = await createUnit(
      trailerSpec,
      form({ sf_name: "NEW-1", fcr_collision_account: "a", fcr_collision_contact: "c", full_vin: "ABC123" }),
      { username: "vknotts", name: "Van" },
      db,
    );
    expect(res.ok).toBe(false);
    if (!res.ok && "duplicates" in res) expect(res.duplicates[0].sfName).toBe("DUP");
    expect(calls.some((c) => c.text.includes("INSERT INTO fcr_core.trailer"))).toBe(false);
  });

  it("confirmDuplicate bypasses dedupe and INSERTs, engine-derived status included", async () => {
    const { db, calls } = fakeDb((text) => {
      if (text.startsWith("SELECT 1")) return { rows: [{ "?column?": 1 }] };
      return { rows: [], rowCount: 1 };
    });
    const res = await createUnit(
      trailerSpec,
      form({ sf_name: "NEW-2", fcr_collision_account: "a", fcr_collision_contact: "c", pickup_city: "Sparta" }),
      { username: "vknotts", name: "Van" },
      db,
      { confirmDuplicate: true },
    );
    expect(res.ok).toBe(true);
    const insert = calls.find((c) => c.text.includes("INSERT INTO fcr_core.trailer"));
    expect(insert).toBeDefined();
    // The engine seeded "Awaiting Pickup" (pickup address present) — the INSERT carries it.
    expect(insert!.params).toContain("Awaiting Pickup");
    expect(insert!.text).toContain("created_at, updated_at");
  });

  it("reference existence check filters soft-deleted rows (deleted_at IS NULL) and blocks on not-found", async () => {
    const { db, calls } = fakeDb((text) => {
      // Reference SELECT returns no rows (row is soft-deleted / absent) → reference not found.
      if (text.startsWith("SELECT 1")) return { rows: [] };
      return { rows: [], rowCount: 1 };
    });
    const res = await createUnit(
      trailerSpec,
      form({ sf_name: "NEW-3", fcr_collision_account: "gone", fcr_collision_contact: "c" }),
      { username: "vknotts", name: "Van" },
      db,
    );
    expect(res.ok).toBe(false);
    if (!res.ok && "errors" in res) {
      expect(res.errors.map((e) => e.field)).toContain("fcr_collision_account");
    }
    // The fix: the reference query must exclude soft-deleted rows.
    const refCall = calls.find((c) => c.text.startsWith("SELECT 1"));
    expect(refCall?.text).toContain("deleted_at IS NULL");
    expect(calls.some((c) => c.text.includes("INSERT INTO"))).toBe(false);
  });

  it("blocks a create missing the required account/contact (no INSERT)", async () => {
    const { db, calls } = fakeDb(() => ({ rows: [], rowCount: 1 }));
    const res = await createUnit(truckSpec, form({ sf_name: "T-1" }), { username: "vknotts", name: "Van" }, db);
    expect(res.ok).toBe(false);
    if (!res.ok && "errors" in res) {
      expect(res.errors.map((e) => e.field)).toContain("fcr_collision_customer");
    }
    expect(calls.some((c) => c.text.includes("INSERT INTO"))).toBe(false);
  });
});
