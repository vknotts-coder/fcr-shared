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

  it("name-dedup: a same-name UNSYNCED customer is reused — no customer INSERT in the batch", async () => {
    const existingId = "0554eff4-a5aa-4a59-a3b3-e4a93ad28ece";
    const { db } = fakeDb((text) => {
      if (text.includes("sf_id IS NULL")) return { rows: [{ id: existingId }] }; // name-dedup hit
      if (text.startsWith("SELECT 1")) return { rows: [{ "?column?": 1 }] }; // reused customer's ref exists
      return { rows: [], rowCount: 1 };
    });
    const txBatches: Statement[][] = [];
    const tx: TxRunner = { async transaction(stmts) { txBatches.push(stmts); } };

    const res = await createUnits(trailerSpec, NEW_CUST, NEW_CONTACT, [form({ sf_name: "U-1" })], ACTOR, db, { confirmDuplicate: true, tx });

    expect(res.ok).toBe(true);
    expect(res.customerRef).toBe(existingId);
    const batch = txBatches[0]!;
    expect(batch.some((s) => s.text.includes("INSERT INTO fcr_core.customer"))).toBe(false); // reused, not re-created
    // the unit references the reused customer ref
    const unit = batch.find((s) => s.text.includes("INSERT INTO fcr_core.trailer"))!;
    expect(unit.params).toContain(existingId);
  });

  it("fallback (no TxRunner) keeps the sequential behavior: writes go through db", async () => {
    const { db, calls } = fakeDb(noDedup);
    const res = await createUnits(trailerSpec, NEW_CUST, NEW_CONTACT, [form({ sf_name: "U-1" })], ACTOR, db, { confirmDuplicate: true });

    expect(res.ok).toBe(true);
    expect(calls.some((c) => c.text.includes("INSERT INTO fcr_core.customer"))).toBe(true);
    expect(calls.some((c) => c.text.includes("INSERT INTO fcr_core.trailer"))).toBe(true);
  });
});
