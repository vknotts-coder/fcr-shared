import type { Queryable } from "../rbac/index.js";
export interface TruckPartActor {
    username: string;
    name: string;
}
export type TruckPartValidationError = {
    field: string | null;
    message: string;
};
export type TruckPartSaveResult = {
    ok: true;
    id: string;
} | {
    ok: false;
    errors: TruckPartValidationError[];
};
/**
 * Create a back-order-parts record on a truck. Generates the fcr_core uuid (sf_id stays NULL until Salesforce
 * assigns one — the row reaches SF via fcr-dispatch's create/PUSH_ORDER path once DISPATCH_TRUCK_PARTS_SYNC_LIVE
 * is lit). Links via unit_number = truck.sf_id; rejects a truck with no sf_id (unit_number is NOT NULL, and an
 * SF create needs the parent's real Id). sf_name is left NULL for SF to assign (the truck parts object Name is
 * SF-owned); the forward sync backfills it after the record exists in SF.
 */
export declare function createTruckBackorderPart(db: Queryable, truckId: string, formData: FormData, actor: TruckPartActor): Promise<TruckPartSaveResult>;
/**
 * Edit a back-order-parts record. Reads the before-image (scoped to the parent truck — IDOR guard), diffs the
 * business columns, and writes row + audit event atomically with an optimistic-concurrency guard on the
 * before-image's updated_at. Stamps local_edit_at + unions the genuinely-changed columns into
 * dispatch_dirty_cols so fcr-dispatch's field-scoped reverse-sync pushes ONLY those fields to Salesforce — and
 * the SF→core forward sync's overwrite guard preserves them until pushed. The DISTINCT-unnest union matches
 * fcr-dispatch's unionDirtyColsSql exactly (append + dedupe); kept inline because @fcr/core/events doesn't
 * export it and the two repos don't share lib code.
 */
export declare function updateTruckBackorderPart(db: Queryable, partId: string, truckId: string, formData: FormData, actor: TruckPartActor): Promise<TruckPartSaveResult>;
//# sourceMappingURL=index.d.ts.map