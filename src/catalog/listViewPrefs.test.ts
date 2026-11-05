import { describe, it, expect } from "vitest";
import {
  mergeColumnOrder,
  resolveColumns,
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

  it("always returns a caller-owned array (never the catalogColumns reference), so mutating the result is safe", () => {
    const cat = ["a", "b", "c"];
    // every branch: no-saved-order early-out AND the reorder path.
    for (const saved of [null, [] as string[], ["c", "a"]]) {
      const out = mergeColumnOrder(cat, saved);
      expect(out).not.toBe(cat); // distinct array reference
      out.push("MUTATED");
      expect(cat).toEqual(["a", "b", "c"]); // the catalog constant is untouched
    }
  });
});

describe("resolveColumns (Track C — show/hide + reorder)", () => {
  const avail = ["id", "a", "b", "c", "d"]; // "id" = the record-link leader when lockedLeading:1

  it("no pref → available in order, all visible", () => {
    const { visible, arrangement } = resolveColumns(avail, null);
    expect(visible).toEqual(avail);
    expect(arrangement).toEqual(avail.map((key) => ({ key, hidden: false })));
    expect(resolveColumns(avail, []).visible).toEqual(avail);
    expect(resolveColumns(avail, { order: [] }).visible).toEqual(avail);
  });

  it("hides the columns named in `hidden`, keeping the saved order", () => {
    const { visible, arrangement } = resolveColumns(avail, { order: ["id", "a", "b", "c", "d"], hidden: ["b", "d"] });
    expect(visible).toEqual(["id", "a", "c"]);
    expect(arrangement).toEqual([
      { key: "id", hidden: false },
      { key: "a", hidden: false },
      { key: "b", hidden: true },
      { key: "c", hidden: false },
      { key: "d", hidden: true },
    ]);
  });

  it("applies reorder AND hide together", () => {
    const { visible } = resolveColumns(avail, { order: ["id", "d", "a", "b", "c"], hidden: ["a"] });
    expect(visible).toEqual(["id", "d", "b", "c"]);
  });

  it("lockedLeading pins the leader FIRST and FORCES it visible even if the pref hides/moves it", () => {
    const r = resolveColumns(avail, { order: ["a", "b", "id", "c", "d"], hidden: ["id"] }, { lockedLeading: 1 });
    expect(r.arrangement[0]).toEqual({ key: "id", hidden: false }); // id pinned first, un-hideable
    expect(r.visible[0]).toBe("id");
    expect(r.visible).toContain("id");
  });

  it("a NEW available column (not in the saved order) defaults VISIBLE, appended at the end", () => {
    // user saved before "d" existed and had hidden "b"
    const { visible, arrangement } = resolveColumns(avail, { order: ["id", "a", "b", "c"], hidden: ["b"] });
    expect(visible).toEqual(["id", "a", "c", "d"]); // d appended, visible; b stays hidden
    expect(arrangement.at(-1)).toEqual({ key: "d", hidden: false });
  });

  it("drops a saved/hidden key the catalog no longer has; result is exactly the available set, reordered", () => {
    const { visible, arrangement } = resolveColumns(avail, { order: ["gone", "c", "a"], hidden: ["gone", "a"] });
    expect(arrangement.map((c) => c.key).sort()).toEqual([...avail].sort()); // same set
    expect(new Set(arrangement.map((c) => c.key)).size).toBe(arrangement.length); // no dups
    expect(visible).not.toContain("gone");
    expect(visible).not.toContain("a"); // a was hidden
  });

  it("accepts the legacy bare string[] (reorder-only) as all-visible", () => {
    const { visible } = resolveColumns(avail, ["d", "c", "b", "a", "id"]);
    expect(visible).toEqual(["d", "c", "b", "a", "id"]);
  });

  it("safety net: if a pref hides EVERY column (no locked leader), the first arranged column stays visible", () => {
    const { visible } = resolveColumns(avail, { order: avail, hidden: avail });
    expect(visible).toEqual(["id"]); // never an empty grid
  });

  it("does not mutate its inputs", () => {
    const a = ["id", "a", "b"];
    const pref = { order: ["b", "a", "id"], hidden: ["a"] };
    resolveColumns(a, pref, { lockedLeading: 1 });
    expect(a).toEqual(["id", "a", "b"]);
    expect(pref).toEqual({ order: ["b", "a", "id"], hidden: ["a"] });
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
    expect(pref).toMatchObject({ objectKey: "trailer", viewSlug: "trailers", columns: ["status", "sf_name"], hidden: [] });
  });

  it("maps a stored { order, hidden } arrangement row (Track C), intersecting hidden ⊆ order", async () => {
    const objRow = { ...ROW, columns: { order: ["status", "sf_name", "team"], hidden: ["team", "notpresent"] } };
    const { db } = mockDb([[objRow]]);
    const pref = await getListViewPref(db, "acct-1", "trailer", "trailers");
    expect(pref).toMatchObject({ columns: ["status", "sf_name", "team"], hidden: ["team"] });
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

  it("a { order, hidden } arrangement with NOTHING hidden stores the bare array (byte-identical to Track B)", async () => {
    const { db, calls } = mockDb([[{ ...ROW, columns: ["status", "sf_name", "team"] }]]);
    await saveListViewPref(db, "acct-1", "trailer", "trailers", { order: ["status", "sf_name", "team"], hidden: [] });
    expect(calls[0].params?.[3]).toBe(JSON.stringify(["status", "sf_name", "team"]));
  });

  it("a { order, hidden } arrangement that hides a column stores the object (hidden ⊆ order enforced)", async () => {
    const { db, calls } = mockDb([[{ ...ROW, columns: { order: ["status", "sf_name", "team"], hidden: ["team"] } }]]);
    const saved = await saveListViewPref(db, "acct-1", "trailer", "trailers", {
      order: ["status", "sf_name", "team"],
      hidden: ["team", "ghost"], // "ghost" not in order → dropped
    });
    expect(calls[0].params?.[3]).toBe(JSON.stringify({ order: ["status", "sf_name", "team"], hidden: ["team"] }));
    expect(saved).toMatchObject({ columns: ["status", "sf_name", "team"], hidden: ["team"] });
  });

  it("an arrangement whose order sanitizes to empty soft-deletes (reset), even with a hidden list", async () => {
    const { db, calls } = mockDb([[]]);
    const saved = await saveListViewPref(db, "acct-1", "trailer", "trailers", { order: ["", "  "], hidden: ["x"] });
    expect(saved).toBeNull();
    expect(calls[0].sql).toMatch(/UPDATE fcr_core\.list_view_pref SET deleted_at = now\(\)/);
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
