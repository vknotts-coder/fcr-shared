// Unit tests for @fcr/core/outbox — validation + the exact SQL/params each helper builds, against a
// capturing mock Queryable (no DB). The live write/read-back + double-send safety are runtime-gated in
// fcr-dispatch on a CoW branch (epic #458 S2); these pin the contract the consumer depends on.

import { describe, it, expect } from "vitest";
import {
  enqueueEmail,
  claimPendingEmails,
  markSent,
  markFailed,
  type EmailOutboxRow,
} from "./index.js";

type Call = { text: string; params: unknown[] };

function mockQ(returnRows: unknown[] = []) {
  const calls: Call[] = [];
  const q = {
    async query<T = unknown>(text: string, params?: unknown[]) {
      calls.push({ text, params: params ?? [] });
      return { rows: returnRows as T[] };
    },
  };
  return { q, calls };
}

const base = { from: "FCR Estimating <estimating@fcrdispatch.com>", subject: "Truck not in system", html: "<p>hi</p>", source: "estimating:missing_truck" };

describe("enqueueEmail — validation", () => {
  it("rejects an empty recipient list (even after trimming blanks)", async () => {
    const { q } = mockQ();
    await expect(enqueueEmail(q, { ...base, to: ["  ", ""] })).rejects.toThrow(/recipient/);
  });
  it("rejects a missing from and a missing subject", async () => {
    const { q } = mockQ();
    await expect(enqueueEmail(q, { ...base, to: ["a@b.com"], from: "  " })).rejects.toThrow(/from/);
    await expect(enqueueEmail(q, { ...base, to: ["a@b.com"], subject: "" })).rejects.toThrow(/subject/);
  });
});

describe("enqueueEmail — INSERT shape", () => {
  it("inserts a pending row with attempts 0, trimmed recipients, null cc when empty", async () => {
    const { q, calls } = mockQ();
    const { id } = await enqueueEmail(q, { ...base, to: [" a@b.com ", "c@d.com", ""], createdBy: "jordanr" });
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    expect(calls).toHaveLength(1);
    expect(calls[0].text).toMatch(/INSERT INTO fcr_core\.email_outbox/);
    expect(calls[0].text).toMatch(/'pending'/);
    const p = calls[0].params;
    expect(p[1]).toEqual(["a@b.com", "c@d.com"]); // to_addrs trimmed + blanks dropped
    expect(p[2]).toBeNull();                        // cc_addrs null when none
    expect(p[9]).toBe(5);                           // default max_attempts
    expect(p[10]).toBe("jordanr");                  // created_by
  });
  it("passes cc through and honors a custom maxAttempts (floored at 1)", async () => {
    const { q, calls } = mockQ();
    await enqueueEmail(q, { ...base, to: ["a@b.com"], cc: ["boss@x.com"], maxAttempts: 0 });
    expect(calls[0].params[2]).toEqual(["boss@x.com"]);
    expect(calls[0].params[9]).toBe(1); // 0 floored to 1
  });
});

describe("claimPendingEmails — atomic claim", () => {
  it("claims via a single atomic UPDATE … FOR UPDATE SKIP LOCKED and returns the rows", async () => {
    const row: EmailOutboxRow = {
      id: "11111111-1111-1111-1111-111111111111", status: "sending",
      to_addrs: ["a@b.com"], cc_addrs: null, from_addr: base.from, reply_to: null,
      subject: base.subject, html: base.html, text: null, source: base.source,
      attempts: 1, max_attempts: 5, last_error: null, created_by: null,
    };
    const { q, calls } = mockQ([row]);
    const out = await claimPendingEmails(q, 10, 15);
    expect(out).toEqual([row]);
    expect(calls[0].text).toMatch(/UPDATE fcr_core\.email_outbox/);
    expect(calls[0].text).toMatch(/FOR UPDATE SKIP LOCKED/);
    expect(calls[0].text).toMatch(/SET status = 'sending', attempts = o\.attempts \+ 1/);
    expect(calls[0].params).toEqual([10, 15]);
  });
});

describe("markSent / markFailed", () => {
  it("markSent flips to sent + stamps sent_at + clears last_error", async () => {
    const { q, calls } = mockQ();
    await markSent(q, "id1");
    expect(calls[0].text).toMatch(/status = 'sent'.*sent_at = now\(\).*last_error = NULL/s);
    expect(calls[0].params).toEqual(["id1"]);
  });
  it("markFailed dead-letters only at the cap (else returns to pending) and truncates the error", async () => {
    const { q, calls } = mockQ();
    await markFailed(q, "id1", "x".repeat(5000));
    expect(calls[0].text).toMatch(/WHEN attempts >= max_attempts THEN 'failed' ELSE 'pending'/);
    expect((calls[0].params[1] as string).length).toBe(2000);
  });
});
