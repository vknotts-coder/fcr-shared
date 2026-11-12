// Per-user record-page SECTION preference (epic fcr-trailers #103): each user's own section ORDER + which
// sections they've COLLAPSED on a record detail page (e.g. /records/trailer/[id]), persisted per
// (user, record object) and reusable across every FCR record-page app.
//
// NO NEW TABLE. This is a thin typed façade over the list-view column-pref store (`listViewPrefs.ts`,
// fcr_core.list_view_pref): the stored jsonb `{ order, hidden }` carries `{ section order, collapsed set }`
// 1:1 — "hidden" (a flagged subset of the order) is structurally identical to "collapsed". So every
// guarantee of that store comes for free: owner-scoped, soft-delete, atomic race-safe upsert, sanitize/cap,
// and `hidden ⊆ order`. We only namespace the `view_slug` so a section pref can never collide with a real
// list-view pref for the same object.
//
// Keyed on `accountId` (the viewer's fcr_core account), exactly like list-view prefs — the app gates the
// save to an operator/admin WITH an account before calling, same predicate it uses to load + render.
import { getListViewPref, saveListViewPref, deleteListViewPref, sanitizeColumns } from "./listViewPrefs.js";
// The DEFAULT `view_slug` under which section prefs live in list_view_pref. A real list view's slug is a plain
// catalog token (e.g. "to_invoice", "pipeline"); this sentinel is not a catalog view, so an app's
// `getListView(object, slug)` validation (which gates its own saves) can never resolve to it — no collision.
//
// Each helper takes an optional `viewSlug` so an app that shares an `objectKey` with ANOTHER app (e.g. both
// fcr-estimating and fcr-dispatch have a "truck" record page; fcr-dispatch and fcr-trailers both have
// "trailer") can namespace its OWN section prefs the way the list-view prefs already do (fcr-estimating
// prefixes list slugs "e:", fcr-dispatch "d:" — see each app's listPrefSlug). Pass e.g. "e:record-sections".
// Omit it (the default) to key the bare "record-sections" slug — fcr-trailers shipped on this default.
export const SECTION_VIEW_SLUG = "record-sections";
/** Enforce the no-collision invariant on a (possibly custom) section `viewSlug`: it must be the bare
 *  sentinel OR an app-namespaced `"<prefix>:record-sections"`. Because it always ENDS in the sentinel, an
 *  app's `getListView(object, slug)` can never resolve it to a real list view — so a section pref can never
 *  overwrite a real list-view pref, whatever prefix a caller passes. A slug that doesn't retain the suffix
 *  (e.g. a real view slug like "pipeline") is a programming error and throws. Centralized so get/save/delete
 *  key identically — an asymmetric slug across them would silently read back nothing. */
function assertSectionSlug(viewSlug) {
    if (viewSlug !== SECTION_VIEW_SLUG && !viewSlug.endsWith(`:${SECTION_VIEW_SLUG}`)) {
        throw new Error(`record-section viewSlug must be "${SECTION_VIEW_SLUG}" or "<prefix>:${SECTION_VIEW_SLUG}", got "${viewSlug}"`);
    }
    return viewSlug;
}
/** The viewer's saved section arrangement for one record object, or null if they've never customized it.
 *  Owner-scoped — never another user's. Maps the generic store's `{ columns, hidden }` → `{ order, collapsed }`. */
export async function getRecordSectionPref(db, accountId, objectKey, viewSlug = SECTION_VIEW_SLUG) {
    const pref = await getListViewPref(db, accountId, objectKey, assertSectionSlug(viewSlug));
    if (!pref)
        return null;
    return { order: pref.columns, collapsed: pref.hidden };
}
/** Upsert the viewer's section arrangement for one record object. Idempotent + race-safe (the underlying
 *  store does an atomic upsert). An EMPTY order resets to default (soft-delete). The store sanitizes the
 *  keys and enforces `collapsed ⊆ order`, so a malformed arrangement can never corrupt a render or the store. */
export async function saveRecordSectionPref(db, accountId, objectKey, pref, viewSlug = SECTION_VIEW_SLUG) {
    // {order, collapsed} → the store's {order, hidden}. A save with nothing collapsed stores the bare array
    // (identical to a reorder-only list pref); a collapse stores the {order, hidden} object. Both read back.
    await saveListViewPref(db, accountId, objectKey, assertSectionSlug(viewSlug), {
        order: pref.order,
        hidden: pref.collapsed,
    });
}
/** Owner-scoped reset of the viewer's section arrangement for one record object back to the app default. */
export async function deleteRecordSectionPref(db, accountId, objectKey, viewSlug = SECTION_VIEW_SLUG) {
    await deleteListViewPref(db, accountId, objectKey, assertSectionSlug(viewSlug));
}
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
export function resolveSections(available, pref, opts = {}) {
    const availSet = new Set(sanitizeColumns(available));
    const avail = [...availSet]; // deduped, available order preserved
    const order = sanitizeColumns(pref?.order);
    const collapsedSet = new Set(sanitizeColumns(pref?.collapsed));
    const out = [];
    const placed = new Set();
    const push = (key) => {
        out.push({ key, collapsed: collapsedSet.has(key) });
        placed.add(key);
    };
    // 1. Pinned section first (if it's an available section).
    const pinned = opts.pinnedKey;
    if (pinned && availSet.has(pinned))
        push(pinned);
    // 2. Saved order (present, not already placed).
    for (const key of order) {
        if (availSet.has(key) && !placed.has(key))
            push(key);
    }
    // 3. New-since-save available sections, appended expanded (collapsedSet won't contain a brand-new key).
    for (const key of avail) {
        if (!placed.has(key))
            push(key);
    }
    return out;
}
