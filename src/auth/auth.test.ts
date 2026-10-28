import { describe, it, expect } from "vitest";
import {
  hashPassword,
  verifyPassword,
  passwordMeetsPolicy,
  authenticateOffice,
  LOCKOUT_THRESHOLD,
  LOCKOUT_DURATION_MS,
  TEMP_PASSWORD_TTL_MS,
  type Queryable,
} from "./index.js";

type Call = { text: string; params: unknown[] };

// A fake pool that routes by SQL content and records every write (text + params). account/access rows are
// configurable so we can drive each branch without a real DB. The lockout counter is now advanced SQL-side
// (atomic `failed_attempts + 1`), so the unit tests assert the WRITE that was issued, not a JS-computed value;
// the real increment/threshold behaviour is proven by the CoW runtime harness.
function fakePool(opts: {
  account?: Record<string, unknown> | null;
  hasAccess?: boolean;
}): { pool: Queryable; writes: Call[] } {
  const writes: Call[] = [];
  const pool: Queryable = {
    async query<T>(text: string, params?: unknown[]) {
      if (text.includes("UPDATE fcr_core.account")) {
        writes.push({ text, params: params ?? [] });
        return { rows: [] as T[] };
      }
      if (text.includes("FROM fcr_core.account")) {
        return { rows: (opts.account ? [opts.account] : []) as T[] };
      }
      if (text.includes("FROM fcr_core.app_access")) {
        return { rows: (opts.hasAccess ? [{ one: 1 }] : []) as T[] };
      }
      throw new Error("unexpected query: " + text);
    },
  };
  return { pool, writes };
}

async function officeRow(over: Record<string, unknown> = {}) {
  const { hash, salt } = await hashPassword("correct-horse-battery");
  return {
    id: "acct-1",
    username: "amanda",
    display_name: "Amanda Fitzgerald",
    password_hash: hash,
    password_salt: salt,
    password_set_at: new Date().toISOString(),
    must_change: false,
    failed_attempts: 0,
    locked_until: null,
    ...over,
  };
}

describe("scrypt helpers", () => {
  it("round-trips a correct password and rejects a wrong one", async () => {
    const { hash, salt } = await hashPassword("correct-horse-battery");
    expect(await verifyPassword("correct-horse-battery", salt, hash)).toBe(true);
    expect(await verifyPassword("wrong", salt, hash)).toBe(false);
  });

  it("never throws on a missing/garbled stored credential", async () => {
    expect(await verifyPassword("x", null, null)).toBe(false);
    expect(await verifyPassword("x", "salt", "not-hex!!")).toBe(false);
    expect(await verifyPassword("x", "salt", "abcd")).toBe(false); // wrong length
  });

  it("enforces the 10-char policy on new passwords", () => {
    expect(passwordMeetsPolicy("123456789")).toBe(false); // 9
    expect(passwordMeetsPolicy("1234567890")).toBe(true); // 10
  });
});

describe("authenticateOffice", () => {
  it("succeeds with a correct password and granted app access", async () => {
    const { pool } = fakePool({ account: await officeRow(), hasAccess: true });
    const r = await authenticateOffice(pool, { username: "Amanda", password: "correct-horse-battery", appKey: "dispatch" });
    expect(r).toEqual({ ok: true, user: { username: "amanda", name: "Amanda Fitzgerald", role: "staff", mustChange: false } });
  });

  it("carries mustChange through on a temp password that is still fresh", async () => {
    const { pool } = fakePool({ account: await officeRow({ must_change: true }), hasAccess: true });
    const r = await authenticateOffice(pool, { username: "amanda", password: "correct-horse-battery", appKey: "dispatch" });
    expect(r.ok && r.user.mustChange).toBe(true);
  });

  it("returns invalid for an unknown username and writes nothing (but spends a decoy verify)", async () => {
    const { pool, writes } = fakePool({ account: null });
    const r = await authenticateOffice(pool, { username: "nobody", password: "x", appKey: "dispatch" });
    expect(r).toEqual({ ok: false, reason: "invalid" });
    expect(writes).toHaveLength(0);
  });

  it("returns invalid on a wrong password and increments failed_attempts atomically (SQL-side)", async () => {
    const { pool, writes } = fakePool({ account: await officeRow({ failed_attempts: 2 }), hasAccess: true });
    const r = await authenticateOffice(pool, { username: "amanda", password: "WRONG", appKey: "dispatch" });
    expect(r).toEqual({ ok: false, reason: "invalid" });
    expect(writes).toHaveLength(1);
    // the counter advances in SQL, not from the stale SELECT — no lost update under concurrency
    expect(writes[0].text).toContain("failed_attempts = failed_attempts + 1");
    // the threshold + lock duration are carried into the same statement's CASE
    expect(writes[0].text).toContain("locked_until = CASE WHEN failed_attempts + 1 >=");
    expect(writes[0].params).toEqual(["acct-1", LOCKOUT_THRESHOLD, String(LOCKOUT_DURATION_MS)]);
  });

  it("returns locked while locked_until is in the future (no password check)", async () => {
    const future = new Date(Date.now() + 5 * 60 * 1000).toISOString();
    const { pool, writes } = fakePool({ account: await officeRow({ locked_until: future }), hasAccess: true });
    const r = await authenticateOffice(pool, { username: "amanda", password: "correct-horse-battery", appKey: "dispatch" });
    expect(r).toEqual({ ok: false, reason: "locked" });
    expect(writes).toHaveLength(0);
  });

  it("rejects an expired temp password (and clears the stale counter first)", async () => {
    const stale = new Date(Date.now() - TEMP_PASSWORD_TTL_MS - 1000).toISOString();
    const { pool } = fakePool({ account: await officeRow({ must_change: true, password_set_at: stale }), hasAccess: true });
    const r = await authenticateOffice(pool, { username: "amanda", password: "correct-horse-battery", appKey: "dispatch" });
    expect(r).toEqual({ ok: false, reason: "temp_expired" });
  });

  it("resets a stale counter/lock once the password verifies, BEFORE the temp/app gates", async () => {
    // password proven but no app grant → still clears the counter (so a later wrong try can't instantly re-lock)
    const { pool, writes } = fakePool({ account: await officeRow({ failed_attempts: 4, locked_until: null }), hasAccess: false });
    const r = await authenticateOffice(pool, { username: "amanda", password: "correct-horse-battery", appKey: "estimating" });
    expect(r).toEqual({ ok: false, reason: "no_app_access" });
    expect(writes).toHaveLength(1);
    expect(writes[0].text).toContain("failed_attempts = 0");
  });

  it("denies a valid credential with no grant for this app", async () => {
    const { pool } = fakePool({ account: await officeRow(), hasAccess: false });
    const r = await authenticateOffice(pool, { username: "amanda", password: "correct-horse-battery", appKey: "estimating" });
    expect(r).toEqual({ ok: false, reason: "no_app_access" });
  });

  it("clears a stale failed-attempt counter on a fully successful login", async () => {
    const { pool, writes } = fakePool({ account: await officeRow({ failed_attempts: 3 }), hasAccess: true });
    const r = await authenticateOffice(pool, { username: "amanda", password: "correct-horse-battery", appKey: "dispatch" });
    expect(r.ok).toBe(true);
    expect(writes).toHaveLength(1);
    expect(writes[0].text).toContain("failed_attempts = 0");
    expect(writes[0].params).toEqual(["acct-1"]);
  });
});
