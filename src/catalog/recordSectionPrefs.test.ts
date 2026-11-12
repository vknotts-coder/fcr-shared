import { describe, it, expect } from "vitest";
import {
  resolveSections,
  getRecordSectionPref,
  saveRecordSectionPref,
  deleteRecordSectionPref,
  SECTION_VIEW_SLUG,
  type SectionPref,
} from "./recordSectionPrefs.js";

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

const ACCT = "22222222-2222-2222-2222-222222222222";
// The trailer registry's real section keys, in SECTION_ORDER (information pinned first).
const AVAIL = ["information", "incoming_transport", "outgoing_transport", "parts", "repair", "estimate", "invoice", "rework", "system"];

describe("resolveSections", () => {
  it("with no pref: available order unchanged, pinned first, all expanded", () => {
    const got = resolveSections(AVAIL, null, { pinnedKey: "information" });
    expect(got.map((s) => s.key)).toEqual(AVAIL);
    expect(got.every((s) => !s.collapsed)).toBe(true);
    expect(resolveSections(AVAIL, undefined, { pinnedKey: "information" }).map((s) => s.key)).toEqual(AVAIL);
    expect(resolveSections(AVAIL, { order: [], collapsed: [] }, { pinnedKey: "information" }).map((s) => s.key)).toEqual(AVAIL);
  });

  it("applies a saved reorder, keeping the pinned section first regardless of saved order", () => {
    // User saved an order that (illegally) puts information last; it is still forced to the front.
    const pref: SectionPref = { order: ["invoice", "repair", "parts", "information"], collapsed: [] };
    const got = resolveSections(AVAIL, pref, { pinnedKey: "information" });
    expect(got[0]!.key).toBe("information");
    // saved order (minus pinned) next, then the remaining available in available order.
    expect(got.map((s) => s.key)).toEqual([
      "information", "invoice", "repair", "parts",
      "incoming_transport", "outgoing_transport", "estimate", "rework", "system",
    ]);
  });

  it("honors the collapsed set, including the pinned section (pinned IS collapsible)", () => {
    const pref: SectionPref = { order: AVAIL, collapsed: ["information", "system"] };
    const got = resolveSections(AVAIL, pref, { pinnedKey: "information" });
    const collapsed = got.filter((s) => s.collapsed).map((s) => s.key);
    expect(collapsed).toEqual(["information", "system"]);
    expect(got[0]!).toEqual({ key: "information", collapsed: true });
  });

  it("drops a saved key no longer available, and appends a NEW available section expanded", () => {
    // Saved before "warranty" existed and names a now-removed "legacy" section.
    const avail = ["information", "repair", "warranty"];
    const pref: SectionPref = { order: ["legacy", "repair", "information"], collapsed: ["repair"] };
    const got = resolveSections(avail, pref, { pinnedKey: "information" });
    expect(got.map((s) => s.key)).toEqual(["information", "repair", "warranty"]);
    // "warranty" is new → expanded; "legacy" vanished; "repair" stays collapsed.
    expect(got.find((s) => s.key === "warranty")!.collapsed).toBe(false);
    expect(got.find((s) => s.key === "repair")!.collapsed).toBe(true);
  });

  it("works with no pinned key (every section reorderable)", () => {
    const pref: SectionPref = { order: ["repair", "parts"], collapsed: [] };
    const got = resolveSections(["parts", "repair", "estimate"], pref, {});
    expect(got.map((s) => s.key)).toEqual(["repair", "parts", "estimate"]);
  });

  it("is defensive against garbage input (non-arrays, dupes, blanks)", () => {
    const pref = { order: ["repair", "repair", "  ", 7, "parts"], collapsed: "nope" } as unknown as SectionPref;
    const got = resolveSections(["parts", "repair", "estimate"], pref, { pinnedKey: "information" });
    // pinned "information" is NOT available here → skipped; deduped/clean order applied.
    expect(got.map((s) => s.key)).toEqual(["repair", "parts", "estimate"]);
    expect(got.every((s) => !s.collapsed)).toBe(true);
  });

  it("never invents, drops, or duplicates: result set always equals the available set", () => {
    const pref: SectionPref = { order: ["system", "system", "ghost", "parts"], collapsed: ["parts"] };
    const got = resolveSections(AVAIL, pref, { pinnedKey: "information" });
    expect(new Set(got.map((s) => s.key))).toEqual(new Set(AVAIL));
    expect(got.length).toBe(AVAIL.length);
  });
});

