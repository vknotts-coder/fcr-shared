import type { EngineResult, FormField, IntakeSpec, ValidationError } from "../types.js";
export declare const TRUCK_NUMERIC_COLS: Set<string>;
export declare const TRUCK_DATE_COLS: Set<string>;
export declare const TRUCK_FORM_FIELDS: FormField[];
/** Truck status seed/stamp. CREATE: seed status from the pickup arrangement (Customer Drop Off
 *  mode → "Customer Drop Off"; a pickup address → "Awaiting Pickup"; else "Awaiting Pickup Info"),
 *  set notify_date + status_date to today if blank. UPDATE: a manual status change stamps
 *  status_date today (no milestone back-fill — deferred). No emails (truck alerts unspecced). */
export declare function applyTruckStatusEngine(before: Record<string, unknown>, edits: Record<string, unknown>, opts?: {
    isNew?: boolean;
    today?: string;
}): EngineResult;
export declare function validateTruck(state: Record<string, unknown>, opts?: {
    isNew?: boolean;
}): ValidationError[];
export declare const truckSpec: IntakeSpec;
//# sourceMappingURL=truck.d.ts.map