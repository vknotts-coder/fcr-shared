// @fcr/core/photo-estimates — shared domain for the Photo Estimates module (epic
// fcr-estimating#94). A Sales→Estimating request to write an estimate from photos (or a
// comparative/competitor estimate), tracked on its own board to completion, and — on customer
// accept — converted into a real truck in the normal workflow.
//
// Lives in @fcr/core (not app-local like donor) because TWO apps share the row + status machine:
// fcr-sales submits, fcr-estimating works/completes/converts. Keeping the single source of the
// status set + transitions here prevents the two apps from drifting. React-free and
// DB-driver-free: the consuming app injects a Queryable (same contract as intake/events/rbac).
//
// The fcr_core.photo_estimate table is APP-OWNED and NEVER a Salesforce sync target. The only SF
// exposure is downstream and deliberate: accept→convert (S5) calls @fcr/core/intake createUnits,
// which makes a normal, syncing truck — the photo_estimate row itself never syncs.

/** Lifecycle. Board-active: unassigned / in_progress / completed. Terminal: accepted / declined. */
export type PhotoEstimateStatus =
  | "unassigned"
  | "in_progress"
  | "completed"
  | "accepted"
  | "declined";

export const PHOTO_ESTIMATE_STATUSES: PhotoEstimateStatus[] = [
  "unassigned",
  "in_progress",
  "completed",
  "accepted",
  "declined",
];

export const PHOTO_ESTIMATE_STATUS_LABEL: Record<PhotoEstimateStatus, string> = {
  unassigned: "Unassigned",
  in_progress: "In Progress",
  completed: "Completed",
  accepted: "Accepted",
  declined: "Declined",
};

/** On the board (active work). accepted/declined leave the board but stay in the list + counter. */
export const PHOTO_ESTIMATE_BOARD_STATUSES: PhotoEstimateStatus[] = [
  "unassigned",
  "in_progress",
  "completed",
];

export const PHOTO_ESTIMATE_TERMINAL_STATUSES: PhotoEstimateStatus[] = ["accepted", "declined"];

export function isTerminalStatus(s: string): boolean {
  return (PHOTO_ESTIMATE_TERMINAL_STATUSES as readonly string[]).includes(s);
}

/** A fcr_core.photo_estimate row. Timestamps are strings — every read casts them ::text so neon's
 *  Date hydration never reaches JSX as a raw Date (the fleet's neon-date-hydration trap). */
export interface PhotoEstimateRow {
  id: string;
  customer_name: string;
  /** Structured customer/contact capture (epic #94). For an existing pick these link the chosen record;
   *  for a new one they are null/'' and the typed name lives in customer_name / contact_name. Record
   *  creation is deferred to convert-to-truck, so these are the carry-through for the convert prefill. */
  customer_sf_id: string | null;
  contact_ref: string | null;
  contact_name: string;
  truck_number: string;
  vin: string;
  status: PhotoEstimateStatus;
  assigned_estimator: string | null;
  declined_reason: string;
  converted_truck_id: string | null;
  submitted_by: string | null;
  submitted_by_name: string | null;
  assigned_at: string | null;
  completed_at: string | null;
  accepted_at: string | null;
  declined_at: string | null;
  created_at: string;
  updated_at: string;
  created_by: string | null;
  created_by_name: string | null;
  updated_by: string | null;
  updated_by_name: string | null;
  deleted_at: string | null;
}

/** Who performed a write. `username` resolves to the user table later; `name` is the human label. */
export interface PhotoEstimateActor {
  username?: string;
  name: string;
}

export interface PhotoEstimateWriteError {
  field: string | null;
  message: string;
}

export type PhotoEstimateWriteResult =
  | { ok: true; id: string }
  | { ok: false; errors: PhotoEstimateWriteError[] };

/** Win/loss counter (the spec's "jobs we get vs. the ones we don't"). */
export interface PhotoEstimateCounts {
  unassigned: number;
  in_progress: number;
  completed: number;
  accepted: number;
  declined: number;
  /** accepted / (accepted + declined), 0..1; null when none have resolved yet. */
  winRate: number | null;
}
