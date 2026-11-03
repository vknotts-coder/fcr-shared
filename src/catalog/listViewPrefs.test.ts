import { describe, it, expect } from "vitest";
import {
  mergeColumnOrder,
  getListViewPref,
  saveListViewPref,
  deleteListViewPref,
} from "./listViewPrefs.js";

// A recording mock of the @fcr/core Queryable seam: captures every (sql, params) and returns queued rows.
function mockDb(queued: unknown[][] = []) {
  const calls: { sql: string; params: unknown[] }[] = [];
  const queue = [...queued];
  const db = {
    async query<T>(sql: string, params?: unknown[]) {
      calls.push({ sql, params: params ?? [] });
      return { rows: (queue.shift() ?? []) as T[] };
    },
  };
  return { db, calls };
}

const ROW = {
  id: "11111111-1111-1111-1111-111111111111",
  owner_account_id: "22222222-2222-2222-2222-222222222222",
  object_key: "trailer",
  view_slug: "trailers",
  columns: ["status", "sf_name"],
  created_at: "2026-11-03T00:00:00.000Z",
  updated_at: "2026-11-03T00:00:00.000Z",
};

describe("mergeColumnOrder", () => {
  const catalog = ["a", "b", "c", "d"];

  it("returns the catalog unchanged with no saved order", () => {
    expect(mergeColumnOrder(catalog, null)).toEqual(catalog);
    expect(mergeColumnOrder(catalog, undefined)).toEqual(catalog);
    expect(mergeColumnOrder(catalog, [])).toEqual(catalog);
  });

  it("applies a full permutation", () => {
    expect(mergeColumnOrder(catalog, ["d", "c", "b", "a"])).toEqual(["d", "c", "b", "a"]);
    expect(mergeColumnOrder(catalog, ["c", "a", "d", "b"])).toEqual(["c", "a", "d", "b"]);
  });

  it("drops a saved key no longer in the catalog", () => {
    // "x" was removed from the catalog since the user saved; it disappears.
    expect(mergeColumnOrder(catalog, ["x", "c", "a"])).toEqual(["c", "a", "b", "d"]);
  });

  it("appends a NEW catalog column (absent from the saved order) at the end", () => {
    // User saved before "d" existed: their order first, "d" appended.
    expect(mergeColumnOrder(catalog, ["c", "b", "a"])).toEqual(["c", "b", "a", "d"]);
  });

  it("orders a partial saved set first, then the rest in catalog order", () => {
    expect(mergeColumnOrder(catalog, ["c"])).toEqual(["c", "a", "b", "d"]);
    expect(mergeColumnOrder(catalog, ["d", "b"])).toEqual(["d", "b", "a", "c"]);
  });

  it("dedupes repeated saved keys (first occurrence wins)", () => {
    expect(mergeColumnOrder(catalog, ["b", "b", "a", "a"])).toEqual(["b", "a", "c", "d"]);
  });

  it("handles a dropped key AND a new column together", () => {
    // saved = [gone, d, b]; "gone" dropped, order [d,b], then append remaining catalog [a,c].
    expect(mergeColumnOrder(catalog, ["gone", "d", "b"])).toEqual(["d", "b", "a", "c"]);
  });

  it("INVARIANT: output is always exactly the catalog set, reordered (no dups, no extras, nothing invented)", () => {
    const cases: string[][] = [
      [],
      ["a"],
      ["d", "c", "b", "a"],
      ["x", "y", "a"],
      ["b", "b", "z", "c"],
      ["gone", "d"],
    ];
    for (const saved of cases) {
      const out = mergeColumnOrder(catalog, saved);
      expect([...out].sort()).toEqual([...catalog].sort()); // same set
      expect(new Set(out).size).toBe(out.length); // no duplicates
      for (const k of out) expect(catalog).toContain(k); // nothing invented
    }
  });

  it("does not mutate its inputs", () => {
    const cat = ["a", "b", "c"];
    const saved = ["c", "a"];
    mergeColumnOrder(cat, saved);
    expect(cat).toEqual(["a", "b", "c"]);
    expect(saved).toEqual(["c", "a"]);
  });
});

