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

// A fake pool that routes by SQL content and records writes. account/access rows are configurable;
// an UPDATE is captured so we can assert lockout / reset behaviour without a real DB.
function fakePool(opts: {
  account?: Record<string, unknown> | null;
  hasAccess?: boolean;
}): { pool: Queryable; updates: unknown[][] } {
  const updates: unknown[][] = [];
  const pool: Queryable = {
    async query<T>(text: string, params?: unknown[]) {
      if (text.includes("UPDATE fcr_core.account")) {
        updates.push(params ?? []);
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
  return { pool, updates };
}

function officeRow(over: Record<string, unknown> = {}) {
  const { hash, salt } = hashPassword("correct-horse-battery");
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
  it("round-trips a correct password and rejects a wrong one", () => {
    const { hash, salt } = hashPassword("correct-horse-battery");
    expect(verifyPassword("correct-horse-battery", salt, hash)).toBe(true);
    expect(verifyPassword("wrong", salt, hash)).toBe(false);
  });

  it("never throws on a missing/garbled stored credential", () => {
    expect(verifyPassword("x", null, null)).toBe(false);
    expect(verifyPassword("x", "salt", "not-hex!!")).toBe(false);
    expect(verifyPassword("x", "salt", "abcd")).toBe(false); // wrong length
  });

  it("enforces the 10-char policy on new passwords", () => {
    expect(passwordMeetsPolicy("123456789")).toBe(false); // 9
    expect(passwordMeetsPolicy("1234567890")).toBe(true); // 10
  });
});

describe("authenticateOffice", () => {
  it("succeeds with a correct password and granted app access", async () => {
    const { pool } = fakePool({ account: officeRow(), hasAccess: true });
    const r = await authenticateOffice(pool, { username: "Amanda", password: "correct-horse-battery", appKey: "dispatch" });
    expect(r).toEqual({ ok: true, user: { username: "amanda", name: "Amanda Fitzgerald", role: "staff", mustChange: false } });
  });

  it("carries mustChange through on a temp password that is still fresh", async () => {
    const { pool } = fakePool({ account: officeRow({ must_change: true }), hasAccess: true });
    const r = await authenticateOffice(pool, { username: "amanda", password: "correct-horse-battery", appKey: "dispatch" });
    expect(r.ok && r.user.mustChange).toBe(true);
  });

  it("returns invalid for an unknown username and writes nothing", async () => {
    const { pool, updates } = fakePool({ account: null });
    const r = await authenticateOffice(pool, { username: "nobody", password: "x", appKey: "dispatch" });
    expect(r).toEqual({ ok: false, reason: "invalid" });
    expect(updates).toHaveLength(0);
  });

  it("returns invalid on a wrong password and increments failed_attempts", async () => {
    const { pool, updates } = fakePool({ account: officeRow({ failed_attempts: 2 }), hasAccess: true });
    const r = await authenticateOffice(pool, { username: "amanda", password: "WRONG", appKey: "dispatch" });
    expect(r).toEqual({ ok: false, reason: "invalid" });
    expect(updates).toHaveLength(1);
    expect(updates[0][1]).toBe(3); // failed_attempts := 2 + 1
    expect(updates[0][2]).toBeNull(); // below threshold → no lock
  });

  it("sets a lockout once the threshold is hit", async () => {
    const { pool, updates } = fakePool({ account: officeRow({ failed_attempts: LOCKOUT_THRESHOLD - 1 }), hasAccess: true });
    const before = Date.now();
    const r = await authenticateOffice(pool, { username: "amanda", password: "WRONG", appKey: "dispatch" });
    expect(r).toEqual({ ok: false, reason: "invalid" });
    expect(updates[0][1]).toBe(LOCKOUT_THRESHOLD);
    const lockUntil = Date.parse(updates[0][2] as string);
    expect(lockUntil).toBeGreaterThanOrEqual(before + LOCKOUT_DURATION_MS - 1000);
  });

  it("returns locked while locked_until is in the future (no password check)", async () => {
    const future = new Date(Date.now() + 5 * 60 * 1000).toISOString();
    const { pool } = fakePool({ account: officeRow({ locked_until: future }), hasAccess: true });
    const r = await authenticateOffice(pool, { username: "amanda", password: "correct-horse-battery", appKey: "dispatch" });
    expect(r).toEqual({ ok: false, reason: "locked" });
  });

  it("rejects an expired temp password", async () => {
    const stale = new Date(Date.now() - TEMP_PASSWORD_TTL_MS - 1000).toISOString();
    const { pool } = fakePool({ account: officeRow({ must_change: true, password_set_at: stale }), hasAccess: true });
    const r = await authenticateOffice(pool, { username: "amanda", password: "correct-horse-battery", appKey: "dispatch" });
    expect(r).toEqual({ ok: false, reason: "temp_expired" });
  });

  it("denies a valid credential with no grant for this app", async () => {
    const { pool } = fakePool({ account: officeRow(), hasAccess: false });
    const r = await authenticateOffice(pool, { username: "amanda", password: "correct-horse-battery", appKey: "estimating" });
    expect(r).toEqual({ ok: false, reason: "no_app_access" });
  });

  it("clears a stale failed-attempt counter on success", async () => {
    const { pool, updates } = fakePool({ account: officeRow({ failed_attempts: 3 }), hasAccess: true });
    const r = await authenticateOffice(pool, { username: "amanda", password: "correct-horse-battery", appKey: "dispatch" });
    expect(r.ok).toBe(true);
    expect(updates).toHaveLength(1);
    expect(updates[0][0]).toBe("acct-1"); // the reset UPDATE ran
  });
});
