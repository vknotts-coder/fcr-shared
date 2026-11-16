/** Lifecycle. Board-active: unassigned / in_progress / completed. Terminal: accepted / declined. */
export type PhotoEstimateStatus = "unassigned" | "in_progress" | "completed" | "accepted" | "declined";
export declare const PHOTO_ESTIMATE_STATUSES: PhotoEstimateStatus[];
export declare const PHOTO_ESTIMATE_STATUS_LABEL: Record<PhotoEstimateStatus, string>;
/** On the board (active work). accepted/declined leave the board but stay in the list + counter. */
export declare const PHOTO_ESTIMATE_BOARD_STATUSES: PhotoEstimateStatus[];
export declare const PHOTO_ESTIMATE_TERMINAL_STATUSES: PhotoEstimateStatus[];
export declare function isTerminalStatus(s: string): boolean;
/** A fcr_core.photo_estimate row. Timestamps are strings — every read casts them ::text so neon's
 *  Date hydration never reaches JSX as a raw Date (the fleet's neon-date-hydration trap). */
export interface PhotoEstimateRow {
    id: string;
    customer_name: string;
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
export type PhotoEstimateWriteResult = {
    ok: true;
    id: string;
} | {
    ok: false;
    errors: PhotoEstimateWriteError[];
};
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
//# sourceMappingURL=types.d.ts.map