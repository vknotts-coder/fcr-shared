import type { Queryable } from "../rbac/index.js";
export type ListViewPref = {
    id: string;
    ownerAccountId: string;
    objectKey: string;
    viewSlug: string;
    /** The user's ordered column keys — a reorder (permutation/subset) of the view's OWN columns. */
    columns: string[];
    createdAt: string;
    updatedAt: string;
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
 * The caller (the app's save action) validates the columns are a reorder of the view's OWN columns before
 * calling this — @fcr/core doesn't know an app's effective column set. `mergeColumnOrder` re-validates on
 * read regardless, so a bad store can never break a render.
 *
 * Returns the saved pref, or null when the save was a reset-to-default (empty columns).
 */
export declare function saveListViewPref(db: Queryable, accountId: string, objectKey: string, viewSlug: string, columns: string[]): Promise<ListViewPref | null>;
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
//# sourceMappingURL=listViewPrefs.d.ts.map