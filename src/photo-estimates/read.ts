// @fcr/core/photo-estimates read helpers. DB-agnostic (injected Queryable). Every timestamp is cast
// ::text in the SELECT so neon's Date hydration never reaches JSX as a raw Date (the fleet's
// neon-date-hydration trap: a raw Date in JSX throws React #31 / a 500 that looks like a 404).

import type { Queryable } from "../rbac/index.js";
import {
  PHOTO_ESTIMATE_BOARD_STATUSES,
  type PhotoEstimateCounts,
  type PhotoEstimateRow,
  type PhotoEstimateStatus,
} from "./types.js";

// Timestamps cast ::text; plain columns selected as-is. Order mirrors the table.
const SELECT_COLS = `
  id, customer_name, truck_number, vin, status, assigned_estimator, declined_reason,
  converted_truck_id, submitted_by, submitted_by_name,
  assigned_at::text  AS assigned_at,
  completed_at::text AS completed_at,
  accepted_at::text  AS accepted_at,
  declined_at::text  AS declined_at,
  created_at::text   AS created_at,
  updated_at::text   AS updated_at,
  created_by, created_by_name, updated_by, updated_by_name,
  deleted_at::text   AS deleted_at`;

export async function getPhotoEstimate(db: Queryable, id: string): Promise<PhotoEstimateRow | null> {
  const { rows } = await db.query<PhotoEstimateRow>(
    `SELECT ${SELECT_COLS} FROM fcr_core.photo_estimate WHERE id = $1 AND deleted_at IS NULL`,
    [id],
  );
  return rows[0] ?? null;
}

export interface PhotoEstimateListFilter {
  /** Exactly this status. */
  status?: PhotoEstimateStatus;
  /** Only the three board-active statuses (unassigned/in_progress/completed). */
  activeOnly?: boolean;
  /** Assigned to this estimator. */
  estimator?: string;
  /** Case-insensitive match on customer / truck # / VIN. */
  search?: string;
  limit?: number;
}

/** List requests, newest-first. Soft-deleted rows are always excluded. */
export async function listPhotoEstimates(
  db: Queryable,
  filter: PhotoEstimateListFilter = {},
): Promise<PhotoEstimateRow[]> {
  const where: string[] = ["deleted_at IS NULL"];
  const params: unknown[] = [];
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
  const { rows } = await db.query<PhotoEstimateRow>(text, params);
  return rows;
}

/** Status counts + win rate — the spec's "jobs we get vs. the ones we don't" counter. */
export async function photoEstimateCounts(db: Queryable): Promise<PhotoEstimateCounts> {
  const { rows } = await db.query<{ status: PhotoEstimateStatus; n: string }>(
    `SELECT status, count(*)::text AS n
       FROM fcr_core.photo_estimate
      WHERE deleted_at IS NULL
      GROUP BY status`,
    [],
  );
  const by: Record<string, number> = {};
  for (const r of rows) by[r.status] = Number(r.n);
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
