import { describe, it, expect } from "vitest";
import { resolveCustomerRef, resolveContactRef } from "./customer.js";
import { createUnit, createUnits } from "./pipeline.js";
import { trailerSpec } from "./specs/trailer.js";
import type { Queryable } from "../rbac/index.js";

// Same programmable fake Queryable as index.test.ts: records every (text, params) and returns
// rows per a handler, so we can assert the exact SQL/params the intake engine issues.
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

const form = (obj: Record<string, string>): FormData => {
  const fd = new FormData();
  for (const [k, v] of Object.entries(obj)) fd.set(k, v);
  return fd;
};
const actor = { username: "vknotts", name: "Van" };
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// findDuplicates and checkReferences are distinguishable by their SQL: refs are "SELECT 1 …",
// dedupe reads end in "LIMIT 5". INSERTs contain "INSERT INTO fcr_core.<table>".
const allFound = (text: string) => (text.startsWith("SELECT 1") ? { rows: [{ "?column?": 1 }] } : { rows: [], rowCount: 1 });

describe("resolveCustomerRef (inline customer creation)", () => {
  it("existing customer → returns its sf_id unchanged, writes nothing", async () => {
    const { db, calls } = fakeDb(() => ({ rows: [], rowCount: 1 }));
    const ref = await resolveCustomerRef({ existingSfId: "001ACME" }, actor, db);
    expect(ref).toBe("001ACME");
    expect(calls).toHaveLength(0);
  });

  it("new customer → INSERTs fcr_core.customer and returns the row's LOCAL UUID (the placeholder ref)", async () => {
    const { db, calls } = fakeDb(() => ({ rows: [], rowCount: 1 }));
    const ref = await resolveCustomerRef({ newCustomer: { sfName: "Acme Towing", billingCity: "Cookeville" } }, actor, db);
    expect(ref).toMatch(UUID_RE); // NOT an sf_id — reverse-sync resolves it later
    const insert = calls.find((c) => c.text.includes("INSERT INTO fcr_core.customer"));
    expect(insert).toBeDefined();
    expect(insert!.params).toContain("Acme Towing"); // sf_name
    expect(insert!.params).toContain("Cookeville"); // billing_city
    expect(insert!.params).toContain(ref); // the returned UUID IS the inserted id
  });
});

describe("resolveContactRef (inline contact creation)", () => {
  it("existing contact → returns the ref unchanged, writes nothing", async () => {
    const { db, calls } = fakeDb(() => ({ rows: [], rowCount: 1 }));
    const ref = await resolveContactRef({ existingRef: "003JANE" }, "001ACME", actor, db);
    expect(ref).toBe("003JANE");
    expect(calls).toHaveLength(0);
  });

  it("new contact → INSERTs unit_contact linked to the customer ref, returns a UUID", async () => {
    const { db, calls } = fakeDb(() => ({ rows: [], rowCount: 1 }));
    const custRef = "11111111-1111-1111-1111-111111111111";
    const ref = await resolveContactRef({ newContact: { sfName: "Jane Doe", role: "Owner" } }, custRef, actor, db);
    expect(ref).toMatch(UUID_RE);
    const insert = calls.find((c) => c.text.includes("INSERT INTO fcr_core.unit_contact"));
    expect(insert!.params).toContain("Jane Doe");
    expect(insert!.params).toContain(custRef); // fcr_collision_account = the just-resolved customer ref
  });
});

describe("checkReferences is UUID-aware (a just-created customer validates)", () => {
  it("a UUID customer ref resolves by id; an sf_id contact ref resolves by sf_id", async () => {
    const { db, calls } = fakeDb(allFound);
    const uuid = "22222222-2222-2222-2222-222222222222";
    const res = await createUnit(
      trailerSpec,
      form({ sf_name: "T-1", fcr_collision_account: uuid, fcr_collision_contact: "003SF" }),
      actor,
      db,
      { confirmDuplicate: true },
    );
    expect(res.ok).toBe(true);
    const refCalls = calls.filter((c) => c.text.startsWith("SELECT 1"));
    expect(refCalls.find((c) => c.params[0] === uuid)?.text).toContain("WHERE id = $1");
    expect(refCalls.find((c) => c.params[0] === "003SF")?.text).toContain("WHERE sf_id = $1");
    // negative control: without UUID-awareness the UUID would be looked up by sf_id and 404 — assert it isn't.
    expect(refCalls.find((c) => c.params[0] === uuid)?.text).not.toContain("WHERE sf_id = $1");
  });
});

