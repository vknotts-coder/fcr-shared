import type { Queryable } from "../rbac/index.js";
export type ListViewPref = {
    id: string;
    ownerAccountId: string;
    objectKey: string;
    viewSlug: string;
    /** The user's ordered column keys (both shown and hidden, in their arranged positions). A reorder-only
     *  pref (Track B legacy, or a save with nothing hidden) lists every column here with `hidden` empty. */
    columns: string[];
    /** The subset of `columns` the user has turned OFF (show/hide, Track C). Always ⊆ `columns`. Empty for a
     *  legacy reorder-only pref — so an old row reads as "every column visible, in the saved order". */
    hidden: string[];
    createdAt: string;
    updatedAt: string;
};
/** A column arrangement as stored/accepted: the ordered keys, plus which of them are hidden. The bare
 *  `string[]` form is the Track B legacy shape (order only, nothing hidden) and stays accepted everywhere. */
export type ColumnArrangement = {
    order: string[];
    hidden?: string[];
};
export type ColumnPrefInput = string[] | ColumnArrangement;
/** A resolved column: its key and whether it renders. `resolveColumns` returns the full arranged set so a
 *  UI can show hidden columns as toggle-off-able; the grid consumes only `.visible`. */
export type ResolvedColumn = {
    key: string;
    hidden: boolean;
};
/** The user's saved column order for one (object, view), or null. Owner-scoped — never another user's. */
export declare function getListViewPref(db: Queryable, accountId: string, objectKey: string, viewSlug: string): Promise<ListViewPref | null>;
/**
 * Upsert the user's column order for one (object, view). Idempotent + race-safe via an ATOMIC upsert on the
 * partial-unique index `(owner_account_id, object_key, view_slug) WHERE deleted_at IS NULL` — a double-click
 * or concurrent save updates the existing row instead of racing two inserts. (This arbiter MUST match the
 * B1 migration's index exactly — a mismatched target throws "no unique or exclusion constraint matching the
 * ON CONFLICT specification".) The columns are sanitized to a clean string[]; an EMPTY result SOFT-DELETES
 * the pref (reset to the view's default order) rather than storing a meaningless empty order.
 *
 * The caller (the app's save action) validates the columns are a subset/reorder of the view's OWN columns
 * before calling this — @fcr/core doesn't know an app's effective column set. `mergeColumnOrder` /
 * `resolveColumns` re-validate on read regardless, so a bad store can never break a render.
 *
 * Accepts the legacy bare `string[]` (order only, Track B) OR a `{ order, hidden }` arrangement (Track C
 * show/hide). To keep reorder-only saves byte-identical to Track B, a save with nothing hidden is stored as
 * the bare array; only a save that actually hides a column stores the `{ order, hidden }` object. An EMPTY
 * order SOFT-DELETES the pref (reset to the view's default) rather than storing a meaningless empty order.
 *
 * Returns the saved pref, or null when the save was a reset-to-default (empty order).
 */
export declare function saveListViewPref(db: Queryable, accountId: string, objectKey: string, viewSlug: string, columns: ColumnPrefInput): Promise<ListViewPref | null>;
/** Owner-scoped soft delete — reset this (object, view) to the default column order. A wrong owner/key is a
 *  no-op, never touches another user's pref. */
export declare function deleteListViewPref(db: Queryable, accountId: string, objectKey: string, viewSlug: string): Promise<void>;
/**
 * PURE. Apply a user's saved column order onto a view's live catalog columns:
 *   1. take the saved keys that STILL exist in the catalog, in the saved order;
 *   2. append any catalog column NOT named in the saved order, in catalog order, at the end.
 *
 * So a key the catalog dropped disappears, and a column the catalog ADDED since the save shows up (at the
 * end) rather than being hidden — a catalog change never breaks or hides a column. With no saved order
 * (null/empty) it returns the catalog columns unchanged. It NEVER invents a column: the result is always the
 * same set as `catalogColumns`, reordered (no duplicates, no extras) — reorder-only, matching #88 decision 3.
 */
export declare function mergeColumnOrder(catalogColumns: string[], savedOrder: string[] | null | undefined): string[];
/**
 * PURE. Apply a user's saved column arrangement (order + hidden) onto a view's live available columns —
 * the Track C show/hide + reorder read-side, the superset of `mergeColumnOrder`.
 *
 * Rules, in order:
 *   1. The first `lockedLeading` available columns (default 0) are PINNED FIRST and FORCED VISIBLE — the
 *      record-link column can't be hidden or moved off the front, whatever the saved pref says.
 *   2. Then the saved `order` keys that still exist in `available` (and aren't locked leaders), in saved
 *      order; each hidden iff it's in the saved `hidden` set.
 *   3. Then any available column the saved order never named (a column ADDED to the catalog since the save),
 *      in available order, at the end — VISIBLE by default (a new column is surfaced, never silently hidden).
 *   4. A key the catalog dropped disappears; nothing is ever invented — the arranged set is exactly the
 *      `available` set, reordered. With no pref (null/empty) it's `available` in order, all visible.
 *   5. Safety net: if every column ended up hidden (only reachable with `lockedLeading` 0 and a pref that
 *      hides all), the first arranged column is forced visible so the grid is never empty.
 *
 * Returns `{ visible, arrangement }`: `visible` is the ordered keys the grid should render/query;
 * `arrangement` is the full ordered set with per-column hidden flags, for a show/hide UI.
 */
export declare function resolveColumns(available: string[], pref: ColumnPrefInput | null | undefined, opts?: {
    lockedLeading?: number;
}): {
    visible: string[];
    arrangement: ResolvedColumn[];
};
//# sourceMappingURL=listViewPrefs.d.ts.map