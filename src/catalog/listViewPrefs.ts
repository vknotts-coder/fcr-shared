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
export type ColumnArrangement = { order: string[]; hidden?: string[] };
export type ColumnPrefInput = string[] | ColumnArrangement;

/** A resolved column: its key and whether it renders. `resolveColumns` returns the full arranged set so a
 *  UI can show hidden columns as toggle-off-able; the grid consumes only `.visible`. */
export type ResolvedColumn = { key: string; hidden: boolean };

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

/** Coerce a stored jsonb value OR an incoming `ColumnPrefInput` to a clean { order, hidden } arrangement.
 *  Accepts both the legacy bare `string[]` (order only) and the `{ order, hidden }` object. `hidden` is
 *  sanitized AND intersected with `order` (a hidden key not in the order is meaningless → dropped), so
 *  `hidden ⊆ order` always holds. Anything unrecognized → empty. */
function normalizeArrangement(value: unknown): { order: string[]; hidden: string[] } {
  if (Array.isArray(value)) return { order: sanitizeColumns(value), hidden: [] };
  if (value && typeof value === "object") {
    const order = sanitizeColumns((value as { order?: unknown }).order);
    const inOrder = new Set(order);
    const hidden = sanitizeColumns((value as { hidden?: unknown }).hidden).filter((k) => inOrder.has(k));
    return { order, hidden };
  }
  return { order: [], hidden: [] };
}

function mapRow(r: Row): ListViewPref {
  const { order, hidden } = normalizeArrangement(r.columns);
  return {
    id: r.id,
    ownerAccountId: r.owner_account_id,
    objectKey: r.object_key,
    viewSlug: r.view_slug,
    columns: order,
    hidden,
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
export async function saveListViewPref(
  db: Queryable,
  accountId: string,
  objectKey: string,
  viewSlug: string,
  columns: ColumnPrefInput,
): Promise<ListViewPref | null> {
  const { order, hidden } = normalizeArrangement(columns);
  if (order.length === 0) {
    await deleteListViewPref(db, accountId, objectKey, viewSlug);
    return null;
  }
  // Store the bare array when nothing is hidden (identical to Track B's reorder-only rows), else the
  // { order, hidden } object. Both are valid jsonb; `normalizeArrangement` reads either back.
  const stored = hidden.length === 0 ? order : { order, hidden };
  const { rows } = await db.query<Row>(
    `INSERT INTO fcr_core.list_view_pref (owner_account_id, object_key, view_slug, columns)
     VALUES ($1, $2, $3, $4::jsonb)
     ON CONFLICT (owner_account_id, object_key, view_slug) WHERE deleted_at IS NULL
     DO UPDATE SET columns = EXCLUDED.columns, updated_at = now()
     RETURNING *`,
    [accountId, objectKey, viewSlug, JSON.stringify(stored)],
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
export function resolveColumns(
  available: string[],
  pref: ColumnPrefInput | null | undefined,
  opts?: { lockedLeading?: number },
): { visible: string[]; arrangement: ResolvedColumn[] } {
  // De-dupe available defensively, preserving first-seen order (the caller's effective column set).
  const avail: string[] = [];
  const availSet = new Set<string>();
  for (const key of available) {
    if (!availSet.has(key)) {
      availSet.add(key);
      avail.push(key);
    }
  }

  const lock = Math.min(Math.max(0, opts?.lockedLeading ?? 0), avail.length);
  const lockedKeys = avail.slice(0, lock);

  const { order, hidden } = normalizeArrangement(pref);
  const hiddenSet = new Set(hidden);

  const arrangement: ResolvedColumn[] = [];
  const placed = new Set<string>();

  // 1. Locked leaders first, forced visible.
  for (const key of lockedKeys) {
    arrangement.push({ key, hidden: false });
    placed.add(key);
  }
  // 2. Saved order (present, non-locked), honoring the hidden flag.
  for (const key of order) {
    if (!availSet.has(key) || placed.has(key)) continue;
    arrangement.push({ key, hidden: hiddenSet.has(key) });
    placed.add(key);
  }
  // 3. New-since-save available columns, appended visible.
  for (const key of avail) {
    if (placed.has(key)) continue;
    arrangement.push({ key, hidden: false });
    placed.add(key);
  }

  // 5. Never render an empty grid.
  if (arrangement.length > 0 && arrangement.every((c) => c.hidden)) {
    arrangement[0]!.hidden = false;
  }

  const visible = arrangement.filter((c) => !c.hidden).map((c) => c.key);
  return { visible, arrangement };
}
