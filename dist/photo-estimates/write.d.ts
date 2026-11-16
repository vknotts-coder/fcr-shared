import type { Queryable } from "../rbac/index.js";
import { type PhotoEstimateActor, type PhotoEstimateWriteResult } from "./types.js";
export interface PhotoEstimateCreateInput {
    customerName: string;
    truckNumber: string;
    vin: string;
}
/** Create a new request (status 'unassigned'). Jordan's hard rule: Customer, Truck # and VIN are all
 *  required. The "at least one of Photos OR a Comparative Estimate" requirement is enforced at the app
 *  layer (attachments land on unit_file/unit_photo after the row exists, keyed by this id). */
export declare function createPhotoEstimate(db: Queryable, input: PhotoEstimateCreateInput, actor: PhotoEstimateActor): Promise<PhotoEstimateWriteResult>;
/** Assign (or re-assign) to an estimator and move to In Progress. assigned_at is set once (first pick-up). */
export declare function assignPhotoEstimate(db: Queryable, id: string, estimator: string, actor: PhotoEstimateActor): Promise<PhotoEstimateWriteResult>;
/** Mark Completed. Only from In Progress. The caller (estimating app) must have verified the finished
 *  estimate file is uploaded before calling this — that check needs unit_file and lives app-side. */
export declare function completePhotoEstimate(db: Queryable, id: string, actor: PhotoEstimateActor): Promise<PhotoEstimateWriteResult>;
/** Customer accepted. Only from Completed. `convertedTruckId` links the real truck created by the
 *  convert-to-job flow (S5); pass it when the truck has been created, else null (link set later). */
export declare function acceptPhotoEstimate(db: Queryable, id: string, actor: PhotoEstimateActor, convertedTruckId?: string | null): Promise<PhotoEstimateWriteResult>;
/** Customer declined. Allowed from any active (non-terminal) status. Optional reason for win/loss. */
export declare function declinePhotoEstimate(db: Queryable, id: string, reason: string, actor: PhotoEstimateActor): Promise<PhotoEstimateWriteResult>;
/** Set (or correct) the converted-truck link after the convert-to-job flow creates the real truck.
 *  Separate from accept so the two-step UI (accept → review card → Create Job) can link once the truck
 *  id exists. No status change. */
export declare function linkConvertedTruck(db: Queryable, id: string, truckId: string, actor: PhotoEstimateActor): Promise<PhotoEstimateWriteResult>;
//# sourceMappingURL=write.d.ts.map