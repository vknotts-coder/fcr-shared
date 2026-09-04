import { describe, it, expect } from "vitest";
import { loadPrincipalGrants, type Queryable } from "./index.js";

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