describe("getListViewPref", () => {
  it("queries owner+object+view scoped, deleted_at IS NULL, and maps the row", async () => {
    const { db, calls } = mockDb([[ROW]]);
    const pref = await getListViewPref(db, "acct-1", "trailer", "trailers");
    expect(calls).toHaveLength(1);
    expect(calls[0].sql).toMatch(/FROM fcr_core\.list_view_pref/);
    expect(calls[0].sql).toMatch(/owner_account_id = \$1 AND object_key = \$2 AND view_slug = \$3 AND deleted_at IS NULL/);
    expect(calls[0].params).toEqual(["acct-1", "trailer", "trailers"]);
    expect(pref).toMatchObject({ objectKey: "trailer", viewSlug: "trailers", columns: ["status", "sf_name"] });
  });

  it("returns null when there is no row", async () => {
    const { db } = mockDb([[]]);
    expect(await getListViewPref(db, "acct-1", "trailer", "trailers")).toBeNull();
  });
});

describe("saveListViewPref", () => {
  it("issues an INSERT ... ON CONFLICT whose arbiter matches the partial unique index", async () => {
    const { db, calls } = mockDb([[{ ...ROW, columns: ["status", "sf_name", "team"] }]]);
    const saved = await saveListViewPref(db, "acct-1", "trailer", "trailers", ["status", "sf_name", "team"]);
    expect(calls).toHaveLength(1);
    expect(calls[0].sql).toMatch(/INSERT INTO fcr_core\.list_view_pref/);
    // The arbiter MUST be exactly (owner_account_id, object_key, view_slug) WHERE deleted_at IS NULL.
    expect(calls[0].sql).toMatch(/ON CONFLICT \(owner_account_id, object_key, view_slug\) WHERE deleted_at IS NULL/);
    expect(calls[0].sql).toMatch(/DO UPDATE SET columns = EXCLUDED\.columns, updated_at = now\(\)/);
    // columns are passed as a JSON array string for $4::jsonb.
    expect(calls[0].params?.[3]).toBe(JSON.stringify(["status", "sf_name", "team"]));
    expect(saved?.columns).toEqual(["status", "sf_name", "team"]);
  });

  it("sanitizes columns before storing (dedupe, drop non-strings/blanks)", async () => {
    const { db, calls } = mockDb([[ROW]]);
    await saveListViewPref(db, "acct-1", "trailer", "trailers", [
      "status", "status", "  sf_name  ", "", 7 as unknown as string, "  ",
    ]);
    // deduped, trimmed, non-strings/blanks dropped.
    expect(calls[0].params?.[3]).toBe(JSON.stringify(["status", "sf_name"]));
  });

  it("an EMPTY/all-invalid columns save soft-deletes (reset to default) and returns null — no INSERT", async () => {
    const { db, calls } = mockDb([[]]);
    const saved = await saveListViewPref(db, "acct-1", "trailer", "trailers", ["", "   ", 5 as unknown as string]);
    expect(saved).toBeNull();
    expect(calls).toHaveLength(1);
    expect(calls[0].sql).toMatch(/UPDATE fcr_core\.list_view_pref SET deleted_at = now\(\)/);
    expect(calls[0].sql).not.toMatch(/INSERT/);
    expect(calls[0].params).toEqual(["acct-1", "trailer", "trailers"]);
  });
});

describe("deleteListViewPref", () => {
  it("soft-deletes owner+object+view scoped", async () => {
    const { db, calls } = mockDb([[]]);
    await deleteListViewPref(db, "acct-1", "trailer", "trailers");
    expect(calls[0].sql).toMatch(/UPDATE fcr_core\.list_view_pref SET deleted_at = now\(\), updated_at = now\(\)/);
    expect(calls[0].sql).toMatch(/owner_account_id = \$1 AND object_key = \$2 AND view_slug = \$3 AND deleted_at IS NULL/);
    expect(calls[0].params).toEqual(["acct-1", "trailer", "trailers"]);
  });
});
