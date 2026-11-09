import { describe, it, expect, vi } from "vitest";
import {
  hashPassword,
  verifyPassword,
  passwordMeetsPolicy,
  authenticateOffice,
  recordAuthEvent,
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
  failAuthEventInsert?: boolean; // simulate a write error on the audit insert
  authEventInsertErrorCode?: string; // SQLSTATE to attach to that error (e.g. "42P01")
}): { pool: Queryable; writes: Call[]; events: Call[] } {
  const writes: Call[] = [];
  const events: Call[] = [];
  const pool: Queryable = {
    async query<T>(text: string, params?: unknown[]) {
      if (text.includes("INSERT INTO fcr_core.auth_event")) {
        if (opts.failAuthEventInsert || opts.authEventInsertErrorCode) {
          const e = new Error('audit insert failed') as Error & { code?: string };
          if (opts.authEventInsertErrorCode) e.code = opts.authEventInsertErrorCode;
          throw e;
        }
        events.push({ text, params: params ?? [] });
        return { rows: [] as T[] };
      }
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
  return { pool, writes, events };
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

describe("auth_event emission (epic #408)", () => {
  // params order: [account_id, username, app_key, event, auth_path, reason, ip, user_agent, metadata]
  it("emits a 'login' event with account id + context on success", async () => {
    const { pool, events } = fakePool({ account: await officeRow(), hasAccess: true });
    const r = await authenticateOffice(pool, {
      username: "amanda", password: "correct-horse-battery", appKey: "dispatch",
      context: { ip: "203.0.113.7", userAgent: "UA/1.0" },
    });
    expect(r.ok).toBe(true);
    expect(events).toHaveLength(1);
    const p = events[0].params;
    expect(p[0]).toBe("acct-1");       // account_id
    expect(p[2]).toBe("dispatch");     // app_key
    expect(p[3]).toBe("login");        // event
    expect(p[4]).toBe("office");       // auth_path
    expect(p[5]).toBeNull();           // reason (none on success)
    expect(p[6]).toBe("203.0.113.7");  // ip
    expect(p[7]).toBe("UA/1.0");       // user_agent
  });

  it("emits 'login_failed'/'invalid' for an unknown username, account id null", async () => {
    const { pool, events } = fakePool({ account: null });
    const r = await authenticateOffice(pool, { username: "nobody", password: "x", appKey: "dispatch" });
    expect(r).toEqual({ ok: false, reason: "invalid" });
    expect(events).toHaveLength(1);
    expect(events[0].params[0]).toBeNull();            // account_id
    expect(events[0].params[1]).toBe("nobody");        // username attempted
    expect(events[0].params[3]).toBe("login_failed");
    expect(events[0].params[5]).toBe("invalid");       // reason
  });

  it("emits exactly one event per terminal outcome (locked / wrong-pw / no_app_access)", async () => {
    const future = new Date(Date.now() + 5 * 60 * 1000).toISOString();
    const locked = fakePool({ account: await officeRow({ locked_until: future }), hasAccess: true });
    await authenticateOffice(locked.pool, { username: "amanda", password: "correct-horse-battery", appKey: "dispatch" });
    expect(locked.events.map((e) => e.params[3])).toEqual(["locked"]);

    const wrong = fakePool({ account: await officeRow(), hasAccess: true });
    await authenticateOffice(wrong.pool, { username: "amanda", password: "WRONG", appKey: "dispatch" });
    expect(wrong.events.map((e) => e.params[3])).toEqual(["login_failed"]);

    const noAccess = fakePool({ account: await officeRow(), hasAccess: false });
    await authenticateOffice(noAccess.pool, { username: "amanda", password: "correct-horse-battery", appKey: "estimating" });
    expect(noAccess.events.map((e) => e.params[3])).toEqual(["no_app_access"]);
  });

  it("never records the password in the emitted event", async () => {
    const { pool, events } = fakePool({ account: await officeRow(), hasAccess: true });
    await authenticateOffice(pool, { username: "amanda", password: "correct-horse-battery", appKey: "dispatch" });
    expect(JSON.stringify(events)).not.toContain("correct-horse-battery");
  });

  it("a failed auth_event insert NEVER affects the login outcome (swallowed)", async () => {
    const { pool } = fakePool({ account: await officeRow(), hasAccess: true, failAuthEventInsert: true });
    const r = await authenticateOffice(pool, { username: "amanda", password: "correct-horse-battery", appKey: "dispatch" });
    expect(r.ok).toBe(true); // the audit insert threw; login still succeeds
  });

  it("recordAuthEvent swallows a write error rather than propagating", async () => {
    const throwing: Queryable = { async query() { throw new Error("boom"); } };
    await expect(
      recordAuthEvent(throwing, { username: "x", appKey: "dispatch", event: "logout" }),
    ).resolves.toBeUndefined();
  });

  it("stays SILENT on the expected pre-migration 42P01, but LOGS any other durable failure", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      // 42P01 (undefined_table) = the expected deploy-before-migration window → no log
      const pre = fakePool({ account: await officeRow(), hasAccess: true, authEventInsertErrorCode: "42P01" });
      const r1 = await authenticateOffice(pre.pool, { username: "amanda", password: "correct-horse-battery", appKey: "dispatch" });
      expect(r1.ok).toBe(true);
      expect(spy).not.toHaveBeenCalled();

      // a different SQLSTATE (e.g. 42703 undefined_column) = durable drift → logged (credential-free)
      const drift = fakePool({ account: await officeRow(), hasAccess: true, authEventInsertErrorCode: "42703" });
      const r2 = await authenticateOffice(drift.pool, { username: "amanda", password: "correct-horse-battery", appKey: "dispatch" });
      expect(r2.ok).toBe(true);
      expect(spy).toHaveBeenCalledTimes(1);
      const logged = String(spy.mock.calls[0]?.[0] ?? "");
      expect(logged).toContain("42703");
      expect(logged).not.toContain("correct-horse-battery"); // never the credential
    } finally {
      spy.mockRestore();
    }
  });
});
