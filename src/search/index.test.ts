// Unit tests for @fcr/core/search — the extraction must preserve the shipped behavior of the
// term floor, LIKE escaping (the drift the trailer copy was MISSING), per-group failure
// isolation, parallel run, and the render-order/count helpers.

import { describe, it, expect, vi } from "vitest";
import {
  escapeLike,
  runSearch,
  nonEmptyGroups,
  totalHits,
  emptyResults,
  defineSearch,
  SEARCH_MIN_TERM_LENGTH,
  type SearchGroupDef,
  type SearchHit,
} from "./index.js";

type K = "a" | "b";

// A group whose run echoes the context it received, so tests can assert what the kernel passed.
function captureGroup(key: K, sink: { ctx?: { term: string; like: string; limit: number } }): SearchGroupDef<K, SearchHit> {
  return {
    key,
    title: key.toUpperCase(),
    run: async (ctx) => {
      sink.ctx = { ...ctx };
      return [{ id: `${key}1`, label: `${key} hit`, sublabel: null, href: `/${key}/1` }];
    },
    map: (rows) => rows,
  };
}

describe("escapeLike", () => {
  it("escapes %, _ and the backslash so a bare wildcard is a literal", () => {
    expect(escapeLike("100%")).toBe("100\\%");
    expect(escapeLike("a_b")).toBe("a\\_b");
    expect(escapeLike("c:\\x")).toBe("c:\\\\x");
    expect(escapeLike("%_\\")).toBe("\\%\\_\\\\");
  });
  it("leaves ordinary text untouched", () => {
    expect(escapeLike("Fitzgerald 42")).toBe("Fitzgerald 42");
  });
});

describe("runSearch — term floor", () => {
  const sink = {};
  const groups = [captureGroup("a", sink)];

  it("returns all-empty groups (in order) below the floor, without running any group", async () => {
    const run = vi.fn(async () => []);
    const r = await runSearch("ab", [{ key: "a", title: "A", run, map: (x) => x as SearchHit[] }]);
    expect(r).toEqual({ a: [] });
    expect(run).not.toHaveBeenCalled();
  });
  it("trims before measuring (whitespace-padded short term is still below the floor)", async () => {
    const run = vi.fn(async () => []);
    await runSearch("  ab  ", [{ key: "a", title: "A", run, map: (x) => x as SearchHit[] }]);
    expect(run).not.toHaveBeenCalled();
  });
  it("runs at exactly the default floor", async () => {
    const r = await runSearch("abc", groups);
    expect(r.a).toHaveLength(1);
  });
  it("honors an overridden minLength", async () => {
    const run = vi.fn(async () => []);
    await runSearch("ab", [{ key: "a", title: "A", run, map: (x) => x as SearchHit[] }], { minLength: 2 });
    expect(run).toHaveBeenCalledOnce();
    expect(SEARCH_MIN_TERM_LENGTH).toBe(3);
  });
});

describe("runSearch — context passed to groups", () => {
  it("passes the escaped, %-wrapped like pattern and the limit (term escaped exactly once)", async () => {
    const sink: { ctx?: { term: string; like: string; limit: number } } = {};
    await runSearch("50%", [captureGroup("a", sink)], { limit: 9 });
    expect(sink.ctx).toEqual({ term: "50%", like: "%50\\%%", limit: 9 });
  });
  it("defaults the per-group limit to 6", async () => {
    const sink: { ctx?: { term: string; like: string; limit: number } } = {};
    await runSearch("abc", [captureGroup("a", sink)]);
    expect(sink.ctx?.limit).toBe(6);
  });
});

describe("runSearch — group isolation + parallelism", () => {
  it("a throwing group yields [] instead of failing the whole search", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const good = captureGroup("a", {});
    const bad: SearchGroupDef<K, SearchHit> = {
      key: "b",
      title: "B",
      run: async () => {
        throw new Error("bad column");
      },
      map: (x) => x,
    };
    const r = await runSearch("abc", [good, bad]);
    expect(r.a).toHaveLength(1);
    expect(r.b).toEqual([]);
    expect(err).toHaveBeenCalled();
    err.mockRestore();
  });
  it("preserves group order in the result regardless of resolve timing", async () => {
    const slowFirst: SearchGroupDef<K, SearchHit> = {
      key: "a",
      title: "A",
      run: () => new Promise((res) => setTimeout(() => res([{ id: "a1", label: "a", sublabel: null }]), 5)),
      map: (x) => x,
    };
    const fastSecond: SearchGroupDef<K, SearchHit> = {
      key: "b",
      title: "B",
      run: async () => [{ id: "b1", label: "b", sublabel: null }],
      map: (x) => x,
    };
    const r = await runSearch("abc", [slowFirst, fastSecond]);
    expect(Object.keys(r)).toEqual(["a", "b"]);
  });
});

describe("helpers", () => {
  const groups: SearchGroupDef<K, SearchHit>[] = [
    { key: "a", title: "A", run: async () => [], map: (x) => x },
    { key: "b", title: "B", run: async () => [], map: (x) => x },
  ];
  it("emptyResults builds a zeroed set in order", () => {
    expect(emptyResults(groups)).toEqual({ a: [], b: [] });
  });
  it("nonEmptyGroups filters by count in the given order", () => {
    const r = { a: [], b: [{ id: "b1", label: "b", sublabel: null }] };
    expect(nonEmptyGroups(r, ["a", "b"])).toEqual(["b"]);
  });
  it("totalHits sums across groups", () => {
    const r = { a: [{ id: "a1", label: "a", sublabel: null }], b: [{ id: "b1", label: "b", sublabel: null }] };
    expect(totalHits(r)).toBe(2);
  });
});

describe("defineSearch — bound helpers can't drift", () => {
  const GROUPS = [
    { key: "a" as const, title: "Alpha", run: async () => [{ id: "a1", label: "a", sublabel: null }], map: (x: SearchHit[]) => x },
    { key: "b" as const, title: "Beta", run: async () => [], map: (x: SearchHit[]) => x },
  ];
  const S = defineSearch(GROUPS, { limit: 4 });

  it("derives order and titles from the groups array", () => {
    expect(S.order).toEqual(["a", "b"]);
    expect(S.titles).toEqual({ a: "Alpha", b: "Beta" });
  });
  it("empty() is a zeroed set in order", () => {
    expect(S.empty()).toEqual({ a: [], b: [] });
  });
  it("search() applies the app's default limit, and a per-call opt overrides it", async () => {
    const sink: { ctx?: { term: string; like: string; limit: number } } = {};
    const S2 = defineSearch([captureGroup("a", sink)], { limit: 4 });
    await S2.search("abc");
    expect(sink.ctx?.limit).toBe(4);
    await S2.search("abc", { limit: 20 });
    expect(sink.ctx?.limit).toBe(20);
  });
  it("bound nonEmptyGroups/totalHits use the bound order", async () => {
    const r = await S.search("abc");
    expect(S.nonEmptyGroups(r)).toEqual(["a"]);
    expect(S.totalHits(r)).toBe(1);
  });
});
