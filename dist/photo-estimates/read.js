// @fcr/core/photo-estimates read helpers. DB-agnostic (injected Queryable). Every timestamp is cast
// ::text in the SELECT so neon's Date hydration never reaches JSX as a raw Date (the fleet's
// neon-date-hydration trap: a raw Date in JSX throws React #31 / a 500 that looks like a 404).
import { PHOTO_ESTIMATE_BOARD_STATUSES, } from "./types.js";
// Timestamps cast ::text; plain columns selected as-is. Order mirrors the table.
const SELECT_COLS = `
  id, customer_name, customer_sf_id, truck_number, vin, contact_ref, contact_name,
  status, assigned_estimator, declined_reason,
  converted_truck_id, submitted_by, submitted_by_name,
  assigned_at::text  AS assigned_at,
  completed_at::text AS completed_at,
  accepted_at::text  AS accepted_at,
  declined_at::text  AS declined_at,
  created_at::text   AS created_at,
  updated_at::text   AS updated_at,
  created_by, created_by_name, updated_by, updated_by_name,
  deleted_at::text   AS deleted_at`;
export async function getPhotoEstimate(db, id) {
    const { rows } = await db.query(`SELECT ${SELECT_COLS} FROM fcr_core.photo_estimate WHERE id = $1 AND deleted_at IS NULL`, [id]);
    return rows[0] ?? null;
}
/** List requests, newest-first. Soft-deleted rows are always excluded. */
export async function listPhotoEstimates(db, filter = {}) {
    const where = ["deleted_at IS NULL"];
    const params = [];
    if (filter.status) {
        params.push(filter.status);
        where.push(`status = $${params.length}`);
    }
    if (filter.activeOnly) {
        params.push(PHOTO_ESTIMATE_BOARD_STATUSES);
        where.push(`status = ANY($${params.length})`);
    }
    if (filter.estimator) {
        params.push(filter.estimator);
        where.push(`assigned_estimator = $${params.length}`);
    }
    if (filter.search && filter.search.trim()) {
        params.push(`%${filter.search.trim()}%`);
        const p = `$${params.length}`;
        where.push(`(customer_name ILIKE ${p} OR truck_number ILIKE ${p} OR vin ILIKE ${p})`);
    }
    let text = `SELECT ${SELECT_COLS} FROM fcr_core.photo_estimate
              WHERE ${where.join(" AND ")}
              ORDER BY created_at DESC`;
    if (filter.limit && filter.limit > 0) {
        params.push(filter.limit);
        text += ` LIMIT $${params.length}`;
    }
    const { rows } = await db.query(text, params);
    return rows;
}
/** Status counts + win rate — the spec's "jobs we get vs. the ones we don't" counter. */
export async function photoEstimateCounts(db) {
    const { rows } = await db.query(`SELECT status, count(*)::text AS n
       FROM fcr_core.photo_estimate
      WHERE deleted_at IS NULL
      GROUP BY status`, []);
    const by = {};
    for (const r of rows)
        by[r.status] = Number(r.n);
    const accepted = by.accepted ?? 0;
    const declined = by.declined ?? 0;
    const resolved = accepted + declined;
    return {
        unassigned: by.unassigned ?? 0,
        in_progress: by.in_progress ?? 0,
        completed: by.completed ?? 0,
        accepted,
        declined,
        winRate: resolved === 0 ? null : accepted / resolved,
    };
}