describe("getRecordSectionPref", () => {
  it("maps the stored {columns, hidden} to {order, collapsed} and queries the namespaced view_slug", async () => {
    const { db, calls } = mockDb([
      [{
        id: "1", owner_account_id: ACCT, object_key: "trailer", view_slug: SECTION_VIEW_SLUG,
        columns: { order: ["information", "repair"], hidden: ["repair"] },
        created_at: "2026-11-12T00:00:00.000Z", updated_at: "2026-11-12T00:00:00.000Z",
      }],
    ]);
    const pref = await getRecordSectionPref(db, ACCT, "trailer");
    expect(pref).toEqual({ order: ["information", "repair"], collapsed: ["repair"] });
    // keyed on the section sentinel slug, not a real list view.
    expect(calls[0]!.params).toEqual([ACCT, "trailer", SECTION_VIEW_SLUG]);
  });

  it("returns null when the user has no saved pref", async () => {
    const { db } = mockDb([[]]);
    expect(await getRecordSectionPref(db, ACCT, "trailer")).toBeNull();
  });

  it("queries a CUSTOM view_slug when given (app namespacing, e.g. 'e:record-sections')", async () => {
    const { db, calls } = mockDb([[]]);
    await getRecordSectionPref(db, ACCT, "truck", "e:record-sections");
    expect(calls[0]!.params).toEqual([ACCT, "truck", "e:record-sections"]);
  });
});

describe("saveRecordSectionPref", () => {
  it("persists under a CUSTOM view_slug when given", async () => {
    const { db, calls } = mockDb([
      [{ id: "1", owner_account_id: ACCT, object_key: "truck", view_slug: "e:record-sections",
         columns: ["identity"], created_at: "x", updated_at: "x" }],
    ]);
    await saveRecordSectionPref(db, ACCT, "truck", { order: ["identity"], collapsed: [] }, "e:record-sections");
    expect(calls[0]!.params[2]).toBe("e:record-sections");
  });

  it("persists {order, collapsed} as the store's {order, hidden} under the section slug", async () => {
    const { db, calls } = mockDb([
      [{
        id: "1", owner_account_id: ACCT, object_key: "trailer", view_slug: SECTION_VIEW_SLUG,
        columns: { order: ["information", "repair", "parts"], hidden: ["parts"] },
        created_at: "x", updated_at: "x",
      }],
    ]);
    await saveRecordSectionPref(db, ACCT, "trailer", { order: ["information", "repair", "parts"], collapsed: ["parts"] });
    const insert = calls[0]!;
    expect(insert.params[1]).toBe("trailer");
    expect(insert.params[2]).toBe(SECTION_VIEW_SLUG);
    // collapsed → hidden in the stored jsonb.
    expect(JSON.parse(insert.params[3] as string)).toEqual({ order: ["information", "repair", "parts"], hidden: ["parts"] });
  });

  it("an empty order resets to default (soft-delete, not an empty store)", async () => {
    const { db, calls } = mockDb([[]]);
    await saveRecordSectionPref(db, ACCT, "trailer", { order: [], collapsed: [] });
    // the store soft-deletes on empty order → an UPDATE ... deleted_at, never an INSERT.
    expect(calls[0]!.sql).toMatch(/deleted_at = now\(\)/);
    expect(calls[0]!.params).toEqual([ACCT, "trailer", SECTION_VIEW_SLUG]);
  });
});

describe("deleteRecordSectionPref", () => {
  it("soft-deletes the viewer's section pref under the section slug", async () => {
    const { db, calls } = mockDb([[]]);
    await deleteRecordSectionPref(db, ACCT, "trailer");
    expect(calls[0]!.sql).toMatch(/UPDATE fcr_core\.list_view_pref SET deleted_at = now\(\)/);
    expect(calls[0]!.params).toEqual([ACCT, "trailer", SECTION_VIEW_SLUG]);
  });
});
