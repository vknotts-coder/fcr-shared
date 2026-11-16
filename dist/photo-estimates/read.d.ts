import type { Queryable } from "../rbac/index.js";
import { type PhotoEstimateCounts, type PhotoEstimateRow, type PhotoEstimateStatus } from "./types.js";
export declare function getPhotoEstimate(db: Queryable, id: string): Promise<PhotoEstimateRow | null>;
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
export declare function listPhotoEstimates(db: Queryable, filter?: PhotoEstimateListFilter): Promise<PhotoEstimateRow[]>;
/** Status counts + win rate — the spec's "jobs we get vs. the ones we don't" counter. */
export declare function photoEstimateCounts(db: Queryable): Promise<PhotoEstimateCounts>;
//# sourceMappingURL=read.d.ts.map