import { describe, it, expect } from "vitest";
import { createUnits } from "./pipeline.js";
import { trailerSpec } from "./specs/trailer.js";
import type { Queryable, Statement, TxRunner } from "../rbac/index.js";

// Programmable fake Queryable (records every call). Reads only in these tests: the name-dedup
// SELECT + (skipped) reference/dedupe checks.
function fakeDb(handler: (text: string, params: unknown[]) => { rows: unknown[]; rowCount?: number }) {
  const calls: { text: string; params: unknown[] }[] = [];
  const db: Queryable = {
    async query<T = unknown>(text: string, params: unknown[] = []) {
      calls.push({ text, params });
      const r = handler(text, params);
      return { rows: r.rows as T[] } as { rows: T[] };
    },
  };
  return { db, calls };
}

const form = (obj: Record<string, string>): FormData => {
  const fd = new FormData();
  for (const [k, v] of Object.entries(obj)) fd.set(k, v);
  return fd;
};
const ACTOR = { username: "vknotts", name: "Van" };
const NEW_CUST = { newCustomer: { sfName: "Acme Towing" } };
const NEW_CONTACT = { newContact: { sfName: "Jane" } };
const noDedup = (text: string) => (text.includes("sf_id IS NULL") ? { rows: [] } : { rows: [], rowCount: 1 });

describe("createUnits — atomic transactional path (#22)", () => {
  it("hands the WHOLE batch (customer + contact + N units) to ONE transaction; nothing written via db", async () => {
    const { db, calls } = fakeDb(noDedup);
    const txBatches: Statement[][] = [];
    const tx: TxRunner = { async transaction(stmts) { txBatches.push(stmts); } };

    const res = await createUnits(trailerSpec, NEW_CUST, NEW_CONTACT, [form({ sf_name: "U-1" }), form({ sf_name: "U-2" })], ACTOR, db, { confirmDuplicate: true, tx });

    expect(res.ok).toBe(true);
    expect(res.units.map((u) => u.result.ok)).toEqual([true, true]);
    // The customer/contact/units were committed inside the transaction, not as loose db writes.
    expect(calls.some((c) => c.text.includes("INSERT INTO"))).toBe(false);
    expect(txBatches).toHaveLength(1);
    const batch = txBatches[0]!;
    expect(batch.some((s) => s.text.includes("INSERT INTO fcr_core.customer"))).toBe(true);
    expect(batch.some((s) => s.text.includes("INSERT INTO fcr_core.unit_contact"))).toBe(true);
    expect(batch.filter((s) => s.text.includes("INSERT INTO fcr_core.trailer"))).toHaveLength(2);
  });

  it("ROLLBACK: a failing transaction orphans NOTHING and reports the batch failed", async () => {
    const { db, calls } = fakeDb(noDedup);
    const tx: TxRunner = { async transaction() { throw new Error("serialization_failure"); } };

    const res = await createUnits(trailerSpec, NEW_CUST, NEW_CONTACT, [form({ sf_name: "U-1" }), form({ sf_name: "U-2" })], ACTOR, db, { confirmDuplicate: true, tx });

    expect(res.ok).toBe(false);
    expect(res.customerRef).toBe(""); // no ref surfaced → operator won't resubmit against a half-made customer
    expect(res.units.every((u) => !u.result.ok)).toBe(true);
    // Critically: the customer/contact/units were NEVER written outside the (rolled-back) tx.
    expect(calls.some((c) => c.text.includes("INSERT INTO"))).toBe(false);
  });

  it("intra-batch dedupe: a 2nd unit with the same sf_name is rejected, not double-inserted", async () => {
    const { db } = fakeDb(noDedup);
    const txBatches: Statement[][] = [];
    const tx: TxRunner = { async transaction(stmts) { txBatches.push(stmts); } };

    // confirmDuplicate defaults to false → intra-batch dedupe active.
    const res = await createUnits(trailerSpec, NEW_CUST, NEW_CONTACT, [form({ sf_name: "DUP-1" }), form({ sf_name: "DUP-1" })], ACTOR, db, { tx });

    expect(res.ok).toBe(false); // not every unit succeeded
    expect(res.units[0].result.ok).toBe(true);
    const second = res.units[1].result;
    expect(second.ok).toBe(false);
    expect(second.ok === false && "duplicates" in second).toBe(true);
    // exactly ONE trailer INSERT reached the batch (the dup never got built)
    expect(txBatches[0]!.filter((s) => s.text.includes("INSERT INTO fcr_core.trailer"))).toHaveLength(1);
  });

  it("atomic path reports ok:false on a partial batch (a non-writable unit), not a hardcoded true", async () => {
    const { db } = fakeDb(noDedup);
    const txBatches: Statement[][] = [];
    const tx: TxRunner = { async transaction(stmts) { txBatches.push(stmts); } };

    // Unit B has an over-length VIN → fails validation → non-writable; unit A is fine.
    const res = await createUnits(trailerSpec, NEW_CUST, NEW_CONTACT, [form({ sf_name: "OK-1" }), form({ sf_name: "BAD-2", full_vin: "123456789012345678901" })], ACTOR, db, { confirmDuplicate: true, tx });

    expect(res.ok).toBe(false);
    expect(res.units[0].result.ok).toBe(true);
    expect(res.units[1].result.ok).toBe(false);
    expect(txBatches[0]!.filter((s) => s.text.includes("INSERT INTO fcr_core.trailer"))).toHaveLength(1);
  });

  it("atomic rollback surfaces a GENERIC message, not the raw driver error", async () => {
    const { db } = fakeDb(noDedup);
    const tx: TxRunner = { async transaction() { throw new Error("duplicate key value violates unique constraint \"customer_pkey\""); } };

    const res = await createUnits(trailerSpec, NEW_CUST, NEW_CONTACT, [form({ sf_name: "U-1" })], ACTOR, db, { confirmDuplicate: true, tx });

    expect(res.ok).toBe(false);
    const first = res.units[0].result;
    const msg = first.ok === false && "errors" in first ? first.errors[0].message : "";
    expect(msg).not.toContain("constraint");
    expect(msg).not.toContain("customer_pkey");
  });

  it("fallback (no TxRunner) keeps the sequential behavior: writes go through db", async () => {
    const { db, calls } = fakeDb(noDedup);
    const res = await createUnits(trailerSpec, NEW_CUST, NEW_CONTACT, [form({ sf_name: "U-1" })], ACTOR, db, { confirmDuplicate: true });

    expect(res.ok).toBe(true);
    expect(calls.some((c) => c.text.includes("INSERT INTO fcr_core.customer"))).toBe(true);
    expect(calls.some((c) => c.text.includes("INSERT INTO fcr_core.trailer"))).toBe(true);
  });
});
