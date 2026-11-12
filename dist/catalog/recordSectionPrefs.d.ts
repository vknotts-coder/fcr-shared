import type { Queryable } from "../rbac/index.js";
export declare const SECTION_VIEW_SLUG = "record-sections";
/** A user's saved section arrangement for one record object: the ordered section keys, and which of them
 *  are collapsed. `collapsed ⊆ order` by construction (the store intersects on save). */
export type SectionPref = {
    order: string[];
    collapsed: string[];
};
/** A resolved section: its key and whether it renders collapsed. `resolveSections` returns the full ordered
 *  set so the UI can render every section header; the body is hidden iff `collapsed`. */
export type ResolvedSection = {
    key: string;
    collapsed: boolean;
};
/** The viewer's saved section arrangement for one record object, or null if they've never customized it.
 *  Owner-scoped — never another user's. Maps the generic store's `{ columns, hidden }` → `{ order, collapsed }`. */
export declare function getRecordSectionPref(db: Queryable, accountId: string, objectKey: string): Promise<SectionPref | null>;
/** Upsert the viewer's section arrangement for one record object. Idempotent + race-safe (the underlying
 *  store does an atomic upsert). An EMPTY order resets to default (soft-delete). The store sanitizes the
 *  keys and enforces `collapsed ⊆ order`, so a malformed arrangement can never corrupt a render or the store. */
export declare function saveRecordSectionPref(db: Queryable, accountId: string, objectKey: string, pref: SectionPref): Promise<void>;
/** Owner-scoped reset of the viewer's section arrangement for one record object back to the app default. */
export declare function deleteRecordSectionPref(db: Queryable, accountId: string, objectKey: string): Promise<void>;
/**
 * PURE. Apply a user's saved section pref onto a record page's live AVAILABLE sections (the sections the
 * viewer may actually see — already filtered by the app for RBAC/emptiness before calling). Rules, in order:
 *
 *   1. `pinnedKey` (e.g. "information"), when present in `available`, is FORCED FIRST and is never
 *      reorderable — whatever the saved order says. It MAY still be collapsed (per the saved collapsed set).
 *   2. Then the saved `order` keys that still exist in `available` (and aren't the pinned key), in saved
 *      order; each collapsed iff it's in the saved collapsed set.
 *   3. Then any available section the saved order never named (a section ADDED since the save), in available
 *      order, at the end — EXPANDED by default (a new section is surfaced open, never silently collapsed).
 *   4. A saved key no longer available disappears; nothing is invented — the result set is exactly the
 *      `available` set, reordered. With no pref (null/empty) it's `available` in order, pinned first, all open.
 *
 * So a section added to or removed from a record registry, or a stale/garbage stored key, can never break,
 * hide, or duplicate a section — same resilience the list-view column merge gives.
 */
export declare function resolveSections(available: string[], pref: SectionPref | null | undefined, opts?: {
    pinnedKey?: string;
}): ResolvedSection[];
//# sourceMappingURL=recordSectionPrefs.d.ts.map