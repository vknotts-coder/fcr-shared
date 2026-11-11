import { describe, it, expect } from "vitest";
import { createUnit, updateUnit, findDuplicates } from "./pipeline.js";
import { coerceField, parseEdits } from "./coerce.js";
import {
  applyTrailerStatusEngine,
  validateTrailer,
  trailerSpec,
  TRAILER_NUMERIC_COLS,
  TRAILER_DATE_COLS,
  TRAILER_BOOL_COLS,
} from "./specs/trailer.js";
import { applyTruckStatusEngine, validateTruck, truckSpec, TRUCK_NUMERIC_COLS, TRUCK_DATE_COLS } from "./specs/truck.js";
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
  it("truck: estimator_name must be an SF picklist initial; blank allowed, bad value rejected", () => {
    // blank clears — no error
    expect(validateTruck({ estimator_name: "" }, { isNew: false }).some((e) => e.field === "estimator_name")).toBe(false);
    // a valid SF initial passes
    expect(validateTruck({ estimator_name: "JR" }, { isNew: false }).some((e) => e.field === "estimator_name")).toBe(false);
    // a full name (the retired runTransition wrote these) is REFUSED so it can't dead-letter at SF
    expect(validateTruck({ estimator_name: "Jordan" }, { isNew: false }).some((e) => e.field === "estimator_name")).toBe(true);
  });
  it("truck: a legacy out-of-domain estimator_name does NOT freeze edits to unrelated fields (scoped to changed)", () => {
    // updateUnit validates the MERGED before-image. A legacy row holds estimator_name="Jordan"; the user edits
    // only `shop`. estimator_name is UNCHANGED → the guard must not fire and block the unrelated edit.
    const before = { estimator_name: "Jordan", status: "Estimating" };
    const merged = { ...before, shop: "Sparta" }; // estimator_name carried through unchanged
    expect(validateTruck(merged, { isNew: false, before }).some((e) => e.field === "estimator_name")).toBe(false);
    // But actually CHANGING estimator_name to a bad value is still refused...
    expect(validateTruck({ estimator_name: "Bob" }, { isNew: false, before }).some((e) => e.field === "estimator_name")).toBe(true);
    // ...and changing it to a valid initial passes.
    expect(validateTruck({ estimator_name: "JR" }, { isNew: false, before }).some((e) => e.field === "estimator_name")).toBe(false);
  });
  it("truck: truck_make must be an SF Make picklist value when changed; off-list CHANGED value refused", () => {
    // blank clears — no error
    expect(validateTruck({ truck_make: "" }, { isNew: false }).some((e) => e.field === "truck_make")).toBe(false);
    // a valid SF make passes
    expect(validateTruck({ truck_make: "Freightliner" }, { isNew: false }).some((e) => e.field === "truck_make")).toBe(false);
    // an off-list make is REFUSED so it can't dead-letter at SF's Truck_Make__c picklist
    expect(validateTruck({ truck_make: "Hino" }, { isNew: false }).some((e) => e.field === "truck_make")).toBe(true);
    // NOTE: this only proves validateTruck is PERMISSIVE on an unchanged legacy value — NOT that the value
    // survives a form submission (that's the coerce round-trip test below). A legacy free-text make on an
    // UNRELATED edit is not BLOCKED (scoped to changed):
    const before = { truck_make: "freightliner", status: "Estimating" };
    expect(validateTruck({ ...before, shop: "Sparta" }, { isNew: false, before }).some((e) => e.field === "truck_make")).toBe(false);
    // but CHANGING make to an off-list value is still refused
    expect(validateTruck({ truck_make: "Hino" }, { isNew: false, before }).some((e) => e.field === "truck_make")).toBe(true);
  });
  it("truck: tires must be Yes/No when changed; off-list CHANGED value refused", () => {
    expect(validateTruck({ tires: "" }, { isNew: false }).some((e) => e.field === "tires")).toBe(false);
    expect(validateTruck({ tires: "Yes" }, { isNew: false }).some((e) => e.field === "tires")).toBe(false);
    expect(validateTruck({ tires: "maybe" }, { isNew: false }).some((e) => e.field === "tires")).toBe(true);
    const before = { tires: "weird-legacy", status: "Estimating" };
    expect(validateTruck({ ...before, shop: "Sparta" }, { isNew: false, before }).some((e) => e.field === "tires")).toBe(false);
  });
  it("truck: restricted-select CONTRACT — preserving a legacy make is the form's job, not validateTruck's", () => {
    // The real submission path is parseEdits(FormData) → merge over the before-row. This pins what each shape of
    // a submitted `truck_make` does, so the data-safety responsibility is explicit (review round 1, the MEDIUM):
    const p = (fd: FormData) => parseEdits(fd, truckSpec.formFields, truckSpec.numericCols, truckSpec.dateCols, truckSpec.boolCols);
    const before = { truck_make: "freightliner" }; // legacy off-list value

    // (a) field ABSENT from the form (e.g. a locked/disabled input isn't submitted) → not in edits → merge keeps it.
    const absent = p(form({ shop: "Sparta" }));
    expect("truck_make" in absent).toBe(false);
    expect({ ...before, ...absent }.truck_make).toBe("freightliner"); // preserved

    // (b) field RE-SUBMITTED with the stored value (what a form that renders the current value as an option does)
    //     → merge keeps it, and validateTruck doesn't block it (unchanged).
    const resubmit = p(form({ truck_make: "freightliner", shop: "Sparta" }));
    expect({ ...before, ...resubmit }.truck_make).toBe("freightliner"); // preserved
    expect(validateTruck({ ...before, ...resubmit }, { isNew: false, before }).some((e) => e.field === "truck_make")).toBe(false);

    // (c) field submitted BLANK (what a <select> with no matching option does if the form DOESN'T inject the
    //     stored value) → coerces to "" → merge WIPES the legacy make. This is the data-loss path; the consuming
    //     form prevents it by keeping the current value selectable, NOT validateTruck (blank is a legitimate clear).
    const blank = p(form({ truck_make: "", shop: "Sparta" }));
    expect({ ...before, ...blank }.truck_make).toBeNull(); // WIPED (blank text → null) — why the form guard is load-bearing
  });
  it("truck: the new Estimate-Information fields are editable form fields (Make select + Tires select + Revised Estimate Date)", () => {
    const byCol = new Map(truckSpec.formFields.map((f) => [f.column, f]));
    expect(byCol.get("truck_make")?.input).toBe("select");
    expect(byCol.get("truck_make")?.options).toEqual(["", "Freightliner", "International", "Kenworth", "Volvo", "Peterbilt", "Mack", "Other"]);
    expect(byCol.get("tires")).toMatchObject({ section: "estimate", input: "select", options: ["", "Yes", "No"] });
    expect(byCol.get("revised_esimate_date")).toMatchObject({ section: "estimate", input: "date" });
    expect(TRUCK_DATE_COLS.has("revised_esimate_date")).toBe(true);
  });
  it("truck: Awaiting-Pickup-needs-address still fires when the coupling is newly violated", () => {
    const addrErr = (state: Record<string, unknown>, opts: { isNew?: boolean; before?: Record<string, unknown> }) =>
      validateTruck(state, opts).some((e) => e.field === "pickup_street_address");
    // CREATE: status set to Awaiting Pickup with no address and not a drop-off → refused
    expect(addrErr({ status: "Awaiting Pickup" }, { isNew: true })).toBe(true);
    // EDIT changing status INTO Awaiting Pickup with no stored address → refused (status changed)
    expect(addrErr({ status: "Awaiting Pickup" }, { isNew: false, before: { status: "Awaiting Pickup Info" } })).toBe(true);
    // EDIT clearing the address while status stays Awaiting Pickup → refused (address changed)
    expect(addrErr(
      { status: "Awaiting Pickup", pickup_city: "" },
      { isNew: false, before: { status: "Awaiting Pickup", pickup_city: "Livingston" } },
    )).toBe(true);
    // a drop-off exempts it even with no address
    expect(addrErr({ status: "Awaiting Pickup", pickup_tow_drive: "Customer Drop Off" }, { isNew: true })).toBe(false);
  });
  it("truck: a legacy Awaiting-Pickup row with no address does NOT freeze an invoice/rework-only edit (scoped to changed)", () => {
    // updateUnit validates the MERGED before-image. A legacy truck sits at "Awaiting Pickup" with no stored
    // pickup address; the user edits only invoice_4. The coupling fields are UNCHANGED → the rule must not fire.
    const before = { status: "Awaiting Pickup", invoice_4: "" };
    const merged = { ...before, invoice_4: "INV-900" }; // status + address carried through unchanged
    expect(validateTruck(merged, { isNew: false, before }).some((e) => e.field === "pickup_street_address")).toBe(false);
    // a rework-only edit on the same legacy row is likewise not frozen
    const merged2 = { ...before, rework: false };
    expect(validateTruck(merged2, { isNew: false, before }).some((e) => e.field === "pickup_street_address")).toBe(false);
  });
  it("trailer: status-coupling rules still fire when the coupling is newly violated", () => {
    const err = (field: string, state: Record<string, unknown>, opts: { isNew?: boolean; before?: Record<string, unknown> }) =>
      validateTrailer(state, opts).some((e) => e.field === field);
    // CREATE into Awaiting Pickup, no address, not a drop-off → refused
    expect(err("pickup_address", { status: "Awaiting Pickup" }, { isNew: true })).toBe(true);
    // EDIT changing status INTO Awaiting Pickup with no stored address → refused (status changed)
    expect(err("pickup_address", { status: "Awaiting Pickup" }, { isNew: false, before: { status: "Received" } })).toBe(true);
    // EDIT clearing the address while status stays Awaiting Pickup → refused (address changed)
    expect(err("pickup_address", { status: "Awaiting Pickup", pickup_city: "" }, { isNew: false, before: { status: "Awaiting Pickup", pickup_city: "Livingston" } })).toBe(true);
    // a customer drop-off exempts it
    expect(err("pickup_address", { status: "Awaiting Pickup", pickup_driver: "CUSTOMER DROP OFF" }, { isNew: true })).toBe(false);
    // Repair Complete with no repair_start_date, on create → refused
    expect(err("repair_start_date", { status: "Repair Complete" }, { isNew: true })).toBe(true);
  });
  it("trailer: a legacy row with a coupling gap does NOT freeze an unrelated edit (scoped to changed)", () => {
    // A legacy trailer sits at "Awaiting Pickup" with no stored pickup address; the user edits only the VIN.
    // The pickup-coupling fields are UNCHANGED → the Awaiting-Pickup rule must not fire.
    const awp = { status: "Awaiting Pickup" };
    expect(validateTrailer({ ...awp, full_vin: "1GR1A0625ME306619" }, { isNew: false, before: awp }).some((e) => e.field === "pickup_address")).toBe(false);
    // A legacy trailer at "Repair Complete" with no repair_start_date; editing only pickup_city must not be
    // frozen by the repair-start rule (status + repair_start_date unchanged).
    const rc = { status: "Repair Complete" };
    expect(validateTrailer({ ...rc, pickup_city: "Sparta" }, { isNew: false, before: rc }).some((e) => e.field === "repair_start_date")).toBe(false);
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

// ── Field-scoped reverse-sync: updateUnit records changed cols into dispatch_dirty_cols (§2.0) ──
describe("updateUnit — dispatch_dirty_cols (field-scoped reverse-sync)", () => {
  it("unions the changed business columns into dispatch_dirty_cols on the UPDATE", async () => {
    const ID = "11111111-1111-1111-1111-111111111111";
    const { db, calls } = fakeDb((text) => {
      if (text.includes("__guard")) {
        // before-image SELECT
        return { rows: [{ id: ID, __guard: "2026-09-16T00:00:00.000Z", status: "Received", sf_name: "T-1", status_notes: "old" }] };
      }
      return { rows: [], rowCount: 1 }; // the UPDATE
    });
    const res = await updateUnit(trailerSpec, ID, form({ status_notes: "new note" }), { username: "vknotts", name: "Van" }, db);
    expect(res.ok).toBe(true);

    const upd = calls.find((c) => c.text.includes("UPDATE fcr_core.trailer"));
    expect(upd).toBeTruthy();
    expect(upd!.text).toContain("dispatch_dirty_cols = ARRAY(SELECT DISTINCT unnest");
    // the changed column is bound as a text[] param
    const arrayParam = upd!.params.find((p) => Array.isArray(p)) as string[] | undefined;
    expect(arrayParam).toContain("status_notes");
  });

  it("a no-op edit writes nothing (no UPDATE, no dirty-col stamp)", async () => {
    const ID = "22222222-2222-2222-2222-222222222222";
    const { db, calls } = fakeDb(() => ({
      rows: [{ id: ID, __guard: "2026-09-16T00:00:00.000Z", status: "Received", sf_name: "T-1", status_notes: "same" }],
    }));
    const res = await updateUnit(trailerSpec, ID, form({ status_notes: "same" }), { username: "vknotts", name: "Van" }, db);
    expect(res.ok).toBe(true);
    expect(calls.some((c) => c.text.includes("UPDATE fcr_core.trailer"))).toBe(false);
  });

  // End-to-end proof the estimator-freeze fix holds THROUGH updateUnit (round-1 HIGH): pipeline.ts threads the
  // before-image into validate, and validateTruck scopes the estimator check to a CHANGED value.
  it("truck: editing an unrelated field on a legacy out-of-domain estimator row is NOT frozen", async () => {
    const ID = "33333333-3333-3333-3333-333333333333";
    const { db } = fakeDb((text) => {
      if (text.startsWith("SELECT 1")) return { rows: [{ "?column?": 1 }] }; // ref existence
      if (text.includes("__guard")) {
        // legacy before-image: estimator_name holds a full name the old runTransition wrote
        return { rows: [{ id: ID, __guard: "2026-09-16T00:00:00.000Z", status: "Estimating", sf_name: "TRK-1", estimator_name: "Jordan" }] };
      }
      return { rows: [], rowCount: 1 }; // the UPDATE
    });
    // Edit ONLY shop — estimator_name unchanged → the guard must not fire.
    const res = await updateUnit(truckSpec, ID, form({ shop: "Sparta" }), { username: "vknotts", name: "Van" }, db);
    expect(res.ok).toBe(true);
  });

  it("truck: CHANGING estimator_name to an out-of-domain value IS refused through updateUnit", async () => {
    const ID = "44444444-4444-4444-4444-444444444444";
    const { db } = fakeDb((text) => {
      if (text.startsWith("SELECT 1")) return { rows: [{ "?column?": 1 }] };
      if (text.includes("__guard")) {
        return { rows: [{ id: ID, __guard: "2026-09-16T00:00:00.000Z", status: "Estimating", sf_name: "TRK-2", estimator_name: "JR" }] };
      }
      return { rows: [], rowCount: 1 };
    });
    const res = await updateUnit(truckSpec, ID, form({ estimator_name: "Bob" }), { username: "vknotts", name: "Van" }, db);
    expect(res.ok).toBe(false);
    if (!res.ok && "errors" in res) expect(res.errors.some((e) => e.field === "estimator_name")).toBe(true);
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

// Truck Estimate-Information edit surface (epic fcr-estimating#60 S2): the 19 editable fields are in the
// truck spec, in the SF page-layout sections, and coerce per type. Pins the set so a regression that drops
// a field (silently making it uneditable / unable to reverse-sync) fails here.
describe("truckSpec — Estimate Information edit fields (#60 S2)", () => {
  const ESTIMATE = [
    "estimate_sent_date", "estimate_completed", "estimate_approved", "estimate_finalized",
    "body_hours", "body_s_hours", "frame_hours", "mechanical_hours", "refinish_hours",
    "total_lines_on_estimate", "estimate_notes", "revised_estimate_notes", "total_sales",
  ];
  const FINALIZED = [
    "finalized_body_hours", "finalized_frame_hours", "finalized_mechanical_hours",
    "finalized_refinish_hours", "total_billed_hours", "finalized_total_sales",
  ];

  it("all 19 are in the form spec, in the estimate / finalized sections", () => {
    const bySection = new Map(truckSpec.formFields.map((f) => [f.column, f.section]));
    for (const c of ESTIMATE) expect(bySection.get(c), `${c} missing/mis-sectioned`).toBe("estimate");
    for (const c of FINALIZED) expect(bySection.get(c), `${c} missing/mis-sectioned`).toBe("finalized");
  });

  it("sales-$ are editable number fields (the estimating dept owns the figure)", () => {
    const byCol = new Map(truckSpec.formFields.map((f) => [f.column, f]));
    expect(byCol.get("total_sales")?.input).toBe("number");
    expect(byCol.get("finalized_total_sales")?.input).toBe("number");
  });

  it("parseEdits coerces each per type: dates→date, hours/lines/sales→number, notes→text", () => {
    const edits = parseEdits(
      form({
        estimate_completed: "2026-11-10",
        body_s_hours: "12.5",
        total_lines_on_estimate: "42",
        total_sales: "15000",
        finalized_total_sales: "15250.5",
        estimate_notes: "two panels",
      }),
      truckSpec.formFields, truckSpec.numericCols, truckSpec.dateCols, truckSpec.boolCols,
    );
    expect(edits.estimate_completed).toBe("2026-11-10");
    expect(edits.body_s_hours).toBe(12.5);
    expect(edits.total_lines_on_estimate).toBe(42);
    expect(edits.total_sales).toBe(15000);
    expect(edits.finalized_total_sales).toBe(15250.5);
    expect(edits.estimate_notes).toBe("two panels");
  });

  it("the computed rollups are NOT editable columns (SF formulas)", () => {
    const cols = new Set(truckSpec.formFields.map((f) => f.column));
    expect(cols.has("total_estimated_hours")).toBe(false);
    expect(cols.has("finalized_total_hours")).toBe(false);
    // and they are not mis-classified as numeric/date edit cols either
    expect(TRUCK_NUMERIC_COLS.has("total_estimated_hours")).toBe(false);
    expect(TRUCK_DATE_COLS.has("total_estimated_hours")).toBe(false);
  });
});

// #60 S2 review fix — a non-numeric money/hours entry must coerce to null, NOT 0. Negative control: the
// pre-fix code did `Number(strip("N/A"))` = Number("") = 0, silently writing $0 and reverse-syncing it to
// SF; these assertions FAIL against that old behavior (0 !== null) and pass only with the empty→null guard.
describe("coerceField — non-numeric numeric input → null, not 0 (#60 S2 money-coercion fix)", () => {
  const num = (raw: string) => coerceField("total_sales", raw, TRUCK_NUMERIC_COLS, TRUCK_DATE_COLS);
  it("all-non-numeric strings → null (would be 0 before the fix)", () => {
    expect(num("N/A")).toBe(null);
    expect(num("TBD")).toBe(null);
    expect(num("pending")).toBe(null);
  });
  it("blank → null; real numbers still coerce", () => {
    expect(num("")).toBe(null);
    expect(num("15000")).toBe(15000);
    expect(num("$15,250.50")).toBe(15250.5);
    expect(num("-3")).toBe(-3);
  });
});
