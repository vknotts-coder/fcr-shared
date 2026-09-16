import { describe, it, expect } from "vitest";
import { createUnit, findDuplicates } from "./pipeline.js";
import { coerceField, parseEdits } from "./coerce.js";
import {
  applyTrailerStatusEngine,
  validateTrailer,
  trailerSpec,
  TRAILER_NUMERIC_COLS,
  TRAILER_DATE_COLS,
  TRAILER_BOOL_COLS,
} from "./specs/trailer.js";
import { applyTruckStatusEngine, validateTruck, truckSpec } from "./specs/truck.js";
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

describe("VIN length validation (varchar 17 — no 500)", () => {
  it("trailer: an 18-char full_vin is rejected; 17 passes", () => {
    const over = validateTrailer({ full_vin: "VANPICKERVERIFYVIN" /* 18 */ }, { isNew: false });
    expect(over.some((e) => e.field === "full_vin")).toBe(true);
    // negative control: exactly 17 chars is accepted (no VIN error)
    const ok = validateTrailer({ full_vin: "1GR1A0625ME306619" /* 17 */ }, { isNew: false });
    expect(ok.some((e) => e.field === "full_vin")).toBe(false);
  });
  it("truck: an 18-char vin is rejected; 17 passes", () => {
    const over = validateTruck({ vin: "VANPICKERVERIFYVIN" /* 18 */ }, { isNew: false });
    expect(over.some((e) => e.field === "vin")).toBe(true);
    const ok = validateTruck({ vin: "1HGCM82633A00PICK" /* 17 */ }, { isNew: false });
    expect(ok.some((e) => e.field === "vin")).toBe(false);
  });
  it("createUnit blocks an over-length VIN before the INSERT (no 500)", async () => {
    const { db, calls } = fakeDb((text) => {
      if (text.startsWith("SELECT 1")) return { rows: [{ "?column?": 1 }] };
      return { rows: [], rowCount: 1 };
    });
    const res = await createUnit(
      trailerSpec,
      form({ sf_name: "N", fcr_collision_account: "a", fcr_collision_contact: "c", full_vin: "VANPICKERVERIFYVIN" }),
      { username: "vknotts", name: "Van" },
      db,
      { confirmDuplicate: true },
    );
    expect(res.ok).toBe(false);
    if (!res.ok && "errors" in res) expect(res.errors.map((e) => e.field)).toContain("full_vin");
    expect(calls.some((c) => c.text.includes("INSERT INTO"))).toBe(false);
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

// ── SF-parity fields now editable (fcr-trailers epic #4, slice 3 Piece B) ──────────
// The 8 fields fcr_core gained in fcr-dispatch#88 (Piece A rendered them read-only) are now in
// the editable form set + coerced/synced like the rest of the trailer app.
describe("trailer SF-parity fields — editable (Piece B)", () => {
  const EIGHT = [
    "parts_notes", "invoice_2", "invoicing_contact", "invoice_notes",
    "rework", "rework_date", "rework_start_date", "rework_end_date",
  ];

  it("all 8 are in the editable form spec, in their SF page-layout sections", () => {
    const bySection = new Map(trailerSpec.formFields.map((f) => [f.column, f.section]));
    for (const c of EIGHT) expect(bySection.has(c)).toBe(true);
    expect(bySection.get("parts_notes")).toBe("parts");
    expect(bySection.get("invoice_2")).toBe("invoice");
    expect(bySection.get("invoicing_contact")).toBe("invoice");
    expect(bySection.get("invoice_notes")).toBe("invoice");
    for (const c of ["rework", "rework_date", "rework_start_date", "rework_end_date"]) {
      expect(bySection.get(c)).toBe("rework");
    }
  });

  it("rework is a real boolean: Yes→true, No→false, blank→null (not the string 'Yes')", () => {
    const c = (raw: string) => coerceField("rework", raw, TRAILER_NUMERIC_COLS, TRAILER_DATE_COLS, TRAILER_BOOL_COLS);
    expect(c("Yes")).toBe(true);
    expect(c("No")).toBe(false);
    expect(c("")).toBe(null);
    expect(c("true")).toBe(true);
    // Guard the whole point of boolCols: without it, "Yes" would bind as text into a boolean column.
    expect(coerceField("rework", "Yes", TRAILER_NUMERIC_COLS, TRAILER_DATE_COLS)).toBe("Yes");
  });

  it("parseEdits coerces the 8 per type (rework→bool, rework dates→date, notes→text)", () => {
    const edits = parseEdits(
      form({
        rework: "Yes",
        rework_date: "2026-09-10",
        rework_start_date: "2026-09-11",
        rework_end_date: "2026-09-12",
        invoice_2: "INV-2",
        invoicing_contact: "Jane Doe",
        invoice_notes: "swap billing",
        parts_notes: "waiting on axle",
      }),
      trailerSpec.formFields,
      trailerSpec.numericCols,
      trailerSpec.dateCols,
      trailerSpec.boolCols,
    );
    expect(edits.rework).toBe(true);
    expect(edits.rework_date).toBe("2026-09-10");
    expect(edits.rework_start_date).toBe("2026-09-11");
    expect(edits.invoice_2).toBe("INV-2");
    expect(edits.invoicing_contact).toBe("Jane Doe");
    expect(edits.parts_notes).toBe("waiting on axle");
  });

  it("engine stamps Invoice Date when Invoice #2 is first entered (SF keys off both invoices)", () => {
    // invoice_1 already set (so its clause can't be what fires); invoice_2 newly entered.
    const r = applyTrailerStatusEngine(
      { status: "Approved", invoice_1: "INV-1" },
      { invoice_2: "INV-2" },
      { today: TODAY },
    );
    expect(r.derived.invoice_date).toBe(TODAY);
  });

  it("engine does NOT re-stamp Invoice Date when one already exists", () => {
    const r = applyTrailerStatusEngine(
      { status: "Approved", invoice_date: "2026-01-01" },
      { invoice_2: "INV-2" },
      { today: TODAY },
    );
    expect(r.derived.invoice_date).toBeUndefined();
  });
});

// ── Rework coupling — bidirectional + auto-date (SCOPE §924, Van 2026-09-16) ────────
describe("trailer rework coupling — checkbox ↔ REWORK status", () => {
  it("ticking rework=Yes advances status→REWORK, sets rework + rework_date + status_date + name", () => {
    const r = applyTrailerStatusEngine(
      { status: "Repair in Progress", sf_name: "T-200", rework: false },
      { rework: true },
      { today: TODAY },
    );
    expect(r.derived.status).toBe("REWORK");
    expect(r.derived.rework).toBe(true);
    expect(r.derived.rework_date).toBe(TODAY);
    expect(r.derived.status_date).toBe(TODAY);
    expect(r.derived.sf_name).toBe("T-200 - REWORK");
  });

  it("picking status REWORK also sets the rework checkbox + rework_date (the other direction)", () => {
    const r = applyTrailerStatusEngine(
      { status: "Repair Complete", sf_name: "T-201" },
      { status: "REWORK" },
      { today: TODAY },
    );
    expect(r.derived.status).toBe("REWORK");
    expect(r.derived.rework).toBe(true);
    expect(r.derived.rework_date).toBe(TODAY);
  });

  it("does not overwrite an existing rework_date", () => {
    const r = applyTrailerStatusEngine(
      { status: "Repair in Progress", rework: false, rework_date: "2026-01-01" },
      { rework: true },
      { today: TODAY },
    );
    expect(r.derived.status).toBe("REWORK");
    expect(r.derived.rework_date).toBeUndefined(); // before already had one → not re-stamped
  });

  it("no churn when rework is already on", () => {
    const r = applyTrailerStatusEngine(
      { status: "REWORK", rework: true, sf_name: "T-202 - REWORK" },
      { rework: true },
      { today: TODAY },
    );
    expect(r.derived.status).toBeUndefined();
    expect(r.derived.rework).toBeUndefined();
    expect(r.derived.sf_name).toBeUndefined();
  });

  it("a non-REWORK status change does not force rework on", () => {
    const r = applyTrailerStatusEngine(
      { status: "Approved", rework: false },
      { status: "Repair in Progress" },
      { today: TODAY },
    );
    expect(r.derived.rework).toBeUndefined();
  });

  // Regression (review #18): rework turn-on is TERMINAL — the Awaiting-Customer-Pickup remap must
  // not clobber status back off REWORK while rework stays true.
  it("ticking rework wins over the Awaiting-Customer-Pickup remap (status stays REWORK)", () => {
    const r = applyTrailerStatusEngine(
      { status: "Awaiting Delivery", delivery_driver: "CUSTOMER PICKUP", rework: false, sf_name: "T-300" },
      { rework: true },
      { today: TODAY },
    );
    expect(r.derived.status).toBe("REWORK");
    expect(r.derived.rework).toBe(true);
  });

  // Regression (review #18): re-ticking rework on a unit already in REWORK must not re-stamp
  // status_date or report a phantom status change.
  it("no status_date churn when already in REWORK", () => {
    const r = applyTrailerStatusEngine(
      { status: "REWORK", rework: false },
      { rework: true },
      { today: TODAY },
    );
    expect(r.derived.rework).toBe(true); // the checkbox value is still applied
    expect(r.derived.status).toBeUndefined(); // no phantom status change
    expect(r.derived.status_date).toBeUndefined(); // not re-stamped
    expect(r.statusChanged).toBe(false);
  });

  // Regression (review #18): a brand-new unit can't be in rework — the checkbox trigger is edit-only.
  it("create-with-rework does NOT flip the intake status to REWORK", () => {
    const r = applyTrailerStatusEngine(
      {},
      { pickup_driver: "CUSTOMER DROP OFF", rework: true },
      { isNew: true, today: TODAY },
    );
    expect(r.derived.status).toBe("Received"); // the intake status, not REWORK
    expect(r.derived.rework).toBeUndefined(); // engine doesn't auto-force it on create
  });
});

// ── Rework validation guards — enforce the invariant server-side (§924, review #39) ────────
describe("trailer rework validation guards", () => {
  it("EDIT turn-off: blocks clearing rework while status is REWORK", () => {
    expect(validateTrailer({ status: "REWORK", rework: false }, { isNew: false }).some((e) => e.field === "rework")).toBe(true);
  });
  it("allows rework=false when status is not REWORK", () => {
    expect(validateTrailer({ status: "Approved", rework: false }, {}).some((e) => e.field === "rework")).toBe(false);
  });
  it("does not trip on a legacy null rework while REWORK (only an explicit clear)", () => {
    expect(validateTrailer({ status: "REWORK", rework: null }, {}).some((e) => e.field === "rework")).toBe(false);
  });
  it("CREATE: blocks rework=true with a non-REWORK status (the crafted-POST hole)", () => {
    expect(
      validateTrailer({ status: "Received", rework: true, fcr_collision_account: "a", fcr_collision_contact: "c" }, { isNew: true }).some(
        (e) => e.field === "rework",
      ),
    ).toBe(true);
  });
  it("CREATE: allows rework=true when status IS REWORK", () => {
    expect(
      validateTrailer({ status: "REWORK", rework: true, fcr_collision_account: "a", fcr_collision_contact: "c" }, { isNew: true }).some(
        (e) => e.field === "rework",
      ),
    ).toBe(false);
  });
});
