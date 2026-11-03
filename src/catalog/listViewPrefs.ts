// Per-user list-view column order (#88 Track B, Slice B2). Persists each user's own column arrangement for a
// given (object, view) over fcr_core.list_view_pref, plus the PURE merge helper that reconciles a saved order
// against the live catalog columns. Owner-scoped, soft-delete (fcr_core convention), app-owned (no sf_id,
// never reverse-synced). Mirrors reports/savedReports.ts (the per-user persistence pattern).
//
// The stored order is ADVISORY on both ends: the app validates columns before saving (it owns the effective
// column set — which may include app-local extras beyond the shared catalog, e.g. fcr-trailers'
// PIPELINE_EXTRA_COLUMNS), and `mergeColumnOrder` re-validates on read (drops a key no longer present,
// appends any new catalog column at the end). So a catalog change — or a stale/garbage stored key — can
// never break or hide a column.

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

// Defensive caps. A saved order never legitimately exceeds a view's column count, but the store takes
// whatever the app sends, so bound it before it reaches the DB (and before a read trusts it).
const MAX_COLUMNS = 100;
const MAX_KEY_LEN = 128;

type Row = {
  id: string;
  owner_account_id: string;
  object_key: string;
  view_slug: string;
  columns: unknown; // jsonb — a string[] by construction, re-validated on read
  created_at: string | Date;
  updated_at: string | Date;
};

/** Coerce a stored/incoming columns value to a clean string[]: array only, non-empty trimmed strings,
 *  deduped (first occurrence wins), each within length, capped. Anything else is dropped. */
function sanitizeColumns(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const v of value) {
    if (typeof v !== "string") continue;
    const key = v.trim();
    if (!key || key.length > MAX_KEY_LEN || seen.has(key)) continue;
    seen.add(key);
    out.push(key);
    if (out.length >= MAX_COLUMNS) break;
  }
  return out;
}

function mapRow(r: Row): ListViewPref {
  return {
    id: r.id,
    ownerAccountId: r.owner_account_id,
    objectKey: r.object_key,
    viewSlug: r.view_slug,
    columns: sanitizeColumns(r.columns),
    createdAt: String(r.created_at),
    updatedAt: String(r.updated_at),
  };
}

/** The user's saved column order for one (object, view), or null. Owner-scoped — never another user's. */
export async function getListViewPref(
  db: Queryable,
  accountId: string,
  objectKey: string,
  viewSlug: string,
): Promise<ListViewPref | null> {
  const { rows } = await db.query<Row>(
    `SELECT * FROM fcr_core.list_view_pref
      WHERE owner_account_id = $1 AND object_key = $2 AND view_slug = $3 AND deleted_at IS NULL`,
    [accountId, objectKey, viewSlug],
  );
  return rows[0] ? mapRow(rows[0]) : null;
}

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
export async function saveListViewPref(
  db: Queryable,
  accountId: string,
  objectKey: string,
  viewSlug: string,
  columns: string[],
): Promise<ListViewPref | null> {
  const cleaned = sanitizeColumns(columns);
  if (cleaned.length === 0) {
    await deleteListViewPref(db, accountId, objectKey, viewSlug);
    return null;
  }
  const { rows } = await db.query<Row>(
    `INSERT INTO fcr_core.list_view_pref (owner_account_id, object_key, view_slug, columns)
     VALUES ($1, $2, $3, $4::jsonb)
     ON CONFLICT (owner_account_id, object_key, view_slug) WHERE deleted_at IS NULL
     DO UPDATE SET columns = EXCLUDED.columns, updated_at = now()
     RETURNING *`,
    [accountId, objectKey, viewSlug, JSON.stringify(cleaned)],
  );
  const saved = rows[0];
  if (!saved) throw new Error("saveListViewPref: upsert returned no row");
  return mapRow(saved);
}

/** Owner-scoped soft delete — reset this (object, view) to the default column order. A wrong owner/key is a
 *  no-op, never touches another user's pref. */
export async function deleteListViewPref(
  db: Queryable,
  accountId: string,
  objectKey: string,
  viewSlug: string,
): Promise<void> {
  await db.query(
    `UPDATE fcr_core.list_view_pref SET deleted_at = now(), updated_at = now()
      WHERE owner_account_id = $1 AND object_key = $2 AND view_slug = $3 AND deleted_at IS NULL`,
    [accountId, objectKey, viewSlug],
  );
}

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
export function mergeColumnOrder(
  catalogColumns: string[],
  savedOrder: string[] | null | undefined,
): string[] {
  // Return a COPY in the early-out too (not the caller's array by reference), so every path yields a
  // caller-owned array — a consumer that mutates the result (e.g. a reorder UI splicing it) can never
  // corrupt a shared module-level catalog constant process-wide.
  if (!savedOrder || savedOrder.length === 0) return [...catalogColumns];
  const catalog = new Set(catalogColumns);
  const seen = new Set<string>();
  const ordered: string[] = [];
  for (const key of savedOrder) {
    if (catalog.has(key) && !seen.has(key)) {
      ordered.push(key);
      seen.add(key);
    }
  }
  for (const key of catalogColumns) {
    if (!seen.has(key)) ordered.push(key);
  }
  return ordered;
}