describe("createUnits — create-multiple for one customer", () => {
  it("new customer + new contact + 2 units: one customer, one contact, two units sharing the refs", async () => {
    const { db, calls } = fakeDb(allFound);
    const res = await createUnits(
      trailerSpec,
      { newCustomer: { sfName: "Acme Towing" } },
      { newContact: { sfName: "Jane Doe" } },
      [form({ sf_name: "T-1" }), form({ sf_name: "T-2", full_vin: "1GR1A0625ME306619" })],
      actor,
      db,
      { confirmDuplicate: true },
    );
    expect(res.ok).toBe(true);
    expect(res.customerRef).toMatch(UUID_RE);
    expect(res.contactRef).toMatch(UUID_RE);
    expect(res.units).toHaveLength(2);
    // exactly ONE customer + ONE contact created, shared across the batch
    expect(calls.filter((c) => c.text.includes("INSERT INTO fcr_core.customer"))).toHaveLength(1);
    expect(calls.filter((c) => c.text.includes("INSERT INTO fcr_core.unit_contact"))).toHaveLength(1);
    const unitInserts = calls.filter((c) => c.text.includes("INSERT INTO fcr_core.trailer"));
    expect(unitInserts).toHaveLength(2);
    for (const ins of unitInserts) {
      expect(ins.params).toContain(res.customerRef); // every unit carries the same resolved refs
      expect(ins.params).toContain(res.contactRef);
    }
  });

  it("existing customer/contact → no customer/contact INSERT; refs passed straight through", async () => {
    const { db, calls } = fakeDb(allFound);
    const res = await createUnits(
      trailerSpec,
      { existingSfId: "001ACME" },
      { existingRef: "003JANE" },
      [form({ sf_name: "T-9" })],
      actor,
      db,
      { confirmDuplicate: true },
    );
    expect(res.customerRef).toBe("001ACME");
    expect(res.contactRef).toBe("003JANE");
    expect(calls.some((c) => c.text.includes("INSERT INTO fcr_core.customer"))).toBe(false);
    expect(calls.some((c) => c.text.includes("INSERT INTO fcr_core.unit_contact"))).toBe(false);
    expect(calls.filter((c) => c.text.includes("INSERT INTO fcr_core.trailer"))).toHaveLength(1);
  });

  it("v1 partial success: a duplicate unit is reported per-unit while the others proceed", async () => {
    const DUP_VIN = "1HGCM82633A00000";
    const { db, calls } = fakeDb((text, params) => {
      if (text.startsWith("SELECT 1")) return { rows: [{ "?column?": 1 }] };
      // dedupe VIN read (LIMIT 5) for the dup VIN → a hit; everything else clean
      if (text.includes("LIMIT 5") && params[0] === DUP_VIN) {
        return { rows: [{ id: "99999999-9999-9999-9999-999999999999", sf_name: "OLD" }] };
      }
      return { rows: [], rowCount: 1 };
    });
    const res = await createUnits(
      trailerSpec,
      { newCustomer: { sfName: "Acme" } },
      { newContact: { sfName: "Jane" } },
      [form({ sf_name: "T-1" }), form({ sf_name: "T-2", full_vin: DUP_VIN })],
      actor,
      db, // NO confirmDuplicate → the dup blocks unit 2 only
    );
    expect(res.ok).toBe(false);
    expect(res.units[0]!.result.ok).toBe(true);
    const second = res.units[1]!.result;
    expect(second.ok).toBe(false);
    if (!second.ok && "duplicates" in second) expect(second.duplicates[0]!.sfName).toBe("OLD");
    // unit 1 was still created, and so were the customer + contact (documented v1 non-atomic behavior)
    expect(calls.filter((c) => c.text.includes("INSERT INTO fcr_core.trailer"))).toHaveLength(1);
    expect(calls.filter((c) => c.text.includes("INSERT INTO fcr_core.customer"))).toHaveLength(1);
  });
});
