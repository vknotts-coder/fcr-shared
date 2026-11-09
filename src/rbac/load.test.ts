import { describe, it, expect } from "vitest";
import { loadPrincipalGrants, loadPrincipalGrantsById, type Queryable } from "./index.js";

// A fake Queryable that records the call and returns canned rows. Lets us test the
// mapping / default-deny logic loadPrincipalGrants owns, without a real Postgres.
function fakePool(rows: unknown[]): Queryable & { calls: { text: string; params?: unknown[] }[] } {
  const calls: { text: string; params?: unknown[] }[] = [];
  return {
    calls,
    async query<T>(text: string, params?: unknown[]) {
      calls.push({ text, params });
      return { rows: rows as T[] };
    },
  };
}

describe("loadPrincipalGrants", () => {
  it("default-denies an unknown username (no rows → accountId null, empty grants)", async () => {
    const p = await loadPrincipalGrants(fakePool([]), "nobody");
    expect(p).toEqual({ username: "nobody", accountId: null, grants: [] });
  });

  it("passes the username as the sole query param", async () => {
    const pool = fakePool([]);
    await loadPrincipalGrants(pool, "Van.Knotts");
    expect(pool.calls).toHaveLength(1);
    expect(pool.calls[0]!.params).toEqual(["Van.Knotts"]);
  });

  it("returns accountId with empty grants for an account that has NO permission rows (LEFT JOIN nulls)", async () => {
    // A real account with no matched permission → one row, account_id set, all permission cols null.
    const rows = [{
      account_id: "acct-9", resource_type: null, action: null, section: null,
      field: null, scope: null, effect: null, department_id: null, shop_id: null,
    }];
    const p = await loadPrincipalGrants(fakePool(rows), "someone");
    expect(p.accountId).toBe("acct-9");
    expect(p.grants).toEqual([]); // grant-less LEFT-JOIN row dropped
  });

  it("maps matched permission rows to camelCase grants and carries scope context", async () => {
    const rows = [
      { account_id: "a1", resource_type: "truck", action: "view", section: "financials",
        field: null, scope: "department", effect: "allow", department_id: "d1", shop_id: "s1" },
      { account_id: "a1", resource_type: "*", action: "*", section: null,
        field: null, scope: "all", effect: "deny", department_id: null, shop_id: null },
    ];
    const p = await loadPrincipalGrants(fakePool(rows), "u");
    expect(p.accountId).toBe("a1");
    expect(p.grants).toHaveLength(2);
    expect(p.grants[0]).toMatchObject({
      resourceType: "truck", action: "view", section: "financials", field: null,
      scope: "department", effect: "allow", departmentId: "d1", shopId: "s1",
    });
    expect(p.grants[1]).toMatchObject({ resourceType: "*", action: "*", scope: "all", effect: "deny" });
  });
});

describe("loadPrincipalGrantsById", () => {
  it("default-denies an unknown id (no rows → accountId null, empty grants, empty username)", async () => {
    const p = await loadPrincipalGrantsById(fakePool([]), "00000000-0000-0000-0000-000000000000");
    expect(p).toEqual({ username: "", accountId: null, grants: [] });
  });

  it("default-denies a MALFORMED (non-UUID) id WITHOUT querying (honors the documented fail-closed, no 22P02 throw)", async () => {
    // account.id is uuid → the query binds $1::uuid, which would THROW on a non-UUID value
    // (stale/tampered/legacy cookie). The loader must short-circuit to default-deny instead.
    for (const bad of ["not-a-uuid", "42", "", "'; DROP TABLE account;--", "123e4567-e89b-12d3-a456"]) {
      const pool = fakePool([{ account_id: "SHOULD-NOT-BE-REACHED" }]); // canned row proves no query ran
      const p = await loadPrincipalGrantsById(pool, bad);
      expect(p).toEqual({ username: "", accountId: null, grants: [] });
      expect(pool.calls).toHaveLength(0); // the DB is never touched for a malformed id
    }
    // Negative control: a WELL-FORMED uuid must pass the guard and reach the query.
    const ok = fakePool([]);
    await loadPrincipalGrantsById(ok, "123e4567-e89b-12d3-a456-426614174000");
    expect(ok.calls).toHaveLength(1);
  });

  it("passes the account id as the sole query param and keys on a.id (not username)", async () => {
    const pool = fakePool([]);
    const id = "11111111-2222-3333-4444-555555555555";
    await loadPrincipalGrantsById(pool, id);
    expect(pool.calls).toHaveLength(1);
    expect(pool.calls[0]!.params).toEqual([id]);
    expect(pool.calls[0]!.text).toContain("a.id = $1::uuid");
    expect(pool.calls[0]!.text).not.toContain("lower(a.username)");
  });

  it("carries the STORED username from the row (the id is authoritative across a rename)", async () => {
    const rows = [{
      account_id: "a7", username: "renamed.user", resource_type: null, action: null,
      section: null, field: null, scope: null, effect: null, department_id: null, shop_id: null,
    }];
    const p = await loadPrincipalGrantsById(fakePool(rows), "aaaaaaaa-7777-4777-8777-777777777777");
    expect(p.accountId).toBe("a7");
    expect(p.username).toBe("renamed.user");
    expect(p.grants).toEqual([]); // grant-less LEFT-JOIN row dropped
  });

  it("maps matched permission rows identically to the by-username loader", async () => {
    const rows = [
      { account_id: "a1", username: "admin.person", resource_type: "*", action: "*", section: null,
        field: null, scope: "all", effect: "allow", department_id: null, shop_id: null },
    ];
    const p = await loadPrincipalGrantsById(fakePool(rows), "a1111111-1111-4111-8111-111111111111");
    expect(p.accountId).toBe("a1");
    expect(p.grants).toHaveLength(1);
    expect(p.grants[0]).toMatchObject({ resourceType: "*", action: "*", scope: "all", effect: "allow" });
  });
});
